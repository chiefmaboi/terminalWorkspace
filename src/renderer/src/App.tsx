import { useEffect, useLayoutEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import GridWall from './components/GridWall'
import WorkspaceDialog from './components/WorkspaceDialog'
import TerminalDialog from './components/TerminalDialog'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import CommandPalette from './components/CommandPalette'
import FileExplorer from './components/FileExplorer'
import { useAppStore } from './store/useAppStore'
import * as terminals from './terminal/registry'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

function isInTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.xterm') !== null
}

export default function App(): React.JSX.Element {
  const loaded = useAppStore((s) => s.loaded)
  const workspaces = useAppStore((s) => s.workspaces)
  const settings = useAppStore((s) => s.settings)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const maximizedTerminalId = useAppStore((s) => s.maximizedTerminalId)
  const load = useAppStore((s) => s.load)
  const openWorkspace = useAppStore((s) => s.openWorkspace)
  const setStatus = useAppStore((s) => s.setStatus)
  const setGitBranch = useAppStore((s) => s.setGitBranch)
  const markHookEventReceived = useAppStore((s) => s.markHookEventReceived)
  const focusTerminal = useAppStore((s) => s.focusTerminal)
  const setMaximized = useAppStore((s) => s.setMaximized)
  const toggleMaximized = useAppStore((s) => s.toggleMaximized)
  const markPtyStarted = useAppStore((s) => s.markPtyStarted)
  const setPreview = useAppStore((s) => s.setPreview)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [terminalDialogWorkspaceId, setTerminalDialogWorkspaceId] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [showRestorePrompt, setShowRestorePrompt] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: string; terminalId: string; name: string }>>([])

  useEffect(() => {
    terminals.initTerminalRegistry({
      onFocus: (id) => focusTerminal(id),
      onPreview: (id, text) => setPreview(id, text),
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
    const active = workspaces.find((w) => w.id === settings.activeWorkspaceId)
    document.title = active ? `${active.name}: Pitwall` : 'Pitwall'
  }, [workspaces, settings.activeWorkspaceId])

  useEffect(() => {
    if (!loaded) return
    if (workspaces.length > 0 && settings.activeWorkspaceId) {
      setShowRestorePrompt(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  useEffect(() => {
    const unsubStatus = window.api.onStatusChanged((id, status, unreadCount) => {
      const previousStatus = useAppStore.getState().runtime[id]?.status
      setStatus(id, status as 'idle' | 'working' | 'waiting', unreadCount)
      // The OS notification (main process) only fires while unfocused; mirror it in-app for
      // the case where you're focused on the app but looking at a different pane.
      if (status === 'waiting' && previousStatus !== 'waiting' && document.hasFocus()) {
        const state = useAppStore.getState()
        const terminal = state.workspaces.flatMap((w) => w.terminals).find((t) => t.id === id)
        const name = terminal?.name ?? id
        const toastId = `${id}-${Date.now()}`
        setToasts((prev) => [...prev, { id: toastId, terminalId: id, name }])
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toastId)), 6000)
      }
    })
    const unsubBranch = window.api.onGitBranchChanged((id, branch) => setGitBranch(id, branch))
    const unsubFocus = window.api.onTerminalFocusRequest((id) => focusTerminal(id))
    const unsubHook = window.api.onHookEvent((_name, receivedAt) => markHookEventReceived(receivedAt))
    return () => {
      unsubStatus()
      unsubBranch()
      unsubFocus()
      unsubHook()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl+Shift+Enter toggles maximize/restore of the selected tile from anywhere, including from
  // inside a terminal. Capture phase on window runs before xterm's own keydown handler on its
  // textarea, and stopPropagation keeps the chord from ever reaching the PTY.
  useEffect(() => {
    function handleChord(event: KeyboardEvent): void {
      if (event.key === 'Enter' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        toggleMaximized()
      }
    }
    window.addEventListener('keydown', handleChord, true)
    return () => window.removeEventListener('keydown', handleChord, true)
  }, [toggleMaximized])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey) {
        if (event.key >= '1' && event.key <= '9') {
          const index = Number(event.key) - 1
          const target = workspaces[index]
          if (target) {
            event.preventDefault()
            openWorkspace(target.id)
          }
          return
        }
        if (event.key.toLowerCase() === 'n') {
          event.preventDefault()
          setDialogOpen(true)
          return
        }
        // Ctrl+K is a common terminal readline shortcut (delete-to-end-of-line); only steal it
        // for the command palette when focus isn't inside a terminal or text field.
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
        // Esc Esc to rewind); it only returns to the grid when focus is somewhere else.
        if (!isInTerminal(event.target) && useAppStore.getState().maximizedTerminalId) {
          setMaximized(null)
        }
        return
      }
      // Quick workspace switching with the arrow keys — but never while a terminal or text
      // field has focus, since shells rely on Up/Down for command history.
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !isTypingTarget(event.target)) {
        if (workspaces.length === 0) return
        event.preventDefault()
        const currentIndex = workspaces.findIndex((w) => w.id === settings.activeWorkspaceId)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (currentIndex + delta + workspaces.length) % workspaces.length
        openWorkspace(workspaces[nextIndex].id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, settings.activeWorkspaceId])

  function applyRestore(shouldRestore: boolean): void {
    setShowRestorePrompt(false)
    if (!shouldRestore) return
    if (settings.activeWorkspaceId) openWorkspace(settings.activeWorkspaceId)
  }

  const activeWorkspace = workspaces.find((w) => w.id === settings.activeWorkspaceId) ?? null

  return (
    <div className="app-shell">
      <Sidebar
        onNewWorkspace={() => setDialogOpen(true)}
        onNewTerminal={(workspaceId) => setTerminalDialogWorkspaceId(workspaceId)}
      />
      <div className="main-area">
        {workspaces.length === 0 && (
          <div className="empty-main">
            <div className="empty-main-mark">&gt;_</div>
            <p>No workspaces yet</p>
            <p className="empty-main-sub">
              A workspace is a named group of terminals. Add one, then add terminals to it.
            </p>
            <button className="primary" onClick={() => setDialogOpen(true)}>
              Create your first workspace
            </button>
          </div>
        )}
        {workspaces.length > 0 && activeWorkspace && activeWorkspace.terminals.length === 0 && (
          <div className="empty-main">
            <div className="empty-main-mark">&gt;_</div>
            <p>&quot;{activeWorkspace.name}&quot; has no terminals yet</p>
            <p className="empty-main-sub">Add one to point it at a project folder and start a session.</p>
            <button className="primary" onClick={() => setTerminalDialogWorkspaceId(activeWorkspace.id)}>
              Add a terminal
            </button>
          </div>
        )}
        {workspaces.length > 0 && !activeWorkspace && (
          <div className="empty-main">
            <div className="empty-main-mark">&gt;_</div>
            <p>Select a workspace to start its sessions</p>
            <p className="empty-main-sub">Click one in the sidebar, or press Ctrl+1…9.</p>
          </div>
        )}
        {activeWorkspace && activeWorkspace.terminals.length > 0 && (
          <GridWall
            workspace={activeWorkspace}
            actions={
              <>
                <button className="auto-arrange-button" title="Keyboard shortcuts (?)" onClick={() => setShortcutsOpen(true)}>
                  ? Shortcuts
                </button>
                <button
                  className={`auto-arrange-button${filesOpen ? ' active' : ''}`}
                  title="Toggle file explorer for the focused terminal"
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  📁 Files
                </button>
              </>
            }
          />
        )}
      </div>
      {filesOpen && <FileExplorer onClose={() => setFilesOpen(false)} />}
      {dialogOpen && <WorkspaceDialog onClose={() => setDialogOpen(false)} />}
      {terminalDialogWorkspaceId && (
        <TerminalDialog workspaceId={terminalDialogWorkspaceId} onClose={() => setTerminalDialogWorkspaceId(null)} />
      )}
      {showRestorePrompt && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Restore previous session?</h2>
            <p>Claude Code sessions don&apos;t survive an app restart. Start them again now?</p>
            <div className="modal-actions">
              <button onClick={() => applyRestore(false)}>Not now</button>
              <button className="primary" onClick={() => applyRestore(true)}>
                Restart sessions
              </button>
            </div>
          </div>
        </div>
      )}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onNewWorkspace={() => setDialogOpen(true)} />
      )}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <button
              key={toast.id}
              className="toast"
              onClick={() => {
                focusTerminal(toast.terminalId)
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
  )
}
