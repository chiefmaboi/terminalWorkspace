import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, PaneCwd } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { relativeSegments, samePath } from '../lib/markdownLinks'
import FilePreviewContent, { fileName } from './FilePreviewContent'
import FolderListing from './FolderListing'
import FileIcon from './FileIcon'

interface Props {
  onClose: () => void
}

type DirState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: FileEntry[] }

/**
 * What the drawer shows on top of the tree. Following links stacks these, and the back button
 * steps down the stack; an empty stack is the tree itself.
 */
type ViewBody =
  | { kind: 'file'; path: string; fragment: string | null; scrollTop?: number }
  /** A folder outside the tile's folder, listed in the preview area. */
  | { kind: 'folder'; path: string; scrollTop?: number }
  | { kind: 'missing'; path: string; message: string }
  /** The tree, with a linked folder inside the tile's folder opened and highlighted. */
  | { kind: 'tree'; reveal: string }
type View = ViewBody & { id: number }

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
        data-path={entry.path}
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
  const [stack, setStack] = useState<View[]>([])
  const resizingRef = useRef(false)
  const dirsRef = useRef(dirs)
  const nextViewId = useRef(1)
  // Bumped whenever the stack is reset, so a link still resolving can't land on a new root.
  const navGeneration = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const terminalId = terminal?.id ?? null
  const projectPath = terminal?.projectPath ?? null

  useLayoutEffect(() => {
    dirsRef.current = dirs
  }, [dirs])

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

  async function loadDir(path: string): Promise<FileEntry[] | null> {
    setDirs((prev) => ({ ...prev, [path]: { status: 'loading' } }))
    const result = await window.api.listDir(path)
    setDirs((prev) => ({
      ...prev,
      [path]: result.ok ? { status: 'ready', entries: result.entries } : { status: 'error', message: result.message }
    }))
    return result.ok ? result.entries : null
  }

  async function ensureDir(path: string): Promise<FileEntry[] | null> {
    const known = dirsRef.current[path]
    return known?.status === 'ready' ? known.entries : loadDir(path)
  }

  useEffect(() => {
    navGeneration.current++
    setDirs({})
    setExpanded(new Set())
    setStack([])
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

  /** Show `body` on top; `fresh` starts a new history (a file picked in the tree). */
  function pushView(body: ViewBody, fresh = false): void {
    const scrollTop = scrollerRef.current?.scrollTop
    const id = nextViewId.current++
    setStack((prev) => {
      const kept = fresh
        ? []
        : prev.map((view, i) =>
            i === prev.length - 1 && (view.kind === 'file' || view.kind === 'folder') && scrollTop !== undefined
              ? { ...view, scrollTop }
              : view
          )
      return [...kept, { ...body, id }]
    })
  }

  function back(): void {
    setStack((prev) => prev.slice(0, -1))
  }

  /**
   * A folder reached from a link or a folder list: inside the tile's folder it opens in the
   * tree (parents expanded, the folder opened and highlighted); anywhere else it's listed in the
   * preview area, since the tree only shows the tile's folder.
   */
  async function openFolder(path: string): Promise<void> {
    const segments = rootPath ? relativeSegments(rootPath, path) : null
    if (!rootPath || segments === null) {
      pushView({ kind: 'folder', path })
      return
    }
    const generation = navGeneration.current
    // Walk down from the root using the tree's own entries, so the expanded paths match its
    // rows exactly even when the link spells a folder with different case.
    let current = rootPath
    const chain: string[] = []
    for (const segment of segments) {
      const entries = await ensureDir(current)
      if (generation !== navGeneration.current) return
      const match =
        entries?.find((e) => e.isDirectory && e.name === segment) ??
        entries?.find((e) => e.isDirectory && e.name.toLowerCase() === segment.toLowerCase())
      if (!match) break
      chain.push(match.path)
      current = match.path
    }
    if (chain.length > 0) void ensureDir(current)
    setExpanded((prev) => new Set([...prev, ...chain]))
    pushView({ kind: 'tree', reveal: current })
  }

  /** A link to a file or folder was clicked in a preview. */
  async function openLinkedPath(path: string, fragment: string | null): Promise<void> {
    const generation = navGeneration.current
    const stat = await window.api.statPath(path)
    if (generation !== navGeneration.current) return
    if (stat.kind === 'file') pushView({ kind: 'file', path, fragment })
    else if (stat.kind === 'directory') await openFolder(path)
    else pushView({ kind: 'missing', path, message: stat.kind === 'error' ? stat.message : '' })
  }

  const top = stack.length > 0 ? stack[stack.length - 1] : null
  const previous = stack.length > 1 ? stack[stack.length - 2] : null
  const highlightPath = top?.kind === 'tree' ? top.reveal : null

  function viewLabel(view: View): string {
    switch (view.kind) {
      case 'file':
      case 'folder':
        return fileName(view.path)
      case 'missing':
        return 'Not found'
      case 'tree':
        return rootPath && samePath(view.reveal, rootPath) ? 'files' : fileName(view.reveal)
    }
  }

  function viewPath(view: View): string {
    return view.kind === 'tree' ? view.reveal : view.path
  }

  // Scroll a revealed folder into view once its row exists (its parents may still be loading).
  const revealedViewId = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (top?.kind !== 'tree' || revealedViewId.current === top.id) return
    const tree = treeRef.current
    if (!tree) return
    if (rootPath && samePath(top.reveal, rootPath)) {
      tree.scrollTop = 0
      revealedViewId.current = top.id
      return
    }
    const row = [...tree.querySelectorAll<HTMLElement>('.file-tree-row')].find((el) => el.dataset.path === top.reveal)
    if (!row) return
    const treeBox = tree.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    if (rowBox.top < treeBox.top || rowBox.bottom > treeBox.bottom) {
      tree.scrollTop += rowBox.top - treeBox.top - treeBox.height / 3
    }
    revealedViewId.current = top.id
  })

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
  const showTree = terminal && root && (!top || top.kind === 'tree')

  return (
    <aside className="file-drawer" style={{ width: drawerWidth }} aria-label="Files">
      <div className="file-panel-resizer" onMouseDown={startResize} />
      <div className="file-panel-header">
        {top ? (
          <button
            className="file-panel-back"
            onClick={back}
            title={`Back to ${previous ? viewLabel(previous) : 'the file tree'}\n${viewPath(top)}`}
          >
            ← {viewLabel(top)}
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
      {showTree && (
        <div className="file-tree" ref={treeRef}>
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
                onSelectFile={(p) => pushView({ kind: 'file', path: p, fragment: null }, true)}
                selectedPath={highlightPath}
              />
            ))}
        </div>
      )}
      {terminal && root && top?.kind === 'file' && (
        <FilePreviewContent
          key={top.id}
          path={top.path}
          fragment={top.fragment}
          initialScrollTop={top.scrollTop}
          fallbackRoot={root.cwd}
          scrollerRef={scrollerRef}
          onOpenPath={(p, f) => void openLinkedPath(p, f)}
        />
      )}
      {terminal && root && top?.kind === 'folder' && (
        <FolderListing
          key={top.id}
          path={top.path}
          initialScrollTop={top.scrollTop}
          scrollerRef={scrollerRef}
          onOpenEntry={(p, isDirectory) =>
            isDirectory ? void openFolder(p) : pushView({ kind: 'file', path: p, fragment: null })
          }
        />
      )}
      {terminal && root && top?.kind === 'missing' && (
        <div className="file-preview file-preview-missing">
          <div className="file-tree-hint">{top.message ? `Can't open: ${top.message}` : 'Not found'}</div>
          <div className="folder-listing-path" title={top.path}>
            {top.path}
          </div>
        </div>
      )}
    </aside>
  )
}
