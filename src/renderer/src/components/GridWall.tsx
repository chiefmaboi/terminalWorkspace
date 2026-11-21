import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import * as terminals from '../terminal/registry'
import {
  TILE_GAP_PX,
  TILE_HEADER_PX,
  WALL_PADDING_PX,
  computePinnedLayout,
  zoomRect
} from '../lib/wallLayout'
import { nextTile } from '../lib/wallNav'
import type { Direction, TileRect } from '../lib/wallNav'
import Tile from './Tile'

/** Window resizes are coalesced before the shared terminal size (and every PTY) changes. */
const RESIZE_DEBOUNCE_MS = 200
/** A press has to travel this far before it becomes a drag, so click / double-click still work. */
export const DRAG_THRESHOLD_PX = 5

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

interface Props {
  workspace: Workspace
}

interface Measured {
  /** Wall viewport size and where it sits in the window (below the top bar). */
  viewportWidth: number
  viewportHeight: number
  viewportTop: number
  windowWidth: number
  windowHeight: number
  /** Scroll area inner size (scrollbar gutter excluded) available to the tile grid. */
  availWidth: number
  availHeight: number
}

function sameMeasure(a: Measured | null, b: Measured): boolean {
  return !!a && (Object.keys(b) as Array<keyof Measured>).every((k) => a[k] === b[k])
}

interface DragState {
  id: string
  pointerId: number
  startX: number
  startY: number
  active: boolean
  tile: HTMLElement
  targetId: string | null
}

/**
 * The active workspace's terminals as a wall of scaled-down live tiles.
 *
 * Keyboard model: in WALL MODE (no terminal focused) arrow keys move the highlight between
 * tiles and Enter zooms the highlighted one and focuses its terminal (TERMINAL MODE, where every
 * key goes to the terminal). Clicking empty wall space or the dim behind a zoomed pane returns
 * to wall mode; App handles Ctrl+Shift+Enter and Esc.
 */
export default function GridWall({ workspace }: Props): React.JSX.Element {
  const tileScale = useAppStore((s) => s.settings.tileScale)
  const terminalWidth = useAppStore((s) => s.settings.terminalWidth)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const zoomedTerminalId = useAppStore((s) => s.maximizedTerminalId)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const reorderTerminals = useAppStore((s) => s.reorderTerminals)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<{ id: string; targetId: string | null } | null>(null)
  const suppressClickRef = useRef(false)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const scroll = scrollRef.current
    if (!viewport || !scroll) return
    const measure = (): Measured => ({
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      viewportTop: Math.round(viewport.getBoundingClientRect().top),
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      availWidth: scroll.clientWidth - 2 * WALL_PADDING_PX,
      availHeight: scroll.clientHeight - 2 * WALL_PADDING_PX
    })
    const apply = (): void => {
      const next = measure()
      setMeasured((prev) => (sameMeasure(prev, next) ? prev : next))
    }
    apply() // first measurement is immediate so tiles mount at the right size
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(apply, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(viewport)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  const tiles = useMemo(() => [...workspace.terminals].sort((a, b) => a.order - b.order), [workspace.terminals])
  const pinnedCount = tiles.filter((t) => t.pinned).length

  // Shared terminal geometry = the zoomed pane's body (88% of the window). Every terminal always
  // has exactly these cols/rows, tiled, pinned or zoomed, so none of those ever resizes a PTY.
  const zoom = measured
    ? zoomRect(
        measured.viewportWidth,
        measured.viewportHeight,
        measured.windowWidth,
        measured.windowHeight,
        measured.viewportTop
      )
    : { left: 0, top: 0, width: 0, height: 0 }
  const hostWidth = measured ? zoom.width : 0
  const hostHeight = measured ? zoom.height - TILE_HEADER_PX : 0

  const layout = useMemo(
    () =>
      computePinnedLayout(tiles.length, pinnedCount, tileScale, {
        hostWidth: Math.max(1, hostWidth),
        hostHeight: Math.max(1, hostHeight),
        availWidth: measured?.availWidth ?? 1,
        availHeight: measured?.availHeight ?? 1
      }),
    [tiles.length, pinnedCount, tileScale, hostWidth, hostHeight, measured]
  )


  // Terminal width option. 'fill' (the original layout): the base font, as many columns as fit.
  // A column count: the font size that makes exactly that many columns fill the same width, so
  // the wall and the zoomed pane keep their size and tiles just show bigger text. Applied during
  // render (idempotent) so terminals the tiles create in their effects, which run before this
  // component's, already get it.
  const fontSize = useMemo(() => {
    if (terminalWidth === 'fill' || !hostWidth) return terminals.BASE_FONT_SIZE
    return terminals.fontSizeForColumns(Number(terminalWidth), hostWidth) ?? terminals.BASE_FONT_SIZE
  }, [terminalWidth, hostWidth])
  terminals.setFontSize(fontSize)

  // The shared geometry or the font changed (debounced window resize, width option): refit
  // every terminal; registry.fit() resizes only the PTYs whose cols/rows actually changed.
  useLayoutEffect(() => {
    if (!hostWidth || !hostHeight) return
    const raf = requestAnimationFrame(() => terminals.fitAll())
    return () => cancelAnimationFrame(raf)
  }, [hostWidth, hostHeight, fontSize])

  // ── Drag to reorder ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const end = (commit: boolean, e: PointerEvent): void => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      dragRef.current = null
      if (!d.active) return // never crossed the threshold: an ordinary click / double-click
      d.tile.style.transform = ''
      d.tile.style.pointerEvents = ''
      setDrag(null)
      // The click that follows this pointerup belongs to the drag, not to whatever it ended on.
      suppressClickRef.current = true
      setTimeout(() => (suppressClickRef.current = false), 0)
      if (!commit || !d.targetId) return
      const order = tiles.map((t) => t.id)
      const from = order.indexOf(d.id)
      const to = order.indexOf(d.targetId)
      if (from < 0 || to < 0 || from === to) return
      order.splice(from, 1)
      order.splice(to, 0, d.id) // the dragged tile takes the target's place
      reorderTerminals(workspace.id, order)
    }
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (!d.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        d.active = true
        // Let elementFromPoint see through the dragged tile to the slot underneath.
        d.tile.style.pointerEvents = 'none'
      }
      d.tile.style.transform = `translate(${dx}px, ${dy}px)`
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.tile-slot')
      const targetId = under?.dataset.terminalId && under.dataset.terminalId !== d.id ? under.dataset.terminalId : null
      d.targetId = targetId
      setDrag((prev) => (prev && prev.id === d.id && prev.targetId === targetId ? prev : { id: d.id, targetId }))
    }
    const onUp = (e: PointerEvent): void => end(true, e)
    const onCancel = (e: PointerEvent): void => end(false, e)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [tiles, workspace.id, reorderTerminals])

  function onGridPointerDown(e: React.PointerEvent): void {
    if (e.button !== 0 || zoomedTerminalId) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, .tile-menu')) return
    if (!target.closest('.tile-overlay, .tile-header')) return
    const slot = target.closest<HTMLElement>('.tile-slot')
    const tile = slot?.querySelector<HTMLElement>('.tile')
    const id = slot?.dataset.terminalId
    if (!id || !tile) return
    // A press on a tile must never become a text selection: a quick second press counts as a
    // double-click, which word-selects whatever terminal text sits behind the overlay, and
    // moving with a selection under the pointer starts the browser's native drag-and-drop,
    // which cancels this pointer stream mid-drag.
    window.getSelection()?.removeAllRanges()
    dragRef.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, tile, targetId: null }
  }

  // ── Wall-mode keyboard: arrows move the highlight, Enter zooms + focuses ────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return
      if (terminals.isTerminalFocused()) return // terminal mode: keys belong to the terminal
      const t = e.target
      if (t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return
      if (document.querySelector('.modal-overlay, .ws-menu, .tile-menu, .palette')) return
      const state = useAppStore.getState()
      const inWall = (id: string | null): id is string => !!id && tiles.some((tile) => tile.id === id)
      const direction = ARROWS[e.key]
      if (direction) {
        e.preventDefault()
        if (state.maximizedTerminalId) return
        const slots = [...(viewportRef.current?.querySelectorAll<HTMLElement>('.tile-slot[data-terminal-id]') ?? [])]
        const rects: TileRect[] = slots.map((el) => {
          const r = el.getBoundingClientRect()
          return { id: el.dataset.terminalId as string, left: r.left, top: r.top, width: r.width, height: r.height }
        })
        const current = inWall(state.focusedTerminalId) ? state.focusedTerminalId : null
        const next = nextTile(rects, current, direction)
        if (next) {
          state.focusTerminal(next)
          slots.find((el) => el.dataset.terminalId === next)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (inWall(state.maximizedTerminalId)) terminals.focus(state.maximizedTerminalId)
        else if (inWall(state.focusedTerminalId)) state.setMaximized(state.focusedTerminalId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tiles])

  const vars = {
    '--host-w': `${hostWidth}px`,
    '--host-h': `${hostHeight}px`,
    '--tile-w': `${layout.tileWidth}px`,
    '--tile-body-h': `${layout.tileBodyHeight}px`,
    '--tile-scale': String(layout.scale),
    '--zoom-left': `${zoom.left}px`,
    '--zoom-top': `${zoom.top}px`,
    '--zoom-w': `${zoom.width}px`,
    '--zoom-h': `${zoom.height}px`
  } as React.CSSProperties

  const pinnedSlotStyle = {
    gridColumn: `span ${layout.pinSpan}`,
    gridRow: `span ${layout.pinSpan}`,
    '--slot-w': `${layout.pinnedWidth}px`,
    '--slot-h': `${layout.pinnedBodyHeight + TILE_HEADER_PX}px`,
    '--slot-scale': String(layout.pinnedScale)
  } as React.CSSProperties

  return (
    <div
      className={`wall-viewport${zoomedTerminalId ? ' has-zoomed' : ''}${drag ? ' is-dragging' : ''}`}
      ref={viewportRef}
      style={vars}
      onClickCapture={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          e.stopPropagation()
          e.preventDefault()
        }
      }}
    >
      <div
        className="wall-scroll"
        ref={scrollRef}
        onClick={(e) => {
          // Empty wall space (padding, gaps, below the last row): deselect, wall mode.
          if ((e.target as HTMLElement).closest('.tile-slot')) return
          clearSelection()
          terminals.blurTerminals()
        }}
      >
        {measured && (
          <div
            className="wall-grid"
            data-cols={layout.cols}
            data-scale={layout.scale.toFixed(3)}
            onPointerDown={onGridPointerDown}
            // No native drag-and-drop on the wall (it would steal the pointer from drag-reorder).
            // The zoomed pane is exempt: xterm does its own selection there.
            onDragStart={(e) => {
              if (!(e.target as HTMLElement).closest('.tile-zoomed')) e.preventDefault()
            }}
            style={{
              gridTemplateColumns: `repeat(${layout.cols}, var(--tile-w))`,
              gridAutoRows: `calc(var(--tile-body-h) + ${TILE_HEADER_PX}px)`,
              // Dense packing: small tiles backfill the holes a 2x2 pinned tile would leave.
              // Arrow navigation is geometric, so visual order differing from DOM order is fine.
              gridAutoFlow: 'row dense',
              gap: `${TILE_GAP_PX}px`
            }}
          >
            {tiles.map((terminal) => (
              <Tile
                key={terminal.id}
                terminal={terminal}
                selected={terminal.id === focusedTerminalId}
                zoomed={terminal.id === zoomedTerminalId}
                slotStyle={terminal.pinned ? pinnedSlotStyle : undefined}
                dragging={drag?.id === terminal.id}
                dropTarget={drag?.targetId === terminal.id}
              />
            ))}
          </div>
        )}
      </div>
      {/* Dims the live wall behind the zoomed pane (no blur: re-blurring constantly updating
          tiles every frame is expensive). Clicking it restores and returns to wall mode. Tile
          status rings stack above it; the zoomed pane above those. */}
      <div
        className={`wall-dim${zoomedTerminalId ? ' visible' : ''}`}
        onClick={() => {
          setMaximized(null)
          terminals.blurTerminals()
        }}
        aria-hidden="true"
      />
    </div>
  )
}
