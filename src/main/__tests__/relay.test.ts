import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { HookServer } from '../hookServer'
import type { HookEvent } from '../hookServer'
import { PaneTokens } from '../paneTokens'
import { posixRelayCommand } from '../hookInstaller'

/**
 * The installed relay, run by a real shell against a live HookServer: exactly what an agent
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

describe.skipIf(!bash)('relay (Claude Code, through bash)', () => {
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

