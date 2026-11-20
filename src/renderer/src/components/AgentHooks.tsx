import { useCallback, useEffect, useState } from 'react'
import type { AgentHookStatus, DiffLine, HookAction, HookPlan, InstallableAgent } from '../../../shared/types'

const STATE_LABEL: Record<AgentHookStatus['state'], string> = {
  installed: 'Installed',
  outdated: 'Needs update',
  missing: 'Not installed',
  error: 'Unreadable config'
}

/** Long unchanged stretches collapse to a marker so the actual change stays readable. */
function collapse(diff: DiffLine[], context = 3): Array<DiffLine | { kind: 'gap'; count: number }> {
  const near = diff.map((_line, i) =>
    diff.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== 'same')
  )
  const out: Array<DiffLine | { kind: 'gap'; count: number }> = []
  let gap = 0
  diff.forEach((line, i) => {
    if (line.kind === 'same' && !near[i]) {
      gap++
      return
    }
    if (gap) out.push({ kind: 'gap', count: gap })
    gap = 0
    out.push(line)
  })
  if (gap) out.push({ kind: 'gap', count: gap })
  return out
}

function ReviewModal({
  agent,
  action,
  onDone,
  onClose
}: {
  agent: InstallableAgent
  action: HookAction
  onDone: (message: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<HookPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.planHooks(agent, action).then((p) => {
      setPlan(p)
      if (p?.error) setError(p.error)
    })
  }, [agent, action])

  async function apply(): Promise<void> {
    if (!plan) return
    setBusy(true)
    const result = await window.api.applyHooks(agent, action, plan.beforeHash)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Failed.')
      return
    }
    const what = action === 'install' ? 'installed' : 'removed'
    const backupName = result.backupPath?.split(/[\\/]/).pop()
    onDone(
      `${agent === 'claude' ? 'Claude Code' : 'Codex'} hooks ${what}.` +
        (backupName ? ` Previous file backed up next to it as ${backupName}.` : '')
    )
    onClose()
  }

  const name = agent === 'claude' ? 'Claude Code' : 'Codex'
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal hook-review" onClick={(e) => e.stopPropagation()}>
        <h2>
          {action === 'install' ? 'Install' : 'Remove'} {name} hooks
        </h2>
        {!plan && <p>Reading the current config…</p>}
        {plan && (
          <>
            <p className="hook-review-path">
              {plan.existed ? 'Edits' : 'Creates'} <code>{plan.configPath}</code>
            </p>
            {action === 'install' && (
              <p className="modal-hint">
                Adds a small relay to {name}&apos;s user-level hooks. It only does something inside a Pitwall terminal
                (it needs the per-terminal PITWALL_TOKEN Pitwall sets), so {name} sessions elsewhere are unaffected. Your
                other settings and hooks are kept.
              </p>
            )}
            {plan.changed && plan.diff.length > 0 && (
              <pre className="hook-diff" aria-label="Changes">
                {collapse(plan.diff).map((line, i) =>
                  line.kind === 'gap' ? (
                    <div key={i} className="diff-gap">
                      ⋯ {line.count} unchanged line{line.count === 1 ? '' : 's'}
                    </div>
                  ) : (
                    <div key={i} className={`diff-${line.kind}`}>
                      {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                      {line.text}
                    </div>
                  )
                )}
              </pre>
            )}
            {!plan.changed && !plan.error && <p>Nothing to change: it&apos;s already {action === 'install' ? 'installed' : 'removed'}.</p>}
            {plan.changed && plan.existed && (
              <p className="modal-hint">
                A backup of the current file is saved next to it first.
                {plan.reformatted && ' The file will be rewritten as standard 2-space JSON (content otherwise unchanged).'}
              </p>
            )}
            {agent === 'codex' && action === 'install' && plan.changed && (
              <p className="modal-hint">
                Codex asks you to trust new hooks before running them: the next time Codex starts it will point you to{' '}
                <code>/hooks</code> to review and trust Pitwall&apos;s.
              </p>
            )}
          </>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>{plan?.changed ? 'Cancel' : 'Close'}</button>
          {plan?.changed && !plan.error && (
            <button className={action === 'install' ? 'primary' : 'danger'} disabled={busy} onClick={() => void apply()}>
              {action === 'install' ? 'Install' : 'Remove'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Settings section: per agent, whether Pitwall's hook relay is installed, with install/remove. */
export default function AgentHooks({ connected }: { connected: boolean }): React.JSX.Element {
  const [statuses, setStatuses] = useState<AgentHookStatus[] | null>(null)
  const [review, setReview] = useState<{ agent: InstallableAgent; action: HookAction } | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.api.hookStatus().then(setStatuses)
  }, [])
  useEffect(refresh, [refresh])

  return (
    <section className="settings-section agent-hooks">
      <div className="settings-section-head">
        <h3>Agent hooks</h3>
        <span className={`settings-pill${connected ? ' live' : ''}`}>
          <span className={`status-dot ${connected ? 'status-working' : 'status-idle'}`} />
          {connected ? 'Receiving events' : 'No events yet'}
        </span>
      </div>
      <p className="settings-hint">
        Exact working / waiting / idle status straight from the agent, per terminal. Without hooks Pitwall still works
        from terminal output.
      </p>
      {statuses && (
        <div className="hook-list">
          {statuses.map((s) => (
            <div key={s.agent} className="hook-item" data-agent={s.agent} data-state={s.state}>
              <div className="hook-item-main">
                <div className="hook-item-title">
                  <span className="hook-item-name">{s.label}</span>
                  <span className={`hook-badge state-${s.state}`}>{STATE_LABEL[s.state]}</span>
                </div>
                <div className={`hook-item-path${s.error ? ' has-error' : ''}`} title={s.error ?? s.configPath}>
                  {s.error ?? s.displayPath}
                </div>
              </div>
              <div className="settings-actions">
                {s.state !== 'installed' && s.state !== 'error' && (
                  <button
                    className="settings-button primary-ish"
                    onClick={() => setReview({ agent: s.agent, action: 'install' })}
                  >
                    {s.state === 'outdated' ? 'Update…' : 'Install…'}
                  </button>
                )}
                {(s.state === 'installed' || s.state === 'outdated') && (
                  <button className="settings-button" onClick={() => setReview({ agent: s.agent, action: 'uninstall' })}>
                    Remove…
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {message && <p className="settings-note">{message}</p>}
      {review && (
        <ReviewModal
          agent={review.agent}
          action={review.action}
          onDone={(m) => {
            setMessage(m)
            refresh()
          }}
          onClose={() => setReview(null)}
        />
      )}
    </section>
  )
}
