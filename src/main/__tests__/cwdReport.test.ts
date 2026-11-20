import { describe, expect, it } from 'vitest'
import { scanCwdReports } from '../cwdReport'
import { parseLsofCwd, parsePidList } from '../processCwd'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

describe('scanCwdReports', () => {
  it('reads OSC 9;9 with a quoted Windows path (Pitwall PowerShell / Windows Terminal)', () => {
    const r = scanCwdReports(`${ESC}]9;9;"C:\\Users\\me\\repo"${ST}PS C:\\Users\\me\\repo> `, '')
    expect(r.cwd).toBe('C:\\Users\\me\\repo')
    expect(r.carry).toBe('')
  })

  it('reads OSC 7 file URLs, decoding percent-escapes and Windows drive paths', () => {
    expect(scanCwdReports(`${ESC}]7;file://host/home/me/my%20repo${BEL}`, '').cwd).toBe('/home/me/my repo')
    expect(scanCwdReports(`${ESC}]7;file://host/C:/Users/me${BEL}`, '').cwd).toBe('C:\\Users\\me')
  })

  it('reads VS Code OSC 633;P;Cwd with its \\x3b escapes', () => {
    expect(scanCwdReports(`${ESC}]633;P;Cwd=/tmp/a\\x3bb${BEL}`, '').cwd).toBe('/tmp/a;b')
  })

  it('returns the last report when a chunk has several', () => {
    const chunk = `${ESC}]9;9;"C:\\one"${ST}out${ESC}]9;9;"C:\\two"${ST}`
    expect(scanCwdReports(chunk, '').cwd).toBe('C:\\two')
  })

  it('reassembles a report split across chunks', () => {
    const first = scanCwdReports(`prompt${ESC}]9;9;"C:\\Use`, '')
    expect(first.cwd).toBeNull()
    expect(first.carry).toBe(`${ESC}]9;9;"C:\\Use`)
    const second = scanCwdReports(`rs\\me"${ST}PS> `, first.carry)
    expect(second.cwd).toBe('C:\\Users\\me')
    expect(second.carry).toBe('')
  })

  it('ignores other OSC codes and bounds the carry', () => {
    expect(scanCwdReports(`${ESC}]0;title${BEL}${ESC}]9;notify me${BEL}`, '').cwd).toBeNull()
    expect(scanCwdReports(`${ESC}]9;9;"${'x'.repeat(5000)}`, '').carry).toBe('')
  })
})

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
