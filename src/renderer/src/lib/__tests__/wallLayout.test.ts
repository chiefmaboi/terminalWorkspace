import { describe, expect, it } from 'vitest'
import {
  SCALE_FLOOR,
  SCALE_MAX,
  TILE_GAP_PX,
  TILE_HEADER_PX,
  WALL_PADDING_PX,
  ZOOM_FRACTION,
  computePinnedLayout,
  computeWallLayout,
  gridHeight,
  zoomRect
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

describe('zoomRect', () => {
  it('is ZOOM_FRACTION of the wall, centered, in whole pixels', () => {
    const r = zoomRect(1640, 1004)
    expect(r.width).toBe(Math.round(1640 * ZOOM_FRACTION))
    expect(r.height).toBe(Math.round(1004 * ZOOM_FRACTION))
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true)
    // Centered to within a pixel on both axes.
    expect(Math.abs(r.left - (1640 - r.left - r.width))).toBeLessThanOrEqual(1)
    expect(Math.abs(r.top - (1004 - r.top - r.height))).toBeLessThanOrEqual(1)
  })

  it('is 88% of the window, centered on the window, kept inside the viewport', () => {
    // 1600x950 window, wall viewport below a 40px top bar.
    const r = zoomRect(1600, 910, 1600, 950, 40)
    expect(r.width).toBe(Math.round(1600 * ZOOM_FRACTION))
    expect(r.height).toBe(Math.round(950 * ZOOM_FRACTION))
    // Window-centered: equal gaps above and below in window coordinates.
    const topInWindow = r.top + 40
    expect(Math.abs(topInWindow - (950 - topInWindow - r.height))).toBeLessThanOrEqual(1)
    // A short window can't push the pane under the top bar or past the bottom.
    const short = zoomRect(800, 260, 800, 300, 40)
    expect(short.top).toBeGreaterThanOrEqual(0)
    expect(short.top + short.height).toBeLessThanOrEqual(260)
  })

  it('takes an explicit size (the column width option), still window-centered and clamped', () => {
    const r = zoomRect(1600, 910, 1600, 950, 40, { width: 1000, height: 600 })
    expect(r).toEqual({ left: 300, top: Math.floor((950 - 600) / 2) - 40, width: 1000, height: 600 })
    const tooBig = zoomRect(1600, 910, 1600, 950, 40, { width: 2000, height: 1200 })
    expect(tooBig.width).toBe(1600)
    expect(tooBig.height).toBe(910)
  })

  it('always leaves room for the header plus at least one body pixel', () => {
    const r = zoomRect(0, 0)
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThan(TILE_HEADER_PX)
  })
})

describe('computePinnedLayout', () => {
  it('fits a pinned tile as four cells spanning 2x2, filling its box at a larger scale', () => {
    const l = computePinnedLayout(4, 1, 'auto', G)
    expect(l.pinSpan).toBe(2)
    expect(l.pinnedWidth).toBe(2 * l.tileWidth + TILE_GAP_PX)
    expect(l.pinnedScale).toBeGreaterThan(l.scale)
    expect(l.pinnedScale).toBeLessThanOrEqual(1)
    // Same terminal geometry: the scaled host never overflows the pinned box.
    expect(G.hostWidth * l.pinnedScale).toBeLessThanOrEqual(l.pinnedWidth + 0.5)
    expect(G.hostHeight * l.pinnedScale).toBeLessThanOrEqual(l.pinnedBodyHeight + 0.5)
  })

  it('falls back to span 1 when the grid has a single column', () => {
    const narrow = { hostWidth: 1000, hostHeight: 800, availWidth: 600, availHeight: 3000 }
    const l = computePinnedLayout(3, 1, 'auto', narrow)
    expect(l.cols).toBe(1)
    expect(l.pinSpan).toBe(1)
    expect(l.pinnedScale).toBeCloseTo(l.scale, 2)
  })

  it('without pins is the plain layout', () => {
    const l = computePinnedLayout(4, 0, 'auto', G)
    expect(l.cols).toBe(computeWallLayout(4, 'auto', G).cols)
    expect(l.scale).toBe(computeWallLayout(4, 'auto', G).scale)
  })
})

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
    ['0.33', 3],
    ['0.25', 4]
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
