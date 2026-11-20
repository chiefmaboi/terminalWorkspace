import type { TerminalStatus } from '../shared/types'

/**
 * Agent hook event -> terminal status. One mapping per agent; task 6 adds Codex alongside.
 * null = the event says nothing about whether the agent needs the user or is working.
 */

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
