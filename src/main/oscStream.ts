/**
 * Streaming OSC (Operating System Command) parser for one PTY's output.
 *
 * PTY output arrives in arbitrary chunks, so an escape sequence can be split anywhere, even
 * between the ESC and the "]" that introduce it, or between the ESC and "\" that end it. Each
 * terminal gets one OscStream; feed() every raw chunk in order and it returns the sequences that
 * completed in that chunk, carrying any unfinished tail over to the next call.
 *
 * Recognized sequences (ST = BEL, ESC \ or the C1 byte U+009C):
 *
 *   Attention ("this session needs you"):
 *     OSC 9 ; <message> ST                  iTerm2 / Growl style notification
 *     OSC 777 ; notify ; <title> ; <body> ST   rxvt / VTE notify-send style
 *     OSC 99 ; <metadata> ; <payload> ST    kitty desktop notification protocol
 *   Working directory:
 *     OSC 7 ; file://<host>/<path> ST       xterm / VTE / macOS Terminal
 *     OSC 9 ; 9 ; "<path>" ST               ConEmu / Windows Terminal (Pitwall's PowerShell)
 *     OSC 633 ; P ; Cwd=<path> ST           VS Code shell integration
 *
 * OSC 9 with a numeric subcommand (9;4 progress bar, 9;9 cwd, ...) is ConEmu's extension, not a
 * notification. An ESC inside a sequence that isn't the start of ST cancels it, as in xterm.
 */

export type OscEvent =
  | { kind: 'attention'; source: 'osc9' | 'osc777' | 'osc99'; message: string }
  | { kind: 'cwd'; path: string }

/** Longest unterminated sequence carried between chunks; anything longer is dropped. */
export const MAX_OSC_LENGTH = 8192

const ESC = '\x1b'
const OSC_START = '\x1b]'

type Terminator = { bodyEnd: number; next: number } | { abortAt: number } | null

/** Where the OSC body starting at `from` ends, whether an ESC cancelled it, or null (incomplete). */
function findTerminator(text: string, from: number): Terminator {
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x07 || c === 0x9c) return { bodyEnd: i, next: i + 1 }
    if (c === 0x1b) {
      if (i + 1 >= text.length) return null // ESC as the last char: could be the first half of ST
      if (text[i + 1] === '\\') return { bodyEnd: i, next: i + 2 }
      return { abortAt: i } // ESC starts something else: this OSC is cancelled
    }
  }
  return null
}

export class OscStream {
  private carry = ''

  feed(chunk: string): OscEvent[] {
    const text = this.carry ? this.carry + chunk : chunk
    this.carry = ''
    const events: OscEvent[] = []

    let start = text.indexOf(OSC_START)
    while (start >= 0) {
      const end = findTerminator(text, start + 2)
      if (end === null) {
        const tail = text.slice(start)
        if (tail.length <= MAX_OSC_LENGTH) this.carry = tail
        return events
      }
      if ('abortAt' in end) {
        start = text.indexOf(OSC_START, end.abortAt)
        continue
      }
      const event = interpret(text.slice(start + 2, end.bodyEnd))
      if (event) events.push(event)
      start = text.indexOf(OSC_START, end.next)
    }
    // A lone ESC at the very end may be the first half of the next OSC introducer.
    if (text.endsWith(ESC)) this.carry = ESC
    return events
  }
}

function interpret(body: string): OscEvent | null {
  const semi = body.indexOf(';')
  const code = semi < 0 ? body : body.slice(0, semi)
  const rest = semi < 0 ? '' : body.slice(semi + 1)
  switch (code) {
    case '9':
      if (/^\d+(;|$)/.test(rest)) {
        if (rest.startsWith('9;')) return cwdEvent(stripQuotes(rest.slice(2).trim()))
        return null // other ConEmu subcommands (4 = progress, ...)
      }
      return { kind: 'attention', source: 'osc9', message: rest }
    case '777': {
      const [command, ...parts] = rest.split(';')
      if (command.toLowerCase() !== 'notify') return null
      return { kind: 'attention', source: 'osc777', message: parts.filter(Boolean).join(': ') }
    }
    case '99':
      return kittyNotification(rest)
    case '7':
      return cwdEvent(fromFileUrl(rest))
    case '633':
      return rest.startsWith('P;Cwd=') ? cwdEvent(decode633(rest.slice('P;Cwd='.length))) : null
    default:
      return null
  }
}

/**
 * kitty OSC 99: `<metadata>;<payload>`, metadata is colon-separated key=value pairs.
 * p= says what the payload is (title/body show a notification; close, ?, alive, icon... don't).
 * d=0 means more chunks of this notification follow; it fires on the final chunk (d=1/absent).
 */
function kittyNotification(rest: string): OscEvent | null {
  const semi = rest.indexOf(';')
  const metadata = semi < 0 ? rest : rest.slice(0, semi)
  const payload = semi < 0 ? '' : rest.slice(semi + 1)
  const fields = new Map<string, string>()
  for (const pair of metadata.split(':')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    fields.set(eq < 0 ? pair : pair.slice(0, eq), eq < 0 ? '' : pair.slice(eq + 1))
  }
  const p = fields.get('p') ?? 'title'
  if (p !== 'title' && p !== 'body') return null
  if (fields.get('d') === '0') return null
  // e=1: base64 payload. The message is only informational here; don't decode untrusted data.
  return { kind: 'attention', source: 'osc99', message: fields.get('e') === '1' ? '' : payload }
}

function cwdEvent(path: string | null): OscEvent | null {
  return path ? { kind: 'cwd', path } : null
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/** VS Code escapes ';' and '\' inside the value as \x3b and \\. */
function decode633(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\/g, '\\')
}

function fromFileUrl(payload: string): string | null {
  let url: URL
  try {
    url = new URL(payload)
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // file://host/C:/Users/me -> C:\Users\me
  if (/^\/[A-Za-z]:/.test(path)) return path.slice(1).replace(/\//g, '\\')
  return path || null
}
