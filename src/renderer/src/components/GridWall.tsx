import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { TILE_SCALE_MODES } from '../../../shared/types'
import type { TileScaleMode, Workspace } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import * as terminals from '../terminal/registry'
import { TILE_GAP_PX, TILE_HEADER_PX, WALL_PADDING_PX, computeWallLayout } from '../lib/wallLayout'
import Tile from './Tile'

/** Window resizes are coalesced before the shared terminal size (and every PTY) changes. */
const RESIZE_DEBOUNCE_MS = 200

interface Props {
  workspace: Workspace
  /** Extra toolbar buttons rendered at the right end of the wall bar. */
  actions?: ReactNode
}

interface Measured {
  /** Wall viewport: also the maximized pane's size, hence the shared terminal geometry. */
  viewportWidth: number
  viewportHeight: number
  /** Scroll area inner size (scrollbar gutter excluded) available to the tile grid. */
  availWidth: number
  availHeight: number
}

function sameMeasure(a: Measured | null, b: Measured): boolean {
  return (
    !!a &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.availWidth === b.availWidth &&
    a.availHeight === b.availHeight
  )
}

/** The active workspace's terminals as a wall of scaled-down live tiles. */
export default function GridWall({ workspace, actions }: Props): React.JSX.Element {
  const tileScale = useAppStore((s) => s.settings.tileScale)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const maximizedTerminalId = useAppStore((s) => s.maximizedTerminalId)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const scroll = scrollRef.current
    if (!viewport || !scroll) return
    const measure = (): Measured => ({
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
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

  const hostWidth = measured?.viewportWidth ?? 0
  const hostHeight = Math.max(0, (measured?.viewportHeight ?? 0) - TILE_HEADER_PX)

  const layout = useMemo(
    () =>
      computeWallLayout(tiles.length, tileScale, {
        hostWidth: Math.max(1, hostWidth),
        hostHeight: Math.max(1, hostHeight),
        availWidth: measured?.availWidth ?? 1,
        availHeight: measured?.availHeight ?? 1
      }),
    [tiles.length, tileScale, hostWidth, hostHeight, measured]
  )

  // The shared geometry changed (debounced window resize): refit every terminal to the new
  // full size; registry.fit() resizes only the PTYs whose cols/rows actually changed.
  useLayoutEffect(() => {
    if (!hostWidth || !hostHeight) return
    const raf = requestAnimationFrame(() => terminals.fitAll())
    return () => cancelAnimationFrame(raf)
  }, [hostWidth, hostHeight])

  const vars = {
    '--host-w': `${hostWidth}px`,
    '--host-h': `${hostHeight}px`,
    '--tile-w': `${layout.tileWidth}px`,
    '--tile-body-h': `${layout.tileBodyHeight}px`,
    '--tile-scale': String(layout.scale)
  } as React.CSSProperties

  return (
    <div className="wall">
      <div className="wall-bar">
        <span className="wall-title">{workspace.name}</span>
        <span className="wall-meta">
          {tiles.length} terminal{tiles.length === 1 ? '' : 's'}
        </span>
        <label className="wall-scale" title="Tile scale (Auto fits the wall: max 0.5, floor 0.33)">
          Scale
          <select
            value={tileScale}
            onChange={(e) => updateAppSettings({ tileScale: e.target.value as TileScaleMode })}
          >
            {TILE_SCALE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'auto' ? 'Auto' : mode}
              </option>
            ))}
          </select>
          <span className="wall-scale-effective">×{layout.scale.toFixed(2)}</span>
        </label>
        {actions}
      </div>
      <div
        className={`wall-viewport${maximizedTerminalId ? ' has-maximized' : ''}`}
        ref={viewportRef}
        style={vars}
      >
        <div className="wall-scroll" ref={scrollRef}>
          {measured && (
            <div
              className="wall-grid"
              data-cols={layout.cols}
              data-scale={layout.scale.toFixed(3)}
              style={{
                gridTemplateColumns: `repeat(${layout.cols}, var(--tile-w))`,
                gap: `${TILE_GAP_PX}px`
              }}
            >
              {tiles.map((terminal) => (
                <Tile
                  key={terminal.id}
                  terminal={terminal}
                  selected={terminal.id === focusedTerminalId}
                  maximized={terminal.id === maximizedTerminalId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
