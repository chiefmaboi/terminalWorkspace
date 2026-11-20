import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { AppTheme } from '../../../shared/types'
import { xtermThemeFor } from './themes'

/**
 * Terminal registry: every xterm instance lives here, outside React. React components only
 * borrow a terminal's DOM host while they are mounted (attach/detach), so a terminal survives
 * re-renders, StrictMode double-mounts, maximize/restore and switching workspaces with its
 * buffer intact. PTY output arrives through ONE IPC listener that routes by id (instead of one
 * listener per pane that filters out everyone else's chunks).
 */

export const SCROLLBACK_LINES = 5000
const PREVIEW_DEBOUNCE_MS = 500
const PREVIEW_MAX_LENGTH = 160

export type RendererKind = 'dom' | 'webgl'

interface TerminalEntry {
  id: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** xterm is opened into this element once; it is moved between React containers. */
  host: HTMLDivElement
  started: boolean
  exited: boolean
  lastCols: number
  lastRows: number
  webgl: WebglAddon | null
  previewTimer: ReturnType<typeof setTimeout> | null
  /** Optional per-terminal key hook (e.g. Ctrl+F search while maximized). true = handled. */
  keyHook: ((event: KeyboardEvent) => boolean) | null
}

export interface RegistryCallbacks {
  /** Keyboard focus entered a terminal (selection follows focus). */
  onFocus: (id: string) => void
  onPreview: (id: string, text: string) => void
  onStarted: (id: string) => void
}

const entries = new Map<string, TerminalEntry>()
let callbacks: RegistryCallbacks | null = null
let currentTheme: AppTheme = 'dark'
let initialized = false

/** Subscribe the single PTY data/exit router. Idempotent. */
export function initTerminalRegistry(cb: RegistryCallbacks): void {
  callbacks = cb
  if (initialized) return
  initialized = true

  window.api.onPtyData((id, data) => {
    const entry = entries.get(id)
    if (!entry) {
      // No terminal to render into (e.g. disposed while output was in flight). Ack right away
      // so main's flow control never waits on output nobody will ever parse.
      window.api.ptyAck(id, data.length)
      return
    }
    // Ack once xterm has actually parsed the chunk; main pauses the PTY when too much output
    // is outstanding (FLOW_HIGH_WATERMARK in ptyManager).
    entry.term.write(data, () => window.api.ptyAck(id, data.length))
    schedulePreview(entry)
  })

  window.api.onPtyExit((id, exitCode) => {
    const entry = entries.get(id)
    if (!entry) return
    entry.exited = true
    entry.term.write(`\r\n\x1b[2m[process exited with code ${exitCode}, press Enter to restart]\x1b[0m\r\n`)
  })
}

function create(id: string): TerminalEntry {
  const term = new Terminal({
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 13,
    theme: xtermThemeFor(currentTheme)
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())

  const host = document.createElement('div')
  host.className = 'terminal-host'
  host.dataset.renderer = 'dom'

  const entry: TerminalEntry = {
    id,
    term,
    fit,
    search,
    host,
    started: false,
    exited: false,
    lastCols: 0,
    lastRows: 0,
    webgl: null,
    previewTimer: null,
    keyHook: null
  }

  // xterm.js maps Ctrl+V to the raw "literal next" byte (0x16) and calls preventDefault() on the
  // keydown, which blocks the browser's native paste event, so xterm's own bracketed paste
  // never runs and programs that expect the terminal to deliver pasted text (Claude Code's UI)
  // get nothing. Returning false for Ctrl+V lets the browser paste proceed normally.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
      return false
    }
    if (event.type === 'keydown' && entry.keyHook?.(event)) return false
    return true
  })

  term.onData((data) => {
    if (entry.exited) {
      // The process exited: Enter starts a fresh one, any other key is swallowed.
      if (data.includes('\r')) {
        entry.exited = false
        entry.started = false
        ensureStarted(id)
      }
      return
    }
    window.api.ptyInput(id, data)
  })

  // Selection follows real keyboard focus. 'focusin' bubbles from xterm's hidden textarea,
  // unlike the native 'focus' event.
  host.addEventListener('focusin', () => callbacks?.onFocus(id))

  entries.set(id, entry)
  return entry
}

/**
 * Move terminal `id`'s host into `container`, creating and opening the terminal on first use.
 * The container must already have its final size for the initial fit to be right.
 */
export function attach(id: string, container: HTMLElement): void {
  const existing = entries.get(id)
  const entry = existing ?? create(id)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (!existing) {
    entry.term.open(entry.host)
    // xterm's hidden input textarea has no ARIA semantics, so OS dictation tools that inject
    // text through the accessibility tree often can't identify it as an editable field.
    const textarea = entry.host.querySelector('.xterm-helper-textarea')
    textarea?.setAttribute('role', 'textbox')
    textarea?.setAttribute('aria-multiline', 'true')
    textarea?.setAttribute('aria-label', 'Terminal input')
  }
}

/** Take the host out of the DOM without disposing the terminal (it keeps receiving output). */
export function detach(id: string, container: HTMLElement): void {
  const entry = entries.get(id)
  if (entry && entry.host.parentElement === container) container.removeChild(entry.host)
}

/** Dispose terminal(s) for good: deleted, or its workspace closed (its PTY was stopped). */
export function dispose(ids: string[]): void {
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry) continue
    if (entry.previewTimer) clearTimeout(entry.previewTimer)
    entry.webgl?.dispose()
    entry.term.dispose()
    entry.host.remove()
    entries.delete(id)
  }
}

/**
 * Fit one terminal to its host and tell the PTY if the grid size changed. Every host has the
 * same size (the shared full-size geometry), so every terminal ends up with the same cols/rows.
 */
export function fit(id: string): void {
  const entry = entries.get(id)
  if (!entry || !entry.host.isConnected) return
  const el = entry.host
  // A host with no box (display:none, mid-teardown) would fit to 0x0 and make xterm reflow
  // and lose wrapped lines. Never fit while degenerate.
  if (el.clientWidth === 0 || el.clientHeight === 0) return
  try {
    entry.fit.fit()
  } catch {
    return // renderer not ready yet; the next fit will catch up
  }
  const { cols, rows } = entry.term
  if (entry.started && (cols !== entry.lastCols || rows !== entry.lastRows)) {
    window.api.ptyResize(id, cols, rows)
  }
  entry.lastCols = cols
  entry.lastRows = rows
}

export function fitAll(): void {
  for (const id of entries.keys()) fit(id)
}

/** Start the PTY at the terminal's current size, once. */
export function ensureStarted(id: string): void {
  const entry = entries.get(id)
  if (!entry || entry.started) return
  entry.started = true
  const { cols, rows } = entry.term
  entry.lastCols = cols
  entry.lastRows = rows
  void window.api.ptyStart(id, cols, rows).then(() => callbacks?.onStarted(id))
}

/** WebGL only for the maximized terminal; every tile uses xterm's DOM renderer. */
export function setRenderer(id: string, kind: RendererKind): void {
  const entry = entries.get(id)
  if (!entry) return
  if (kind === 'webgl' && !entry.webgl) {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // GPU reset or context eviction: drop back to the DOM renderer rather than go blank.
        addon.dispose()
        if (entry.webgl === addon) {
          entry.webgl = null
          entry.host.dataset.renderer = 'dom'
        }
      })
      entry.term.loadAddon(addon)
      entry.webgl = addon
      entry.host.dataset.renderer = 'webgl'
    } catch (err) {
      console.warn(`[terminal] WebGL unavailable, staying on the DOM renderer: ${String(err)}`)
      entry.webgl = null
      entry.host.dataset.renderer = 'dom'
    }
  } else if (kind === 'dom' && entry.webgl) {
    entry.webgl.dispose()
    entry.webgl = null
    entry.host.dataset.renderer = 'dom'
  }
}

export function focus(id: string): void {
  entries.get(id)?.term.focus()
}

export function setKeyHook(id: string, hook: ((event: KeyboardEvent) => boolean) | null): void {
  const entry = entries.get(id)
  if (entry) entry.keyHook = hook
}

export function searchAddon(id: string): SearchAddon | null {
  return entries.get(id)?.search ?? null
}

export function setTheme(theme: AppTheme): void {
  currentTheme = theme
  for (const entry of entries.values()) {
    try {
      entry.term.options.theme = xtermThemeFor(theme)
    } catch {
      // Renderer not initialized yet (first frame after open); it was created with currentTheme.
    }
  }
}

// xterm has already parsed away all ANSI/color codes into its buffer, so reading plain text back
// out of it is far more reliable than stripping escape sequences from raw PTY output.
function schedulePreview(entry: TerminalEntry): void {
  if (!callbacks) return
  if (entry.previewTimer) clearTimeout(entry.previewTimer)
  entry.previewTimer = setTimeout(() => {
    entry.previewTimer = null
    const buffer = entry.term.buffer.active
    const lines: string[] = []
    for (let i = buffer.length - 1; i >= 0 && lines.length < 3; i--) {
      const text = buffer.getLine(i)?.translateToString(true).trim()
      if (text) lines.unshift(text)
    }
    const joined = lines.join('  ').replace(/\s+/g, ' ').trim()
    callbacks?.onPreview(
      entry.id,
      joined.length > PREVIEW_MAX_LENGTH ? `${joined.slice(0, PREVIEW_MAX_LENGTH)}…` : joined
    )
  }, PREVIEW_DEBOUNCE_MS)
}
