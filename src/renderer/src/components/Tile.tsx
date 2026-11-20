import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Terminal, TerminalStatus } from '../../../shared/types'
import * as terminals from '../terminal/registry'
import { useAppStore } from '../store/useAppStore'

interface Props {
  terminal: Terminal
  selected: boolean
  maximized: boolean
}

function statusDotClass(status: TerminalStatus): string {
  return `status-dot status-${status}`
}

/** Someone is typing in a text field that isn't a terminal: don't steal their focus. */
function typingElsewhere(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.classList.contains('xterm-helper-textarea')) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/**
 * One terminal on the wall. The terminal itself is always rendered at the shared full-size
 * geometry (--host-w × --host-h) and shown at --tile-scale; maximizing only drops the scale and
 * pins the tile over the wall, so the PTY never resizes and the agent's TUI never reflows.
 */
export default function Tile({ terminal, selected, maximized }: Props): React.JSX.Element {
  const id = terminal.id
  const hostRef = useRef<HTMLDivElement>(null)
  const status = useAppStore((s) => s.runtime[id]?.status ?? 'idle')
  const branch = useAppStore((s) => s.gitBranches[id])
  const focusTerminal = useAppStore((s) => s.focusTerminal)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Borrow the registry's terminal host while mounted; the terminal itself outlives this.
  useLayoutEffect(() => {
    const container = hostRef.current
    if (!container) return
    terminals.attach(id, container)
    // xterm finishes initializing its renderer on the frame after open(); fitting (or reading
    // cols/rows) synchronously before that can throw.
    const raf = requestAnimationFrame(() => {
      terminals.fit(id)
      terminals.ensureStarted(id)
    })
    return () => {
      cancelAnimationFrame(raf)
      terminals.detach(id, container)
    }
  }, [id])

  // WebGL only while maximized; tiles stay on the DOM renderer (browsers cap live WebGL
  // contexts at ~16, and a scaled-down tile gains nothing from the GPU path).
  useEffect(() => {
    terminals.setRenderer(id, maximized ? 'webgl' : 'dom')
    if (maximized) requestAnimationFrame(() => terminals.focus(id))
    else setSearchOpen(false)
  }, [id, maximized])

  // Ctrl+F searches the maximized terminal (in a tile it goes to the shell as usual).
  useEffect(() => {
    terminals.setKeyHook(
      id,
      maximized
        ? (event) => {
            if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
              setSearchOpen(true)
              return true
            }
            return false
          }
        : null
    )
    return () => terminals.setKeyHook(id, null)
  }, [id, maximized])

  // A selection made elsewhere (sidebar, toast, notification) also gets keyboard focus.
  useEffect(() => {
    if (selected && !typingElsewhere()) requestAnimationFrame(() => terminals.focus(id))
  }, [id, selected])

  const toggleMaximized = (): void => setMaximized(maximized ? null : id)

  const className = ['tile', selected ? 'tile-selected' : '', maximized ? 'tile-maximized' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} data-terminal-id={id} data-status={status}>
      <div
        className="tile-header"
        onClick={() => focusTerminal(id)}
        onDoubleClick={toggleMaximized}
        title={maximized ? 'Double-click or Ctrl+Shift+Enter to restore' : 'Double-click to maximize'}
      >
        <span className={statusDotClass(status)} />
        <span className="tile-title">{terminal.name}</span>
        {branch && <span className="tile-branch">⎇ {branch}</span>}
        <button
          className="tile-max-button"
          title={maximized ? 'Restore (Ctrl+Shift+Enter)' : 'Maximize (Ctrl+Shift+Enter)'}
          onClick={(e) => {
            e.stopPropagation()
            toggleMaximized()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
      </div>
      <div className="tile-body">
        <div className="tile-host" ref={hostRef} />
        {/* Tiles are display-only: xterm maps mouse coordinates through getBoundingClientRect,
            which the scale transform distorts, so clicks and selections inside a scaled tile
            would land on the wrong cells. The overlay takes the pointer instead. */}
        {!maximized && (
          <div
            className="tile-overlay"
            onClick={() => {
              focusTerminal(id)
              terminals.focus(id)
            }}
            onDoubleClick={() => setMaximized(id)}
          />
        )}
        {maximized && searchOpen && (
          <div className="tile-search">
            <input
              autoFocus
              value={query}
              placeholder="Search terminal…"
              onChange={(e) => {
                setQuery(e.target.value)
                terminals.searchAddon(id)?.findNext(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') terminals.searchAddon(id)?.findNext(query)
                if (e.key === 'Escape') {
                  // Close search only; don't let the wall's Esc handler restore the tile too.
                  e.stopPropagation()
                  setSearchOpen(false)
                  terminals.focus(id)
                }
              }}
            />
            <button onClick={() => terminals.searchAddon(id)?.findPrevious(query)}>Prev</button>
            <button onClick={() => terminals.searchAddon(id)?.findNext(query)}>Next</button>
            <button
              onClick={() => {
                setSearchOpen(false)
                terminals.focus(id)
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
