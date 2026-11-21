import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { Terminal, Workspace } from '../../shared/types'
import TopBar from './components/TopBar'
import GridWall from './components/GridWall'
import FileDrawer from './components/FileDrawer'
import WorkspaceDialog from './components/WorkspaceDialog'
import TerminalDialog from './components/TerminalDialog'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import CommandPalette from './components/CommandPalette'
import SettingsModal from './components/SettingsModal'
import { ConfirmDialog, PromptDialog } from './components/Dialogs'
import { TileActionsContext } from './components/tileActions'
import type { TileActions } from './components/tileActions'
import { useAppStore } from './store/useAppStore'
import * as terminals from './terminal/registry'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

type Dialog =
  | { kind: 'renameWorkspace'; workspace: Workspace }
  | { kind: 'deleteWorkspace'; workspace: Workspace }
  | { kind: 'renameTerminal'; terminal: Terminal }
  | { kind: 'deleteTerminal'; terminal: Terminal }
  | null

export default function App(): React.JSX.Element {
  const loaded = useAppStore((s) => s.loaded)
  const workspaces = useAppStore((s) => s.workspaces)
  const settings = useAppStore((s) => s.settings)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const maximizedTerminalId = useAppStore((s) => s.maximizedTerminalId)
  const openedWorkspaceIds = useAppStore((s) => s.openedWorkspaceIds)
  const settingsModalOpen = useAppStore((s) => s.settingsModalOpen)
  const load = useAppStore((s) => s.load)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const setStatus = useAppStore((s) => s.setStatus)
  const setGitBranch = useAppStore((s) => s.setGitBranch)
  const markHookEventReceived = useAppStore((s) => s.markHookEventReceived)
  const focusTerminal = useAppStore((s) => s.focusTerminal)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const markPtyStarted = useAppStore((s) => s.markPtyStarted)
  const renameWorkspace = useAppStore((s) => s.renameWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const renameTerminal = useAppStore((s) => s.renameTerminal)
  const removeTerminal = useAppStore((s) => s.removeTerminal)
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen)

  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [terminalDialog, setTerminalDialog] = useState<{ workspaceId: string; initialPath?: string } | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)

  const [toasts, setToasts] = useState<Array<{ id: string; terminalId: string; name: string }>>([])

  const activeWorkspace = workspaces.find((w) => w.id === settings.activeWorkspaceId) ?? null
  const workspaceOf = (terminalId: string): Workspace | undefined =>
    useAppStore.getState().workspaces.find((w) => w.terminals.some((t) => t.id === terminalId))

  /** Select a terminal and put keyboard focus in it (terminal mode). */
  const enterTerminal = useCallback(
    (id: string): void => {
      focusTerminal(id)
      requestAnimationFrame(() => terminals.focus(id))
    },
    [focusTerminal]
  )

  useEffect(() => {
    terminals.initTerminalRegistry({
      onFocus: (id) => focusTerminal(id),
      onStarted: (id) => markPtyStarted(id)
    })
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // Layout effect so the registry has the loaded theme before any tile creates a terminal.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    terminals.setTheme(settings.theme)
  }, [settings.theme])

  // Main flushes this terminal's output at the fast rate and every other one at the slow rate.
  useEffect(() => {
    window.api.ptySetPriority(maximizedTerminalId ?? focusedTerminalId)
  }, [maximizedTerminalId, focusedTerminalId])

  useEffect(() => {
    document.title = activeWorkspace ? `${activeWorkspace.name}: Pitwall` : 'Pitwall'
  }, [activeWorkspace])

  // Start the way it ended: reopen the last active workspace (its terminals start with its
  // tiles; order, pins and scale are saved). No prompt.
  useEffect(() => {
    if (!loaded) return
    const last = workspaces.find((w) => w.id === settings.activeWorkspaceId)
    if (last) openWorkspace(last.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  useEffect(() => {
    const unsubStatus = window.api.onStatusChanged((id, status, unreadCount) => {
      const previousStatus = useAppStore.getState().runtime[id]?.status
      setStatus(id, status as 'idle' | 'working' | 'waiting', unreadCount)
      // The OS notification (main process) only fires while unfocused; mirror it in-app for
      // the case where you're focused on the app but looking at a different tile.
      if (status === 'waiting' && previousStatus !== 'waiting' && document.hasFocus()) {
        const terminal = useAppStore
          .getState()
          .workspaces.flatMap((w) => w.terminals)
          .find((t) => t.id === id)
        const toastId = `${id}-${Date.now()}`
        setToasts((prev) => [...prev, { id: toastId, terminalId: id, name: terminal?.name ?? id }])
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 6000)
      }
    })
    const unsubBranch = window.api.onGitBranchChanged((id, branch) => setGitBranch(id, branch))
    const unsubFocus = window.api.onTerminalFocusRequest((id) => enterTerminal(id))
    const unsubHook = window.api.onHookEvent((_name, receivedAt) => markHookEventReceived(receivedAt))
    return () => {
      unsubStatus()
      unsubBranch()
      unsubFocus()
      unsubHook()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Chords that work in BOTH modes, captured before xterm sees them so they never reach a PTY:
  // - Ctrl+Shift+Enter: terminal mode -> wall mode (restoring a zoomed pane); wall mode -> zoom
  //   the highlighted tile and focus it (same as Enter).
  // - Ctrl+Shift+E: toggle the file drawer.
  useEffect(() => {
    function handleChord(event: KeyboardEvent): void {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (key !== 'enter' && key !== 'e') return
      event.preventDefault()
      event.stopPropagation()
      if (key === 'e') {
        setFilesOpen((open) => !open)
        return
      }
      const state = useAppStore.getState()
      if (terminals.isTerminalFocused()) {
        if (state.maximizedTerminalId) state.setMaximized(null)
        terminals.blurTerminals()
        return
      }
      if (state.maximizedTerminalId) {
        terminals.focus(state.maximizedTerminalId)
        return
      }
      const wall = state.workspaces.find((w) => w.id === state.settings.activeWorkspaceId)
      const ordered = [...(wall?.terminals ?? [])].sort((a, b) => a.order - b.order)
      const id = ordered.some((t) => t.id === state.focusedTerminalId) ? state.focusedTerminalId : ordered[0]?.id
      if (id) state.setMaximized(id)
    }
    window.addEventListener('keydown', handleChord, true)
    return () => window.removeEventListener('keydown', handleChord, true)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (event.key >= '1' && event.key <= '9') {
          const target = workspaces[Number(event.key) - 1]
          if (target) {
            event.preventDefault()
            openWorkspace(target.id)
          }
          return
        }
        if (event.key.toLowerCase() === 'n') {
          event.preventDefault()
          setWorkspaceDialogOpen(true)
          return
        }
        // Ctrl+K is a readline shortcut (kill to end of line); only take it outside terminals.
        if (event.key.toLowerCase() === 'k' && !isTypingTarget(event.target)) {
          event.preventDefault()
          setPaletteOpen((open) => !open)
        }
        return
      }
      if (event.key === '?' && !isTypingTarget(event.target)) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') {
        // A dialog takes Esc first.
        if (document.querySelector('.modal-overlay')) {
          setShortcutsOpen(false)
          return
        }
        // Esc belongs to the terminal while it has focus (Claude Code uses Esc to interrupt and
        // Esc Esc to rewind); outside one it restores a zoomed pane.
        if (!terminals.isTerminalFocused() && useAppStore.getState().maximizedTerminalId) setMaximized(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [workspaces, openWorkspace, setMaximized])

  const tileActions = useMemo<TileActions>(
    () => ({
      rename: (terminal) => setDialog({ kind: 'renameTerminal', terminal }),
      remove: (terminal) => setDialog({ kind: 'deleteTerminal', terminal }),
      restart: (terminal) => {
        void window.api.restartTerminal(terminal.id).then(() => terminals.restart(terminal.id))
      }
    }),
    []
  )

  /**
   * "+": new terminal in the active workspace. With a tile selected, its folder is prefilled
   * with that terminal's current cwd (same source as the file drawer, so a shell that cd'd into a
   * worktree hands that worktree on), falling back to its project folder.
   */
  async function openNewTerminalDialog(): Promise<void> {
    if (!activeWorkspace) {
      setWorkspaceDialogOpen(true)
      return
    }
    const selected = activeWorkspace.terminals.find((t) => t.id === useAppStore.getState().focusedTerminalId)
    if (!selected) {
      setTerminalDialog({ workspaceId: activeWorkspace.id })
      return
    }
    const cwd = await window.api.getTerminalCwd(selected.id).catch(() => null)
    setTerminalDialog({ workspaceId: activeWorkspace.id, initialPath: cwd?.cwd ?? selected.projectPath })
  }


  return (
    <TileActionsContext.Provider value={tileActions}>
      <div className="app-shell">
        <TopBar
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen((open) => !open)}
          onNewWorkspace={() => setWorkspaceDialogOpen(true)}
          onNewTerminal={() => void openNewTerminalDialog()}
          onRenameWorkspace={(workspace) => setDialog({ kind: 'renameWorkspace', workspace })}
          onDeleteWorkspace={(workspace) => setDialog({ kind: 'deleteWorkspace', workspace })}
          onShortcuts={() => setShortcutsOpen(true)}
        />
        <div className="main-area">
          {workspaces.length === 0 && (
            <div className="empty-main">
              <div className="empty-main-mark">&gt;_</div>
              <p>No workspaces yet</p>
              <p className="empty-main-sub">
                A workspace is a named wall of terminals. Create one, then add terminals to it.
              </p>
              <button className="primary" onClick={() => setWorkspaceDialogOpen(true)}>
                Create your first workspace
              </button>
            </div>
          )}
          {activeWorkspace && activeWorkspace.terminals.length === 0 && (
            <div className="empty-main">
              <div className="empty-main-mark">&gt;_</div>
              <p>&quot;{activeWorkspace.name}&quot; has no terminals yet</p>
              <p className="empty-main-sub">Add one to point it at a project folder and start a session.</p>
              <button className="primary" onClick={() => setTerminalDialog({ workspaceId: activeWorkspace.id })}>
                Add a terminal
              </button>
            </div>
          )}
          {workspaces.length > 0 && !activeWorkspace && (
            <div className="empty-main">
              <div className="empty-main-mark">&gt;_</div>
              <p>Pick a workspace to start its sessions</p>
              <p className="empty-main-sub">Use the workspace menu at the top left, or press Ctrl+1…9.</p>
            </div>
          )}
          {/* Tiles start their terminals when they mount, so the wall only renders for a
              workspace opened in this run (reopened at launch, the switcher, Ctrl+1-9, Start
              terminals). Fallback if the active workspace somehow isn't open. */}
          {activeWorkspace &&
            activeWorkspace.terminals.length > 0 &&
            !openedWorkspaceIds.has(activeWorkspace.id) &&
            loaded && (
              <div className="empty-main not-running">
                <div className="empty-main-mark">&gt;_</div>
                <p>&quot;{activeWorkspace.name}&quot; isn&apos;t running</p>
                <p className="empty-main-sub">
                  Its {activeWorkspace.terminals.length} terminal{activeWorkspace.terminals.length === 1 ? '' : 's'}{' '}
                  start{activeWorkspace.terminals.length === 1 ? 's' : ''} when you open it.
                </p>
                <button className="primary" onClick={() => openWorkspace(activeWorkspace.id)}>
                  Start terminals
                </button>
              </div>
            )}
          {activeWorkspace && activeWorkspace.terminals.length > 0 && openedWorkspaceIds.has(activeWorkspace.id) && (
            <GridWall workspace={activeWorkspace} />
          )}
          {/* Overlays the wall instead of taking space from it: the shared terminal size can't change. */}
          {filesOpen && <FileDrawer onClose={() => setFilesOpen(false)} />}
        </div>

        {workspaceDialogOpen && <WorkspaceDialog onClose={() => setWorkspaceDialogOpen(false)} />}
        {terminalDialog && (
          <TerminalDialog
            workspaceId={terminalDialog.workspaceId}
            initialPath={terminalDialog.initialPath}
            onClose={() => setTerminalDialog(null)}
          />
        )}
        {settingsModalOpen && <SettingsModal onClose={() => setSettingsModalOpen(false)} />}
        {dialog?.kind === 'renameWorkspace' && (
          <PromptDialog
            title="Rename workspace"
            label="Name"
            initial={dialog.workspace.name}
            onSubmit={(name) => {
              renameWorkspace(dialog.workspace.id, name)
              void window.api.renameWorkspace(dialog.workspace.id, name)
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'deleteWorkspace' && (
          <ConfirmDialog
            title="Delete workspace?"
            confirmLabel="Delete"
            onConfirm={() => {
              removeWorkspace(dialog.workspace.id)
              void window.api.deleteWorkspace(dialog.workspace.id)
            }}
            onClose={() => setDialog(null)}
          >
            This stops all {dialog.workspace.terminals.length} running session
            {dialog.workspace.terminals.length === 1 ? '' : 's'} in <strong>{dialog.workspace.name}</strong> and
            removes it from Pitwall. The project files on disk are untouched.
          </ConfirmDialog>
        )}
        {dialog?.kind === 'renameTerminal' && (
          <PromptDialog
            title="Rename terminal"
            label="Name"
            initial={dialog.terminal.name}
            onSubmit={(name) => {
              const ws = workspaceOf(dialog.terminal.id)
              if (ws) renameTerminal(ws.id, dialog.terminal.id, name)
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'deleteTerminal' && (
          <ConfirmDialog
            title="Delete terminal?"
            confirmLabel="Delete"
            onConfirm={() => {
              const ws = workspaceOf(dialog.terminal.id)
              if (ws) removeTerminal(ws.id, dialog.terminal.id)
            }}
            onClose={() => setDialog(null)}
          >
            This stops the running session for <strong>{dialog.terminal.name}</strong>. The project files on disk are
            untouched.
          </ConfirmDialog>
        )}

        {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
        {paletteOpen && (
          <CommandPalette onClose={() => setPaletteOpen(false)} onNewWorkspace={() => setWorkspaceDialogOpen(true)} />
        )}
        {toasts.length > 0 && (
          <div className="toast-stack">
            {toasts.map((toast) => (
              <button
                key={toast.id}
                className="toast"
                onClick={() => {
                  enterTerminal(toast.terminalId)
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id))
                }}
              >
                <span className="status-dot status-waiting" />
                <span>
                  <strong>{toast.name}</strong> is waiting for input
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </TileActionsContext.Provider>
  )
}
