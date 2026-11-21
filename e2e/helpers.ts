import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

/**
 * Launch the built app against an isolated profile. Pass `userDataDir` to relaunch against a
 * profile kept by closeApp(..., { keepUserData: true }), e.g. to check what persisted.
 */
export async function launchApp(
  extraEnv: Record<string, string> = {},
  options: { userDataDir?: string; isolateAgentConfig?: boolean } = {}
): Promise<LaunchedApp> {
  let userDataDir = options.userDataDir
  if (!userDataDir) {
    userDataDir = mkdtempSync(join(tmpdir(), 'pitwall-e2e-'))
    // Fresh test profiles start with desktop notifications off, so tests that make a tile
    // "waiting" don't pop OS toasts on the machine running them. (The app merges this with its
    // default settings exactly as it would a real saved profile.)
    writeFileSync(
      join(userDataDir, 'workspaces.json'),
      JSON.stringify({ workspaces: [], settings: { notificationsEnabled: false } })
    )
  }

  // require, not import: Playwright's test runner executes under plain Node, so requiring the
  // `electron` package here returns the path to the platform Electron binary (its normal
  // behavior outside of an actual Electron process) — exactly what executablePath needs.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronPath = require('electron') as unknown as string

  // Claude Code's settings.json (where hooks are installed) is redirected into the test profile,
  // so no test can ever install hooks into the real ~/.claude. Only the opt-in real-session
  // harness keeps the real config (its Claude sessions need the login).
  const isolation =
    options.isolateAgentConfig === false
      ? {}
      : { CLAUDE_CONFIG_DIR: join(userDataDir, 'claude-config') }
  const env = { ...process.env, ...isolation, ...extraEnv }
  // This sandboxed dev session sets ELECTRON_RUN_AS_NODE globally, which makes a bare
  // `electron` invocation run as plain Node instead of launching the app (app/BrowserWindow
  // undefined). Real user machines don't have this set, but strip it defensively either way.
  delete env.ELECTRON_RUN_AS_NODE
  env.PITWALL_USER_DATA_DIR = userDataDir

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env
  })
  const window = await appWindow(app)
  // 'domcontentloaded' fires before our SPA's React tree has actually mounted; wait for a
  // real rendered element instead of racing the app's own async startup (IPC round trip for
  // getWorkspaces() + getHookServerInfo() in the store's load()).
  await window.locator('.app-shell').waitFor({ state: 'attached', timeout: 30_000 })
  return { app, window, userDataDir }
}

// Pick the window that loaded the app's own file:// page rather than firstWindow(): with
// PITWALL_DEVTOOLS=1 a detached DevTools window can appear first.
async function appWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().startsWith('file:'))
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no app window; open windows: ${app.windows().map((w) => w.url()).join(', ')}`)
}

export async function closeApp(
  { app, userDataDir }: LaunchedApp,
  options: { keepUserData?: boolean } = {}
): Promise<void> {
  await app.close()
  if (options.keepUserData) return
  // The just-killed process can hold its userData files open for a brief moment after
  // app.close() resolves in this environment; retry the cleanup instead of throwing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}
