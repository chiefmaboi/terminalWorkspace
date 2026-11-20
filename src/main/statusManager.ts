import type { TerminalStatus } from '../shared/types'

/**
 * Provider-agnostic status layer.
 *
 * Every source of status information reports a StatusSignal; this class decides which signals
 * win and owns the idle-timeout fallback. Sources, strongest first:
 *
 *   hook     An agent's own lifecycle event (Claude Code / Codex hooks). Authoritative.
 *   osc      A notification escape sequence from the terminal (OSC 9 / 777 / 99): "waiting".
 *   input    The user pressed Enter in the terminal: probably "working" now.
 *   timeout  The terminal has been silent for a while: probably "idle" again.
 *   exit     The process is gone: "idle".
 *
 * Rules (who may override whom):
 *   - hook, osc and exit signals always apply.
 *   - input applies from idle or waiting: the user just acted (submitted a prompt, answered a
 *     question), which is the strongest evidence that the agent is about to work.
 *   - timeout only reverts "working". A "working" set by input reverts after the user-tunable
 *     idle debounce. One set by a hook reverts only after HOOK_WORKING_SILENCE_MS of silence:
 *     agents animate continuously while they work, so a long silence still means they stopped,
 *     and Claude Code's Stop hook doesn't fire when the user interrupts with Esc.
 *   - timeout never touches "waiting": that needs the user, however quiet the terminal is.
 */

export type StatusSource = 'hook' | 'osc' | 'input' | 'timeout' | 'exit'

export interface StatusSignal {
  terminalId: string
  state: TerminalStatus
  source: StatusSource
  /** Human-readable detail (notification text), used for desktop notifications. */
  message?: string
}

export interface StatusChange {
  previous: TerminalStatus
  source: StatusSource
  message?: string
}

type Listener = (terminalId: string, status: TerminalStatus, change: StatusChange) => void

interface PaneStatus {
  state: TerminalStatus
  source: StatusSource
  lastActivityAt: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Silence required before the timeout may revert a hook-reported "working". */
export const HOOK_WORKING_SILENCE_MS = 30_000

export class StatusManager {
  private panes = new Map<string, PaneStatus>()
  private listeners = new Set<Listener>()

  /** @param getIdleDebounceMs user-tunable silence before an input-driven "working" is idle. */
  constructor(private getIdleDebounceMs: () => number = () => 1200) {}

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(terminalId: string): TerminalStatus {
    return this.panes.get(terminalId)?.state ?? 'idle'
  }

  /** The source of the current status (for tests and diagnostics). */
  sourceOf(terminalId: string): StatusSource | null {
    return this.panes.get(terminalId)?.source ?? null
  }

  signal(signal: StatusSignal): void {
    const pane = this.pane(signal.terminalId)
    if (!this.accepts(pane, signal)) return
    const previous = pane.state
    pane.source = signal.source
    if (signal.state !== 'working') {
      this.clearTimer(pane)
    } else {
      // Becoming (or being re-told) "working" is activity: the silence clock starts now, not at
      // the last output, or Enter after a quiet spell would read as already silent.
      pane.lastActivityAt = Date.now()
      this.armTimer(signal.terminalId, pane)
    }
    if (previous === signal.state) return
    pane.state = signal.state
    const change: StatusChange = { previous, source: signal.source, message: signal.message }
    for (const listener of this.listeners) listener(signal.terminalId, signal.state, change)
  }

  /** The terminal produced output: it's alive, push the idle timeout back. */
  noteOutput(terminalId: string): void {
    const pane = this.pane(terminalId)
    pane.lastActivityAt = Date.now()
    if (pane.state === 'working') this.armTimer(terminalId, pane)
  }

  /** The user typed into the terminal; Enter means they likely set the agent to work. */
  noteInput(terminalId: string, data: string): void {
    if (data.includes('\r') || data.includes('\n')) {
      this.signal({ terminalId, state: 'working', source: 'input' })
    }
  }

  /** A fresh process started for this terminal: forget everything about the old one. */
  reset(terminalId: string): void {
    const pane = this.panes.get(terminalId)
    if (pane) this.clearTimer(pane)
    this.signal({ terminalId, state: 'idle', source: 'exit' })
  }

  remove(terminalId: string): void {
    const pane = this.panes.get(terminalId)
    if (pane) this.clearTimer(pane)
    this.panes.delete(terminalId)
  }

  private accepts(pane: PaneStatus, signal: StatusSignal): boolean {
    switch (signal.source) {
      case 'hook':
      case 'osc':
      case 'exit':
        return true
      case 'input':
        return pane.state === 'idle' || pane.state === 'waiting' || pane.source === 'input'
      case 'timeout':
        return pane.state === 'working' && signal.state === 'idle'
    }
  }

  private pane(terminalId: string): PaneStatus {
    let pane = this.panes.get(terminalId)
    if (!pane) {
      pane = { state: 'idle', source: 'exit', lastActivityAt: Date.now(), timer: null }
      this.panes.set(terminalId, pane)
    }
    return pane
  }

  private clearTimer(pane: PaneStatus): void {
    if (pane.timer) clearTimeout(pane.timer)
    pane.timer = null
  }

  /** (Re)arm the silence check for a "working" pane, sized to who said it's working. */
  private armTimer(terminalId: string, pane: PaneStatus): void {
    this.clearTimer(pane)
    const required = pane.source === 'hook' ? HOOK_WORKING_SILENCE_MS : this.getIdleDebounceMs()
    const elapsed = Date.now() - pane.lastActivityAt
    pane.timer = setTimeout(
      () => {
        pane.timer = null
        if (pane.state !== 'working') return
        const silence = Date.now() - pane.lastActivityAt
        const needed = pane.source === 'hook' ? HOOK_WORKING_SILENCE_MS : this.getIdleDebounceMs()
        if (silence + 5 < needed) {
          this.armTimer(terminalId, pane) // output arrived meanwhile, or the source changed
          return
        }
        this.signal({ terminalId, state: 'idle', source: 'timeout' })
      },
      Math.max(0, required - Math.max(0, elapsed))
    )
  }
}
