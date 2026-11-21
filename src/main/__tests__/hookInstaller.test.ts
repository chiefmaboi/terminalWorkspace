import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  HookInstaller,
  RELAY_SCRIPT,
  posixRelayCommand,
  windowsRelayCommand
} from '../hookInstaller'

let base: string
let claudeDir: string
let codexDir: string
let script: string
let installer: HookInstaller

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pitwall-installer-'))
  claudeDir = join(base, 'claude')
  codexDir = join(base, 'codex')
  script = join(base, 'userData', 'hooks', 'pitwall-hook.ps1')
  installer = new HookInstaller({
    relayScriptPath: script,
    env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir },
    home: join(base, 'home')
  })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf-8'))
const install = async (agent: 'claude' | 'codex'): Promise<{ ok: boolean; backupPath?: string; error?: string }> => {
  const plan = await installer.plan(agent, 'install')
  return installer.apply(agent, 'install', plan.beforeHash)
}
const statusOf = async (agent: 'claude' | 'codex'): Promise<string> =>
  (await installer.status()).find((s) => s.agent === agent)!.state

describe('HookInstaller paths', () => {
  it('honors CLAUDE_CONFIG_DIR / CODEX_HOME, defaulting to ~/.claude and ~/.codex', () => {
    expect(installer.configPath('claude')).toBe(join(claudeDir, 'settings.json'))
    expect(installer.configPath('codex')).toBe(join(codexDir, 'hooks.json'))
    const defaults = new HookInstaller({ relayScriptPath: script, env: {}, home: '/home/me' })
    expect(defaults.configPath('claude')).toBe(join('/home/me', '.claude', 'settings.json'))
    expect(defaults.configPath('codex')).toBe(join('/home/me', '.codex', 'hooks.json'))
  })
})

describe('HookInstaller: Claude Code', () => {
  it('creates settings.json with a guarded relay on every Pitwall event when none exists', async () => {
    expect(await statusOf('claude')).toBe('missing')
    const result = await install('claude')
    expect(result).toEqual({ ok: true, backupPath: undefined })
    const hooks = readJson(join(claudeDir, 'settings.json')).hooks as Record<string, Array<{ hooks: unknown[] }>>
    expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_EVENTS].sort())
    for (const event of CLAUDE_EVENTS) {
      expect(hooks[event]).toEqual([{ hooks: [{ type: 'command', command: posixRelayCommand('claude'), timeout: 5 }] }])
    }
    expect(await statusOf('claude')).toBe('installed')
  })

  it('keeps unrelated settings and existing hooks, appends after them, and backs the file up', async () => {
    mkdirSync(claudeDir, { recursive: true })
    const existing = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
    }
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2) + '\n')
    const result = await install('claude')
    expect(result.ok).toBe(true)
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true)
    expect(readJson(result.backupPath!)).toEqual(existing)

    const after = readJson(join(claudeDir, 'settings.json'))
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual({ allow: ['Bash(ls)'] })
    const stop = (after.hooks as Record<string, unknown[]>).Stop
    expect(stop[0]).toEqual(existing.hooks.Stop[0]) // the user's hook keeps position 0
    expect(JSON.stringify(stop[1])).toContain('PITWALL_TOKEN')
  })

  it('is idempotent: a second install changes nothing and makes no backup', async () => {
    await install('claude')
    const plan = await installer.plan('claude', 'install')
    expect(plan.changed).toBe(false)
    expect((await installer.apply('claude', 'install', plan.beforeHash)).backupPath).toBeUndefined()
    expect(readdirSync(claudeDir).filter((f) => f.includes('pitwall-backup'))).toHaveLength(0)
  })

  it('updates an outdated Pitwall entry in place, leaving other groups where they are', async () => {
    mkdirSync(claudeDir, { recursive: true })
    const old = { type: 'command', command: 'curl old-relay $PITWALL_TOKEN', timeout: 1 }
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [old] }, { hooks: [{ type: 'command', command: 'mine' }] }] } })
    )
    expect(await statusOf('claude')).toBe('outdated')
    await install('claude')
    const stop = (readJson(join(claudeDir, 'settings.json')).hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop
    expect(stop).toHaveLength(2)
    expect(stop[0].hooks[0]).toMatchObject({ command: posixRelayCommand('claude') })
    expect(stop[1].hooks[0]).toEqual({ type: 'command', command: 'mine' })
  })

  it('uninstall removes only Pitwall entries', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } })
    )
    await install('claude')
    const plan = await installer.plan('claude', 'uninstall')
    expect(plan.diff.some((l) => l.kind === 'del' && l.text.includes('PITWALL_TOKEN'))).toBe(true)
    expect((await installer.apply('claude', 'uninstall', plan.beforeHash)).ok).toBe(true)
    expect(readJson(join(claudeDir, 'settings.json'))).toEqual({
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }
    })
  })

  it('never touches a file that is not plain JSON', async () => {
    mkdirSync(claudeDir, { recursive: true })
    const jsonc = '{\n  // a comment\n  "model": "opus"\n}\n'
    writeFileSync(join(claudeDir, 'settings.json'), jsonc)
    const plan = await installer.plan('claude', 'install')
    expect(plan.error).toMatch(/won't modify it/)
    expect((await installer.apply('claude', 'install', plan.beforeHash)).ok).toBe(false)
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe(jsonc)
    expect(await statusOf('claude')).toBe('error')
  })

  it('refuses to apply if the file changed after review', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), '{"a":1}')
    const plan = await installer.plan('claude', 'install')
    writeFileSync(join(claudeDir, 'settings.json'), '{"a":2}')
    const result = await installer.apply('claude', 'install', plan.beforeHash)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed since you reviewed/)
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"a":2}')
  })

  it('flags reformatting only for real formatting differences', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ a: 1 }, null, 2)) // no final newline
    expect((await installer.plan('claude', 'install')).reformatted).toBe(false)
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ a: 1 }, null, 4) + '\n')
    expect((await installer.plan('claude', 'install')).reformatted).toBe(true)
  })

  it('keeps CRLF line endings', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), '{\r\n  "a": 1\r\n}\r\n')
    await install('claude')
    const text = readFileSync(join(claudeDir, 'settings.json'), 'utf-8')
    expect(text.includes('\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })
})

describe('HookInstaller: Codex', () => {
  it('appends after the user\'s hooks (Codex trusts hooks by position) and writes the relay script', async () => {
    mkdirSync(codexDir, { recursive: true })
    const userGroup = { hooks: [{ type: 'command', command: 'python scribe.py', commandWindows: 'python scribe.py' }] }
    writeFileSync(
      join(codexDir, 'hooks.json'),
      JSON.stringify({ description: 'mine', hooks: { Stop: [userGroup], UserPromptSubmit: [userGroup] } }, null, 2)
    )
    expect((await install('codex')).ok).toBe(true)
    const after = readJson(join(codexDir, 'hooks.json'))
    expect(after.description).toBe('mine')
    const hooks = after.hooks as Record<string, unknown[]>
    expect(Object.keys(hooks).sort()).toEqual([...CODEX_EVENTS].sort())
    expect(hooks.Stop[0]).toEqual(userGroup) // still group 0: its trust key is unchanged
    expect(hooks.Stop[1]).toEqual({
      hooks: [
        {
          type: 'command',
          command: posixRelayCommand('codex'),
          commandWindows: windowsRelayCommand(script, 'codex'),
          timeout: 3,
          async: true
        }
      ]
    })
    expect(readFileSync(script, 'utf-8')).toBe(RELAY_SCRIPT)
    expect(await statusOf('codex')).toBe('installed')
  })

  it('an install from before SessionEnd was dropped shows as outdated; updating removes only that entry', async () => {
    mkdirSync(codexDir, { recursive: true })
    expect(CODEX_EVENTS).not.toContain('SessionEnd')
    const relay = {
      type: 'command',
      command: posixRelayCommand('codex'),
      commandWindows: windowsRelayCommand(script, 'codex'),
      timeout: 3,
      async: true
    }
    const userGroup = { hooks: [{ type: 'command', command: 'python scribe.py' }] }
    const old: Record<string, unknown[]> = { SessionEnd: [userGroup, { hooks: [relay] }] }
    for (const event of CODEX_EVENTS) old[event] = [{ hooks: [relay] }]
    writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify({ hooks: old }, null, 2))
    expect(await statusOf('codex')).toBe('outdated')
    expect((await install('codex')).ok).toBe(true)
    const hooks = readJson(join(codexDir, 'hooks.json')).hooks as Record<string, unknown[]>
    expect(hooks.SessionEnd).toEqual([userGroup]) // the user's own SessionEnd hook stays, at index 0
    for (const event of CODEX_EVENTS) expect(hooks[event]).toEqual([{ hooks: [relay] }]) // untouched: trust kept
    expect(await statusOf('codex')).toBe('installed')
  })

  it('the relay command is guarded, silent and always exits 0', () => {
    const cmd = posixRelayCommand('codex')
    expect(cmd.startsWith('[ -n "$PITWALL_TOKEN" ] && [ -n "$PITWALL_HOOK_URL" ] &&')).toBe(true)
    expect(cmd).toContain('>/dev/null 2>&1; exit 0')
    expect(RELAY_SCRIPT).toContain('if (-not $env:PITWALL_TOKEN -or -not $env:PITWALL_HOOK_URL) { exit 0 }')
    expect(/^[\x00-\x7f]*$/.test(RELAY_SCRIPT)).toBe(true) // ASCII: PowerShell 5.1 reads it without a BOM
  })
})
