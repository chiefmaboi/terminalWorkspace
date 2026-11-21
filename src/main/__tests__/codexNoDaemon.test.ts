import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { withCodexNoDaemon } from '../codexNoDaemon'

describe('withCodexNoDaemon (start commands)', () => {
  it.each([
    ['codex', 'codex --no-daemon'],
    ['codex -a on-request -s read-only', 'codex --no-daemon -a on-request -s read-only'],
    ['codex "fix the tests"', 'codex --no-daemon "fix the tests"'],
    ['codex resume --last', 'codex --no-daemon resume --last'],
    ['codex fork', 'codex --no-daemon fork'],
    ['  codex.cmd -m gpt', '  codex.cmd --no-daemon -m gpt'],
    ['CODEX', 'CODEX --no-daemon']
  ])('adds --no-daemon to interactive %j', (input, expected) => {
    expect(withCodexNoDaemon(input)).toBe(expected)
  })

  it.each([
    'codex --no-daemon',
    'codex -a on-request --no-daemon',
    'codex exec "do it"',
    'codex e hi',
    'codex login',
    'codex agents',
    'codex app-server daemon stop',
    'codex mcp list',
    'claude',
    'npx codex',
    'codexx',
    'echo codex'
  ])('leaves %j unchanged', (input) => {
    expect(withCodexNoDaemon(input)).toBe(input)
  })
})

describe.skipIf(process.platform !== 'win32')('PowerShell codex wrapper (typed commands)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pitwall-fakecodex-'))
    writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\necho FAKECODEX args=[%*]\r\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('adds --no-daemon to interactive codex only, never twice, and resolves the real executable', async () => {
    const { POWERSHELL_INTEGRATION } = await import('../ptyManager')
    const script = [
      POWERSHELL_INTEGRATION,
      'codex -a on-request',
      'codex exec hi',
      'codex resume --last',
      'codex --no-daemon',
      'codex agents',
      'codex'
    ].join('\n')
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }, windowsHide: true }
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', (d) => (err += String(d)))
      child.on('error', reject)
      // PowerShell serializes progress records to stderr as CLIXML when output is redirected;
      // only an actual error record (S="Error") counts as a failure.
      child.on('close', () => (/S="Error"/.test(err) ? reject(new Error(err)) : resolve(out)))
    })
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('FAKECODEX'))
    expect(lines).toEqual([
      'FAKECODEX args=[--no-daemon -a on-request]',
      'FAKECODEX args=[exec hi]',
      'FAKECODEX args=[--no-daemon resume --last]',
      'FAKECODEX args=[--no-daemon]',
      'FAKECODEX args=[agents]',
      'FAKECODEX args=[--no-daemon]'
    ])
  }, 30_000)
})
