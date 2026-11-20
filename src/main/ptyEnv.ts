/**
 * Environment for spawned terminals: everything Pitwall inherited, minus a denylist.
 *
 * A denylist rather than an allowlist, on purpose: shells and agents depend on an open-ended
 * set of variables (PATH, proxies, toolchain homes, API keys...) that no allowlist would keep
 * up with. What gets removed is only state that belongs to whatever launched Pitwall and would
 * mislead the programs started inside it:
 *
 * - CLAUDECODE, CLAUDE_CODE_*: markers a Claude Code session sets for its own children. If
 *   Pitwall was started from inside Claude Code, a `claude` run in a pane would otherwise
 *   believe it is a nested child session (it inherits auto mode, disables transcript saving).
 *   CLAUDE_CONFIG_DIR and other non-CLAUDE_CODE_ settings are user configuration and are kept.
 * - PITWALL_*: Pitwall's own launch/test switches (PITWALL_USER_DATA_DIR, PITWALL_DEVTOOLS, ...).
 *   Per-pane PITWALL_* variables are injected after filtering, so they can never be inherited
 *   from the outside or leak from one Pitwall into a nested one.
 *
 * Matching is case-insensitive: Windows environment variable names are.
 */

const DENY_EXACT = new Set(['CLAUDECODE'])
const DENY_PREFIXES = ['CLAUDE_CODE_', 'PITWALL_']

export function isDeniedEnvVar(name: string): boolean {
  const upper = name.toUpperCase()
  return DENY_EXACT.has(upper) || DENY_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

/** A fresh env object for a PTY: denied names removed, undefined values dropped. */
export function buildPtyEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isDeniedEnvVar(name)) continue
    env[name] = value
  }
  return env
}
