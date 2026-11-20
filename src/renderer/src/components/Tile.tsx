import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Terminal, TerminalStatus } from '../../../shared/types'
import * as terminals from '../terminal/registry'
import { useAppStore } from '../store/useAppStore'

interface Props {
  terminal: Terminal
  selected: boolean
  /** This tile is the zoomed pane (store: maximizedTerminalId). */
  zoomed: boolean
}

const ZOOM_MS = 180
const ZOOM_EASING = 'ease-out'

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Transform that makes an element laid out at `to` appear exactly at `from` (FLIP "invert"). */
function invert(from: DOMRect, to: DOMRect): string {
  return (
    `translate(${from.left - to.left}px, ${from.top - to.top}px) ` +
    `scale(${from.width / to.width}, ${from.height / to.height})`
  )
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
 * One terminal on the wall. The terminal always renders at the shared geometry (--host-w ×
 * --host-h, the zoomed pane's body) and is shown at --tile-scale. Zooming lifts the tile out of
 * its grid slot (which keeps its place) into a pane floating over the dimmed wall at scale 1, so
 * the PTY never resizes and the agent's TUI never reflows.
 */
export default function Tile({ terminal, selected, zoomed }: Props): React.JSX.Element {
  const id = terminal.id
  const slotRef = useRef<HTMLDivElement>(null)
  const tileRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<Animation | null>(null)
  const status = useAppStore((s) => s.runtime[id]?.status ?? 'idle')
  const branch = useAppStore((s) => s.gitBranches[id])
  const focusTerminal = useAppStore((s) => s.focusTerminal)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Restoring animates the pane back into its slot BEFORE it leaves the zoomed layout, so it
  // must stay zoomed in the DOM for the animation's duration even though the store already
  // says restored. Derived during render (not in an effect) so the very first restored commit
  // is still the zoomed layout and there's no one-frame jump.
  const [closing, setClosing] = useState(false)
  const [prevZoomed, setPrevZoomed] = useState(zoomed)
  if (prevZoomed !== zoomed) {
    setPrevZoomed(zoomed)
    setClosing(!zoomed && !prefersReducedMotion())
  }
  const zoomedLayout = zoomed || closing

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

  // FLIP between the grid slot and the floating pane. Only transform is animated, so it stays
  // on the compositor; the terminal content itself never re-lays out during the animation.
  const lastZoomed = useRef(zoomed)
  useLayoutEffect(() => {
    if (lastZoomed.current === zoomed) return
    lastZoomed.current = zoomed
    const tile = tileRef.current
    const slot = slotRef.current
    animationRef.current?.cancel()
    animationRef.current = null
    if (!tile || !slot || prefersReducedMotion()) return

    // The slot keeps the tile's grid cell at all times, so its rect is where the tile sits
    // un-zoomed; the tile's own rect (zoomed layout in both directions here) is the pane.
    const fromSlot = invert(slot.getBoundingClientRect(), tile.getBoundingClientRect())
    if (zoomed) {
      animationRef.current = tile.animate([{ transform: fromSlot }, { transform: 'none' }], {
        duration: ZOOM_MS,
        easing: ZOOM_EASING
      })
    } else {
      const animation = tile.animate([{ transform: 'none' }, { transform: fromSlot }], {
        duration: ZOOM_MS,
        easing: ZOOM_EASING,
        fill: 'forwards' // hold the slot-sized end frame until the grid layout is committed
      })
      animation.onfinish = () => {
        flushSync(() => setClosing(false))
        animation.cancel()
        if (animationRef.current === animation) animationRef.current = null
      }
      animationRef.current = animation
    }
  }, [zoomed])

  useEffect(() => () => animationRef.current?.cancel(), [])

  // Zooming hands the terminal keyboard focus; restoring closes its search bar.
  useEffect(() => {
    if (zoomed) requestAnimationFrame(() => terminals.focus(id))
    else setSearchOpen(false)
  }, [id, zoomed])

  // Ctrl+F searches the zoomed terminal (in a tile it goes to the shell as usual).
  useEffect(() => {
    terminals.setKeyHook(
      id,
      zoomed
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
  }, [id, zoomed])

  // A selection made elsewhere (sidebar, toast, notification) also gets keyboard focus.
  useEffect(() => {
    if (selected && !typingElsewhere()) requestAnimationFrame(() => terminals.focus(id))
  }, [id, selected])

  const toggleZoom = (): void => setMaximized(zoomed ? null : id)

  const className = ['tile', selected ? 'tile-selected' : '', zoomedLayout ? 'tile-zoomed' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className="tile-slot" ref={slotRef}>
      <div className={className} ref={tileRef} data-terminal-id={id} data-status={status}>
        {/* Status/selection ring as its own layer: it stacks above the wall's dim overlay, so
            background tiles' states stay readable while another pane is zoomed. */}
        <div className="tile-ring" />
        <div
          className="tile-header"
          onClick={() => focusTerminal(id)}
          onDoubleClick={toggleZoom}
          title={zoomed ? 'Double-click or Ctrl+Shift+Enter to restore' : 'Double-click to zoom'}
        >
          <span className={statusDotClass(status)} />
          <span className="tile-title">{terminal.name}</span>
          {branch && <span className="tile-branch">⎇ {branch}</span>}
          <button
            className="tile-max-button"
            title={zoomed ? 'Restore (Ctrl+Shift+Enter)' : 'Zoom (Ctrl+Shift+Enter)'}
            onClick={(e) => {
              e.stopPropagation()
              toggleZoom()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {zoomed ? '⤡' : '⤢'}
          </button>
        </div>
        <div className="tile-body">
          <div className="tile-host" ref={hostRef} />
          {/* Tiles are display-only: xterm maps mouse coordinates through getBoundingClientRect,
              which the scale transform distorts, so clicks and selections inside a scaled tile
              would land on the wrong cells. The overlay takes the pointer instead. */}
          {!zoomedLayout && (
            <div
              className="tile-overlay"
              onClick={() => {
                focusTerminal(id)
                terminals.focus(id)
              }}
              onDoubleClick={() => setMaximized(id)}
            />
          )}
          {zoomed && searchOpen && (
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
                    // Close search only; don't let the wall's Esc handler restore the pane too.
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
    </div>
  )
}
