import { describe, expect, it } from 'vitest'
import { parseLsofCwd, parsePidList } from '../processCwd'

describe('processCwd parsers', () => {
  it('parses pgrep / proc children pid lists', () => {
    expect(parsePidList('123\n456\n')).toEqual([123, 456])
    expect(parsePidList('789 790 ')).toEqual([789, 790])
    expect(parsePidList('')).toEqual([])
  })

  it('parses the cwd line out of lsof -Fn output', () => {
    expect(parseLsofCwd('p4242\nfcwd\nn/Users/me/repo/.worktrees/feature\n')).toBe('/Users/me/repo/.worktrees/feature')
    expect(parseLsofCwd('')).toBeNull()
  })
})
