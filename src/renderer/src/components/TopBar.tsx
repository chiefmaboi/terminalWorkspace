import { useEffect, useRef, useState } from 'react'
import { TILE_SCALE_MODES } from '../../../shared/types'
import type { TileScaleMode, Workspace } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { GearIcon } from './icons'

interface Props {
  /** Scale the wall actually uses (shown next to the mode), or null with no wall on screen. */
  effectiveScale: number | null
  filesOpen: boolean
  onToggleFiles: () => void
  onNewWorkspace: () => void
  onNewTerminal: () => void
  onRenameWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
  onShortcuts: () => void
}

// Toolbar buttons must not take keyboard focus: a click on them would otherwise pull focus out
// of the terminal you're typing in (or leave a focused button that swallows wall-mode Enter).
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

function WorkspaceSwitcher({
  onNewWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace
}: Pick<Props, 'onNewWorkspace' | 'onRenameWorkspace' | 'onDeleteWorkspace'>): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeId = useAppStore((s) => s.settings.activeWorkspaceId)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = workspaces.find((w) => w.id === activeId) ?? null

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Capture + stop: Esc closes the menu without also restoring a zoomed pane.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const run = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <div className="ws-switcher" ref={rootRef}>
      <button
        className="ws-switcher-button"
        onMouseDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
        title="Switch workspace"
      >
        <span className="ws-switcher-name">{active ? active.name : 'No workspace'}</span>
        {active && <span className="ws-switcher-count">{active.terminals.length}</span>}
        <span className="ws-switcher-caret">▾</span>
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          {workspaces.map((w, i) => (
            <button
              key={w.id}
              className={`ws-menu-item${w.id === activeId ? ' active' : ''}`}
              onMouseDown={keepFocus}
              onClick={() => run(() => openWorkspace(w.id))}
            >
              <span className="ws-menu-check">{w.id === activeId ? '✓' : ''}</span>
              <span className="ws-menu-label">{w.name}</span>
              <span className="ws-menu-hint">{i < 9 ? `Ctrl+${i + 1}` : `${w.terminals.length}`}</span>
            </button>
          ))}
          {workspaces.length > 0 && <div className="ws-menu-sep" />}
          <button className="ws-menu-item" onMouseDown={keepFocus} onClick={() => run(onNewWorkspace)}>
            <span className="ws-menu-check">+</span>
            <span className="ws-menu-label">New workspace…</span>
            <span className="ws-menu-hint">Ctrl+N</span>
          </button>
          {active && (
            <>
              <button className="ws-menu-item" onMouseDown={keepFocus} onClick={() => run(() => onRenameWorkspace(active))}>
                <span className="ws-menu-check" />
                <span className="ws-menu-label">Rename “{active.name}”…</span>
              </button>
              <button
                className="ws-menu-item danger-item"
                onMouseDown={keepFocus}
                onClick={() => run(() => onDeleteWorkspace(active))}
              >
                <span className="ws-menu-check" />
                <span className="ws-menu-label">Delete “{active.name}”…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function TopBar(props: Props): React.JSX.Element {
  const tileScale = useAppStore((s) => s.settings.tileScale)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen)

  return (
    <header className="top-bar">
      <WorkspaceSwitcher
        onNewWorkspace={props.onNewWorkspace}
        onRenameWorkspace={props.onRenameWorkspace}
        onDeleteWorkspace={props.onDeleteWorkspace}
      />
      <button
        className="primary add-terminal"
        title="New terminal"
        aria-label="New terminal"
        onMouseDown={keepFocus}
        onClick={props.onNewTerminal}
      >
        +
      </button>
      <div className="top-bar-spacer" />
      <label className="wall-scale" title="Tile scale (Auto fits the wall: max 0.5, floor 0.33)">
        Scale
        <select value={tileScale} onChange={(e) => updateAppSettings({ tileScale: e.target.value as TileScaleMode })}>
          {TILE_SCALE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'auto' ? 'Auto' : mode}
            </option>
          ))}
        </select>
        {props.effectiveScale !== null && (
          <span className="wall-scale-effective">×{props.effectiveScale.toFixed(2)}</span>
        )}
      </label>
      <button
        className={`top-bar-button${props.filesOpen ? ' active' : ''}`}
        title="Files for the selected tile (Ctrl+Shift+E)"
        onMouseDown={keepFocus}
        onClick={props.onToggleFiles}
      >
        Files
      </button>
      <button className="top-bar-button" title="Keyboard shortcuts (?)" onMouseDown={keepFocus} onClick={props.onShortcuts}>
        ?
      </button>
      <button
        className="top-bar-button"
        title="Settings"
        onMouseDown={keepFocus}
        onClick={() => setSettingsModalOpen(true)}
      >
        <GearIcon />
      </button>
    </header>
  )
}
