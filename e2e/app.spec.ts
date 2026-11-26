import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
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
    await expect(window.locator('.tile .xterm-screen')).toContainText('hello-e2e', { timeout: 15_000 })
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

  test('ended terminals leave no console host behind (exit, restart)', async () => {
    test.skip(process.platform !== 'win32', 'ConPTY console hosts are Windows only')
    const { window } = ctx
    // Console hosts (OpenConsole.exe, or a system conhost.exe) and shells that are children of
    // the app; every live terminal has one of each. (The app's own PID: Playwright's process()
    // is a launcher above the real main process.)
    const pid = await ctx.app.evaluate(() => process.pid)
    const children = (): { conhosts: number; shells: number } => {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$k = Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}'; ` +
            `"$(@($k | Where-Object { $_.Name -in 'conhost.exe','OpenConsole.exe' }).Count) $(@($k | Where-Object Name -eq 'powershell.exe').Count)"`
        ],
        { encoding: 'utf-8' }
      )
      const [conhosts, shells] = out.trim().split(' ').map(Number)
      return { conhosts, shells }
    }
    // The Exiter tile above has exited on its own twice: neither left its console host.
    await expect.poll(children, { timeout: 15_000 }).toEqual({ conhosts: 0, shells: 0 })

    await addTerminal(window, 'Pty Workspace', 'Host', 'echo host-ready')
    await expect(screenOf(window, 'Host')).toContainText('host-ready', { timeout: 15_000 })
    await expect.poll(children, { timeout: 15_000 }).toEqual({ conhosts: 1, shells: 1 })

    // Restart from the tile menu, twice: each stopped session's console host goes with it.
    for (let i = 0; i < 2; i++) {
      await tileOf(window, 'Host').locator('.tile-menu-button').click()
      await window.locator('.tile-menu button', { hasText: 'Restart' }).click()
      await expect(screenOf(window, 'Host')).toContainText('host-ready', { timeout: 15_000 })
      await expect.poll(children, { timeout: 15_000 }).toEqual({ conhosts: 1, shells: 1 })
    }

    // A shell exiting on its own.
    await tileOf(window, 'Host').locator('.tile-overlay').click()
    await window.keyboard.type('exit')
    await window.keyboard.press('Enter')
    await expect(screenOf(window, 'Host')).toContainText('process exited with code 0', { timeout: 15_000 })
    await expect.poll(children, { timeout: 15_000 }).toEqual({ conhosts: 0, shells: 0 })
  })

  test("a real OSC 9 notification marks the tile waiting; the prompt's OSC 9;9 cwd reports never do", async () => {
    const { window } = ctx
    await addTerminal(window, 'Pty Workspace', 'Notifier', 'echo notifier-ready')
    const tile = tileOf(window, 'Notifier')
    await expect(tile.locator('.xterm-screen')).toContainText('notifier-ready', { timeout: 15_000 })

    // Several prompts' worth of Pitwall's own OSC 9;9 cwd reports: not a notification.
    await tile.locator('.tile-overlay').click()
    for (let i = 0; i < 3; i++) await window.keyboard.press('Enter')
    await window.waitForTimeout(2000) // past the idle debounce, so a stray "waiting" would show
    await expect(tile).not.toHaveAttribute('data-status', 'waiting')

    // An actual OSC 9 notification from a program in the terminal.
    await window.keyboard.type(
      process.platform === 'win32'
        ? 'Write-Host -NoNewline "$([char]27)]9;needs you$([char]7)"'
        : "printf '\\033]9;needs you\\007'"
    )
    await window.keyboard.press('Enter')
    await expect(tile).toHaveAttribute('data-status', 'waiting', { timeout: 10_000 })
    // Waiting tiles get the light breathing glow (an opacity animation on the ring's ::after).
    expect(
      await tile.locator('.tile-ring').evaluate((el) => getComputedStyle(el, '::after').animationName)
    ).toBe('tile-waiting-glow')
    // Answering (Enter) clears waiting, and with it the glow.
    await window.keyboard.press('Enter')
    await expect(tile).not.toHaveAttribute('data-status', 'waiting')
    expect(
      await tile.locator('.tile-ring').evaluate((el) => getComputedStyle(el, '::after').animationName)
    ).toBe('none')
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

  test('Ctrl+C copies a selection instead of interrupting, and interrupts without one; Ctrl+Shift+C only copies', async () => {
    const { app, window } = ctx
    const gamma = tileOf(window, 'Gamma')
    const clipboard = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText())
    const setClipboard = (text: string): Promise<void> =>
      app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
    const rows = (): Promise<string[]> =>
      gamma
        .locator('.xterm-rows > div')
        .evaluateAll((els) => els.map((e) => e.textContent?.trimEnd() ?? '').filter(Boolean))
    // The shell prints "^C" for every interrupt it gets at the prompt.
    const interrupts = async (): Promise<number> => (await rows()).filter((r) => r.endsWith('^C')).length
    const selection = gamma.locator('.xterm-selection > div')
    const selectLine = async (text: string): Promise<void> => {
      const box = await gamma.locator('.xterm-rows > div', { hasText: new RegExp(`^${text}\\s*$`) }).last().boundingBox()
      if (!box) throw new Error(`no row "${text}"`)
      await window.mouse.move(box.x + 1, box.y + box.height / 2)
      await window.mouse.down()
      await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 })
      await window.mouse.up()
      await expect(selection).not.toHaveCount(0)
    }

    await gamma.locator('.tile-overlay').dblclick()
    await expect(gamma).toHaveClass(/tile-zoomed/)
    await expect.poll(() => inTerminal(window)).toBe(true)
    await window.keyboard.type('echo copy-target')
    await window.keyboard.press('Enter')
    await expect.poll(async () => (await rows()).includes('copy-target')).toBe(true)

    // Selection + Ctrl+C: copied, selection cleared, nothing sent to the shell.
    await setClipboard('unchanged')
    const before = await interrupts()
    await selectLine('copy-target')
    await window.keyboard.press('Control+C')
    await expect.poll(clipboard).toBe('copy-target')
    await expect(selection).toHaveCount(0)
    await window.waitForTimeout(500)
    expect(await interrupts()).toBe(before)

    // No selection: Ctrl+C is the interrupt, as always.
    await window.keyboard.press('Control+C')
    await expect.poll(interrupts).toBe(before + 1)
    expect(await clipboard()).toBe('copy-target')

    // Ctrl+Shift+C copies a selection, and without one does nothing at all.
    await setClipboard('unchanged')
    await selectLine('copy-target')
    await window.keyboard.press('Control+Shift+C')
    await expect.poll(clipboard).toBe('copy-target')
    await setClipboard('unchanged')
    await window.keyboard.press('Control+Shift+C')
    await window.waitForTimeout(500)
    expect(await clipboard()).toBe('unchanged')
    expect(await interrupts()).toBe(before + 1)

    await window.keyboard.press('Control+Shift+Enter')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
  })

  test("Shift+Enter sends ESC CR (Claude Code's new line); right-click in a zoomed pane offers Copy / Paste", async () => {
    const { app, window } = ctx
    const gamma = tileOf(window, 'Gamma')
    type Probe = {
      __input: string[]
      __onInput: (...args: unknown[]) => void
      __menu: { items: Array<{ label: string; enabled: boolean; click: () => void }> } | null
      __popup: unknown
    }
    // Record what reaches the ptys, and capture the context menu instead of showing it.
    await app.evaluate(({ ipcMain, Menu }) => {
      const g = globalThis as unknown as Probe
      g.__input = []
      g.__onInput = (_event, _id, data) => g.__input.push(data as string)
      ipcMain.on('pty:input', g.__onInput)
      g.__menu = null
      g.__popup = Menu.prototype.popup
      Menu.prototype.popup = function (this: Probe['__menu']) {
        ;(globalThis as unknown as Probe).__menu = this
      }
    })
    const input = (): Promise<string> =>
      app.evaluate(() => (globalThis as unknown as Probe).__input.join(''))
    const menu = (): Promise<Array<{ label: string; enabled: boolean }> | null> =>
      app.evaluate(() => {
        const m = (globalThis as unknown as Probe).__menu
        return m && m.items.map((i) => ({ label: i.label, enabled: i.enabled }))
      })
    const choose = (label: string): Promise<void> =>
      app.evaluate((_electron, l) => {
        const g = globalThis as unknown as Probe
        g.__menu!.items.find((i) => i.label === l)!.click()
        g.__menu = null
      }, label)
    const clipboard = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText())
    const setClipboard = (text: string): Promise<void> =>
      app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
    try {
      await gamma.locator('.tile-overlay').dblclick()
      await expect(gamma).toHaveClass(/tile-zoomed/)
      await expect.poll(() => inTerminal(window)).toBe(true)

      // ESC CR and never a bare CR (Enter). Other bytes, like focus reports, may come along.
      await window.keyboard.press('Shift+Enter')
      await expect.poll(input).toContain('\x1b\r')
      expect(JSON.stringify((await input()).replaceAll('\x1b\r', ''))).not.toContain('\\r')

      // Nothing selected: Copy is disabled; Paste pastes the clipboard into this terminal.
      await setClipboard('pasted-by-menu')
      await gamma.locator('.xterm-screen').click({ button: 'right' })
      await expect.poll(menu).toEqual([
        { label: 'Copy', enabled: false },
        { label: 'Paste', enabled: true }
      ])
      await choose('Paste')
      await expect.poll(input).toContain('pasted-by-menu')
      await expect(gamma.locator('.xterm-screen')).toContainText('pasted-by-menu')
      await window.keyboard.press('Control+C')

      // A selection: Copy copies it.
      await window.keyboard.type('echo menu-copy')
      await window.keyboard.press('Enter')
      const row = gamma.locator('.xterm-rows > div', { hasText: /^menu-copy\s*$/ }).last()
      await expect(row).toBeVisible()
      const box = (await row.boundingBox())!
      await window.mouse.move(box.x + 1, box.y + box.height / 2)
      await window.mouse.down()
      await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 })
      await window.mouse.up()
      await setClipboard('unchanged')
      await gamma.locator('.xterm-screen').click({ button: 'right', position: { x: box.width / 4, y: 10 } })
      await expect.poll(menu).toEqual([
        { label: 'Copy', enabled: true },
        { label: 'Paste', enabled: true }
      ])
      await choose('Copy')
      expect(await clipboard()).toBe('menu-copy')
      // Zoomed right-click never pins.
      await expect(gamma).not.toHaveClass(/tile-pinned/)
      await expect(window.locator('.tile-slot.tile-pinned')).toHaveCount(0)
    } finally {
      await app.evaluate(({ ipcMain, Menu }) => {
        const g = globalThis as unknown as Probe
        ipcMain.removeListener('pty:input', g.__onInput)
        Menu.prototype.popup = g.__popup as typeof Menu.prototype.popup
      })
    }
    await window.keyboard.press('Control+Shift+Enter')
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
    // The 88% pane is the Fill width option's (the 120 col default shows a normal-size pane).
    await window.locator('.wall-width select').selectOption('fill')
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
    await window.locator('.wall-width select').selectOption('120')
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

  test('the wheel scrolls the terminal you are typing into; over any other tile, the wall', async () => {
    const { window } = ctx
    const scroller = window.locator('.wall-scroll')
    const wallTop = (): Promise<number> => scroller.evaluate((el) => el.scrollTop)
    const historyTop = (title: string): Promise<number> =>
      tileOf(window, title).locator('.xterm-viewport').evaluate((el) => el.scrollTop)
    const pointAt = async (title: string): Promise<void> => {
      const box = (await tileOf(window, title).boundingBox())!
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    }
    // 0.5 with five tiles: three rows, so the wall itself can scroll too.
    await window.locator('.wall-scale select').selectOption('0.5')
    await expect(window.locator('.wall-grid')).toHaveAttribute('data-cols', '2')
    await scroller.evaluate((el) => (el.scrollTop = 0))

    // Alpha gets history to scroll through, and keeps the typing focus.
    const alpha = tileOf(window, 'Alpha')
    await alpha.locator('.tile-overlay').click()
    await window.keyboard.type(process.platform === 'win32' ? '1..150 | % { "wheel-$_" }' : 'seq 1 150 | sed "s/^/wheel-/"')
    await window.keyboard.press('Enter')
    await expect(alpha.locator('.xterm-screen')).toContainText('wheel-150')
    const atBottom = await historyTop('Alpha')
    await pointAt('Alpha')
    await window.mouse.wheel(0, -400)
    await expect.poll(() => historyTop('Alpha')).toBeLessThan(atBottom)
    expect(await wallTop()).toBe(0) // the wall stayed put

    // Beta isn't the one you're typing into: the wheel scrolls the wall, not Beta.
    const betaTop = await historyTop('Beta')
    await pointAt('Beta')
    await window.mouse.wheel(0, 400)
    await expect.poll(wallTop).toBeGreaterThan(0)
    expect(await historyTop('Beta')).toBe(betaTop)

    await scroller.evaluate((el) => (el.scrollTop = 0))
    await window.locator('.wall-scale select').selectOption('auto')
  })

  test('the scale selector switches tile scale and column count at runtime', async () => {
    const { window } = ctx
    const grid = window.locator('.wall-grid')
    const select = window.locator('.wall-scale select')
    const scale = async (): Promise<number> => Number(await grid.getAttribute('data-scale'))

    await select.selectOption('0.25')
    await expect(grid).toHaveAttribute('data-cols', '4')
    expect(await scale()).toBeLessThanOrEqual(0.25)

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

  test('the width option: 120 columns in the same tile boxes, and back', async () => {
    const { window } = ctx
    const alpha = tileOf(window, 'Alpha')
    const width = window.locator('.wall-width select')
    /** The terminal's own idea of its size, asked from inside the shell. */
    const shellColumns = async (tag: string): Promise<number> => {
      await alpha.locator('.tile-overlay').dispatchEvent('click')
      await expect.poll(() => inTerminal(window)).toBe(true)
      const ask = process.platform === 'win32' ? `"${tag}=$($Host.UI.RawUI.BufferSize.Width)"` : `echo "${tag}=$(tput cols)"`
      await window.keyboard.type(ask)
      await window.keyboard.press('Enter')
      const screen = alpha.locator('.xterm-screen')
      await expect(screen).toContainText(new RegExp(`${tag}=\\d+`))
      const match = ((await screen.textContent()) ?? '').match(new RegExp(`${tag}=(\\d+)`, 'g'))!.pop()!
      await window.keyboard.press('Control+Shift+Enter')
      return Number(match.split('=')[1])
    }

    const errors: string[] = []
    const onError = (e: Error): number => errors.push(e.message)
    window.on('pageerror', onError)
    /** Zoom Alpha, return the zoomed pane's size, restore. */
    const zoomedSize = async (): Promise<{ width: number; height: number }> => {
      await alpha.locator('.tile-overlay').dispatchEvent('dblclick')
      const pane = window.locator('.tile-zoomed')
      await expect(pane).toBeVisible()
      await window.waitForTimeout(300) // past the zoom animation
      const size = (await pane.boundingBox())!
      await window.locator('.wall-dim').click({ position: { x: 2, y: 2 } })
      await expect(pane).toHaveCount(0)
      return size
    }

    await width.selectOption('fill')
    await expect.poll(() => shellColumns('FILLCOLS')).toBeGreaterThan(120)
    const box = await alpha.boundingBox()
    const fillZoom = await zoomedSize()

    await width.selectOption('120')
    await expect.poll(() => shellColumns('NARROWCOLS')).toBe(120)
    expect(await alpha.boundingBox()).toEqual(box) // the wall itself doesn't change
    // The zoomed view shows those 120 columns at a normal text size: smaller than Fill's pane.
    const narrowZoom = await zoomedSize()
    expect(narrowZoom.width).toBeLessThan(fillZoom.width)
    expect(await shellColumns('AFTERZOOM')).toBe(120) // zooming never resizes a terminal

    await width.selectOption('fill')
    await expect.poll(() => shellColumns('BACKCOLS')).toBeGreaterThan(120)
    await width.selectOption('120') // back to the default for the tests that follow
    window.off('pageerror', onError)
    expect(errors).toEqual([])
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

  test('"+" prefills the folder with the selected terminal\'s current cwd, and nothing without a selection', async () => {
    const { window } = ctx
    const sub = mkdtempSync(join(tmpdir(), 'pitwall-plus-'))
    const gamma = tileOf(window, 'Gamma')
    const folderInput = window.locator('.modal .folder-row input')
    const cancel = (): Promise<void> => window.locator('.modal-actions button', { hasText: 'Cancel' }).click()
    try {
      await gamma.locator('.tile-overlay').dispatchEvent('click')
      await expect.poll(() => inTerminal(window)).toBe(true)
      await window.keyboard.type(`cd "${sub}"`)
      await window.keyboard.press('Enter')
      await window.waitForTimeout(1000) // the next prompt carries the shell's cwd report

      await window.locator('button.add-terminal').click()
      await expect(folderInput).toHaveValue(osPath(sub))
      await cancel()

      // Deselect (empty wall space), then "+" starts with an empty folder.
      const point = await window.evaluate(() => {
        const r = document.querySelector('.wall-scroll')!.getBoundingClientRect()
        const x = r.right - 30
        const y = r.bottom - 20
        return { x, y, onTile: !!document.elementFromPoint(x, y)?.closest('.tile-slot') }
      })
      expect(point.onTile).toBe(false)
      await window.mouse.click(point.x, point.y)
      await expect(window.locator('.tile.tile-selected')).toHaveCount(0)
      await window.locator('button.add-terminal').click()
      await expect(folderInput).toHaveValue('')
      await cancel()
    } finally {
      await gamma.locator('.tile-overlay').dispatchEvent('click')
      await window.keyboard.type(`cd "${tmpdir()}"`)
      await window.keyboard.press('Enter')
      await window.waitForTimeout(500)
      try {
        rmSync(sub, { recursive: true, force: true })
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
    // No prompt: the last workspace reopens on its own.
    await expect(slotOf('Beta')).toHaveClass(/tile-pinned/)
    await expect(slotOf('Gamma')).not.toHaveClass(/tile-pinned/)
    expect(await titles()).toEqual(order)
  })
})

test.describe('markdown links in the file drawer', () => {
  let ctx: LaunchedApp
  let base: string
  let repo: string
  let tileDir: string

  const drawer = () => ctx.window.locator('.file-drawer')
  const header = () => drawer().locator('.file-panel-header')
  const markdown = () => drawer().locator('.file-preview-markdown')
  const listing = () => drawer().locator('.folder-listing')
  const link = (name: string) => markdown().getByRole('link', { name, exact: true })
  const back = (): Promise<void> => drawer().locator('.file-panel-back').click()
  const previewScrollTop = (): Promise<number> =>
    ctx.window.evaluate(() => document.querySelector('.file-drawer .file-preview')!.scrollTop)
  /** How far below the preview's top edge an element sits (about 8 once scrolled to). */
  const offsetInPreview = (selector: string): Promise<number> =>
    ctx.window.evaluate((sel) => {
      const scroller = document.querySelector('.file-drawer .file-preview')!
      return document.querySelector(sel)!.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }, selector)
  const openedUrls = (): Promise<string[]> =>
    ctx.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

  test.beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'pitwall-md-'))
    repo = join(base, 'repo')
    tileDir = join(repo, 'packages', 'web')
    const write = (rel: string, text: string): void => {
      const path = join(repo, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    // A .git folder is all a repository needs for "/" links (found without running git).
    mkdirSync(join(repo, '.git'), { recursive: true })
    const filler = Array.from({ length: 80 }, (_, i) => `Filler paragraph ${i}.`).join('\n\n')
    write('docs/root-guide.md', '# Root guide\n')
    write('shared/notes.txt', 'shared notes\n')
    write('shared/sub/deep.txt', 'deep file\n')
    write('packages/web/docs/guide.md', `# Guide\n\n${filler}\n\n## Setup steps\n\nSetup body.\n\n${filler}\n`)
    write('packages/web/docs/my notes.md', '# My notes\n')
    write('packages/web/src/app.ts', 'export const app = 1\n')
    write('packages/web/src/lib/util.ts', 'export const util = 1\n')
    write(
      'packages/web/README.md',
      [
        '# Web package',
        '',
        '- [Guide](docs/guide.md)',
        '- [Guide setup](./docs/guide.md#setup-steps)',
        '- [Notes](<docs/my notes.md>)',
        '- [Local section](#more-links)',
        '- [App source](src/app.ts)',
        '- [Lib folder](src/lib/)',
        '- [Shared folder](../../shared)',
        '- [Root guide](/docs/root-guide.md)',
        '- [Missing](docs/missing.md)',
        '- [Website](https://example.com/pitwall-e2e)',
        '- [Mail](mailto:someone@example.invalid)',
        '',
        filler,
        '',
        '## More links',
        '',
        'More text.',
        '',
        filler,
        ''
      ].join('\n')
    )

    ctx = await launchApp()
    await createWorkspace(ctx.window, 'Docs')
    await addTerminal(ctx.window, 'Docs', 'Web', 'echo web-ready', tileDir)
    await expect(ctx.window.locator('.tile .xterm-screen')).toContainText('web-ready', { timeout: 15_000 })
    // Web links end in shell.openExternal; record them instead of opening a browser.
    await ctx.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] }
      g.__opened = []
      shell.openExternal = async (url: string): Promise<void> => {
        g.__opened.push(url)
      }
    })
  })

  test.afterAll(async () => {
    await closeApp(ctx)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(base, { recursive: true, force: true })
        return
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  })

  test('links open files, sections and folders in the drawer, and Back steps through them', async () => {
    const { window } = ctx
    const startUrl = window.url()
    await window.locator('.tile .tile-overlay').first().dispatchEvent('click')
    await expect.poll(() => inTerminal(window)).toBe(true)
    await window.keyboard.press('Control+Shift+E')
    await expect(drawer().locator('.file-drawer-path')).toHaveText(tileDir)
    await drawer().locator('.file-tree-row', { hasText: 'README.md' }).click()
    await expect(markdown().locator('h1')).toHaveText('Web package')
    await expect(header()).toContainText('README.md')

    // Hovering a link shows where it goes.
    await expect(link('Guide')).toHaveAttribute('title', join(tileDir, 'docs', 'guide.md'))
    await expect(link('Guide setup')).toHaveAttribute('title', `${join(tileDir, 'docs', 'guide.md')}#setup-steps`)
    await expect(link('Root guide')).toHaveAttribute('title', join(repo, 'docs', 'root-guide.md'))
    await expect(link('Website')).toHaveAttribute('title', 'https://example.com/pitwall-e2e')

    // A section of the same page scrolls the preview and stays on the file.
    await link('Local section').click()
    await expect.poll(() => offsetInPreview('#md-more-links')).toBeLessThan(40)
    expect(await offsetInPreview('#md-more-links')).toBeGreaterThanOrEqual(0)
    await expect(header()).toContainText('README.md')

    // A file link opens that file; Back returns to the same spot in the previous one.
    // (dispatchEvent: clicking without first scrolling the link into view.)
    const readmeScroll = await previewScrollTop()
    expect(readmeScroll).toBeGreaterThan(100)
    await link('Guide').dispatchEvent('click')
    await expect(markdown().locator('h1')).toHaveText('Guide')
    await expect(header()).toContainText('guide.md')
    await back()
    await expect(markdown().locator('h1')).toHaveText('Web package')
    await expect.poll(async () => Math.abs((await previewScrollTop()) - readmeScroll)).toBeLessThanOrEqual(1)

    // file.md#section opens the file at that heading.
    await link('Guide setup').click()
    await expect(header()).toContainText('guide.md')
    await expect.poll(() => offsetInPreview('#md-setup-steps')).toBeLessThan(40)
    await back()

    // Names with spaces, and non-Markdown files in their usual preview.
    await link('Notes').click()
    await expect(markdown().locator('h1')).toHaveText('My notes')
    await back()
    await link('App source').click()
    await expect(drawer().locator('pre.file-preview-content')).toContainText('export const app = 1')
    await back()

    // "/" counts from the repository root, like on GitHub.
    await link('Root guide').click()
    await expect(markdown().locator('h1')).toHaveText('Root guide')
    await back()

    // A missing target says so; Back still works.
    await link('Missing').click()
    await expect(drawer().locator('.file-preview-missing')).toContainText('Not found')
    await expect(drawer().locator('.file-preview-missing')).toContainText(join(tileDir, 'docs', 'missing.md'))
    await back()

    // A folder inside the tile's folder opens in the tree: highlighted, with its contents shown.
    await link('Lib folder').click()
    await expect(drawer().locator('.file-tree-row.selected .file-tree-name')).toHaveText('lib')
    await expect(drawer().locator('.file-tree')).toContainText('util.ts')
    await expect(header()).toContainText('lib')
    await back()
    await expect(markdown().locator('h1')).toHaveText('Web package')

    // A folder outside it is listed in the preview area, one level at a time.
    await link('Shared folder').click()
    await expect(listing().locator('.folder-listing-path')).toHaveText(join(repo, 'shared'))
    await expect(listing().locator('.file-tree-row .file-tree-name')).toHaveText(['..', 'sub', 'notes.txt'])
    await listing().locator('.file-tree-row', { hasText: 'sub' }).click()
    await expect(listing().locator('.folder-listing-path')).toHaveText(join(repo, 'shared', 'sub'))
    await listing().locator('.file-tree-row', { hasText: 'deep.txt' }).click()
    await expect(drawer().locator('pre.file-preview-content')).toContainText('deep file')
    await back()
    await expect(listing().locator('.folder-listing-path')).toHaveText(join(repo, 'shared', 'sub'))
    await back()
    await expect(listing().locator('.folder-listing-path')).toHaveText(join(repo, 'shared'))
    await listing().locator('.folder-listing-up').click()
    await expect(listing().locator('.folder-listing-path')).toHaveText(repo)
    await listing().locator('.file-tree-row', { hasText: 'packages' }).click()
    await expect(listing().locator('.folder-listing-path')).toHaveText(join(repo, 'packages'))
    // Reaching the tile's folder from a list shows it in the tree again.
    await listing().locator('.file-tree-row', { hasText: 'web' }).click()
    await expect(listing()).toHaveCount(0)
    await expect(drawer().locator('.file-tree')).toContainText('README.md')
    await expect(header()).toContainText('files')
    for (const folder of [join(repo, 'packages'), repo, join(repo, 'shared')]) {
      await back()
      await expect(listing().locator('.folder-listing-path')).toHaveText(folder)
    }
    await back()
    await expect(markdown().locator('h1')).toHaveText('Web package')

    // Web links go to the browser; other kinds of link do nothing; the window never navigates.
    await link('Website').click()
    await expect.poll(openedUrls).toEqual(['https://example.com/pitwall-e2e'])
    await link('Mail').click()
    await window.waitForTimeout(300)
    expect(await openedUrls()).toEqual(['https://example.com/pitwall-e2e'])
    await expect(header()).toContainText('README.md')
    expect(window.url()).toBe(startUrl)

    // Back from the first file returns to the tree.
    await back()
    await expect(drawer().locator('.file-panel-title')).toHaveText('Web')
    await expect(drawer().locator('.file-tree')).toContainText('README.md')
  })

  test('the path at the top can be typed: folders, relative paths and files; the tile button goes back', async () => {
    const { window } = ctx
    const pathText = drawer().locator('.file-drawer-path')
    const input = drawer().locator('.file-drawer-path-input')
    const source = drawer().locator('.file-drawer-source')
    const error = drawer().locator('.file-drawer-path-error')
    const go = async (typed: string): Promise<void> => {
      await pathText.click()
      await input.fill(typed)
      await input.press('Enter')
    }

    // Zoom the tile first: Esc in the path field must not also restore it.
    await window.locator('.tile .tile-overlay').first().dispatchEvent('dblclick')
    await expect(window.locator('.tile-zoomed')).toHaveCount(1)
    if ((await drawer().count()) === 0) await window.keyboard.press('Control+Shift+E')
    await expect(pathText).toHaveText(tileDir)

    // Clicking shows the full path, selected, ready to type over.
    await pathText.click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(tileDir)
    expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0))).toBe(
      tileDir
    )
    // Typed keys stay in the field: "?" doesn't open the shortcuts.
    await input.press('End')
    await input.pressSequentially('?')
    await expect(input).toHaveValue(`${tileDir}?`)
    await expect(window.locator('.modal-overlay')).toHaveCount(0)
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(pathText).toHaveText(tileDir)
    await expect(window.locator('.tile-zoomed')).toHaveCount(1)

    // A folder.
    await go(join(repo, 'shared'))
    await expect(pathText).toHaveText(join(repo, 'shared'))
    await expect(source).toHaveText('typed')
    await expect(drawer().locator('.file-tree')).toContainText('notes.txt')

    // Relative to the folder shown.
    await go('..')
    await expect(pathText).toHaveText(repo)
    await expect(drawer().locator('.file-tree')).toContainText('packages')

    // A file (quoted, as Explorer's "Copy as path" gives it) opens in its folder.
    await go(`"${join(tileDir, 'docs', 'guide.md')}"`)
    await expect(pathText).toHaveText(join(tileDir, 'docs'))
    await expect(markdown().locator('h1')).toHaveText('Guide')

    // A path that doesn't exist: the field stays open and nothing changes.
    await go('no-such-folder')
    await expect(error).toHaveText(`Not found: ${join(tileDir, 'docs', 'no-such-folder')}`)
    await expect(input).toBeFocused()
    await expect(markdown().locator('h1')).toHaveText('Guide')
    await input.press('Escape')
    await expect(error).toHaveCount(0)
    await expect(pathText).toHaveText(join(tileDir, 'docs'))

    // The tile button goes back to the tile's own folder.
    await drawer().locator('button[title^="Back to the tile"]').click()
    await expect(pathText).toHaveText(tileDir)
    await expect(source).not.toHaveText('typed')
    await expect(drawer().locator('.file-tree')).toContainText('README.md')
    await window.keyboard.press('Escape')
    await expect(window.locator('.tile-zoomed')).toHaveCount(0)
  })
})

test.describe('agent hooks', () => {
  let ctx: LaunchedApp
  let base: string
  let claudeDir: string
  const isWin = process.platform === 'win32'
  const userClaudeHook = { hooks: [{ type: 'command', command: 'echo users-own-claude-hook' }] }

  const tileOf = (window: Page, title: string) =>
    window.locator('.tile').filter({ has: window.locator('.tile-title', { hasText: title }) })
  /** PowerShell single-quoted literal (or POSIX single-quoted) of a string. */
  const quote = (s: string): string => (isWin ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`)
  /** A command typed into a terminal that POSTs `body` to Pitwall as `agent`, using the
   * terminal's own PITWALL_* variables (or an explicit bogus token). */
  const postFromTerminal = (agent: string, body: object, token?: string): string => {
    const json = quote(JSON.stringify(body))
    if (isWin) {
      const tok = token ?? '$env:PITWALL_TOKEN'
      return `Invoke-RestMethod -Method Post -Uri "$env:PITWALL_HOOK_URL/${agent}" -Headers @{ Authorization = "Bearer ${tok}" } -ContentType 'application/json' -Body ${json}`
    }
    const tok = token ?? '$PITWALL_TOKEN'
    return `curl -s -X POST -H "Authorization: Bearer ${tok}" -H 'Content-Type: application/json' --data ${json} "$PITWALL_HOOK_URL/${agent}"`
  }
  const run = async (window: Page, title: string, command: string): Promise<void> => {
    await tileOf(window, title).locator('.tile-overlay').dispatchEvent('click')
    await expect.poll(() => inTerminal(window)).toBe(true)
    await window.keyboard.type(command)
    await window.keyboard.press('Enter')
  }

  test.beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'pitwall-hooks-e2e-'))
    claudeDir = join(base, 'claude')
    mkdirSync(claudeDir)
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { Stop: [userClaudeHook] } }, null, 2) + '\n'
    )
    ctx = await launchApp({ CLAUDE_CONFIG_DIR: claudeDir })
    await createWorkspace(ctx.window, 'Hooks')
    await addTerminal(ctx.window, 'Hooks', 'Left', 'echo left-ready')
    await addTerminal(ctx.window, 'Hooks', 'Right', 'echo right-ready')
    await expect(tileOf(ctx.window, 'Right').locator('.xterm-screen')).toContainText('right-ready', { timeout: 15_000 })
  })

  test.afterAll(async () => {
    await closeApp(ctx)
    rmSync(base, { recursive: true, force: true })
  })

  test('hook events reach the terminal that sent them (by token, not folder); bad tokens are refused', async () => {
    const { window } = ctx
    const left = tileOf(window, 'Left')
    const right = tileOf(window, 'Right') // same folder as Left

    await run(window, 'Left', isWin ? '"url=$env:PITWALL_HOOK_URL"' : 'echo "url=$PITWALL_HOOK_URL"')
    await expect(left.locator('.xterm-screen')).toContainText(/url=http:\/\/127\.0\.0\.1:\d+\/hook/)
    await expect(left.locator('.xterm-screen')).not.toContainText(':47823')

    await run(window, 'Left', postFromTerminal('claude', { hook_event_name: 'Notification', message: 'approve edit?' }))
    await expect(left).toHaveAttribute('data-status', 'waiting', { timeout: 10_000 })
    await expect(right).not.toHaveAttribute('data-status', 'waiting')

    await run(window, 'Right', postFromTerminal('claude', { hook_event_name: 'Notification' }, '0'.repeat(64)))
    await window.waitForTimeout(1500)
    await expect(right).not.toHaveAttribute('data-status', 'waiting')

    // Stop from Left: idle again.
    await run(window, 'Left', postFromTerminal('claude', { hook_event_name: 'Stop' }))
    await expect(left).toHaveAttribute('data-status', 'idle', { timeout: 10_000 })
  })

  test("an agent's hook cwd (a worktree) re-roots the file drawer until the shell is back", async () => {
    const { window } = ctx
    const worktree = mkdtempSync(join(tmpdir(), 'pitwall-agent-wt-'))
    writeFileSync(join(worktree, 'agent-side.txt'), 'x')
    const drawer = window.locator('.file-drawer')
    try {
      // Stand in for a foreground agent: report from inside the terminal, then keep it busy
      // (no shell prompt) the way a running agent does.
      const sleep = isWin ? 'Start-Sleep -Seconds 60' : 'sleep 60'
      await run(window, 'Left', `${postFromTerminal('claude', { hook_event_name: 'SessionStart', cwd: worktree })}; ${sleep}`)
      await window.waitForTimeout(1500)
      await window.keyboard.press('Control+Shift+E')
      await expect(drawer.locator('.file-drawer-path')).toHaveText(worktree)
      await expect(drawer.locator('.file-drawer-source')).toHaveText('agent cwd')
      await expect(drawer.locator('.file-tree')).toContainText('agent-side.txt')
      await window.keyboard.press('Control+Shift+E')

      // The "agent" exits: the shell's next prompt reports its own cwd, which wins again.
      await window.keyboard.press('Control+C')
      await window.waitForTimeout(1500)
      await window.keyboard.press('Control+Shift+E')
      await expect(drawer.locator('.file-drawer-path')).toHaveText(tmpdir())
      await expect(drawer.locator('.file-drawer-source')).not.toHaveText('agent cwd')
      await window.keyboard.press('Control+Shift+E')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  const openHooksSettings = async (window: Page): Promise<void> => {
    await window.locator('button[title="Settings"]').click()
    await expect(window.locator('.hook-item')).toHaveCount(1)
  }
  const closeSettings = (window: Page): Promise<void> =>
    window.locator('.settings-modal .modal-actions button.primary', { hasText: 'Done' }).click()

  {
    const agent = 'claude'
    test('installing claude hooks: review the diff, apply, idempotent, then remove', async () => {
      const { window } = ctx
      const configPath = join(claudeDir, 'settings.json')
      const userGroup = userClaudeHook
      const row = window.locator(`.hook-item[data-agent="${agent}"]`)
      await openHooksSettings(window)
      await expect(row).toHaveAttribute('data-state', 'missing')

      await row.locator('button', { hasText: 'Install' }).click()
      const review = window.locator('.hook-review')
      await expect(review.locator('.hook-review-path')).toContainText(configPath)
      await expect(review.locator('.diff-add').first()).toBeVisible()
      expect(await review.locator('.diff-add').allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining('PITWALL_TOKEN')])
      )
      await expect(review.locator('.diff-del')).toHaveCount(0) // installing only adds
      await review.locator('.modal-actions button.primary', { hasText: 'Install' }).click()
      await expect(row).toHaveAttribute('data-state', 'installed')

      const installed = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(installed.hooks.Stop[0]).toEqual(userGroup) // the user's hook keeps its position
      expect(JSON.stringify(installed.hooks.Stop[1])).toContain('PITWALL_TOKEN')
      expect(installed.model).toBe('opus')
      expect(readdirSync(claudeDir).some((f) => f.includes('pitwall-backup'))).toBe(true)

      // Remove: back to exactly the user's own config.
      await row.locator('button', { hasText: 'Remove' }).click()
      await expect(review.locator('.diff-del').first()).toBeVisible()
      await review.locator('.modal-actions button.danger', { hasText: 'Remove' }).click()
      await expect(row).toHaveAttribute('data-state', 'missing')
      const removed = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(removed.hooks).toEqual({ Stop: [userGroup] })

      // Leave it installed for the next test.
      await row.locator('button', { hasText: 'Install' }).click()
      await review.locator('.modal-actions button.primary', { hasText: 'Install' }).click()
      await expect(row).toHaveAttribute('data-state', 'installed')
      await closeSettings(window)
    })
  }

})

test.describe('relaunch', () => {
  test('reopens the last workspace and starts its terminals, with no prompt', async () => {
    let ctx = await launchApp()
    await createWorkspace(ctx.window, 'Other')
    await createWorkspace(ctx.window, 'Persisted')
    await addTerminal(ctx.window, 'Persisted', 'Keeper', 'echo keeper-started')
    await expect(ctx.window.locator('.tile .xterm-screen')).toContainText('keeper-started', { timeout: 15_000 })
    const userDataDir = ctx.userDataDir
    await closeApp(ctx, { keepUserData: true })

    ctx = await launchApp({}, { userDataDir })
    await expect(ctx.window.locator('.ws-switcher-name')).toHaveText('Persisted')
    await expect(ctx.window.locator('.tile .xterm-screen')).toContainText('keeper-started', { timeout: 15_000 })
    await expect(ctx.window.locator('.modal-overlay')).toHaveCount(0)
    await closeApp(ctx)
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
