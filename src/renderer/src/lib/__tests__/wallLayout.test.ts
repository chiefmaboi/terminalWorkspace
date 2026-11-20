import { describe, expect, it } from 'vitest'
import {
  SCALE_FLOOR,
  SCALE_MAX,
  TILE_GAP_PX,
  TILE_HEADER_PX,
  WALL_PADDING_PX,
  computeWallLayout,
  gridHeight
} from '../wallLayout'
import type { WallGeometry } from '../wallLayout'

// A 1600x900 wall viewport: host = full viewport body, avail = minus padding and a 12px gutter.
function geometry(width: number, height: number): WallGeometry {
  return {
    hostWidth: width,
    hostHeight: height - TILE_HEADER_PX,
    availWidth: width - 2 * WALL_PADDING_PX - 12,
    availHeight: height - 2 * WALL_PADDING_PX
  }
}
const G = geometry(1600, 900)

function fitsWidth(cols: number, tileWidth: number, g: WallGeometry): boolean {
  return cols * tileWidth + (cols - 1) * TILE_GAP_PX <= g.availWidth
}

describe('computeWallLayout', () => {
  it('caps a lone tile at SCALE_MAX', () => {
    const l = computeWallLayout(1, 'auto', G)
    expect(l.scale).toBe(SCALE_MAX)
    expect(l.cols).toBe(1)
  })

  it('auto-fits 4 tiles as 2x2 with everything visible', () => {
    const l = computeWallLayout(4, 'auto', G)
    expect(l.cols).toBe(2)
    expect(l.scale).toBeLessThanOrEqual(SCALE_MAX)
    expect(l.scale).toBeGreaterThanOrEqual(SCALE_FLOOR)
    expect(fitsWidth(l.cols, l.tileWidth, G)).toBe(true)
    expect(gridHeight(4, l)).toBeLessThanOrEqual(G.availHeight)
  })

  it('auto-fits 6 tiles without scrolling, at least as large as the floor layout', () => {
    const l = computeWallLayout(6, 'auto', G)
    expect(l.scale).toBeGreaterThanOrEqual(computeWallLayout(6, '0.33', G).scale)
    expect(fitsWidth(l.cols, l.tileWidth, G)).toBe(true)
    expect(gridHeight(6, l)).toBeLessThanOrEqual(G.availHeight)
  })

  it('falls back to the floor and scrolls when everything cannot fit', () => {
    const l = computeWallLayout(12, 'auto', G)
    expect(l.cols).toBe(3)
    expect(l.scale).toBeLessThanOrEqual(SCALE_FLOOR)
    expect(fitsWidth(l.cols, l.tileWidth, G)).toBe(true)
    expect(gridHeight(12, l)).toBeGreaterThan(G.availHeight)
  })

  it.each([
    ['0.5', 2],
    ['0.4', 2],
    ['0.33', 3]
  ] as const)('fixed mode %s uses %i columns and never exceeds its target', (mode, cols) => {
    const l = computeWallLayout(8, mode, G)
    expect(l.cols).toBe(cols)
    expect(l.scale).toBeLessThanOrEqual(Number(mode))
    expect(fitsWidth(l.cols, l.tileWidth, G)).toBe(true)
  })

  it('never uses more columns than there are tiles', () => {
    expect(computeWallLayout(2, '0.33', G).cols).toBe(2)
    expect(computeWallLayout(0, 'auto', G).cols).toBe(1)
  })

  it('stays finite and positive on degenerate geometry', () => {
    const l = computeWallLayout(4, 'auto', geometry(10, 30))
    expect(Number.isFinite(l.scale)).toBe(true)
    expect(l.scale).toBeGreaterThan(0)
    expect(l.cols).toBeGreaterThanOrEqual(1)
  })
})
