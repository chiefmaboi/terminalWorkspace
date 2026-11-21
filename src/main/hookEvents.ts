import type { TerminalStatus } from '../shared/types'

/**
 * Agent hook payload -> what it tells us about the terminal.
 *
 * Claude Code delivers hook events as JSON on stdin (hook_event_name, cwd, session_id, ...); the
 * relay forwards that JSON untouched and the adapter below interprets it. A "generic" adapter lets any other tool report a state
 * directly with {"state": "waiting" | "working" | "idle", "message"?, "cwd"?}.
 */

export type HookAgent = 'claude' | 'generic'
export const HOOK_AGENTS: readonly HookAgent[] = ['claude', 'generic']

export interface HookReading {
  /** null: the event says nothing about whether the agent is working or needs the user. */
  state: TerminalStatus | null
  /** Text for a desktop notification when it becomes waiting. */
  message?: string
  /** The agent's working directory (a worktree it moved into, for example). */
  cwd?: string
  /** The agent's session ended: its cwd no longer describes the terminal. */
  sessionEnded?: boolean
  eventName: string
}

/**
 * Claude Code hook events (hook_event_name).
 * - Notification: a permission prompt, or Claude idle-waiting for input -> waiting.
 * - UserPromptSubmit / PreToolUse / PostToolUse: it's working.
 * - Stop / SessionEnd: the main agent finished its turn / the session ended -> idle.
 * - SubagentStop: only a subagent finished; the main agent is still working, so it must NOT
 *   mark the terminal idle.
 */
export function stateForClaudeHook(eventName: string): TerminalStatus | null {
  switch (eventName) {
    case 'Notification':
      return 'waiting'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
    case 'SessionEnd':
      return 'idle'
    default:
      return null // SubagentStop, SessionStart, PreCompact, unknown events
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Interpret one hook payload from `agent`, or null if it isn't a usable event. */
export function readHook(agent: HookAgent, payload: unknown): HookReading | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (agent === 'generic') {
    const state = p.state
    if (state !== 'waiting' && state !== 'working' && state !== 'idle') return null
    return { state, message: str(p.message), cwd: str(p.cwd), eventName: `generic:${state}` }
  }
  const eventName = str(p.hook_event_name)
  if (!eventName) return null
  const state = stateForClaudeHook(eventName)
  const message = str(p.message)
  return { state, message, cwd: str(p.cwd), sessionEnded: eventName === 'SessionEnd', eventName }
}
