import http from 'http'
import type { AddressInfo } from 'net'
import { HOOK_AGENTS, readHook } from './hookEvents'
import type { HookAgent, HookReading } from './hookEvents'
import type { PaneTokens } from './paneTokens'

export interface HookEvent extends HookReading {
  terminalId: string
  agent: HookAgent
}

const MAX_BODY_BYTES = 1_000_000

/**
 * Localhost-only HTTP endpoint that agent hooks report to: POST /hook/<agent> with
 * `Authorization: Bearer <PITWALL_TOKEN>` and the agent's hook JSON as the body.
 *
 * - Binds 127.0.0.1 on an OS-assigned port (no fixed port to collide with another app or a
 *   second copy); terminals learn the URL from PITWALL_HOOK_URL in their environment.
 * - The bearer token identifies the terminal (see PaneTokens). Unknown or revoked tokens get
 *   401, so only processes running inside a live Pitwall terminal can report.
 * - Requests carrying an Origin header are refused: hooks are curl/PowerShell processes, which
 *   never send one, while a web page's request always does (blocks drive-by CSRF from a browser).
 * - Answers 204 with no body: the relay forwards nothing back into the agent (Claude Code and
 *   Codex add some hooks' stdout to the model's context).
 */
export class HookServer {
  private server: http.Server | null = null
  private port: number | null = null

  constructor(
    private tokens: PaneTokens,
    private onEvent: (event: HookEvent) => void
  ) {}

  /** Start listening; resolves with the assigned port. */
  start(): Promise<number> {
    const server = http.createServer((req, res) => this.handle(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        // Later errors must not crash the main process (an EventEmitter 'error' without a
        // listener throws); they only cost hook-based status detection.
        server.on('error', (err) => console.error('[hookServer]', err.message))
        this.port = (server.address() as AddressInfo).port
        resolve(this.port)
      })
    })
  }

  /** Base URL for PITWALL_HOOK_URL, or null before start(). */
  url(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}/hook`
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = null
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reply = (code: number): void => {
      res.writeHead(code).end()
    }
    if (req.method !== 'POST') return reply(405)
    if (req.headers.origin) return reply(403)

    const match = /^\/hook\/([a-z]+)\/?$/.exec((req.url ?? '').split('?')[0])
    const agent = match?.[1] as HookAgent | undefined
    if (!agent || !HOOK_AGENTS.includes(agent)) return reply(404)

    const auth = req.headers.authorization ?? ''
    const terminalId = this.tokens.resolve(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null)
    if (!terminalId) return reply(401)

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reply(413)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      let payload: unknown
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      } catch {
        return reply(400)
      }
      const reading = readHook(agent, payload)
      if (!reading) return reply(400)
      reply(204)
      this.onEvent({ ...reading, terminalId, agent })
    })
  }
}
