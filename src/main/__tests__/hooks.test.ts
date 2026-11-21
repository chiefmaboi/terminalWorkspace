import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneTokens } from '../paneTokens'
import { readHook, stateForCodexHook } from '../hookEvents'
import { HookServer } from '../hookServer'
import type { HookEvent } from '../hookServer'

describe('PaneTokens', () => {
  it('issues a distinct 64-hex token per terminal and resolves it back', () => {
    const tokens = new PaneTokens()
    const a = tokens.issue('a')
    const b = tokens.issue('b')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
    expect(tokens.resolve(a)).toBe('a')
    expect(tokens.resolve(b)).toBe('b')
  })

  it('reissuing (a restart) invalidates the previous token; revoke invalidates it too', () => {
    const tokens = new PaneTokens()
    const first = tokens.issue('a')
    const second = tokens.issue('a')
    expect(tokens.resolve(first)).toBeNull()
    expect(tokens.resolve(second)).toBe('a')
    tokens.revoke('a')
    expect(tokens.resolve(second)).toBeNull()
  })

  it('rejects missing, malformed and unknown tokens', () => {
    const tokens = new PaneTokens()
    tokens.issue('a')
    for (const bad of [null, undefined, '', 'nope', 'f'.repeat(63), 'g'.repeat(64), '0'.repeat(64)]) {
      expect(tokens.resolve(bad)).toBeNull()
    }
  })
})

describe('hook adapters', () => {
  it('maps Codex events: PermissionRequest is the waiting signal, Interrupt is idle', () => {
    expect(stateForCodexHook('PermissionRequest')).toBe('waiting')
    expect(stateForCodexHook('UserPromptSubmit')).toBe('working')
    expect(stateForCodexHook('Stop')).toBe('idle')
    expect(stateForCodexHook('Interrupt')).toBe('idle')
    expect(stateForCodexHook('SessionEnd')).toBe('idle')
    expect(stateForCodexHook('SubagentStop')).toBeNull()
    expect(stateForCodexHook('SessionStart')).toBeNull()
  })

  it('reads Claude payloads: state, notification text and cwd', () => {
    expect(readHook('claude', { hook_event_name: 'Notification', message: 'Claude needs permission', cwd: '/r' })).toEqual({
      state: 'waiting',
      message: 'Claude needs permission',
      cwd: '/r',
      sessionEnded: false,
      eventName: 'Notification'
    })
    // SessionStart carries no state but does carry the session's cwd (a worktree, say).
    expect(readHook('claude', { hook_event_name: 'SessionStart', cwd: '/r/.worktrees/x' })).toMatchObject({
      state: null,
      cwd: '/r/.worktrees/x'
    })
    expect(readHook('claude', { hook_event_name: 'SessionEnd' })).toMatchObject({ state: 'idle', sessionEnded: true })
  })

  it('reads Codex payloads, keeping the approval message generic (commands can contain secrets)', () => {
    expect(
      readHook('codex', {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'curl -H "Authorization: Bearer s3cret" https://example.test' },
        cwd: 'C:\\repo'
      })
    ).toEqual({
      state: 'waiting',
      message: 'Codex needs your approval',
      cwd: 'C:\\repo',
      sessionEnded: false,
      eventName: 'PermissionRequest'
    })
  })

  it('reads the generic {state} shape and rejects anything unusable', () => {
    expect(readHook('generic', { state: 'working', message: 'building' })).toMatchObject({
      state: 'working',
      message: 'building'
    })
    expect(readHook('generic', { state: 'busy' })).toBeNull()
    expect(readHook('claude', { nothing: true })).toBeNull()
    expect(readHook('codex', 'not an object')).toBeNull()
  })
})

describe('HookServer', () => {
  let server: HookServer
  let tokens: PaneTokens
  let events: HookEvent[]
  let url: string

  beforeEach(async () => {
    tokens = new PaneTokens()
    events = []
    server = new HookServer(tokens, (e) => events.push(e))
    await server.start()
    url = server.url()!
  })
  afterEach(() => server.stop())

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  it('binds an OS-assigned loopback port (no fixed port)', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/)
    expect(url).not.toContain(':47823')
  })

  it('routes an event to the terminal its token belongs to, with 204 and no body', async () => {
    const tA = tokens.issue('A')
    tokens.issue('B')
    const res = await post('/claude', { hook_event_name: 'Notification', message: 'hi', cwd: '/same' }, {
      Authorization: `Bearer ${tA}`
    })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 'A', agent: 'claude', state: 'waiting', message: 'hi' })
  })

  it('refuses requests without a valid token, from browsers, to unknown agents, or malformed', async () => {
    const token = tokens.issue('A')
    const auth = { Authorization: `Bearer ${token}` }
    expect((await post('/claude', { hook_event_name: 'Stop' })).status).toBe(401)
    expect((await post('/claude', { hook_event_name: 'Stop' }, { Authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
    expect((await post('/claude', { hook_event_name: 'Stop' }, { ...auth, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('/gemini', { hook_event_name: 'Stop' }, auth)).status).toBe(404)
    expect((await post('/claude', '{not json', auth)).status).toBe(400)
    expect((await post('/generic', { state: 'nope' }, auth)).status).toBe(400)
    expect((await fetch(`${url}/claude`)).status).toBe(405)
    expect(events).toHaveLength(0)
  })

  it('stops accepting a token once it is revoked', async () => {
    const token = tokens.issue('A')
    tokens.revoke('A')
    const res = await post('/codex', { hook_event_name: 'Stop' }, { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(401)
  })

  it('survives an error listener-less crash scenario: stop() then a new start() picks a new port', async () => {
    const first = server.url()
    server.stop()
    const again = new HookServer(tokens, vi.fn())
    await again.start()
    expect(again.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/)
    expect(first).toBeTruthy()
    again.stop()
  })
})
