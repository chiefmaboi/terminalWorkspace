/**
 * Wall-mode keyboard navigation: which tile the highlight moves to for an arrow key.
 *
 * Works on the tiles' on-screen rectangles rather than grid indices, so it stays right with
 * pinned 2x2 tiles and dense packing, where a tile's index says little about its position.
 */

export type Direction = 'left' | 'right' | 'up' | 'down'

export interface TileRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

/** Reading order: top to bottom, then left to right. */
export function firstTile(rects: TileRect[]): string | null {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  return sorted[0]?.id ?? null
}

/**
 * The nearest tile in `direction` from `currentId`, judged from rectangle centers: distance
 * along the direction plus twice the sideways offset, so the tile straight ahead beats a
 * slightly closer one off to the side. No selection yet: the first tile in reading order. Nothing
 * in that direction: the current tile (the highlight stays put).
 */
export function nextTile(rects: TileRect[], currentId: string | null, direction: Direction): string | null {
  const current = rects.find((r) => r.id === currentId)
  if (!current) return firstTile(rects)
  const cx = current.left + current.width / 2
  const cy = current.top + current.height / 2

  let best: { id: string; score: number } | null = null
  for (const rect of rects) {
    if (rect.id === current.id) continue
    const dx = rect.left + rect.width / 2 - cx
    const dy = rect.top + rect.height / 2 - cy
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    if (along <= 1) continue
    const score = along + 2 * across
    if (!best || score < best.score) best = { id: rect.id, score }
  }
  return best?.id ?? current.id
}
