/**
 * Shell-reported working directory, parsed from the PTY output stream.
 *
 * Shells (or prompt frameworks) announce their cwd with one of three escape sequences:
 * - OSC 7      `ESC ] 7 ; file://host/path ST`      (the xterm/VTE convention, macOS Terminal)
 * - OSC 9;9    `ESC ] 9 ; 9 ; "C:\path" ST`         (ConEmu / Windows Terminal; Pitwall's own
 *                                                    PowerShell integration emits this one)
 * - OSC 633 P  `ESC ] 633 ; P ; Cwd=path ST`        (VS Code shell integration)
 * ST is BEL or ESC \. Sequences can be split across PTY chunks, so an unterminated tail is
 * carried over to the next chunk (bounded, so a stray ESC ] can't grow it forever).
 */

const MAX_CARRY = 4096
const CWD_OSC = /\x1b\](7;|9;9;|633;P;Cwd=)([^\x07\x1b]*)(?:\x07|\x1b\\)/g

export interface CwdScan {
  /** The last cwd reported in this chunk, or null if none was. */
  cwd: string | null
  /** Unterminated OSC tail to prepend to the next chunk. */
  carry: string
}

export function scanCwdReports(chunk: string, carry: string): CwdScan {
  const text = carry + chunk
  if (!text.includes('\x1b]')) return { cwd: null, carry: '' }

  let cwd: string | null = null
  let consumed = 0
  CWD_OSC.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CWD_OSC.exec(text)) !== null) {
    const parsed = parsePayload(match[1], match[2])
    if (parsed) cwd = parsed
    consumed = CWD_OSC.lastIndex
  }

  // Carry an OSC that started after the last complete match but hasn't terminated yet.
  const lastStart = text.lastIndexOf('\x1b]')
  let nextCarry = ''
  if (lastStart >= consumed) {
    const tail = text.slice(lastStart)
    const terminated = tail.includes('\x07') || tail.includes('\x1b\\')
    if (!terminated && tail.length <= MAX_CARRY) nextCarry = tail
  }
  return { cwd, carry: nextCarry }
}

function parsePayload(kind: string, payload: string): string | null {
  if (kind === '7;') return fromFileUrl(payload)
  if (kind === '9;9;') return stripQuotes(payload.trim()) || null
  // VS Code escapes ';' and '\' inside the value as \x3b and \\.
  const value = payload.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  return value.replace(/\\\\/g, '\\') || null
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
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
