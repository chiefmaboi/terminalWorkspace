import { randomBytes, timingSafeEqual } from 'crypto'

/**
 * Per-terminal hook tokens.
 *
 * Every spawned terminal gets a fresh random token in its environment (PITWALL_TOKEN). An agent
 * hook running inside that terminal inherits it and sends it back with each event, which is how
 * the hook server knows which terminal the event belongs to (two terminals in the same folder are
 * no longer confused) and that the sender really runs inside a Pitwall terminal. Restarting a
 * terminal issues a new token, so a stale process from before can't report for the new one.
 */
export class PaneTokens {
  private byTerminal = new Map<string, string>()
  private byToken = new Map<string, string>()

  /** A new token for a terminal (replacing and invalidating any previous one). */
  issue(terminalId: string): string {
    this.revoke(terminalId)
    const token = randomBytes(32).toString('hex')
    this.byTerminal.set(terminalId, token)
    this.byToken.set(token, terminalId)
    return token
  }

  /** The terminal a token belongs to, or null for unknown / revoked tokens. */
  resolve(token: string | null | undefined): string | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null
    const terminalId = this.byToken.get(token)
    if (!terminalId) return null
    // Re-compare in constant time against the stored value (defense in depth: the Map lookup
    // itself already requires an exact match).
    const stored = this.byTerminal.get(terminalId)
    if (!stored || !timingSafeEqual(Buffer.from(stored), Buffer.from(token))) return null
    return terminalId
  }

  revoke(terminalId: string): void {
    const token = this.byTerminal.get(terminalId)
    if (token) this.byToken.delete(token)
    this.byTerminal.delete(terminalId)
  }
}
