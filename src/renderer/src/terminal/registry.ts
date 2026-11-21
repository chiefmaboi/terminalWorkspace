import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
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
/** Font size of the original layout (width option "fill"). */
export const BASE_FONT_SIZE = 13
/** Width option with a column count: the zoomed view's text size (Windows Terminal's default). */
export const COLUMNS_ZOOM_FONT_SIZE = 16
const FONT_FAMILY = 'Cascadia Code, Consolas, monospace'
let fontSize = BASE_FONT_SIZE


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
  /** Optional per-terminal key hook (e.g. Ctrl+F search while maximized). true = handled. */
  keyHook: ((event: KeyboardEvent) => boolean) | null
}

export interface RegistryCallbacks {
  /** Keyboard focus entered a terminal (selection follows focus). */
  onFocus: (id: string) => void
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
    fontFamily: FONT_FAMILY,
    fontSize,
    theme: xtermThemeFor(currentTheme)
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())

  const host = document.createElement('div')
  host.className = 'terminal-host'

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

/** Whether terminal `id` has the keyboard focus (you're typing into it). */
export function hasFocus(id: string): boolean {
  const entry = entries.get(id)
  return !!entry && entry.host.contains(document.activeElement)
}

/**
 * Hand a wheel event from over a tile to that tile's terminal, which then scrolls exactly as it
 * would zoomed (xterm's own wheel handling: its history, arrow keys on the alternate screen, or
 * a mouse event for programs that asked for them). The pointer position is mapped through the
 * tile's scale first: xterm divides the offset inside its on-screen (scaled) rect by unscaled
 * cell sizes, so the raw position would point at the wrong cell.
 */
export function forwardWheel(id: string, event: WheelEvent): boolean {
  const screen = entries.get(id)?.term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || screen.offsetWidth === 0 || screen.offsetHeight === 0) return false
  const rect = screen.getBoundingClientRect()
  const scaleX = rect.width / screen.offsetWidth
  const scaleY = rect.height / screen.offsetHeight
  screen.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      clientX: rect.left + (event.clientX - rect.left) / scaleX,
      clientY: rect.top + (event.clientY - rect.top) / scaleY,
      screenX: event.screenX,
      screenY: event.screenY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey
    })
  )
  return true
}

/**
 * Font size of every terminal (existing and future). Each terminal re-measures its cells; the
 * caller then refits (fitAll) so cols/rows and the PTYs follow.
 */
export function setFontSize(size: number): void {
  if (size === fontSize) return
  fontSize = size
  for (const entry of entries.values()) entry.term.options.fontSize = size
}

/** xterm's scrollbar width when it can't measure one (Viewport: `... || 15`). */
const XTERM_FALLBACK_SCROLLBAR_PX = 15
interface XtermCore {
  viewport?: { scrollBarWidth: number }
  _renderService: { dimensions: { css: { cell: { width: number } } } }
}

/**
 * A hidden terminal used only to measure cell widths at a given font size (same font and
 * padding as every real terminal). It lives as long as the app: a terminal disposed right after
 * a font change still has a redraw scheduled, which then throws on its torn-down renderer.
 *
 * Scrollbar: xterm measures each terminal's once, when it opens, falling back to 15px when it
 * can't (a host without layout yet), so terminals can carry slightly different values. Sizing
 * for the widest makes every one of them land on the intended column count: a narrower
 * scrollbar only adds a few px of slack, far less than a cell, never a column.
 */
let probe: { term: Terminal; core: XtermCore; padding: number; scrollbar: number } | null = null

function measuringProbe(): NonNullable<typeof probe> {
  if (probe) return probe
  const host = document.createElement('div')
  host.className = 'terminal-host'
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;height:300px;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  const term = new Terminal({ scrollback: SCROLLBACK_LINES, fontFamily: FONT_FAMILY, fontSize: BASE_FONT_SIZE, disableStdin: true })
  term.open(host)
  // Private API: the same values FitAddon itself reads.
  const core = (term as unknown as { _core: XtermCore })._core
  const style = window.getComputedStyle(term.element!)
  probe = {
    term,
    core,
    padding: parseInt(style.paddingLeft) + parseInt(style.paddingRight),
    scrollbar: Math.max(core.viewport?.scrollBarWidth ?? 0, XTERM_FALLBACK_SCROLLBAR_PX)
  }
  return probe
}

function cellWidthAt(size: number): number {
  const p = measuringProbe()
  p.term.options.fontSize = size
  return p.core._renderService.dimensions.css.cell.width
}

const measured = new Map<string, number>()
function cachedMeasure(key: string, compute: () => number | null): number | null {
  const full = `${window.devicePixelRatio}:${key}`
  const hit = measured.get(full)
  if (hit) return hit
  let value: number | null
  try {
    value = compute()
  } catch {
    value = null
  }
  if (value) measured.set(full, value)
  return value
}

/**
 * The largest font size at which `columns` columns fit a terminal host `hostWidth` px wide, or
 * null if they can't (tiny window). FitAddon's math: cols = floor((width - padding - scrollbar) / cell).
 */
export function fontSizeForColumns(columns: number, hostWidth: number): number | null {
  return cachedMeasure(`font:${columns}:${hostWidth}`, () => {
    const { padding, scrollbar } = measuringProbe()
    const available = hostWidth - padding - scrollbar
    const colsAt = (size: number): number => {
      const cell = cellWidthAt(size)
      return cell > 0 ? Math.floor(available / cell) : 0
    }
    // Fewer columns as the font grows: bisect for the largest size that still fits them all.
    let lo = 4
    let hi = 96
    if (colsAt(lo) < columns) return null
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (colsAt(mid) >= columns) lo = mid
      else hi = mid
    }
    return Math.floor(lo * 1000) / 1000
  })
}

/** The host width (px) that holds exactly `columns` columns at font size `size`. */
export function widthForColumns(columns: number, size: number): number | null {
  return cachedMeasure(`width:${columns}:${size}`, () => {
    const { padding, scrollbar } = measuringProbe()
    const cell = cellWidthAt(size)
    // +1: keeps floor() safely at `columns` despite rounding.
    return cell > 0 ? Math.ceil(columns * cell + padding + scrollbar) + 1 : null
  })
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

/**
 * Give terminal `id` keyboard focus without scrolling the wall: focusing an element normally
 * scrolls every scrollable ancestor to reveal it, which would yank a partly visible tile into
 * view on click. xterm's own focus() happens to do the same today; doing it here explicitly
 * keeps the guarantee independent of xterm internals.
 */
export function focus(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  const textarea = entry.term.textarea
  if (textarea) textarea.focus({ preventScroll: true })
  else entry.term.focus()
}

/** Is keyboard focus inside a terminal right now (terminal mode)? */
export function isTerminalFocused(): boolean {
  const el = document.activeElement
  return el instanceof HTMLElement && el.closest('.xterm') !== null
}

/** Leave terminal mode: take keyboard focus out of whichever terminal has it. */
export function blurTerminals(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && el.closest('.xterm')) el.blur()
}

/** Fresh process for a terminal whose PTY main just stopped (Restart in the tile menu). */
export function restart(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.exited = false
  entry.started = false
  entry.term.reset()
  ensureStarted(id)
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
