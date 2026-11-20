import { describe, expect, it } from 'vitest'
import { firstTile, nextTile } from '../wallNav'
import type { TileRect } from '../wallNav'

const tile = (id: string, col: number, row: number, span = 1): TileRect => ({
  id,
  left: col * 110,
  top: row * 110,
  width: span * 100 + (span - 1) * 10,
  height: span * 100 + (span - 1) * 10
})

// A B
// C D
const grid = [tile('A', 0, 0), tile('B', 1, 0), tile('C', 0, 1), tile('D', 1, 1)]

describe('nextTile', () => {
  it('starts at the first tile in reading order when nothing is highlighted', () => {
    expect(nextTile(grid, null, 'right')).toBe('A')
    expect(firstTile([tile('Z', 1, 1), tile('Y', 0, 1), tile('X', 1, 0)])).toBe('X')
  })

  it('moves to the neighbour in each direction', () => {
    expect(nextTile(grid, 'A', 'right')).toBe('B')
    expect(nextTile(grid, 'A', 'down')).toBe('C')
    expect(nextTile(grid, 'D', 'left')).toBe('C')
    expect(nextTile(grid, 'D', 'up')).toBe('B')
  })

  it('stays put at the edge of the wall', () => {
    expect(nextTile(grid, 'A', 'left')).toBe('A')
    expect(nextTile(grid, 'A', 'up')).toBe('A')
  })

  it('prefers the tile straight ahead over a closer one off to the side', () => {
    // P is a pinned 2x2 at the left; Q and R are stacked to its right.
    const rects = [tile('P', 0, 0, 2), tile('Q', 2, 0), tile('R', 2, 1), tile('S', 0, 2)]
    expect(nextTile(rects, 'Q', 'left')).toBe('P')
    expect(nextTile(rects, 'R', 'left')).toBe('P')
    expect(nextTile(rects, 'P', 'down')).toBe('S')
    expect(nextTile(rects, 'S', 'up')).toBe('P')
  })
})
