import { useState } from 'react'
import type { ReactNode } from 'react'

interface PromptProps {
  title: string
  label: string
  initial: string
  confirmLabel?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

/** One-field text dialog (rename workspace / terminal). Empty input keeps the old value. */
export function PromptDialog({ title, label, initial, confirmLabel = 'Save', onSubmit, onClose }: PromptProps): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onClose()
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <label>
          {label}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ConfirmProps {
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}

/** Destructive-action confirmation (delete workspace / terminal). */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose }: ConfirmProps): React.JSX.Element {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p>{children}</p>
        <div className="modal-actions">
          <button onClick={onClose} autoFocus>
            Cancel
          </button>
          <button
            className="danger"
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
