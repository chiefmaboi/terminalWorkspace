import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers'
import type { LaunchedApp } from './helpers'

async function createWorkspace(window: Page, name: string): Promise<void> {
  await window.locator('.ws-switcher-button').click()
  await window.locator('.ws-menu-item', { hasText: 'New workspace' }).click()
  await window.locator('.modal input').first().fill(name)
  await window.locator('.modal-actions button.primary').click()
  await expect(window.locator('.ws-switcher-name')).toHaveText(name)
}

async function addTerminal(
  window: Page,
  workspaceName: string,
  terminalName: string,
  startCommand: string,
  cwd = tmpdir()
): Promise<void> {
  // The top bar's "+" adds to the active workspace; switch first if needed.
  if ((await window.locator('.ws-switcher-name').textContent()) !== workspaceName) {
    await window.locator('.ws-switcher-button').click()
    await window.locator('.ws-menu-item', { hasText: workspaceName }).click()
  }
  await window.locator('button.add-terminal').click()
  await window.locator('.modal input').first().fill(terminalName)
  await window.locator('.folder-row input').fill(cwd)
  await window.locator('.modal label:has-text("Start command") input').fill(startCommand)
  await window.locator('.modal-actions button.primary', { hasText: 'Add' }).click()
}

/** Whether keyboard focus is inside a terminal (terminal mode) rather than on the wall. */
const inTerminal = (window: Page): Promise<boolean> =>
  window.evaluate(() => !!document.activeElement?.closest('.xterm'))

test.describe('workspace lifecycle', () => {
  let ctx: LaunchedApp

  test.beforeAll(async () => {
    ctx = await launchApp()
  })

  test.afterAll(async () => {
    await closeApp(ctx)
  })

  test('shows the empty state with no workspaces', async () => {
    await expect(ctx.window.locator('.empty-main')).toContainText('No workspaces yet')
  })

  test('creating a workspace shows it in the workspace switcher with no terminals yet', async () => {
    const { window } = ctx
    await createWorkspace(window, 'E2E Test Workspace')
    await expect(window.locator('.empty-main')).toContainText('has no terminals yet')
  })

  test('adding a terminal opens it and runs its start command', async () => {
    const { window } = ctx
    await addTerminal(window, 'E2E Test Workspace', 'Main', 'echo hello-e2e')

    await expect(window.locator('.tile .tile-title')).toContainText('Main')
    // The pty actually starts and the shell prints something — proves the IPC round trip
    // (renderer -> main -> node-pty -> back to renderer) works end to end, not just the UI shell.
    await expect(window.locator('.xterm-screen')).toContainText('hello-e2e', { timeout: 15_000 })
  })
})

test.describe('multi-terminal workspace and settings', () => {
  let ctx: LaunchedApp

  test.beforeAll(async () => {
    ctx = await launchApp()
    await createWorkspace(ctx.window, 'Multi Workspace')
    // Explicit harmless commands — the dialog otherwise defaults to the real "claude" CLI,
    // which is slow/network-dependent and has no place in a fast, deterministic test.
    await addTerminal(ctx.window, 'Multi Workspace', 'Terminal A', 'echo terminal-a-ready')
    await addTerminal(ctx.window, 'Multi Workspace', 'Terminal B', 'echo terminal-b-ready')
  })

  test.afterAll(async () => {
    await closeApp(ctx)
  })

  test('a workspace with two terminals shows both as tiles on the wall', async () => {
    const { window } = ctx
    await expect(window.locator('.wall-grid .tile').filter({ visible: true })).toHaveCount(2)
  })

  test('switching theme in Settings updates the document theme attribute', async () => {
    const { window } = ctx
    await window.locator('button[title="Settings"]').click()
    await expect(window.locator('.settings-modal')).toBeVisible()

    await window.locator('.theme-swatch', { hasText: 'Nord' }).click()
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'nord')

    await window.locator('.theme-swatch', { hasText: 'Dark' }).click()
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
    await window.locator('.modal-actions button.primary', { hasText: 'Done' }).click()
  })
})

test.describe('pty lifecycle', () => {
  let ctx: LaunchedApp

  // Locate one tile's terminal by its header title (several tiles are on the wall at once).
  const tileOf = (window: Page, title: string) =>
    window.locator('.tile').filter({ has: window.locator('.tile-title', { hasText: title }) })
  const screenOf = (window: Page, title: string) => tileOf(window, title).locator('.xterm-screen')

  test.beforeAll(async () => {
    ctx = await launchApp()
    await createWorkspace(ctx.window, 'Pty Workspace')
  })

  // Marker file in the terminal's cwd (tmpdir): the first run creates it and exits 7, any later
  // run sees it and exits 8. Counting notices on screen doesn't work, because ConPTY clears the
  // screen when a new process starts.
  const marker = `pitwall-e2e-restart-${process.pid}-${Date.now()}`

  test.afterAll(async () => {
    await closeApp(ctx)
    rmSync(join(tmpdir(), marker), { force: true })
  })

  test('an exited process is reported in the pane and Enter restarts it', async () => {
    const { window } = ctx
    const exitOnceThenDifferently =
      process.platform === 'win32'
        ? `if (Test-Path ${marker}) { exit 8 } else { New-Item ${marker} | Out-Null; exit 7 }`
        : `if [ -e ${marker} ]; then exit 8; else touch ${marker}; exit 7; fi`
    await addTerminal(window, 'Pty Workspace', 'Exiter', exitOnceThenDifferently)
    const screen = screenOf(window, 'Exiter')

    await expect(screen).toContainText('process exited with code 7', { timeout: 15_000 })

    // Tiles are display-only: the overlay takes the click, selects the tile and focuses it.
    await tileOf(window, 'Exiter').locator('.tile-overlay').click()
    await window.keyboard.press('Enter')
    // Exit code 8 can only come from a freshly spawned process re-running the start command.
    await expect(screen).toContainText('process exited with code 8', { timeout: 15_000 })
  })

  test('a large burst of output drains completely through flow control', async () => {
    const { window } = ctx
    // ~1 MB of output, well past FLOW_HIGH_WATERMARK, so the pty must pause and resume rather
    // than deadlock. The typed command never contains the literal final line, so seeing it on
    // screen proves the output itself arrived.
    const flood =
      process.platform === 'win32'
        ? '1..60000 | ForEach-Object { "flood-line-$_" }'
        : "seq 1 60000 | sed 's/^/flood-line-/'"
    await addTerminal(window, 'Pty Workspace', 'Flood', flood)

    await expect(screenOf(window, 'Flood')).toContainText('flood-line-60000', { timeout: 60_000 })
  })
})

test.describe('grid wall', () => {
  let ctx: LaunchedApp

  const tileOf = (window: Page, title: string) =>
    window.locator('.tile').filter({ has: window.locator('.tile-title', { hasText: title }) })
  // Every pty:resize the renderer sends, recorded by an extra listener in the main process.
  const ptyResizeCount = (): Promise<number> =>
    ctx.app.evaluate(() => (globalThis as unknown as { __ptyResizes: unknown[] }).__ptyResizes.length)

  test.beforeAll(async () => {
    ctx = await launchApp()
    await createWorkspace(ctx.window, 'Wall')
    await addTerminal(ctx.window, 'Wall', 'Alpha', 'echo alpha-ready')
    await addTerminal(ctx.window, 'Wall', 'Beta', 'echo beta-ready')
    await addTerminal(ctx.window, 'Wall', 'Gamma', 'echo gamma-ready')
    for (const name of ['alpha', 'beta', 'gamma']) {
      await expect(tileOf(ctx.window, name[0].toUpperCase() + name.slice(1)).locator('.xterm-screen')).toContainText(
        `${name}-ready`,
        { timeout: 15_000 }
      )
    }
    await ctx.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __ptyResizes: unknown[] }
      g.__ptyResizes = []
      ipcMain.on('pty:resize', (_event, ...args) => g.__ptyResizes.push(args))
    })
  })

  test.afterAll(async () => {
    await closeApp(ctx)
  })

  test('single click selects a tile and sends keystrokes to its pty', async () => {
    const { window } = ctx
    const beta = tileOf(window, 'Beta')
    await beta.locator('.tile-overlay').click()
    await expect(beta).toHaveClass(/tile-selected/)
    await expect(window.locator('.tile.tile-selected')).toHaveCount(1)

    await window.keyboard.type('echo typed-into-beta')
    await window.keyboard.press('Enter')
    // The shell echoes input (xterm never echoes locally), so this proves the keystrokes went
    // through Beta's pty and nowhere else.
    await expect(beta.locator('.xterm-screen')).toContainText('typed-into-beta')
    await expect(tileOf(window, 'Alpha').locator('.xterm-screen')).not.toContainText('typed-into-beta')
  })

  test('double click zooms without resizing the pty and fills the width; Ctrl+Shift+Enter restores', async () => {
    const { window } = ctx
    const alpha = tileOf(window, 'Alpha')
    const resizesBefore = await ptyResizeCount()

    await alpha.locator('.tile-overlay').dblclick()
    await expect(alpha).toHaveClass(/tile-zoomed/)
    await expect(window.locator('.wall-viewport')).toHaveClass(/has-zoomed/)
    // Tiles and the maximized view share one renderer (DOM) and one geometry, so the maximized
    // terminal fills its host instead of leaving a strip (the old WebGL cell-width mismatch).
    const screenPx = await alpha.locator('.xterm-screen').evaluate((el) => (el as HTMLElement).offsetWidth)
    const hostPx = await alpha.locator('.terminal-host').evaluate((el) => (el as HTMLElement).clientWidth)
    expect(screenPx / hostPx).toBeGreaterThan(0.95)

    // The terminal has focus; the chord must still work from inside it.
    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)

    // Same shared geometry in both modes: maximize/restore never resizes a pty (so the agent's
    // TUI never reflows). Wait out the resize debounce before counting.
    await window.waitForTimeout(500)
    expect(await ptyResizeCount()).toBe(resizesBefore)
  })

  test('Ctrl+Shift+Enter leaves terminal mode; from wall mode it zooms and focuses the highlight', async () => {
    const { window } = ctx
    const gamma = tileOf(window, 'Gamma')
    await gamma.locator('.tile-overlay').click()
    expect(await inTerminal(window)).toBe(true)

    // Terminal mode (typing into a tile in place) -> wall mode; the highlight stays on Gamma.
    await window.keyboard.press('Control+Shift+Enter')
    expect(await inTerminal(window)).toBe(false)
    await expect(gamma).toHaveClass(/tile-selected/)
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)

    // Wall mode -> zoom the highlighted tile and type into it.
    await window.keyboard.press('Control+Shift+Enter')
    await expect(gamma).toHaveClass(/tile-zoomed/)
    await expect.poll(() => inTerminal(window)).toBe(true)

    // Zoomed terminal mode -> restored, wall mode.
    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
    expect(await inTerminal(window)).toBe(false)
  })

  test('clicking empty wall space deselects everything and enters wall mode', async () => {
    const { window } = ctx
    await tileOf(window, 'Alpha').locator('.tile-overlay').click()
    expect(await inTerminal(window)).toBe(true)

    // A point in the wall that no tile covers (bottom-right: Gamma sits alone on row 2).
    const point = await window.evaluate(() => {
      const r = document.querySelector('.wall-scroll')!.getBoundingClientRect()
      const x = r.right - 30
      const y = r.bottom - 20
      return { x, y, onTile: !!document.elementFromPoint(x, y)?.closest('.tile-slot') }
    })
    expect(point.onTile).toBe(false)
    await window.mouse.click(point.x, point.y)

    await expect(window.locator('.tile.tile-selected')).toHaveCount(0)
    expect(await inTerminal(window)).toBe(false)
  })

  test('wall mode: arrows move the highlight, Enter zooms + focuses, other keys go nowhere', async () => {
    const { window } = ctx
    const selected = (): Promise<string | null> => window.locator('.tile.tile-selected .tile-title').textContent()
    expect(await inTerminal(window)).toBe(false) // left in wall mode with nothing selected

    // Alpha Beta
    // Gamma
    await window.keyboard.press('ArrowRight')
    expect(await selected()).toBe('Alpha') // first press with no highlight: first tile
    await window.keyboard.press('ArrowRight')
    expect(await selected()).toBe('Beta')
    await window.keyboard.press('ArrowDown')
    expect(await selected()).toBe('Gamma')
    await window.keyboard.press('ArrowUp')
    expect(await selected()).toBe('Alpha')
    await window.keyboard.press('ArrowDown')
    expect(await selected()).toBe('Gamma')

    // Typing on the wall reaches no terminal.
    await window.keyboard.type('zqzq')
    await window.waitForTimeout(300)
    for (const t of ['Alpha', 'Beta', 'Gamma']) {
      await expect(tileOf(window, t).locator('.xterm-screen')).not.toContainText('zqzq')
    }

    await window.keyboard.press('Enter')
    const gamma = tileOf(window, 'Gamma')
    await expect(gamma).toHaveClass(/tile-zoomed/)
    await expect.poll(() => inTerminal(window)).toBe(true)
    await window.keyboard.type('echo in-gamma')
    await window.keyboard.press('Enter')
    await expect(gamma.locator('.xterm-screen')).toContainText('in-gamma')

    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
    expect(await inTerminal(window)).toBe(false)
    await window.keyboard.type('wvwv')
    await window.waitForTimeout(300)
    await expect(gamma.locator('.xterm-screen')).not.toContainText('wvwv')
  })

  test('clicking the dim restores and returns to wall mode', async () => {
    const { window } = ctx
    const alpha = tileOf(window, 'Alpha')
    await alpha.locator('.tile-overlay').dblclick()
    await expect(alpha).toHaveClass(/tile-zoomed/)
    await expect.poll(() => inTerminal(window)).toBe(true)

    await window.locator('.wall-dim').click({ position: { x: 4, y: 4 } })
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
    expect(await inTerminal(window)).toBe(false)
    await expect(alpha).toHaveClass(/tile-selected/)
  })

  test('Esc stays with a focused terminal and only restores once focus leaves it', async () => {
    const { window } = ctx
    const alpha = tileOf(window, 'Alpha')
    await alpha.locator('.tile-overlay').dblclick()
    await expect(alpha).toHaveClass(/tile-zoomed/)
    await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true)

    await window.keyboard.press('Escape')
    await expect(alpha).toHaveClass(/tile-zoomed/)

    // Clicking the (non-focusable) header moves focus out of the terminal.
    await alpha.locator('.tile-title').click()
    await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(false)
    await window.keyboard.press('Escape')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
  })

  test('a burst of window resizes is debounced into one pty resize per terminal', async () => {
    const { app, window } = ctx
    const before = await ptyResizeCount()
    const [width, height] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
    for (let step = 1; step <= 5; step++) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        [width - step * 40, height - step * 20]
      )
      await window.waitForTimeout(30)
    }
    await window.waitForTimeout(800)
    expect(await ptyResizeCount()).toBe(before + 3)

    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [
      width,
      height
    ])
    await window.waitForTimeout(800)
    expect(await ptyResizeCount()).toBe(before + 6)
  })

  // Animations finished on the given tile (FLIP uses the Web Animations API on .tile).
  const settled = (tile: ReturnType<typeof tileOf>) =>
    expect.poll(() => tile.evaluate((el) => el.getAnimations().length)).toBe(0)

  test('the zoomed pane floats centered at ~88% over the dimmed, still visible wall', async () => {
    const { window } = ctx
    const alpha = tileOf(window, 'Alpha')
    const beta = tileOf(window, 'Beta')
    await alpha.locator('.tile-overlay').dblclick()
    await expect(alpha).toHaveClass(/tile-zoomed/)
    await settled(alpha)

    // 88% of the WINDOW (the wall now spans it, below the top bar), centered on the window.
    const geometry = await window.evaluate(() => {
      const pane = document.querySelector('.tile-zoomed')!.getBoundingClientRect()
      return {
        widthRatio: pane.width / window.innerWidth,
        heightRatio: pane.height / window.innerHeight,
        leftGap: pane.left,
        rightGap: window.innerWidth - pane.right,
        topGap: pane.top,
        bottomGap: window.innerHeight - pane.bottom
      }
    })
    expect(geometry.widthRatio).toBeCloseTo(0.88, 2)
    expect(geometry.heightRatio).toBeCloseTo(0.88, 2)
    expect(Math.abs(geometry.leftGap - geometry.rightGap)).toBeLessThanOrEqual(2)
    expect(Math.abs(geometry.topGap - geometry.bottomGap)).toBeLessThanOrEqual(2)

    // The wall stays rendered behind the pane, under a ~60% dark dim...
    await expect(beta).toBeVisible()
    const dim = window.locator('.wall-dim')
    await expect(dim).toHaveClass(/visible/)
    expect(await dim.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0.6)')
    expect(await dim.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none')
    // ...with background tiles' status rings stacked above the dim but their content below it.
    const z = (el: Element): number => Number(getComputedStyle(el).zIndex)
    const dimZ = await dim.evaluate(z)
    expect(await beta.locator('.tile-ring').evaluate(z)).toBeGreaterThan(dimZ)
    // A point on a background tile's body (below its header) that the pane doesn't cover: the
    // dim is on top there, so a click lands on the dim, not the tile.
    const hitOnBackgroundTile = await window.evaluate(() => {
      const pane = document.querySelector('.tile-zoomed')!.getBoundingClientRect()
      const wall = document.querySelector('.wall-viewport')!.getBoundingClientRect()
      for (const el of document.querySelectorAll('.tile:not(.tile-zoomed)')) {
        const tile = el.getBoundingClientRect()
        for (let fy = 0.02; fy < 1; fy += 0.02) {
          for (let fx = 0.02; fx < 1; fx += 0.04) {
            const x = tile.left + fx * tile.width
            const y = tile.top + fy * tile.height
            const inPane = x >= pane.left && x <= pane.right && y >= pane.top && y <= pane.bottom
            const inWall = y < wall.bottom - 1 && x < wall.right - 1
            if (!inPane && inWall && y > tile.top + 30) return String(document.elementFromPoint(x, y)?.className)
          }
        }
      }
      return 'no uncovered tile point'
    })
    expect(hitOnBackgroundTile).toContain('wall-dim')

    // Clicking the dimmed area (outside the pane) restores.
    await dim.click({ position: { x: 4, y: 4 } })
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
    await expect(dim).not.toHaveClass(/visible/)
  })

  test('zoom and restore animate with FLIP; reduced motion skips the animation', async () => {
    const { window } = ctx
    const beta = tileOf(window, 'Beta')
    const flip = (): Promise<{ count: number; duration: number; from: string }> =>
      beta.evaluate((el) => {
        const [animation] = el.getAnimations()
        if (!animation) return { count: 0, duration: 0, from: '' }
        const frames = (animation.effect as KeyframeEffect).getKeyframes()
        return {
          count: el.getAnimations().length,
          duration: Number((animation.effect as KeyframeEffect).getTiming().duration),
          from: String(frames[0].transform)
        }
      })

    await beta.locator('.tile-overlay').dblclick()
    const zoomIn = await flip()
    expect(zoomIn.count).toBe(1)
    expect(zoomIn.duration).toBe(180)
    expect(zoomIn.from).toMatch(/translate\(.*\) scale\(/) // starts at the slot's rect
    await settled(beta)

    await window.keyboard.press('Control+Shift+Enter')
    // Restoring animates back into the slot while still in the zoomed layout...
    await expect(beta).toHaveClass(/tile-zoomed/)
    expect((await flip()).count).toBe(1)
    // ...and only then drops back into the grid.
    await expect(beta).not.toHaveClass(/tile-zoomed/)
    await settled(beta)

    await window.emulateMedia({ reducedMotion: 'reduce' })
    try {
      await beta.locator('.tile-overlay').dblclick()
      await expect(beta).toHaveClass(/tile-zoomed/)
      expect((await flip()).count).toBe(0)
      await window.keyboard.press('Control+Shift+Enter')
      // No exit animation either: the grid layout is back right away.
      expect(await beta.evaluate((el) => el.classList.contains('tile-zoomed'))).toBe(false)
    } finally {
      await window.emulateMedia({ reducedMotion: null })
    }
  })

  test('background tiles keep updating while a pane is zoomed', async () => {
    const { window } = ctx
    const gamma = tileOf(window, 'Gamma')
    await gamma.locator('.tile-overlay').click()
    await window.keyboard.type(
      process.platform === 'win32'
        ? '1..8 | % { "tick-$_"; Start-Sleep -Milliseconds 300 }'
        : 'for i in 1 2 3 4 5 6 7 8; do echo tick-$i; sleep 0.3; done'
    )
    await window.keyboard.press('Enter')

    const alpha = tileOf(window, 'Alpha')
    await alpha.locator('.tile-overlay').dblclick()
    await expect(alpha).toHaveClass(/tile-zoomed/)
    // Gamma is under the dim the whole time; its output still lands at the normal tile rate.
    await expect(gamma.locator('.xterm-screen')).toContainText('tick-8', { timeout: 15_000 })
    await expect(alpha).toHaveClass(/tile-zoomed/)
    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
  })

  test('click-to-focus on a partly visible tile never scrolls the wall', async () => {
    const { window } = ctx
    const scroller = window.locator('.wall-scroll')
    // Five tiles at 0.5 = 2 columns x 3 rows. Tile size follows the zoomed pane (88% of the
    // wall), so two rows always fit; the third row is the one that runs past the bottom.
    await addTerminal(window, 'Wall', 'Delta', 'echo delta-ready')
    await addTerminal(window, 'Wall', 'Epsilon', 'echo epsilon-ready')
    const epsilon = tileOf(window, 'Epsilon')
    await expect(epsilon.locator('.xterm-screen')).toContainText('epsilon-ready', { timeout: 15_000 })
    // Push Epsilon's cursor (and with it xterm's hidden input textarea) to its last row, like an
    // agent's input box: that is the part of a partly visible tile that sits below the fold.
    await epsilon.locator('.tile-overlay').click()
    await window.keyboard.type(process.platform === 'win32' ? '1..120 | % { "fill-$_" }' : 'seq 1 120 | sed "s/^/fill-/"')
    await window.keyboard.press('Enter')
    await expect(epsilon.locator('.xterm-screen')).toContainText('fill-120')
    await tileOf(window, 'Alpha').locator('.tile-overlay').click()

    await window.locator('.wall-scale select').selectOption('0.5')
    await expect(window.locator('.wall-grid')).toHaveAttribute('data-cols', '2')
    await scroller.evaluate((el) => (el.scrollTop = 0))
    // Epsilon's textarea really is out of view, so a plain focus() would have to scroll.
    const textareaBelowFold = await window.evaluate(() => {
      const scroll = document.querySelector('.wall-scroll') as HTMLElement
      const tile = [...document.querySelectorAll('.tile')].find((t) => t.textContent?.includes('Epsilon'))
      const textarea = tile?.querySelector('.xterm-helper-textarea') as HTMLElement
      return textarea.getBoundingClientRect().top > scroll.getBoundingClientRect().bottom
    })
    expect(textareaBelowFold).toBe(true)

    // dispatchEvent, not click(): Playwright's click() scrolls its target into view itself.
    await epsilon.locator('.tile-overlay').dispatchEvent('click')
    await expect(epsilon).toHaveClass(/tile-selected/)
    await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0)
    // Typing is a different matter: Chromium reveals the text caret as input arrives, so typing
    // into a tile whose cursor row is below the fold nudges the wall toward it. Not asserted.
    await window.locator('.wall-scale select').selectOption('auto')
  })

  test('the scale selector switches tile scale and column count at runtime', async () => {
    const { window } = ctx
    const grid = window.locator('.wall-grid')
    const select = window.locator('.wall-scale select')
    const scale = async (): Promise<number> => Number(await grid.getAttribute('data-scale'))

    await select.selectOption('0.33')
    await expect(grid).toHaveAttribute('data-cols', '3')
    expect(await scale()).toBeLessThanOrEqual(0.33)

    await select.selectOption('0.4')
    await expect(grid).toHaveAttribute('data-cols', '2')
    expect(await scale()).toBeLessThanOrEqual(0.4)

    await select.selectOption('0.5')
    await expect(grid).toHaveAttribute('data-cols', '2')
    expect(await scale()).toBeGreaterThan(0.4)

    await select.selectOption('auto')
    expect(await scale()).toBeLessThanOrEqual(0.5)
    expect(await scale()).toBeGreaterThan(0)
  })

  // macOS reports cwd through /private symlinks; compare against the resolved path there.
  const osPath = (p: string): string => (process.platform === 'darwin' ? realpathSync(p) : p)
  const titles = (): Promise<string[]> => ctx.window.locator('.wall-grid .tile-title').allTextContents()
  const slotOf = (name: string) =>
    ctx.window.locator('.tile-slot').filter({ has: ctx.window.locator('.tile-title', { hasText: name }) })

  test('the file drawer is closed by default, overlays the wall and never resizes anything', async () => {
    const { window } = ctx
    const drawer = window.locator('.file-drawer')
    await expect(drawer).toHaveCount(0)
    // dispatchEvent: select without hit-testing (the drawer will cover the right-hand tiles).
    await tileOf(window, 'Alpha').locator('.tile-overlay').dispatchEvent('click')
    await expect.poll(() => inTerminal(window)).toBe(true)

    const snapshot = (): Promise<unknown> =>
      window.evaluate(() => ({
        viewport: JSON.stringify(document.querySelector('.wall-viewport')!.getBoundingClientRect()),
        scale: document.querySelector('.wall-grid')!.getAttribute('data-scale'),
        cols: document.querySelector('.wall-grid')!.getAttribute('data-cols'),
        slots: [...document.querySelectorAll('.tile-slot')].map((el) => JSON.stringify(el.getBoundingClientRect()))
      }))
    const before = await snapshot()
    const resizesBefore = await ptyResizeCount()

    // The chord works from terminal mode and is never typed into the PTY.
    await window.keyboard.press('Control+Shift+E')
    await expect(drawer).toBeVisible()
    await expect(window.locator('.top-bar-button', { hasText: 'Files' })).toHaveClass(/active/)
    await window.waitForTimeout(600) // longer than the resize debounce
    expect(await snapshot()).toEqual(before)
    expect(await ptyResizeCount()).toBe(resizesBefore)
    // It sits over the wall's right edge rather than beside it.
    const edges = await window.evaluate(() => ({
      drawer: document.querySelector('.file-drawer')!.getBoundingClientRect().right,
      wall: document.querySelector('.wall-viewport')!.getBoundingClientRect().right
    }))
    expect(Math.abs(edges.drawer - edges.wall)).toBeLessThanOrEqual(1)
    // Rooted at the selected tile's cwd.
    await expect(drawer.locator('.file-drawer-path')).toHaveText(osPath(tmpdir()))

    await window.locator('.top-bar-button', { hasText: 'Files' }).click()
    await expect(drawer).toHaveCount(0)
  })

  test("the drawer follows the selected tile's cwd into a git worktree", async () => {
    const { window } = ctx
    const base = mkdtempSync(join(tmpdir(), 'pitwall-wt-'))
    const repo = join(base, 'repo')
    const worktree = join(base, 'feature-wt')
    mkdirSync(repo)
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=pitwall-e2e', '-c', 'user.email=e2e@example.invalid', ...args], {
        cwd: repo,
        stdio: 'pipe'
      })
    }
    writeFileSync(join(repo, 'tracked.txt'), 'x')
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    git('worktree', 'add', '-q', '-b', 'feature', worktree)
    writeFileSync(join(worktree, 'worktree-only.txt'), 'y')

    const gamma = tileOf(window, 'Gamma')
    const drawer = window.locator('.file-drawer')
    try {
      await gamma.locator('.tile-overlay').dispatchEvent('click')
      await expect.poll(() => inTerminal(window)).toBe(true)
      await window.keyboard.type(`cd "${worktree}"`)
      await window.keyboard.press('Enter')
      await window.waitForTimeout(1000) // the next prompt carries the shell's cwd report

      await window.keyboard.press('Control+Shift+E')
      await expect(drawer.locator('.file-drawer-path')).toHaveText(osPath(worktree))
      await expect(drawer.locator('.file-tree')).toContainText('worktree-only.txt')

      // Selecting another tile re-roots the open drawer at that tile's cwd.
      await tileOf(window, 'Alpha').locator('.tile-overlay').dispatchEvent('click')
      await expect(drawer.locator('.file-drawer-path')).toHaveText(osPath(tmpdir()))
      await window.keyboard.press('Control+Shift+E')
      await expect(drawer).toHaveCount(0)
    } finally {
      // Step the shell back out so the directory can be removed.
      await gamma.locator('.tile-overlay').dispatchEvent('click')
      await window.keyboard.type(`cd "${tmpdir()}"`)
      await window.keyboard.press('Enter')
      await window.waitForTimeout(500)
      try {
        rmSync(base, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  })

  test('a press moving under 5px is still a click; past it the tile drags and reorders (persisted)', async () => {
    const { window } = ctx
    await window.locator('.wall-scroll').evaluate((el) => (el.scrollTop = 0))
    const before = await titles()
    expect(before.slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma'])
    const center = async (name: string): Promise<{ x: number; y: number }> => {
      const box = (await tileOf(window, name).locator('.tile-overlay').boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    // 3px of travel: below the threshold, so it's an ordinary click (select + focus).
    const a = await center('Alpha')
    await window.mouse.move(a.x, a.y)
    await window.mouse.down()
    await window.mouse.move(a.x + 3, a.y + 1, { steps: 3 })
    await expect(window.locator('.tile-dragging')).toHaveCount(0)
    await window.mouse.up()
    await expect(tileOf(window, 'Alpha')).toHaveClass(/tile-selected/)
    await expect.poll(() => inTerminal(window)).toBe(true)
    expect(await titles()).toEqual(before)

    // A real drag onto Gamma: Alpha takes Gamma's place.
    const g = await center('Gamma')
    await window.mouse.move(a.x, a.y)
    await window.mouse.down()
    await window.mouse.move((a.x + g.x) / 2, (a.y + g.y) / 2, { steps: 6 })
    await expect(tileOf(window, 'Alpha')).toHaveClass(/tile-dragging/)
    await window.mouse.move(g.x, g.y, { steps: 6 })
    await expect(slotOf('Gamma')).toHaveClass(/drop-target/)
    await window.mouse.up()

    const expected = [...before]
    expected.splice(expected.indexOf('Alpha'), 1)
    expected.splice(before.indexOf('Gamma'), 0, 'Alpha')
    await expect.poll(titles).toEqual(expected)
    await expect(window.locator('.tile-dragging')).toHaveCount(0)

    const saved = JSON.parse(readFileSync(join(ctx.userDataDir, 'workspaces.json'), 'utf-8')) as {
      workspaces: Array<{ name: string; terminals: Array<{ name: string; order: number }> }>
    }
    const wall = saved.workspaces.find((w) => w.name === 'Wall')!
    expect([...wall.terminals].sort((x, y) => x.order - y.order).map((t) => t.name)).toEqual(expected)
  })

  test('right-click or the pin icon pins a tile 2x2; pins and order survive a restart', async () => {
    const resizesBefore = await ptyResizeCount()
    await tileOf(ctx.window, 'Beta').locator('.tile-overlay').click({ button: 'right' })
    await expect(slotOf('Beta')).toHaveClass(/tile-pinned/)
    await expect(tileOf(ctx.window, 'Beta').locator('.tile-pin')).toHaveAttribute('aria-pressed', 'true')
    // grid-column: span 2 computes to start "span 2" / end "auto".
    expect(await slotOf('Beta').evaluate((el) => getComputedStyle(el).gridColumnStart)).toBe('span 2')
    expect(await slotOf('Beta').evaluate((el) => getComputedStyle(el).gridRowStart)).toBe('span 2')
    const widths = await ctx.window.evaluate(() => {
      const width = (name: string): number => {
        const slot = [...document.querySelectorAll('.tile-slot')].find(
          (s) => s.querySelector('.tile-title')?.textContent === name
        )!
        return slot.getBoundingClientRect().width
      }
      return { pinned: width('Beta'), plain: width('Delta') }
    })
    expect(widths.pinned).toBeGreaterThan(1.9 * widths.plain)
    // Bigger, not resized: the pinned tile shows the same cols/rows at a larger scale.
    await ctx.window.waitForTimeout(500)
    expect(await ptyResizeCount()).toBe(resizesBefore)

    // The pin icon toggles too.
    const gammaPin = tileOf(ctx.window, 'Gamma').locator('.tile-pin')
    await gammaPin.click()
    await expect(slotOf('Gamma')).toHaveClass(/tile-pinned/)
    await gammaPin.click()
    await expect(slotOf('Gamma')).not.toHaveClass(/tile-pinned/)

    const order = await titles()
    const userDataDir = ctx.userDataDir
    await closeApp(ctx, { keepUserData: true })
    ctx = await launchApp({}, { userDataDir })
    await ctx.window.locator('.modal-actions button.primary', { hasText: 'Restart sessions' }).click()
    await expect(slotOf('Beta')).toHaveClass(/tile-pinned/)
    await expect(slotOf('Gamma')).not.toHaveClass(/tile-pinned/)
    expect(await titles()).toEqual(order)
  })
})

test.describe('spawned environment', () => {
  let ctx: LaunchedApp

  test.beforeAll(async () => {
    // As if Pitwall itself had been launched from inside a Claude Code session.
    ctx = await launchApp({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: 'keep-me' })
    await createWorkspace(ctx.window, 'Env')
  })

  test.afterAll(async () => {
    await closeApp(ctx)
  })

  test('terminals do not inherit CLAUDECODE, CLAUDE_CODE_* or PITWALL_*', async () => {
    const { window } = ctx
    // The typed command shows the variable names, never the bracketed result, so a match on the
    // result line can only come from the shell's output.
    const probe =
      process.platform === 'win32'
        ? '"cc=[$env:CLAUDECODE] ccx=[$env:CLAUDE_CODE_ENTRYPOINT] pw=[$env:PITWALL_USER_DATA_DIR] cfg=[$env:CLAUDE_CONFIG_DIR]"'
        : 'echo "cc=[$CLAUDECODE] ccx=[$CLAUDE_CODE_ENTRYPOINT] pw=[$PITWALL_USER_DATA_DIR] cfg=[$CLAUDE_CONFIG_DIR]"'
    await addTerminal(window, 'Env', 'Probe', probe)
    await expect(window.locator('.tile .xterm-screen')).toContainText('cc=[] ccx=[] pw=[] cfg=[keep-me]', {
      timeout: 15_000
    })
  })
})
