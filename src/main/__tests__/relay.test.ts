import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HookServer } from '../hookServer'
import type { HookEvent } from '../hookServer'
import { PaneTokens } from '../paneTokens'
import { RELAY_SCRIPT, posixRelayCommand, windowsRelayCommand } from '../hookInstaller'

/**
 * The installed relays, run by real shells against a live HookServer: exactly what an agent
 * does when it fires a hook inside a Pitwall terminal.
 */

function findBash(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : 'bash'
  // Git Bash, which Claude Code uses on Windows (not WSL's bash, which can't see this loopback).
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (existsSync(p)) return p
  }
  return null
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
  verbatim = false
): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, windowsVerbatimArguments: verbatim })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += String(d)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }))
    child.stdin.end(stdin, 'utf-8')
  })
}

const baseEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('PITWALL_')) delete env[k]
  return env
}

let server: HookServer
let tokens: PaneTokens
let events: HookEvent[]

beforeEach(async () => {
  tokens = new PaneTokens()
  events = []
  server = new HookServer(tokens, (e) => events.push(e))
  await server.start()
})
afterEach(() => server.stop())

const bash = findBash()

describe.skipIf(!bash)('POSIX relay (Claude Code everywhere, Codex on macOS/Linux)', () => {
  it('delivers the hook JSON to the right terminal, printing nothing and exiting 0', async () => {
    const token = tokens.issue('T1')
    const payload = { hook_event_name: 'Notification', message: 'Claude needs permission', cwd: '/tmp/Zo\u00eb repo' }
    const result = await run(
      bash!,
      ['-c', posixRelayCommand('claude')],
      { ...baseEnv(), PITWALL_TOKEN: token, PITWALL_HOOK_URL: server.url()! },
      JSON.stringify(payload)
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 'T1', agent: 'claude', state: 'waiting', cwd: '/tmp/Zo\u00eb repo' })
  })

  it('does nothing outside a Pitwall terminal (no PITWALL_TOKEN)', async () => {
    const result = await run(bash!, ['-c', posixRelayCommand('claude')], baseEnv(), '{"hook_event_name":"Stop"}')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(events).toHaveLength(0)
  })

  it('still exits 0 quickly when Pitwall is not reachable', async () => {
    const token = tokens.issue('T1')
    server.stop()
    const result = await run(
      bash!,
      ['-c', posixRelayCommand('claude')],
      { ...baseEnv(), PITWALL_TOKEN: token, PITWALL_HOOK_URL: 'http://127.0.0.1:9/hook' },
      '{"hook_event_name":"Stop"}'
    )
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(10_000)
  })
})

describe.skipIf(process.platform !== 'win32')('PowerShell relay script (Codex on Windows)', () => {
  let dir: string
  let script: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pitwall-relay-'))
    script = join(dir, 'pitwall-hook.ps1')
    writeFileSync(script, RELAY_SCRIPT, 'utf-8')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const ps = (env: NodeJS.ProcessEnv, stdin: string): ReturnType<typeof run> =>
    run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'codex'],
      env,
      stdin
    )

  it('delivers a Codex PermissionRequest (UTF-8 intact) to the right terminal, silently', async () => {
    const token = tokens.issue('T2')
    const payload = {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
      cwd: 'C:\\Users\\Zo\u00eb\\repo'
    }
    const result = await ps({ ...baseEnv(), PITWALL_TOKEN: token, PITWALL_HOOK_URL: server.url()! }, JSON.stringify(payload))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      terminalId: 'T2',
      agent: 'codex',
      state: 'waiting',
      message: 'Codex needs your approval',
      cwd: 'C:\\Users\\Zo\u00eb\\repo'
    })
  }, 30_000)

  // The installed commandWindows line, launched the ways Codex launches it (codex-rs hooks
  // command_runner.rs): through PowerShell with -NoProfile -Command (a normally quoted argument),
  // or, with no shell configured, through %COMSPEC% /C with the line passed verbatim in quotes.
  it.each([
    ['powershell -Command', 'powershell.exe', (cmd: string) => ['-NoProfile', '-Command', cmd], false],
    ['cmd /C', process.env.ComSpec ?? 'cmd.exe', (cmd: string) => ['/C', `"${cmd}"`], true]
  ])('delivers through %s', async (_label, shell, args, verbatim) => {
    const token = tokens.issue('T3')
    const result = await run(
      shell,
      args(windowsRelayCommand(script, 'codex')),
      { ...baseEnv(), PITWALL_TOKEN: token, PITWALL_HOOK_URL: server.url()! },
      '{"hook_event_name":"Stop","cwd":"C:\\\\repo"}',
      verbatim
    )
    expect(result.code).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 'T3', agent: 'codex', state: 'idle', eventName: 'Stop' })
  }, 30_000)

  it('does nothing outside a Pitwall terminal and never fails', async () => {
    const result = await ps(baseEnv(), '{"hook_event_name":"Stop"}')
    expect(result.code).toBe(0)
    expect(events).toHaveLength(0)
    const unreachable = await ps(
      { ...baseEnv(), PITWALL_TOKEN: tokens.issue('T2'), PITWALL_HOOK_URL: 'http://127.0.0.1:9/hook' },
      '{"hook_event_name":"Stop"}'
    )
    expect(unreachable.code).toBe(0)
  }, 30_000)
})
