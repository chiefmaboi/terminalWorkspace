import * as pty from 'node-pty'
import treeKill from 'tree-kill'
import os from 'os'
import { containsAttentionOsc } from './osc'
import { buildPtyEnv } from './ptyEnv'
import type { StatusManager } from './statusManager'

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? 'bash')
// Apps launched from Finder/Dock (not a Terminal) don't inherit the user's login-shell PATH, so
// tools installed via Homebrew/nvm/etc. (their PATH exports typically live in .zprofile /
// .bash_profile, which only a login shell sources) are invisible to a plain interactive shell.
// -l forces the same login-shell startup Terminal.app/iTerm2 use, matching VS Code's own default
// on macOS for this exact reason.
const SHELL_ARGS = process.platform === 'darwin' ? ['-l'] : []

// Output is coalesced per terminal before crossing IPC. The priority terminal (the one the user
// is looking at / typing into) flushes at roughly one frame; every other tile flushes far less
// often, which is plenty for a scaled-down preview and keeps IPC traffic flat as tiles multiply.
export const FLUSH_MS_PRIORITY = 16
export const FLUSH_MS_BACKGROUND = 150
// A burst bigger than this is flushed right away instead of waiting for the timer, bounding the
// size of any single IPC message.
export const MAX_PENDING_CHARS = 256 * 1024

// Flow control: output sent to the renderer but not yet acknowledged (xterm calls back once a
// write is parsed) is tracked per terminal. Past the high watermark the PTY is paused, which
// back-pressures the child process instead of letting the renderer's write queue grow without
// bound; it resumes once the renderer has caught up to the low watermark.
export const FLOW_HIGH_WATERMARK = 512 * 1024
export const FLOW_LOW_WATERMARK = 128 * 1024
// A PTY that stays paused this long without a single ack is resumed anyway (with a warning):
// acks are only ever lost through renderer failure, and a stuck pause silently freezes the agent.
export const FLOW_WATCHDOG_MS = 5000

interface Session {
  proc: pty.IPty
  terminalId: string
  idleTimer: NodeJS.Timeout | null
  pending: string[]
  pendingChars: number
  flushTimer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
  watchdog: NodeJS.Timeout | null
}

export class PtyManager {
  private sessions = new Map<string, Session>()
  private priorityId: string | null = null

  constructor(
    private statusManager: StatusManager,
    private onData: (terminalId: string, data: string) => void,
    private onExit: (terminalId: string, exitCode: number) => void,
    // How long output must stay silent before a "working" session is auto-marked idle. This is
    // a fallback signal that needs no Claude Code hook setup, user-tunable via Settings.
    private getIdleDebounceMs: () => number
  ) {}

  has(terminalId: string): boolean {
    return this.sessions.has(terminalId)
  }

  start(terminalId: string, cwd: string, startCommand: string, cols = 80, rows = 30): void {
    const existing = this.sessions.get(terminalId)
    if (existing) {
      // The renderer is (re)attaching to a live session, e.g. after a reload. Anything it had
      // not acknowledged yet died with the old renderer state, so reset flow control rather
      // than leave the PTY paused forever waiting for acks that will never come.
      existing.unacked = 0
      this.resumeIfPaused(existing)
      return
    }

    const proc = pty.spawn(DEFAULT_SHELL, SHELL_ARGS, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // Inherited env minus launcher/Pitwall-internal markers (see ptyEnv.ts).
      env: buildPtyEnv(process.env),
      useConpty: process.platform === 'win32'
    })

    const session: Session = {
      proc,
      terminalId,
      idleTimer: null,
      pending: [],
      pendingChars: 0,
      flushTimer: null,
      unacked: 0,
      paused: false,
      watchdog: null
    }
    this.sessions.set(terminalId, session)

    proc.onData((data) => {
      // A process that was stopped (restart/delete) can still emit trailing output after a new
      // session took over the same terminal id. Never let it bleed into the new session.
      if (!this.isCurrent(session)) return
      // Status detection runs on raw chunks, before batching, so it reacts immediately.
      if (containsAttentionOsc(data)) {
        this.statusManager.markWaiting(terminalId)
      }
      this.scheduleAutoIdle(session)
      this.enqueue(session, data)
    })

    proc.onExit(({ exitCode }) => {
      // Only the current session's exit is real news. A stopped or replaced process exiting
      // late must not delete the session that replaced it (the restart race) or report an exit
      // the renderer never asked about.
      if (!this.isCurrent(session)) return
      this.flush(session)
      this.clearTimers(session)
      this.sessions.delete(terminalId)
      this.onExit(terminalId, exitCode)
    })

    if (startCommand && startCommand.trim().length > 0) {
      proc.write(`${startCommand}${os.EOL}`)
    }
  }

  /** The terminal whose output should flush at the fast rate (selected / maximized), or null. */
  setPriority(terminalId: string | null): void {
    if (this.priorityId === terminalId) return
    this.priorityId = terminalId
    // Output that was waiting on the slow background timer is flushed now instead of making the
    // newly selected terminal look stale for up to FLUSH_MS_BACKGROUND.
    const session = terminalId ? this.sessions.get(terminalId) : undefined
    if (session?.flushTimer) this.flush(session)
  }

  /** The renderer finished parsing `chars` characters of output for this terminal. */
  ack(terminalId: string, chars: number): void {
    const session = this.sessions.get(terminalId)
    if (!session || !(chars > 0)) return
    session.unacked = Math.max(0, session.unacked - chars)
    if (session.unacked <= FLOW_LOW_WATERMARK) this.resumeIfPaused(session)
    // Still paused but the renderer is making progress: restart the watchdog window.
    else if (session.paused) this.armWatchdog(session)
  }

  /**
   * Forget all outstanding output and resume every paused PTY. Called when the renderer reloads,
   * crashes or hangs: its pending acks will never arrive, so waiting for them would leave the
   * PTYs paused (and the agents in them blocked) indefinitely.
   */
  resetFlowControl(reason: string): void {
    let resumed = 0
    for (const session of this.sessions.values()) {
      session.unacked = 0
      if (session.paused) resumed++
      this.resumeIfPaused(session)
    }
    if (resumed > 0) console.warn(`[pty] flow control reset (${reason}): resumed ${resumed} paused pty(s)`)
  }

  private isCurrent(session: Session): boolean {
    return this.sessions.get(session.terminalId) === session
  }

  private enqueue(session: Session, data: string): void {
    session.pending.push(data)
    session.pendingChars += data.length
    if (session.pendingChars >= MAX_PENDING_CHARS) {
      this.flush(session)
      return
    }
    if (!session.flushTimer) {
      const delay = session.terminalId === this.priorityId ? FLUSH_MS_PRIORITY : FLUSH_MS_BACKGROUND
      session.flushTimer = setTimeout(() => this.flush(session), delay)
    }
  }

  private flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.pendingChars === 0) return
    const data = session.pending.length === 1 ? session.pending[0] : session.pending.join('')
    session.pending = []
    session.pendingChars = 0
    session.unacked += data.length
    this.onData(session.terminalId, data)
    if (!session.paused && session.unacked > FLOW_HIGH_WATERMARK) {
      session.paused = true
      session.proc.pause()
      this.armWatchdog(session)
    }
  }

  private armWatchdog(session: Session): void {
    if (session.watchdog) clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      session.watchdog = null
      if (!this.isCurrent(session) || !session.paused) return
      console.warn(
        `[pty] ${session.terminalId}: paused ${FLOW_WATCHDOG_MS}ms with no ack ` +
          `(${session.unacked} chars outstanding), resuming`
      )
      // Treat the outstanding output as lost; otherwise the next flush would pause again at once.
      session.unacked = 0
      this.resumeIfPaused(session)
    }, FLOW_WATCHDOG_MS)
  }

  private resumeIfPaused(session: Session): void {
    if (session.watchdog) {
      clearTimeout(session.watchdog)
      session.watchdog = null
    }
    if (!session.paused) return
    session.paused = false
    session.proc.resume()
  }

  private clearTimers(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.flushTimer) clearTimeout(session.flushTimer)
    if (session.watchdog) clearTimeout(session.watchdog)
    session.idleTimer = null
    session.flushTimer = null
    session.watchdog = null
  }

  private scheduleAutoIdle(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (this.statusManager.get(session.terminalId) === 'working') {
        this.statusManager.markIdle(session.terminalId)
      }
    }, this.getIdleDebounceMs())
  }

  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    if (data.includes('\r') || data.includes('\n')) {
      this.statusManager.markLikelyWorking(terminalId)
    }
    session.proc.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    try {
      session.proc.resize(Math.max(cols, 1), Math.max(rows, 1))
    } catch {
      // ignore resize races during teardown
    }
  }

  stop(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session) return Promise.resolve()
    // Pending output of a deliberately stopped session is dropped: the terminal is being
    // restarted or deleted, and the late onExit is ignored by the isCurrent() check.
    this.clearTimers(session)
    this.sessions.delete(terminalId)
    return new Promise((resolve) => {
      treeKill(session.proc.pid, 'SIGTERM', () => resolve())
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }
}
