import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../../shared/types'
import { dirName, samePath } from '../lib/markdownLinks'
import FileIcon from './FileIcon'

interface Props {
  path: string
  /** Scroll position to come back to (returning here with the back button). */
  initialScrollTop?: number
  /** Receives the scrolling element, so the drawer can remember the position. */
  scrollerRef?: React.MutableRefObject<HTMLDivElement | null>
  onOpenEntry: (path: string, isDirectory: boolean) => void
}

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: FileEntry[] }

/**
 * The contents of a folder outside the tile's folder, reached from a link. The tree only shows
 * the tile's folder, so a folder elsewhere is listed here instead, one level at a time.
 */
export default function FolderListing({ path, initialScrollTop, scrollerRef, onOpenEntry }: Props): React.JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  const initialScrollDone = useRef(false)
  const parent = dirName(path)
  const hasParent = !samePath(parent, path)

  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerElRef.current = el
      if (scrollerRef) scrollerRef.current = el
    },
    [scrollerRef]
  )

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    window.api.listDir(path).then((result) => {
      if (cancelled) return
      setState(result.ok ? { status: 'ready', entries: result.entries } : { status: 'error', message: result.message })
    })
    return () => {
      cancelled = true
    }
  }, [path])

  useLayoutEffect(() => {
    if (state.status !== 'ready' || initialScrollDone.current) return
    initialScrollDone.current = true
    if (initialScrollTop && scrollerElRef.current) scrollerElRef.current.scrollTop = initialScrollTop
  }, [state.status, initialScrollTop])

  return (
    <div className="file-tree folder-listing" ref={setScroller}>
      <div className="folder-listing-path" title={path}>
        {path}
      </div>
      {hasParent && (
        <div className="file-tree-row folder-listing-up" title={parent} onClick={() => onOpenEntry(parent, true)}>
          <span className="file-tree-chevron" />
          <span className="file-tree-icon">
            <FileIcon name=".." isDirectory isOpen={false} />
          </span>
          <span className="file-tree-name">..</span>
          <span className="folder-listing-up-label">up one level</span>
        </div>
      )}
      {state.status === 'loading' && <div className="file-tree-hint">Loading…</div>}
      {state.status === 'error' && (
        <div className="file-tree-hint">
          Can&apos;t read this folder: {state.message}
        </div>
      )}
      {state.status === 'ready' && state.entries.length === 0 && <div className="file-tree-hint">Empty folder</div>}
      {state.status === 'ready' &&
        state.entries.map((entry) => (
          <div
            key={entry.path}
            className="file-tree-row"
            data-path={entry.path}
            onClick={() => onOpenEntry(entry.path, entry.isDirectory)}
          >
            <span className="file-tree-chevron">{entry.isDirectory ? '▸' : ''}</span>
            <span className="file-tree-icon">
              <FileIcon name={entry.name} isDirectory={entry.isDirectory} isOpen={false} />
            </span>
            <span className="file-tree-name">{entry.name}</span>
          </div>
        ))}
    </div>
  )
}
