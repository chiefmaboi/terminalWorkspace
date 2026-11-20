import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers'
import type { LaunchedApp } from './helpers'

async function createWorkspace(window: Page, name: string): Promise<void> {
  await window.locator('button[title="New workspace (Ctrl+N)"]').click()
  await window.locator('.modal input').first().fill(name)
  await window.locator('.modal-actions button.primary').click()
  await expect(window.locator('.workspace-item', { hasText: name })).toBeVisible()
}

async function addTerminal(window: Page, workspaceName: string, terminalName: string, startCommand: string): Promise<void> {
  await window.locator('.sidebar-tab', { hasText: 'Workspaces' }).click()
  const group = window.locator('.workspace-group').filter({ hasText: workspaceName })
  await group.locator('.terminal-add-row').click()
  await window.locator('.modal input').first().fill(terminalName)
  await window.locator('.folder-row input').fill(tmpdir())
  await window.locator('.modal label:has-text("Start command") input').fill(startCommand)
  await window.locator('.modal-actions button.primary', { hasText: 'Add' }).click()
}

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

  test('creating a workspace shows it in the sidebar with no terminals yet', async () => {
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

  test('Ctrl+Shift+Enter zooms the selected tile', async () => {
    const { window } = ctx
    await tileOf(window, 'Gamma').locator('.tile-overlay').click()
    await window.keyboard.press('Control+Shift+Enter')
    await expect(tileOf(window, 'Gamma')).toHaveClass(/tile-zoomed/)
    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
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

    const geometry = await window.evaluate(() => {
      const viewport = document.querySelector('.wall-viewport')!.getBoundingClientRect()
      const pane = document.querySelector('.tile-zoomed')!.getBoundingClientRect()
      return {
        widthRatio: pane.width / viewport.width,
        heightRatio: pane.height / viewport.height,
        leftGap: pane.left - viewport.left,
        rightGap: viewport.right - pane.right,
        topGap: pane.top - viewport.top,
        bottomGap: viewport.bottom - pane.bottom
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
    // A point on Beta's body (below its header) that the pane doesn't cover: the dim is on top
    // there, so a click lands on the dim, not the tile.
    const hitOnBeta = await beta.evaluate((el) => {
      const tile = el.getBoundingClientRect()
      const pane = document.querySelector('.tile-zoomed')!.getBoundingClientRect()
      for (let fy = 0.02; fy < 1; fy += 0.04) {
        for (let fx = 0.02; fx < 1; fx += 0.04) {
          const x = tile.left + fx * tile.width
          const y = tile.top + fy * tile.height
          const inPane = x >= pane.left && x <= pane.right && y >= pane.top && y <= pane.bottom
          if (!inPane && y > tile.top + 30) return String(document.elementFromPoint(x, y)?.className)
        }
      }
      return 'no uncovered point on Beta'
    })
    expect(hitOnBeta).toContain('wall-dim')

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
