import { describe, expect, it } from 'vitest'
import { MAX_OSC_LENGTH, OscStream } from '../oscStream'
import type { OscEvent } from '../oscStream'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`
const C1_ST = '\u009c'

const parse = (...chunks: string[]): OscEvent[] => {
  const stream = new OscStream()
  return chunks.flatMap((chunk) => stream.feed(chunk))
}
const attention = (message: string, source: 'osc9' | 'osc777' | 'osc99' = 'osc9'): OscEvent => ({
  kind: 'attention',
  source,
  message
})
const cwd = (path: string): OscEvent => ({ kind: 'cwd', path })

describe('OscStream: attention', () => {
  it('ignores plain text and unrelated OSC codes (window title)', () => {
    expect(parse('hello world\n')).toEqual([])
    expect(parse(`${ESC}]0;my title${BEL}${ESC}]2;other${ST}`)).toEqual([])
  })

  it('detects OSC 9 notifications with any terminator', () => {
    expect(parse(`${ESC}]9;build finished${BEL}`)).toEqual([attention('build finished')])
    expect(parse(`${ESC}]9;done${ST}`)).toEqual([attention('done')])
    expect(parse(`${ESC}]9;done${C1_ST}`)).toEqual([attention('done')])
    expect(parse(`${ESC}]9;42 tests passed${BEL}`)).toEqual([attention('42 tests passed')])
  })

  it('treats OSC 9 numeric subcommands as ConEmu extensions, not notifications', () => {
    expect(parse(`${ESC}]9;4;1;50${BEL}`)).toEqual([]) // progress bar
    expect(parse(`${ESC}]9;9;"C:\\x"${BEL}`)).toEqual([cwd('C:\\x')]) // cwd report
  })

  it('detects OSC 777 notify, and only notify', () => {
    expect(parse(`${ESC}]777;notify;Claude;Needs input${BEL}`)).toEqual([attention('Claude: Needs input', 'osc777')])
    expect(parse(`${ESC}]777;other;Title;Body${BEL}`)).toEqual([])
  })

  it('detects kitty OSC 99 notifications on their final chunk only', () => {
    expect(parse(`${ESC}]99;;Agent is waiting${ST}`)).toEqual([attention('Agent is waiting', 'osc99')])
    expect(parse(`${ESC}]99;i=1:d=0;Title${ST}`)).toEqual([]) // more chunks follow
    expect(parse(`${ESC}]99;i=1:d=1:p=body;Details${ST}`)).toEqual([attention('Details', 'osc99')])
    expect(parse(`${ESC}]99;i=1:p=close;${ST}`)).toEqual([]) // closing, not notifying
    expect(parse(`${ESC}]99;i=1:p=?;${ST}`)).toEqual([]) // capability query
    expect(parse(`${ESC}]99;e=1;QmFzZTY0${ST}`)).toEqual([attention('', 'osc99')]) // base64 not decoded
  })
})

describe('OscStream: working directory', () => {
  it('reads OSC 9;9 with a quoted Windows path (Pitwall PowerShell / Windows Terminal)', () => {
    expect(parse(`${ESC}]9;9;"C:\\Users\\me\\repo"${ST}PS C:\\Users\\me\\repo> `)).toEqual([cwd('C:\\Users\\me\\repo')])
  })

  it('reads OSC 7 file URLs, decoding percent-escapes and Windows drive paths', () => {
    expect(parse(`${ESC}]7;file://host/home/me/my%20repo${BEL}`)).toEqual([cwd('/home/me/my repo')])
    expect(parse(`${ESC}]7;file://host/C:/Users/me${BEL}`)).toEqual([cwd('C:\\Users\\me')])
    expect(parse(`${ESC}]7;not a url${BEL}${ESC}]7;http://x/y${BEL}`)).toEqual([])
  })

  it('reads VS Code OSC 633;P;Cwd with its \\x3b escapes', () => {
    expect(parse(`${ESC}]633;P;Cwd=/tmp/a\\x3bb${BEL}`)).toEqual([cwd('/tmp/a;b')])
    expect(parse(`${ESC}]633;A${BEL}`)).toEqual([]) // other shell-integration marks
  })
})

describe('OscStream: streaming', () => {
  // A realistic mix: prompt cwd report, output, a notification, a title, a progress update.
  const stream =
    `${ESC}]9;9;"C:\\repo"${ST}PS C:\\repo> claude\r\n` +
    `thinking...${ESC}]0;claude${BEL}${ESC}]9;4;1;30${BEL}` +
    `${ESC}]777;notify;Claude;Approve edit?${BEL}more output${ESC}]9;waiting on you${C1_ST}` +
    `${ESC}]7;file://host/C:/repo/.worktrees/feat${ST}done`
  const expected = [
    cwd('C:\\repo'),
    attention('Claude: Approve edit?', 'osc777'),
    attention('waiting on you'),
    cwd('C:\\repo\\.worktrees\\feat')
  ]

  it('parses the whole stream fed at once', () => {
    expect(parse(stream)).toEqual(expected)
  })

  it('gives identical events for a split at every possible position', () => {
    for (let i = 0; i <= stream.length; i++) {
      expect(parse(stream.slice(0, i), stream.slice(i)), `split at ${i}`).toEqual(expected)
    }
  })

  it('gives identical events fed one character at a time', () => {
    expect(parse(...stream.split(''))).toEqual(expected)
  })

  it('handles the awkward splits explicitly: ESC|], inside ST, ESC|\\', () => {
    expect(parse(`text${ESC}`, `]9;hi${BEL}`)).toEqual([attention('hi')])
    expect(parse(`${ESC}]9;hi${ESC}`, '\\')).toEqual([attention('hi')])
    expect(parse(`${ESC}]9;h`, 'i', `${ST}`)).toEqual([attention('hi')])
  })

  it('cancels an OSC interrupted by another escape sequence, without swallowing the next one', () => {
    expect(parse(`${ESC}]9;cut off${ESC}[31mred${ESC}]9;real${BEL}`)).toEqual([attention('real')])
  })

  it('drops an unterminated sequence longer than MAX_OSC_LENGTH and recovers', () => {
    const s = new OscStream()
    expect(s.feed(`${ESC}]9;${'x'.repeat(MAX_OSC_LENGTH + 10)}`)).toEqual([])
    expect(s.feed(`plain text${ESC}]9;after${BEL}`)).toEqual([attention('after')])
  })

  it('does not carry anything after a fully terminated chunk', () => {
    const s = new OscStream()
    s.feed(`${ESC}]9;one${BEL}`)
    expect(s.feed('no escapes here')).toEqual([])
  })
})
