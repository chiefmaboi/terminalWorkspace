import * as pty from 'node-pty'
import treeKill from 'tree-kill'
import os from 'os'
import { OscStream } from './oscStream'
import { buildPtyEnv } from './ptyEnv'
import { foregroundCwd } from './processCwd'
import { CODEX_SESSION_SUBCOMMANDS, CODEX_SUBCOMMANDS, withCodexNoDaemon } from './codexNoDaemon'
import type { PaneCwd } from '../shared/types'
import type { StatusManager } from './statusManager'

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? 'bash')
// Apps launched from Finder/Dock (not a Terminal) don't inherit the user's login-shell PATH, so
// tools installed via Homebrew/nvm/etc. (their PATH exports typically live in .zprofile /
// .bash_profile, which only a login shell sources) are invisible to a plain interactive shell.
// -l forces the same login-shell startup Terminal.app/iTerm2 use, matching VS Code's own default
// on macOS for this exact reason.
//
// Windows: PowerShell gets a tiny prompt wrapper that reports the current location as OSC 9;9
// before the user's own prompt (the sequence Windows Terminal documents for this). Windows has
// no API for reading another process's cwd, and PowerShell's `cd` doesn't change its process cwd
// anyway, so the shell telling us is the only reliable signal. The user's prompt (profile,
// oh-my-posh, ...) is wrapped, not replaced, and renders exactly as before.
//
// It also wraps `codex` so that interactive Codex typed in a Pitwall terminal runs with
// --no-daemon (see codexNoDaemon.ts for why); the real executable is resolved from PATH and every
// other invocation passes through untouched.
const psList = (items: readonly string[]): string => items.map((s) => `'${s}'`).join(', ')
export const POWERSHELL_INTEGRATION = [
  '$global:__pitwallPrompt = $function:prompt',
  'function global:prompt {',
  '  $loc = $executionContext.SessionState.Path.CurrentLocation',
  "  $osc = ''",
  "  if ($loc.Provider.Name -eq 'FileSystem') { $osc = \"$([char]27)]9;9;`\"$($loc.ProviderPath)`\"$([char]27)\\\" }",
  '  if ($global:__pitwallPrompt) { $osc + (& $global:__pitwallPrompt) } else { $osc + "PS $loc> " }',
  '}',
  'function global:codex {',
  "  $real = Get-Command codex -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  if (-not $real) { Write-Error 'codex: command not found'; return }",
  "  $first = $args | Where-Object { \"$_\" -notlike '-*' } | Select-Object -First 1",
  `  $sub = @(${psList(CODEX_SUBCOMMANDS)}) -contains "$first"`,
  `  $session = (-not $sub) -or (@(${psList(CODEX_SESSION_SUBCOMMANDS)}) -contains "$first")`,
  "  if ($session -and -not ($args -contains '--no-daemon')) { & $real.Source --no-daemon @args } else { & $real.Source @args }",
  '}'
].join('\n')

const SHELL_ARGS =
  process.platform === 'darwin'
    ? ['-l']
    : process.platform === 'win32'
      ? ['-NoExit', '-EncodedCommand', Buffer.from(POWERSHELL_INTEGRATION, 'utf16le').toString('base64')]
      : []

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
  pending: string[]
  pendingChars: number
  flushTimer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
  watchdog: NodeJS.Timeout | null
  /** Where the shell was started (the terminal's project folder). */
  startCwd: string
  /** Last cwd the shell reported via OSC 7 / 9;9 / 633, if it reports at all. */
  reportedCwd: string | null
  /** The agent's cwd from its hook events (e.g. a worktree it moved into), while it runs. */
  agentCwd: string | null
  /** Streaming OSC parser: attention notifications and cwd reports, split-chunk safe. */
  osc: OscStream
}

export class PtyManager {
  private sessions = new Map<string, Session>()
  private priorityId: string | null = null

  /**
   * @param statusManager receives this terminal's status evidence: OSC notifications, output
   *   activity (for its idle timeout) and user input. It decides what the status actually is.
   */
  constructor(
    private statusManager: StatusManager,
    private onData: (terminalId: string, data: string) => void,
    private onExit: (terminalId: string, exitCode: number) => void,
    /** Extra per-terminal variables (PITWALL_PANE_ID / PITWALL_TOKEN / PITWALL_HOOK_URL). */
    private paneEnv: (terminalId: string) => Record<string, string> = () => ({})
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
      // Inherited env minus launcher/Pitwall-internal markers (see ptyEnv.ts), then this
      // terminal's own PITWALL_* variables, added after filtering so they can't be inherited.
      env: { ...buildPtyEnv(process.env), ...this.paneEnv(terminalId) },
      useConpty: process.platform === 'win32'
    })

    const session: Session = {
      proc,
      terminalId,
      pending: [],
      pendingChars: 0,
      flushTimer: null,
      unacked: 0,
      paused: false,
      watchdog: null,
      startCwd: cwd,
      reportedCwd: null,
      agentCwd: null,
      osc: new OscStream()
    }
    this.sessions.set(terminalId, session)
    // New process: whatever was known about the previous one no longer applies.
    this.statusManager.reset(terminalId)

    proc.onData((data) => {
      // A process that was stopped (restart/delete) can still emit trailing output after a new
      // session took over the same terminal id. Never let it bleed into the new session.
      if (!this.isCurrent(session)) return
      // OSC parsing runs on raw chunks, before batching, so status reacts immediately.
      this.statusManager.noteOutput(terminalId)
      for (const event of session.osc.feed(data)) {
        if (event.kind === 'attention') {
          this.statusManager.signal({ terminalId, state: 'waiting', source: 'osc', message: event.message })
        } else {
          session.reportedCwd = event.path
          // A prompt's cwd report means the shell is back in the foreground: any agent that
          // was running in this terminal has exited, so its cwd no longer applies.
          session.agentCwd = null
        }
      }
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
      // Interactive Codex gets --no-daemon here too, so it also applies on macOS/Linux shells,
      // which have no Pitwall wrapper for typed commands.
      proc.write(`${withCodexNoDaemon(startCommand)}${os.EOL}`)
    }
  }

  /**
   * Best-known working directory of a terminal, for the file drawer.
   * macOS/Linux: read from the OS (the agent child's cwd if one is running, else the shell's).
   * Windows / fallback: the shell's last OSC cwd report, else the folder it was started in.
   * (An agent's own cwd on Windows, e.g. a worktree it moved into, needs per-pane hook events.)
   */
  async getCwd(terminalId: string): Promise<PaneCwd | null> {
    const session = this.sessions.get(terminalId)
    if (!session) return null
    if (process.platform !== 'win32') {
      const fromOs = await foregroundCwd(session.proc.pid).catch(() => null)
      if (fromOs) return { cwd: fromOs.cwd, source: fromOs.pid === session.proc.pid ? 'shell' : 'agent' }
    }
    if (session.agentCwd) return { cwd: session.agentCwd, source: 'agent' }
    if (session.reportedCwd) return { cwd: session.reportedCwd, source: 'reported' }
    return { cwd: session.startCwd, source: 'start' }
  }

  /** The agent running in this terminal reported its cwd through a hook (null: it ended). */
  setAgentCwd(terminalId: string, cwd: string | null): void {
    const session = this.sessions.get(terminalId)
    if (session) session.agentCwd = cwd
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
    if (session.flushTimer) clearTimeout(session.flushTimer)
    if (session.watchdog) clearTimeout(session.watchdog)
    session.flushTimer = null
    session.watchdog = null
  }

  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    this.statusManager.noteInput(terminalId, data)
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
