/**
 * Codex hands interactive sessions to a shared background daemon (`codex app-server`) unless
 * started with --no-daemon. The daemon runs hooks with ITS environment, not the Pitwall terminal's,
 * so Pitwall's per-terminal token never reaches them and Codex status (working / waiting / idle)
 * can't be attributed. Inside Pitwall terminals, interactive Codex therefore gets --no-daemon:
 * the session runs in its own process, inheriting that terminal's PITWALL_* variables.
 *
 * Only commands that open an interactive session get the flag: plain `codex [flags] [prompt]`,
 * `codex resume`, `codex fork`. Everything else (exec, which is already in-process, login, mcp,
 * agents, app-server, ...) is left exactly as typed.
 */

/** Every `codex` subcommand (codex-cli 0.169 `codex --help`), aliases included. */
export const CODEX_SUBCOMMANDS = [
  'agents',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'resume',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'migrate-nfs-db',
  'unarchive',
  'fork',
  'cloud',
  'exec-server',
  'help'
] as const

/** Subcommands that open an interactive session (and so would use the daemon). */
export const CODEX_SESSION_SUBCOMMANDS = ['resume', 'fork'] as const

const CODEX_AT_START = /^(\s*)(codex(?:\.cmd|\.exe|\.ps1)?)(?=\s|$)(.*)$/is

/** `command` with --no-daemon added if it starts an interactive Codex session; else unchanged. */
export function withCodexNoDaemon(command: string): string {
  const match = CODEX_AT_START.exec(command)
  if (!match) return command
  const [, lead, bin, rest] = match
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  if (tokens.includes('--no-daemon')) return command
  const firstPositional = tokens.find((t) => !t.startsWith('-'))?.toLowerCase()
  const isSubcommand = firstPositional !== undefined && (CODEX_SUBCOMMANDS as readonly string[]).includes(firstPositional)
  const isSession =
    !isSubcommand || (CODEX_SESSION_SUBCOMMANDS as readonly string[]).includes(firstPositional as string)
  return isSession ? `${lead}${bin} --no-daemon${rest}` : command
}
