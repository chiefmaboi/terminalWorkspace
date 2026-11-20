import { describe, expect, it } from 'vitest'
import { buildPtyEnv, isDeniedEnvVar } from '../ptyEnv'

describe('buildPtyEnv', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CONFIG_DIR: '/home/me/.claude',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_CHILD_SESSION: '1',
    PITWALL_USER_DATA_DIR: '/tmp/pw',
    PITWALL_DEVTOOLS: '1',
    UNSET: undefined
  }

  it('strips CLAUDECODE, CLAUDE_CODE_* and PITWALL_*', () => {
    const env = buildPtyEnv(source)
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'PITWALL_USER_DATA_DIR',
      'PITWALL_DEVTOOLS'
    ]) {
      expect(env).not.toHaveProperty(name)
    }
  })

  it('keeps everything else, including look-alikes that are user configuration', () => {
    expect(buildPtyEnv(source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CONFIG_DIR: '/home/me/.claude'
    })
  })

  it('matches case-insensitively (Windows env names are)', () => {
    const env = buildPtyEnv({ ClaudeCode: '1', claude_code_x: '1', Pitwall_Pane_Id: 'x', Path: 'C:\\bin' })
    expect(env).toEqual({ Path: 'C:\\bin' })
  })

  it('does not over-match prefixes', () => {
    expect(isDeniedEnvVar('CLAUDECODE_HOME')).toBe(false) // exact name only, not a prefix
    expect(isDeniedEnvVar('CLAUDE_CODEX')).toBe(false) // CLAUDE_CODE_ needs the trailing underscore
    expect(isDeniedEnvVar('MY_PITWALL_THING')).toBe(false)
    expect(isDeniedEnvVar('PITWALL')).toBe(false)
  })

  it('returns a new object and leaves the source untouched', () => {
    const copy = { ...source }
    const env = buildPtyEnv(source)
    expect(env).not.toBe(source)
    expect(source).toEqual(copy)
  })
})
