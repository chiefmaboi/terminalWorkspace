import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { launchApp, closeApp } from './helpers'

/**
 * Opt-in load check with REAL sessions, not synthetic output: four Claude Code sessions doing a
 * small read-only task plus four real shell workloads in this repo, all on one wall. Measures
 * renderer frame pacing and long tasks, typing latency in the selected tile, CPU/memory, and
 * flow-control warnings, while toggling maximize under load. Uses a little Claude usage.
 *
 *   PITWALL_REAL_SESSIONS=1 npm run test:e2e -- e2e/real-sessions.spec.ts
 *
 * Results: test-results/real-sessions/report.json plus screenshots.
 *
 * The Claude sessions run in a throwaway temp folder holding only a copy of package.json, and
 * the harness answers Claude Code's folder-trust prompt for THAT folder only. It never accepts
 * trust for your real repo on your behalf.
 */

const ENABLED = process.env.PITWALL_REAL_SESSIONS === '1'
const REPO = resolve(__dirname, '..')
const OUT = join(REPO, 'test-results', 'real-sessions')
const LOAD_SECONDS = Number(process.env.PITWALL_REAL_SESSIONS_SECONDS ?? 60)
const isWin = process.platform === 'win32'

// Long enough to keep every session streaming for most of the measurement window. Run on Haiku:
// cheaper, and it streams faster, which is the harder case for the wall.
const CLAUDE_COMMAND = 'claude --model haiku'
const CLAUDE_PROMPT =
  'Read package.json in this folder, then explain each runtime dependency in about 120 words, one after another. Chat only: do not create or modify any files.'
const CLAUDE_FOLLOW_UP = 'Now do the same for every devDependency. Chat only.'

const SHELLS: Array<{ name: string; command: string }> = [
  { name: 'ping', command: isWin ? 'ping -t 127.0.0.1' : 'ping 127.0.0.1' },
  {
    name: 'vitest-loop',
    command: isWin
      ? 'while ($true) { npx vitest run; Start-Sleep -Seconds 2 }'
      : 'while true; do npx vitest run; sleep 2; done'
  },
  { name: 'git-log', command: 'git --no-pager log --stat -n 400' },
  {
    name: 'big-listing',
    command: isWin
      ? 'Get-ChildItem -Recurse node_modules | Select-Object -First 30000 FullName, Length'
      : 'find node_modules | head -n 30000'
  }
]

/** Answer Claude Code's folder-trust prompt with "Yes", pressing Enter only once it's selected. */
async function acceptTrustIfAsked(window: Page, tile: Locator): Promise<void> {
  const screen = tile.locator('.xterm-screen')
  for (let attempt = 0; attempt < 6; attempt++) {
    const text = (await screen.textContent()) ?? ''
    if (!text.includes('trust this folder')) return
    await tile.locator('.tile-overlay').click()
    if (/❯\s*Yes, I trust this folder/.test(text)) {
      await window.keyboard.press('Enter')
    } else {
      await window.keyboard.press(attempt < 3 ? 'ArrowDown' : 'ArrowUp')
    }
    await window.waitForTimeout(800)
  }
  throw new Error('could not get past the folder-trust prompt')
}

test.describe('real sessions under load', () => {
  test.skip(!ENABLED, 'set PITWALL_REAL_SESSIONS=1 to run (starts real Claude Code sessions)')
  test.setTimeout((LOAD_SECONDS + 240) * 1000)

  test('4 Claude Code sessions + 4 shell workloads on one wall', async () => {
    mkdirSync(OUT, { recursive: true })
    const claudeDir = mkdtempSync(join(tmpdir(), 'pitwall-real-'))
    copyFileSync(join(REPO, 'package.json'), join(claudeDir, 'package.json'))
    const ctx = await launchApp()
    const { app, window } = ctx
    const warnings: string[] = []
    app.process().stdout?.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.includes('[pty]')) warnings.push(line.trim())
    })
    app.process().stderr?.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.includes('[pty]')) warnings.push(line.trim())
    })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1920, 1080)
      win.center()
    })

    const tileOf = (title: string) =>
      window.locator('.tile').filter({ has: window.locator('.tile-title', { hasText: title }) })

    // Workspace + 8 terminals: Claude sessions in the scratch folder, shells in this repo.
    await window.locator('.ws-switcher-button').click()
    await window.locator('.ws-menu-item', { hasText: 'New workspace' }).click()
    await window.locator('.modal input').first().fill('Load')
    await window.locator('.modal-actions button.primary').click()
    const add = async (name: string, command: string, cwd: string): Promise<void> => {
      await window.locator('button.add-terminal').click()
      await window.locator('.modal input').first().fill(name)
      await window.locator('.folder-row input').fill(cwd)
      await window.locator('.modal label:has-text("Start command") input').fill(command)
      await window.locator('.modal-actions button.primary', { hasText: 'Add' }).click()
    }
    for (let i = 1; i <= 4; i++) await add(`claude-${i}`, CLAUDE_COMMAND, claudeDir)
    for (const s of SHELLS) await add(s.name, s.command, REPO)
    await expect(window.locator('.wall-grid .tile')).toHaveCount(8)

    // Give each Claude Code TUI time to boot (past the trust prompt), then hand it the prompt.
    for (let i = 1; i <= 4; i++) {
      const tile = tileOf(`claude-${i}`)
      await expect(tile.locator('.xterm-screen')).toContainText(/trust this folder|shortcuts|Welcome to Claude/, {
        timeout: 60_000
      })
      await acceptTrustIfAsked(window, tile)
    }
    await window.waitForTimeout(5000)

    // Renderer-side instrumentation: rAF frame deltas and long tasks for the whole load window,
    // armed BEFORE the prompts go out so the streaming is inside the measurement.
    await window.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __longTasks: number[] }
      w.__frames = []
      w.__longTasks = []
      let last = performance.now()
      const tick = (now: number): void => {
        w.__frames.push(now - last)
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(entry.duration)
      }).observe({ entryTypes: ['longtask'] })
    })

    const cpuAt = (): Promise<Record<string, number>> =>
      app.evaluate(({ app: electronApp }) => {
        const totals: Record<string, number> = {}
        for (const m of electronApp.getAppMetrics()) {
          totals[m.type] = (totals[m.type] ?? 0) + (m.cpu.cumulativeCPUUsage ?? 0)
        }
        return totals
      })
    const cpuStart = await cpuAt()
    const cpuStartedAt = Date.now()

    const submit = async (i: number, prompt: string): Promise<void> => {
      const tile = tileOf(`claude-${i}`)
      await tile.locator('.tile-overlay').click()
      await window.keyboard.insertText(prompt)
      // Claude Code treats one big insert as a paste, and an Enter that lands right on the heels
      // of a paste is taken as part of it rather than as submit. Let the paste settle first.
      await window.waitForTimeout(800)
      await window.keyboard.press('Enter')
      // Submitted means the prompt left the input box and the session started working.
      await expect(tile.locator('.xterm-screen')).toContainText(/esc to interrupt|Reading|thinking/i, {
        timeout: 20_000
      })
    }
    for (let i = 1; i <= 4; i++) await submit(i, CLAUDE_PROMPT)
    const promptsSentAt = Date.now()
    let followUpsSent = false

    const cpuSamples: Array<{ type: string; cpu: number; memMB: number }[]> = []
    const latencies: number[] = []
    const deadline = Date.now() + LOAD_SECONDS * 1000
    let round = 0
    // The idle-after-burst shell is the typing target; Claude tiles keep streaming meanwhile.
    const typingTile = tileOf('git-log')
    const typingId = (await typingTile.getAttribute('data-terminal-id')) ?? ''
    await typingTile.locator('.tile-overlay').click()
    const fill: Record<string, number> = {}

    while (Date.now() < deadline) {
      round++
      cpuSamples.push(
        await app.evaluate(({ app: electronApp }) =>
          electronApp.getAppMetrics().map((m) => ({
            type: m.type,
            cpu: m.cpu.percentCPUUsage,
            memMB: Math.round(m.memory.workingSetSize / 1024)
          }))
        )
      )

      // Typing latency, timed inside the page: input -> pty -> shell echo -> batched IPC ->
      // xterm parse -> DOM. One insertText call, and a MutationObserver stops the clock the
      // moment the echoed text is in the tile's DOM, so harness polling doesn't inflate it.
      const marker = `lat${round}x${Math.floor(Math.random() * 1e6)}`
      await typingTile.locator('.tile-overlay').click()
      await window.evaluate(
        ({ id, marker }) => {
          const w = window as unknown as { __lat: { t0: number; t1: number | null } }
          const rows = document.querySelector(`.tile[data-terminal-id="${id}"] .xterm-rows`) as HTMLElement
          w.__lat = { t0: performance.now(), t1: null }
          const observer = new MutationObserver(() => {
            if (w.__lat.t1 === null && rows.textContent?.includes(marker)) {
              w.__lat.t1 = performance.now()
              observer.disconnect()
            }
          })
          observer.observe(rows, { childList: true, subtree: true, characterData: true })
        },
        { id: typingId, marker }
      )
      await window.keyboard.insertText(marker)
      await window.waitForFunction(
        () => (window as unknown as { __lat: { t1: number | null } }).__lat.t1 !== null,
        null,
        { timeout: 10_000, polling: 'raf' }
      )
      latencies.push(
        await window.evaluate(() => {
          const lat = (window as unknown as { __lat: { t0: number; t1: number } }).__lat
          return Math.round(lat.t1 - lat.t0)
        })
      )
      await window.keyboard.press('Control+C')
      if (round === 2) await window.screenshot({ path: join(OUT, 'wall-auto.png') })

      // Second wave so Claude keeps streaming through the back half of the window too.
      if (!followUpsSent && Date.now() - promptsSentAt > 25_000) {
        followUpsSent = true
        for (let i = 1; i <= 4; i++) await submit(i, CLAUDE_FOLLOW_UP)
        await typingTile.locator('.tile-overlay').click()
      }

      // Maximize/restore a busy Claude tile under load every few rounds.
      if (round % 3 === 0) {
        const t = tileOf(`claude-${(round % 4) + 1}`)
        const screenWidth = (): Promise<number> =>
          t.locator('.xterm-screen').evaluate((el) => (el as HTMLElement).offsetWidth)
        const hostWidth = (): Promise<number> =>
          t.locator('.terminal-host').evaluate((el) => (el as HTMLElement).clientWidth)
        if (round === 3) {
          fill.tileScreenPx = await screenWidth()
          fill.hostPx = await hostWidth()
        }
        await t.locator('.tile-overlay').dblclick()
        await expect(t).toHaveClass(/tile-zoomed/)
        if (round === 3) {
          await window.waitForTimeout(300)
          fill.maximizedScreenPx = await screenWidth()
          fill.devicePixelRatio = await window.evaluate(() => window.devicePixelRatio)
          await window.screenshot({ path: join(OUT, 'maximized.png') })
        }
        await window.waitForTimeout(1500)
        await window.keyboard.press('Control+Shift+Enter')
        await expect(window.locator('.tile-zoomed')).toHaveCount(0)
      }
      await window.waitForTimeout(2000)
    }

    const cpuEnd = await cpuAt()
    const cpuSeconds = (Date.now() - cpuStartedAt) / 1000
    const coresUsed = (type: string): number =>
      Math.round((((cpuEnd[type] ?? 0) - (cpuStart[type] ?? 0)) / cpuSeconds) * 1000) / 1000

    await window.locator('.wall-scale select').selectOption('0.33')
    await window.waitForTimeout(500)
    await window.screenshot({ path: join(OUT, 'wall-0.33.png') })
    await window.locator('.wall-scale select').selectOption('auto')

    const renderer = await window.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __longTasks: number[] }
      return { frames: w.__frames, longTasks: w.__longTasks }
    })
    // How long each Claude session kept streaming inside the window ("✻ <verb> for Ns" footer).
    const screens = await Promise.all(
      [1, 2, 3, 4].map(async (i) => ({
        tile: `claude-${i}`,
        tail: ((await tileOf(`claude-${i}`).locator('.xterm-rows').innerText()) ?? '')
          .split('\n')
          .filter((l) => l.trim())
          .slice(-6)
      }))
    )

    const pct = (xs: number[], p: number): number => {
      if (xs.length === 0) return 0
      const s = [...xs].sort((a, b) => a - b)
      return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10
    }
    const frames = renderer.frames.slice(1)
    const byType = (type: string): number[] =>
      cpuSamples.map((sample) => sample.filter((m) => m.type === type).reduce((a, m) => a + m.cpu, 0))
    const report = {
      loadSeconds: LOAD_SECONDS,
      claudePromptsSentSecondsIntoLoad: Math.round((promptsSentAt - (deadline - LOAD_SECONDS * 1000)) / 1000),
      frames: {
        count: frames.length,
        fps: Math.round((frames.length / LOAD_SECONDS) * 10) / 10,
        p50ms: pct(frames, 50),
        p95ms: pct(frames, 95),
        p99ms: pct(frames, 99),
        maxMs: Math.round(Math.max(0, ...frames)),
        over50ms: frames.filter((f) => f > 50).length
      },
      longTasks: {
        count: renderer.longTasks.length,
        totalMs: Math.round(renderer.longTasks.reduce((a, b) => a + b, 0)),
        maxMs: Math.round(Math.max(0, ...renderer.longTasks))
      },
      typingLatencyMs: { samples: latencies.length, p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(0, ...latencies) },
      // Average cores busy over the whole window (cumulative CPU seconds / wall seconds).
      // 1.0 = one core fully busy. Main = Electron main process (PTYs, batching, IPC).
      coresUsedAvg: {
        main: coresUsed('Browser'),
        renderer: coresUsed('Tab'),
        gpu: coresUsed('GPU')
      },
      cpuPercentSampledP50: {
        main: pct(byType('Browser'), 50),
        renderer: pct(byType('Tab'), 50)
      },
      memoryMB: cpuSamples.at(-1)?.reduce((acc, m) => ({ ...acc, [m.type]: (acc[m.type] ?? 0) + m.memMB }), {} as Record<string, number>),
      // Same cols tiled and maximized; how much of the host width the terminal actually fills.
      maximizedFill: fill,
      flowControlWarnings: warnings,
      claudeScreens: screens
    }
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))

    await closeApp(ctx)
    rmSync(claudeDir, { recursive: true, force: true })
    expect(report.flowControlWarnings).toEqual([])
  })
})
