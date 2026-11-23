import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  HEADING_ID_PREFIX,
  createSlugger,
  dirName,
  parseMarkdownLink,
  resolveLinkPath,
  samePath
} from '../lib/markdownLinks'
import type { MarkdownLink } from '../lib/markdownLinks'

interface Props {
  path: string
  /** Section to show once the file is loaded (the #fragment of the link that opened it). */
  fragment?: string | null
  /** Scroll position to come back to (returning to this file with the back button). */
  initialScrollTop?: number
  /** What a "/" link counts from when the file isn't in a repository: the drawer's folder. */
  fallbackRoot: string
  /** Receives the scrolling element, so the drawer can remember the position. */
  scrollerRef?: React.MutableRefObject<HTMLDivElement | null>
  /** A link to another file or folder was clicked. */
  onOpenPath: (path: string, fragment: string | null) => void
}

type FileState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'binary' }
  | { status: 'ready'; content: string; truncated: boolean }

type PathLink = Extract<MarkdownLink, { kind: 'path' }>

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function extensionOf(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isMarkdownFile(path: string): boolean {
  return ['md', 'markdown'].includes(extensionOf(path))
}

export function isHtmlFile(path: string): boolean {
  return ['html', 'htm'].includes(extensionOf(path))
}

// Repository root per folder, looked up once per folder for the app's lifetime.
const repoRoots = new Map<string, Promise<string | null>>()
function repoRootOf(dir: string): Promise<string | null> {
  let root = repoRoots.get(dir)
  if (!root) {
    root = window.api.repoRoot(dir).catch(() => null)
    repoRoots.set(dir, root)
  }
  return root
}

/** The element a #fragment points at: a heading's id, or an id/name the file sets itself. */
function findFragmentTarget(container: HTMLElement, fragment: string): HTMLElement | null {
  const ids = [HEADING_ID_PREFIX + fragment, HEADING_ID_PREFIX + fragment.toLowerCase()]
  const candidates = [...container.querySelectorAll<HTMLElement>('[id], [name]')]
  for (const id of ids) {
    const heading = candidates.find((el) => el.id === id)
    if (heading) return heading
  }
  return candidates.find((el) => el.id === fragment || el.getAttribute('name') === fragment) ?? null
}

export default function FilePreviewContent({
  path,
  fragment = null,
  initialScrollTop,
  fallbackRoot,
  scrollerRef,
  onOpenPath
}: Props): React.JSX.Element {
  const [fileState, setFileState] = useState<FileState>({ status: 'loading' })
  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  const markdownRef = useRef<HTMLDivElement | null>(null)
  const initialScrollDone = useRef(false)

  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerElRef.current = el
      if (scrollerRef) scrollerRef.current = el
    },
    [scrollerRef]
  )

  useEffect(() => {
    let cancelled = false
    setFileState({ status: 'loading' })
    window.api.readFile(path).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setFileState(
          result.reason === 'binary'
            ? { status: 'binary' }
            : { status: 'error', message: result.message ?? 'Could not read file.' }
        )
        return
      }
      setFileState({ status: 'ready', content: result.content, truncated: result.truncated })
    })
    return () => {
      cancelled = true
    }
  }, [path])

  const isMarkdown = isMarkdownFile(path)
  const content = fileState.status === 'ready' ? fileState.content : null
  // marked only converts Markdown syntax to HTML, it doesn't vet the raw HTML a file can already
  // contain; DOMPurify strips scripts and other unsafe markup before this ever reaches the DOM.
  const markdownHtml = useMemo(
    () => (isMarkdown && content !== null ? DOMPurify.sanitize(marked.parse(content, { async: false })) : null),
    [isMarkdown, content]
  )

  const repoRootFor = useCallback(
    async (): Promise<string> => (await repoRootOf(dirName(path))) ?? fallbackRoot,
    [path, fallbackRoot]
  )

  const scrollToFragment = useCallback((target: string) => {
    const scroller = scrollerElRef.current
    const container = markdownRef.current
    if (!scroller || !container) return
    if (!target) {
      scroller.scrollTop = 0
      return
    }
    const el = findFragmentTarget(container, target)
    if (!el) return
    // Scroll only the preview itself: scrollIntoView would also move the wall behind the drawer.
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
  }, [])

  // After each render of new Markdown: give headings their GitHub ids, show each link's target
  // on hover, and (the first time) scroll to the section the link asked for.
  useLayoutEffect(() => {
    const container = markdownRef.current
    if (!container || markdownHtml === null) return
    const slug = createSlugger()
    for (const heading of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
      heading.id = HEADING_ID_PREFIX + slug(heading.textContent ?? '')
    }

    let cancelled = false
    const describeTarget = (anchor: HTMLAnchorElement, target: string): void => {
      // The file's own link title (`[text](url "title")`) stays, with the target under it.
      const own = (anchor.dataset.ownTitle ??= anchor.getAttribute('title') ?? '')
      anchor.title = own ? `${own}\n${target}` : target
    }
    const repoLinks: { anchor: HTMLAnchorElement; link: PathLink }[] = []
    for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const link = parseMarkdownLink(anchor.getAttribute('href'))
      const withFragment = (p: string, f: string | null): string => (f ? `${p}#${f}` : p)
      if (link.kind === 'external') describeTarget(anchor, link.url)
      else if (link.kind === 'anchor' && link.fragment) describeTarget(anchor, `#${link.fragment}`)
      else if (link.kind === 'path' && link.base === 'repo') repoLinks.push({ anchor, link })
      else if (link.kind === 'path') describeTarget(anchor, withFragment(resolveLinkPath(link, path, ''), link.fragment))
    }
    if (repoLinks.length > 0) {
      void repoRootFor().then((root) => {
        if (cancelled) return
        for (const { anchor, link } of repoLinks) {
          const target = resolveLinkPath(link, path, root)
          describeTarget(anchor, link.fragment ? `${target}#${link.fragment}` : target)
        }
      })
    }

    if (!initialScrollDone.current) {
      initialScrollDone.current = true
      if (fragment) scrollToFragment(fragment)
      else if (initialScrollTop && scrollerElRef.current) scrollerElRef.current.scrollTop = initialScrollTop
    }
    return () => {
      cancelled = true
    }
  }, [markdownHtml, path, fragment, initialScrollTop, repoRootFor, scrollToFragment])

  // Plain-text previews come back to where they were too.
  useLayoutEffect(() => {
    if (fileState.status !== 'ready' || isMarkdown || initialScrollDone.current) return
    initialScrollDone.current = true
    if (initialScrollTop && scrollerElRef.current) scrollerElRef.current.scrollTop = initialScrollTop
  }, [fileState.status, isMarkdown, initialScrollTop])

  async function followLink(href: string | null): Promise<void> {
    const link = parseMarkdownLink(href)
    if (link.kind === 'ignore') return
    if (link.kind === 'external') {
      // Denied as a window and handed to the browser by the main process (http/https only).
      window.open(link.url, '_blank', 'noopener')
      return
    }
    if (link.kind === 'anchor') {
      scrollToFragment(link.fragment)
      return
    }
    const target = resolveLinkPath(link, path, link.base === 'repo' ? await repoRootFor() : '')
    if (samePath(target, path)) scrollToFragment(link.fragment ?? '')
    else onOpenPath(target, link.fragment)
  }

  function handleMarkdownClick(event: React.MouseEvent<HTMLDivElement>): void {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor || !event.currentTarget.contains(anchor) || !anchor.hasAttribute('href')) return
    // Never let the window itself navigate: a relative href would resolve against Pitwall's own
    // page, not the Markdown file.
    event.preventDefault()
    void followLink(anchor.getAttribute('href'))
  }

  return (
    <div className="file-preview" ref={setScroller}>
      {fileState.status === 'loading' && <div className="file-tree-hint">Loading…</div>}
      {fileState.status === 'error' && <div className="file-tree-hint">{fileState.message}</div>}
      {fileState.status === 'binary' && <div className="file-tree-hint">Binary file — no preview available.</div>}
      {fileState.status === 'ready' && (
        <>
          {fileState.truncated && <div className="file-tree-hint">Showing the first part of a large file.</div>}
          {markdownHtml !== null ? (
            <div
              ref={markdownRef}
              className="file-preview-markdown"
              onClick={handleMarkdownClick}
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
          ) : isHtmlFile(path) ? (
            // Fully sandboxed: no scripts, no same-origin access, no forms/popups — this is a
            // visual "what would this page look like" preview only, not a live webpage.
            <iframe className="file-preview-html" sandbox="" srcDoc={fileState.content} title={fileName(path)} />
          ) : (
            <pre className="file-preview-content">{fileState.content}</pre>
          )}
        </>
      )}
    </div>
  )
}
