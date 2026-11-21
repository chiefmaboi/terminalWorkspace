import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Terminal, TerminalStatus } from '../../../shared/types'
import * as terminals from '../terminal/registry'
import { useAppStore } from '../store/useAppStore'
import { useTileActions } from './tileActions'
import { PinIcon } from './icons'

interface Props {
  terminal: Terminal
  /** Highlighted on the wall (wall mode) / the tile keyboard focus belongs to (terminal mode). */
  selected: boolean
  /** This tile is the zoomed pane (store: maximizedTerminalId). */
  zoomed: boolean
  /** Grid placement and size overrides for a pinned (2x2) tile. */
  slotStyle?: React.CSSProperties
  /** Being dragged / hovered as the drop target during a drag-reorder. */
  dragging: boolean
  dropTarget: boolean
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

/** The ⋯ menu: rename / restart / delete, the per-terminal actions the sidebar used to hold. */
function TileMenu({ terminal, onClose }: { terminal: Terminal; onClose: () => void }): React.JSX.Element {
  const actions = useTileActions()
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  const run = (fn?: (t: Terminal) => void): void => {
    onClose()
    fn?.(terminal)
  }
  return (
    <div className="tile-menu" ref={rootRef} role="menu" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => run(actions?.rename)}>Rename…</button>
      <button onClick={() => run(actions?.restart)}>Restart</button>
      <button className="danger-item" onClick={() => run(actions?.remove)}>
        Delete…
      </button>
    </div>
  )
}

/**
 * One terminal on the wall. The terminal always renders at the shared geometry (--host-w ×
 * --host-h, the zoomed pane's body) and is shown at the tile's scale. Zooming lifts the tile out
 * of its grid slot (which keeps its place) into a pane floating over the dimmed wall at scale 1,
 * so the PTY never resizes and the agent's TUI never reflows.
 *
 * Pointer handling for drag-to-reorder lives in GridWall; tiles only expose data-terminal-id.
 */
export default function Tile({ terminal, selected, zoomed, slotStyle, dragging, dropTarget }: Props): React.JSX.Element {
  const id = terminal.id
  const slotRef = useRef<HTMLDivElement>(null)
  const tileRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<Animation | null>(null)
  const status = useAppStore((s) => s.runtime[id]?.status ?? 'idle')
  const branch = useAppStore((s) => s.gitBranches[id])
  const focusTerminal = useAppStore((s) => s.focusTerminal)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const togglePinned = useAppStore((s) => s.togglePinned)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const pinned = terminal.pinned === true

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

  // The wheel over the tile you're typing into scrolls its terminal, as it would zoomed. Over
  // any other tile it scrolls the wall. Native listener: React registers wheel handlers as
  // passive, which can't stop the wall from scrolling too.
  const overlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const onWheel = (event: WheelEvent): void => {
      if (terminals.hasFocus(id) && terminals.forwardWheel(id, event)) event.preventDefault()
    }
    overlay.addEventListener('wheel', onWheel, { passive: false })
    return () => overlay.removeEventListener('wheel', onWheel)
  }, [id, zoomedLayout])

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

  // Zooming hands the terminal keyboard focus (terminal mode); restoring closes its search bar.
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

  const toggleZoom = (): void => setMaximized(zoomed ? null : id)

  const slotClassName = ['tile-slot', pinned ? 'tile-pinned' : '', dropTarget ? 'drop-target' : '']
    .filter(Boolean)
    .join(' ')
  const className = [
    'tile',
    selected ? 'tile-selected' : '',
    zoomedLayout ? 'tile-zoomed' : '',
    dragging ? 'tile-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={slotClassName} ref={slotRef} style={slotStyle} data-terminal-id={id}>
      <div
        className={className}
        ref={tileRef}
        data-terminal-id={id}
        data-status={status}
        onContextMenu={(e) => {
          // Right-click pins/unpins (2x2 on the wall). Inside a zoomed pane the terminal keeps
          // the browser's default context menu (copy/paste).
          if (zoomedLayout) return
          e.preventDefault()
          togglePinned(id)
        }}
      >
        {/* Status/selection ring as its own layer: it stacks above the wall's dim overlay, so
            background tiles' states stay readable while another pane is zoomed. */}
        <div className="tile-ring" />
        <div
          className="tile-header"
          onClick={() => focusTerminal(id)}
          onDoubleClick={toggleZoom}
          title={zoomed ? 'Double-click or Ctrl+Shift+Enter to restore' : 'Double-click to zoom, drag to reorder'}
        >
          <span className={statusDotClass(status)} />
          <span className="tile-title">{terminal.name}</span>
          {branch && <span className="tile-branch">⎇ {branch}</span>}
          <button
            className={`tile-icon-button tile-pin${pinned ? ' active' : ''}`}
            title={pinned ? 'Unpin (right-click)' : 'Pin 2x2 (right-click)'}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation()
              togglePinned(id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <PinIcon />
          </button>
          <button
            className="tile-icon-button tile-menu-button"
            title="Terminal actions"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((o) => !o)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⋯
          </button>
          <button
            className="tile-icon-button tile-max-button"
            title={zoomed ? 'Restore (Ctrl+Shift+Enter)' : 'Zoom (Enter in wall mode)'}
            onClick={(e) => {
              e.stopPropagation()
              toggleZoom()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {zoomed ? '⤡' : '⤢'}
          </button>
          {menuOpen && <TileMenu terminal={terminal} onClose={() => setMenuOpen(false)} />}
        </div>
        <div className="tile-body">
          <div className="tile-host" ref={hostRef} />
          {/* Tiles are display-only: xterm maps mouse coordinates through getBoundingClientRect,
              which the scale transform distorts, so clicks and selections inside a scaled tile
              would land on the wrong cells. The overlay takes the pointer instead. */}
          {!zoomedLayout && (
            <div
              ref={overlayRef}
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
