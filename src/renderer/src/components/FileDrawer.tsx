import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, PaneCwd } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import FilePreviewContent, { fileName } from './FilePreviewContent'
import FileIcon from './FileIcon'

interface Props {
  onClose: () => void
}

type DirState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: FileEntry[] }

const SOURCE_LABEL: Record<PaneCwd['source'], string> = {
  agent: 'agent cwd',
  shell: 'shell cwd',
  reported: 'shell cwd',
  start: 'start folder'
}

function TreeNode({
  entry,
  depth,
  expanded,
  dirs,
  onToggle,
  onSelectFile,
  selectedPath
}: {
  entry: FileEntry
  depth: number
  expanded: Set<string>
  dirs: Record<string, DirState>
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
  selectedPath: string | null
}): React.JSX.Element {
  const isOpen = entry.isDirectory && expanded.has(entry.path)
  const dirState = dirs[entry.path]
  return (
    <div>
      <div
        className={`file-tree-row${selectedPath === entry.path ? ' selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => (entry.isDirectory ? onToggle(entry.path) : onSelectFile(entry.path))}
      >
        <span className="file-tree-chevron">{entry.isDirectory ? (isOpen ? '▾' : '▸') : ''}</span>
        <span className="file-tree-icon">
          <FileIcon name={entry.name} isDirectory={entry.isDirectory} isOpen={isOpen} />
        </span>
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {isOpen && dirState?.status === 'loading' && (
        <div className="file-tree-hint" style={{ paddingLeft: 24 + depth * 14 }}>
          Loading…
        </div>
      )}
      {isOpen && dirState?.status === 'error' && (
        <div className="file-tree-hint" style={{ paddingLeft: 24 + depth * 14 }}>
          {dirState.message}
        </div>
      )}
      {isOpen && dirState?.status === 'ready' && dirState.entries.length === 0 && (
        <div className="file-tree-hint" style={{ paddingLeft: 24 + depth * 14 }}>
          Empty
        </div>
      )}
      {isOpen &&
        dirState?.status === 'ready' &&
        dirState.entries.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            dirs={dirs}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
            selectedPath={selectedPath}
          />
        ))}
    </div>
  )
}

/**
 * File explorer as an overlay drawer on the right of the wall. It floats over the tiles and
 * never takes space from them, so opening it can't change the shared terminal size. Its root is
 * the selected tile's current working directory (agent child / shell report / start folder, see
 * PtyManager.getCwd), resolved when it opens, when the selection changes, and on ↻.
 */
export default function FileDrawer({ onClose }: Props): React.JSX.Element {
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const workspaces = useAppStore((s) => s.workspaces)
  const drawerWidth = useAppStore((s) => s.settings.filePanelWidth)
  const setDrawerWidth = useAppStore((s) => s.setFilePanelWidth)
  const terminal = useMemo(
    () => workspaces.flatMap((w) => w.terminals).find((t) => t.id === focusedTerminalId) ?? null,
    [workspaces, focusedTerminalId]
  )

  const [root, setRoot] = useState<PaneCwd | null>(null)
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const resizingRef = useRef(false)
  const terminalId = terminal?.id ?? null
  const projectPath = terminal?.projectPath ?? null

  const resolveRoot = useCallback(async (): Promise<void> => {
    if (!terminalId) {
      setRoot(null)
      return
    }
    const result = await window.api.getTerminalCwd(terminalId)
    setRoot(result ?? (projectPath ? { cwd: projectPath, source: 'start' } : null))
  }, [terminalId, projectPath])

  useEffect(() => {
    setRoot(null)
    void resolveRoot()
  }, [resolveRoot])

  const rootPath = root?.cwd ?? null

  async function loadDir(path: string): Promise<void> {
    setDirs((prev) => ({ ...prev, [path]: { status: 'loading' } }))
    const result = await window.api.listDir(path)
    setDirs((prev) => ({
      ...prev,
      [path]: result.ok ? { status: 'ready', entries: result.entries } : { status: 'error', message: result.message }
    }))
  }

  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setSelectedPath(null)
    if (rootPath) void loadDir(rootPath)
  }, [rootPath])

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!dirs[path]) void loadDir(path)
      }
      return next
    })
  }

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    resizingRef.current = true
    const onMove = (moveEvent: MouseEvent): void => {
      if (!resizingRef.current) return
      setDrawerWidth(Math.min(Math.max(window.innerWidth - moveEvent.clientX, 240), Math.min(900, window.innerWidth - 200)))
    }
    const onUp = (): void => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const rootEntries = rootPath ? dirs[rootPath] : undefined

  return (
    <aside className="file-drawer" style={{ width: drawerWidth }} aria-label="Files">
      <div className="file-panel-resizer" onMouseDown={startResize} />
      <div className="file-panel-header">
        {selectedPath ? (
          <button className="file-panel-back" onClick={() => setSelectedPath(null)} title="Back to tree">
            ← {fileName(selectedPath)}
          </button>
        ) : (
          <span className="file-panel-title">{terminal ? terminal.name : 'Files'}</span>
        )}
        <div className="file-panel-header-actions">
          {terminal && (
            <button className="icon-button small" title="Re-read the tile's cwd" onClick={() => void resolveRoot()}>
              ↻
            </button>
          )}
          <button className="icon-button small" title="Close (Ctrl+Shift+E)" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      {root && (
        <div className="file-drawer-root" title={root.cwd}>
          <span className="file-drawer-path">{root.cwd}</span>
          <span className="file-drawer-source">{SOURCE_LABEL[root.source]}</span>
        </div>
      )}
      {!terminal && <div className="file-tree-hint file-drawer-empty">Select a tile to browse its files.</div>}
      {terminal && !root && <div className="file-tree-hint file-drawer-empty">Resolving cwd…</div>}
      {terminal && root && !selectedPath && (
        <div className="file-tree">
          {rootEntries?.status === 'loading' && <div className="file-tree-hint">Loading…</div>}
          {rootEntries?.status === 'error' && <div className="file-tree-hint">{rootEntries.message}</div>}
          {rootEntries?.status === 'ready' &&
            rootEntries.entries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                dirs={dirs}
                onToggle={toggleDir}
                onSelectFile={(p) => setSelectedPath(p)}
                selectedPath={selectedPath}
              />
            ))}
        </div>
      )}
      {terminal && selectedPath && <FilePreviewContent path={selectedPath} />}
    </aside>
  )
}
