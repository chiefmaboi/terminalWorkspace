import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AgentHookStatus, HookAction, HookApplyResult, HookPlan, InstallableAgent } from '../shared/types'
import { lineDiff } from './lineDiff'

/**
 * Installs Pitwall's hook relay into Claude Code's USER-level settings
 * ($CLAUDE_CONFIG_DIR/settings.json, default ~/.claude/settings.json), so it applies to every
 * session in every folder. (Codex needs no hooks: it reports its status on its own terminal
 * output, see oscStream.ts.)
 *
 * The relay is guarded: it does nothing unless PITWALL_TOKEN and PITWALL_HOOK_URL are set, which
 * only happens inside a Pitwall terminal, so sessions outside Pitwall are unaffected.
 *
 * Editing rules: other keys and other hooks are preserved; Pitwall's entries are recognized by
 * the relay they call and updated in place, new ones are appended at the end of an event's list;
 * a file that doesn't parse as JSON is never touched; every write is preceded by a backup;
 * apply() refuses if the file changed after the user reviewed the plan.
 */

export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const
const LABELS: Record<InstallableAgent, string> = { claude: 'Claude Code' }

/**
 * POSIX-shell relay: curl the hook JSON (stdin) to this terminal's Pitwall. Claude Code runs hooks
 * through bash everywhere (Git Bash on Windows).
 * Output is discarded (some hooks' stdout is fed to the model) and the exit code is always 0
 * (a failing relay must never disturb the agent).
 */
export function posixRelayCommand(agent: InstallableAgent): string {
  return (
    '[ -n "$PITWALL_TOKEN" ] && [ -n "$PITWALL_HOOK_URL" ] && ' +
    "curl -s -m 2 --noproxy '*' -X POST " +
    '-H "Authorization: Bearer $PITWALL_TOKEN" -H \'Content-Type: application/json\' ' +
    `--data-binary @- "$PITWALL_HOOK_URL/${agent}" >/dev/null 2>&1; exit 0`
  )
}

type Json = Record<string, unknown>

function isPitwallHandler(handler: unknown): boolean {
  if (typeof handler !== 'object' || handler === null) return false
  const h = handler as Json
  return typeof h.command === 'string' && h.command.includes('PITWALL_TOKEN')
}

function handlersOf(group: unknown): unknown[] {
  if (typeof group !== 'object' || group === null) return []
  const hooks = (group as Json).hooks
  return Array.isArray(hooks) ? hooks : []
}

function desiredHandler(): Json {
  return { type: 'command', command: posixRelayCommand('claude'), timeout: 5 }
}


/** Pure: the config object after installing / uninstalling Pitwall's hooks. */
export function transformConfig(root: Json, action: HookAction): Json {
  const events: readonly string[] = CLAUDE_EVENTS
  const result: Json = { ...root }
  const hooks: Json = { ...((root.hooks as Json | undefined) ?? {}) }
  const handler = desiredHandler()

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event] as unknown[]
    const wanted = action === 'install' && events.includes(event)
    if (wanted) continue // handled below
    // Uninstall, or an event Pitwall no longer uses: strip Pitwall's handlers only.
    const kept = groups
      .map((g) => {
        const handlers = handlersOf(g)
        if (!handlers.some(isPitwallHandler)) return g
        const rest = handlers.filter((h) => !isPitwallHandler(h))
        return rest.length ? { ...(g as Json), hooks: rest } : null
      })
      .filter((g) => g !== null)
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }

  if (action === 'install') {
    for (const event of events) {
      const groups = [...((hooks[event] as unknown[] | undefined) ?? [])]
      const index = groups.findIndex((g) => handlersOf(g).some(isPitwallHandler))
      if (index < 0) {
        groups.push({ hooks: [handler] }) // appended: existing hooks keep their positions
      } else {
        const group = groups[index] as Json
        const handlers = handlersOf(group)
        const onlyPitwall = handlers.every(isPitwallHandler)
        // Update in place. If someone put Pitwall's handler into a group with their own, only
        // Pitwall's handler is replaced; their handlers and matcher stay.
        groups[index] = onlyPitwall
          ? { hooks: [handler] }
          : { ...group, hooks: handlers.map((h) => (isPitwallHandler(h) ? handler : h)) }
      }
      hooks[event] = groups
    }
  }

  if (Object.keys(hooks).length) result.hooks = hooks
  else delete result.hooks
  return result
}

export interface InstallerOptions {
  env?: NodeJS.ProcessEnv
  home?: string
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

export class HookInstaller {
  private env: NodeJS.ProcessEnv
  private home: string

  constructor(opts: InstallerOptions = {}) {
    this.env = opts.env ?? process.env
    this.home = opts.home ?? homedir()
  }

  configPath(): string {
    return join(this.env.CLAUDE_CONFIG_DIR || join(this.home, '.claude'), 'settings.json')
  }

  async status(): Promise<AgentHookStatus[]> {
    return Promise.all(
      (['claude'] as const).map(async (agent) => {
        const plan = await this.plan(agent, 'install')
        const base = {
          agent,
          label: LABELS[agent],
          configPath: plan.configPath,
          displayPath: plan.configPath.startsWith(this.home) ? `~${plan.configPath.slice(this.home.length)}` : plan.configPath
        }
        if (plan.error) return { ...base, state: 'error' as const, error: plan.error }
        if (!plan.changed) return { ...base, state: 'installed' as const }
        return { ...base, state: plan.hadPitwall ? ('outdated' as const) : ('missing' as const) }
      })
    )
  }

  async plan(agent: InstallableAgent, action: HookAction): Promise<HookPlan> {
    const configPath = this.configPath()
    const base = { agent, action, configPath }
    let text: string | null
    try {
      text = await fs.readFile(configPath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ...base, ...emptyPlan(), error: String(err) }
      text = null
    }
    let root: Json
    try {
      const parsed: unknown = text && text.trim() ? JSON.parse(text) : {}
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object')
      const hooks = (parsed as Json).hooks
      if (hooks !== undefined && (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))) {
        throw new Error('"hooks" is not an object')
      }
      for (const v of Object.values((hooks as Json | undefined) ?? {})) {
        if (!Array.isArray(v)) throw new Error('a "hooks" event entry is not an array')
      }
      root = parsed as Json
    } catch (err) {
      return {
        ...base,
        ...emptyPlan(),
        existed: text !== null,
        error: `Can't read ${configPath} as plain JSON (${(err as Error).message}). Pitwall won't modify it.`
      }
    }
    const normalizedBefore = JSON.stringify(root, null, 2) + '\n'
    const after = transformConfig(root, action)
    const normalizedAfter = JSON.stringify(after, null, 2) + '\n'
    const hadPitwall = Object.values((root.hooks as Json | undefined) ?? {}).some((groups) =>
      (groups as unknown[]).some((g) => handlersOf(g).some(isPitwallHandler))
    )
    return {
      ...base,
      existed: text !== null,
      changed: normalizedAfter !== normalizedBefore,
      // Only real formatting differences count (indentation, spacing), not a missing final newline.
      reformatted: text !== null && text.replace(/\r\n/g, '\n').trimEnd() !== normalizedBefore.trimEnd(),
      hadPitwall,
      diff: lineDiff(normalizedBefore, normalizedAfter),
      beforeHash: sha(text ?? '')
    }
  }

  async apply(agent: InstallableAgent, action: HookAction, beforeHash: string): Promise<HookApplyResult> {
    const plan = await this.plan(agent, action)
    if (plan.error) return { ok: false, error: plan.error }
    if (plan.beforeHash !== beforeHash) {
      return { ok: false, error: `${plan.configPath} changed since you reviewed it. Review again.` }
    }
    if (!plan.changed) return { ok: true }

    const path = plan.configPath
    const original = plan.existed ? await fs.readFile(path, 'utf-8') : null
    let backupPath: string | undefined
    if (original !== null) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
      backupPath = `${path}.pitwall-backup-${stamp}`
      await fs.writeFile(backupPath, original, 'utf-8')
    }
    const root: Json = original && original.trim() ? (JSON.parse(original) as Json) : {}
    const eol = original?.includes('\r\n') ? '\r\n' : '\n'
    const next = (JSON.stringify(transformConfig(root, action), null, 2) + '\n').replace(/\n/g, eol)
    await fs.mkdir(dirname(path), { recursive: true })
    const temp = `${path}.pitwall-tmp`
    await fs.writeFile(temp, next, 'utf-8')
    await fs.rename(temp, path)
    return { ok: true, backupPath }
  }
}

function emptyPlan(): Omit<HookPlan, 'agent' | 'action' | 'configPath'> {
  return { existed: false, changed: false, reformatted: false, hadPitwall: false, diff: [], beforeHash: '' }
}
