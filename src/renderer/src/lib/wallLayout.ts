import type { TileScaleMode } from '../../../shared/types'

/** Upper bound on the tile scale: tiles never render larger than half size. */
export const SCALE_MAX = 0.5
/** Below this the text is unreadable; the wall scrolls instead of shrinking further. */
export const SCALE_FLOOR = 0.33
export const TILE_GAP_PX = 10
export const WALL_PADDING_PX = 10
/** Tile header bar (title, status, branch). Not scaled, so it stays readable at any scale. */
export const TILE_HEADER_PX = 26
/** The zoomed pane floats centered over the wall at this fraction of the wall's width/height. */
export const ZOOM_FRACTION = 0.88

export interface ZoomRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the zoomed pane sits inside a wall viewport of the given size: ZOOM_FRACTION of each
 * dimension, centered, in whole pixels. The zoomed pane's body (this minus the header) is also
 * the shared terminal geometry, so zooming in or out never changes any terminal's cols/rows.
 */
export function zoomRect(viewportWidth: number, viewportHeight: number): ZoomRect {
  const width = Math.max(1, Math.round(viewportWidth * ZOOM_FRACTION))
  const height = Math.max(TILE_HEADER_PX + 1, Math.round(viewportHeight * ZOOM_FRACTION))
  return {
    left: Math.floor((viewportWidth - width) / 2),
    top: Math.floor((viewportHeight - height) / 2),
    width,
    height
  }
}

export interface WallLayout {
  cols: number
  /** Effective CSS scale applied to every tile's full-size terminal host. */
  scale: number
  /** Visual tile width in px (host width × scale). */
  tileWidth: number
  /** Visual height of the scaled terminal body in px, excluding the header. */
  tileBodyHeight: number
}

export interface WallGeometry {
  /** Full-size terminal body (exactly what the zoomed pane shows). Shared by every terminal. */
  hostWidth: number
  hostHeight: number
  /** Space the grid of tiles can occupy without scrolling (wall minus padding and scrollbar). */
  availWidth: number
  availHeight: number
}

const EPSILON = 1e-9

/** Largest scale at which `cols` tiles fit side by side. */
function widthScale(cols: number, g: WallGeometry): number {
  return (g.availWidth - (cols - 1) * TILE_GAP_PX) / (cols * g.hostWidth)
}

/** Largest scale at which `rows` rows of tiles (headers included) fit without scrolling. */
function heightScale(rows: number, g: WallGeometry): number {
  return (g.availHeight - (rows - 1) * TILE_GAP_PX - rows * TILE_HEADER_PX) / (rows * g.hostHeight)
}

/**
 * Fixed target scale: use as many columns as the target allows (1/target, so 0.5 → 2,
 * 0.4 → 2, 0.33 → 3), then cap the scale so that many columns actually fit once gaps and
 * padding are taken out. Rows that don't fit vertically scroll.
 */
function fixedLayout(target: number, g: WallGeometry): { cols: number; scale: number } {
  const cols = Math.max(1, Math.floor(1 / target + EPSILON))
  return { cols, scale: Math.min(target, widthScale(cols, g)) }
}

/**
 * Lay out `count` tiles. 'auto' picks the column count that gives the largest scale with every
 * tile visible, capped at SCALE_MAX; if even the best arrangement is smaller than the floor
 * layout (SCALE_FLOOR's column count, width-capped for gaps), it uses the floor layout and the
 * wall scrolls. A numeric mode is a fixed target scale.
 */
export function computeWallLayout(count: number, mode: TileScaleMode, g: WallGeometry): WallLayout {
  const n = Math.max(1, count)
  let cols: number
  let scale: number

  if (mode === 'auto') {
    let best = { cols: 1, scale: -Infinity }
    for (let c = 1; c <= n; c++) {
      const s = Math.min(widthScale(c, g), heightScale(Math.ceil(n / c), g))
      if (s > best.scale + EPSILON) best = { cols: c, scale: s }
    }
    // Compare against the floor layout's effective scale, not SCALE_FLOOR itself: gaps and
    // padding mean 3 columns can never quite reach 0.33, so the raw constant would reject
    // arrangements that are exactly as large as the fallback.
    const floor = fixedLayout(SCALE_FLOOR, g)
    if (best.scale + EPSILON >= floor.scale) {
      cols = best.cols
      scale = Math.min(best.scale, SCALE_MAX)
    } else {
      ;({ cols, scale } = floor)
    }
  } else {
    ;({ cols, scale } = fixedLayout(Number(mode), g))
  }

  // Degenerate geometry (window minimized to nothing): keep values finite and positive.
  scale = Number.isFinite(scale) && scale > 0 ? scale : 0.01
  cols = Math.min(cols, n)
  return {
    cols,
    scale,
    tileWidth: Math.floor(g.hostWidth * scale),
    tileBodyHeight: Math.floor(g.hostHeight * scale)
  }
}

/** Total grid height for `count` tiles under `layout` (used to decide whether the wall scrolls). */
export function gridHeight(count: number, layout: WallLayout): number {
  const rows = Math.ceil(Math.max(1, count) / layout.cols)
  return rows * (layout.tileBodyHeight + TILE_HEADER_PX) + (rows - 1) * TILE_GAP_PX
}
