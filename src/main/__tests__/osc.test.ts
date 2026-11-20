import { describe, expect, it } from 'vitest'
import { containsAttentionOsc } from '../osc'

const ESC = '\x1b'
const BEL = '\x07'

describe('containsAttentionOsc', () => {
  it('returns false for plain text with no escape sequences', () => {
    expect(containsAttentionOsc('hello world\n')).toBe(false)
  })

  it('detects an OSC 9 notification', () => {
    expect(containsAttentionOsc(`${ESC}]9;build finished${BEL}`)).toBe(true)
  })

  it('detects an OSC 777 notify sequence', () => {
    expect(containsAttentionOsc(`${ESC}]777;notify;Title;Body${BEL}`)).toBe(true)
  })

  it('ignores OSC 777 sequences that are not a notify subcommand', () => {
    expect(containsAttentionOsc(`${ESC}]777;other;Title;Body${BEL}`)).toBe(false)
  })

  it('ignores unrelated OSC codes such as window-title (OSC 0/2)', () => {
    expect(containsAttentionOsc(`${ESC}]0;my terminal title${BEL}`)).toBe(false)
  })

  it('finds an attention OSC embedded in a larger chunk of output', () => {
    const chunk = `some output\n${ESC}]9;done${BEL}\nmore output`
    expect(containsAttentionOsc(chunk)).toBe(true)
  })

  it('ignores OSC 9 numeric subcommands: 9;9 cwd reports and 9;4 progress', () => {
    const ST = `${ESC}\\`
    expect(containsAttentionOsc(`${ESC}]9;9;"C:\\Users\\me"${ST}`)).toBe(false)
    expect(containsAttentionOsc(`${ESC}]9;4;1;50${BEL}`)).toBe(false)
    // ...but still finds a real notification next to them.
    expect(containsAttentionOsc(`${ESC}]9;9;"C:\\x"${BEL}${ESC}]9;agent needs input${BEL}`)).toBe(true)
  })

  it('supports the ST (ESC \\\\) terminator as well as BEL', () => {
    expect(containsAttentionOsc(`${ESC}]9;done${ESC}\\`)).toBe(true)
  })
})
