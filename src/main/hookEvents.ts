import type { TerminalStatus } from '../shared/types'

/**
 * Agent hook payload -> what it tells us about the terminal.
 *
 * Claude Code and Codex both deliver hook events as JSON on stdin with the same core fields
 * (hook_event_name, cwd, session_id, ...); the relay forwards that JSON untouched, and the
 * adapters below interpret it per agent. A "generic" adapter lets any other tool report a state
 * directly with {"state": "waiting" | "working" | "idle", "message"?, "cwd"?}.
 */

export type HookAgent = 'claude' | 'codex' | 'generic'
export const HOOK_AGENTS: readonly HookAgent[] = ['claude', 'codex', 'generic']

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

/**
 * Codex hook events. Codex has no Notification event: "needs you" is PermissionRequest, which
 * runs before an approval is routed (to the user, or to an automatic reviewer: best effort).
 * Interrupt covers the user stopping a turn (Esc). Interactive Codex (0.163+) reports its exact
 * state on its terminal output instead (OSC 7501), which takes precedence; these hooks matter for
 * `codex exec` and older versions.
 */
export function stateForCodexHook(eventName: string): TerminalStatus | null {
  switch (eventName) {
    case 'PermissionRequest':
      return 'waiting'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
    case 'Interrupt':
    case 'SessionEnd':
      return 'idle'
    default:
      return null // SubagentStart/Stop, SessionStart, Pre/PostCompact, model-request events
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
  const state = agent === 'claude' ? stateForClaudeHook(eventName) : stateForCodexHook(eventName)
  // Codex's approval text is deliberately generic: the command it wants to run can contain
  // secrets, and the message ends up in a desktop notification.
  const message =
    agent === 'claude' ? str(p.message) : eventName === 'PermissionRequest' ? 'Codex needs your approval' : undefined
  return { state, message, cwd: str(p.cwd), sessionEnded: eventName === 'SessionEnd', eventName }
}
