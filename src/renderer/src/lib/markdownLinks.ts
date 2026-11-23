/**
 * Links inside a previewed Markdown file, followed the way GitHub follows them: a relative path
 * counts from the file's own folder, a leading "/" from the repository root, and "#section"
 * points at a heading on the page. Pure string logic (no fs, no DOM) so it can be unit-tested.
 */

export type MarkdownLink =
  /** A web page: handed to the browser. */
  | { kind: 'external'; url: string }
  /** A section of the file being shown ('' = its top). */
  | { kind: 'anchor'; fragment: string }
  /**
   * A file or folder on disk. `base` says what `path` counts from: the Markdown file's folder,
   * the repository root (a leading "/"), or nothing (already absolute).
   */
  | { kind: 'path'; path: string; base: 'file' | 'repo' | 'absolute'; fragment: string | null }
  /** Anything else (mailto:, javascript:, network paths, empty links): not followed. */
  | { kind: 'ignore' }

/** Prefix of the ids given to headings, so a heading can never take an id the app itself uses. */
export const HEADING_ID_PREFIX = 'md-'

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const DRIVE = /^[a-zA-Z]:([\\/]|$)/
const NETWORK = /^[\\/]{2}/

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * What a link points to, from its href exactly as written in the file (marked percent-encodes
 * it, so spaces, backslashes and non-ASCII letters arrive as %XX).
 */
export function parseMarkdownLink(href: string | null | undefined): MarkdownLink {
  const raw = (href ?? '').trim()
  if (!raw) return { kind: 'ignore' }
  if (raw.startsWith('#')) return { kind: 'anchor', fragment: decode(raw.slice(1)) }

  const scheme = SCHEME.exec(raw)?.[1].toLowerCase()
  // A one-letter "scheme" is a Windows drive letter (C:\...), not a URL.
  if (scheme && scheme.length > 1) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'external', url: raw }
    if (scheme === 'file') return parseFileUrl(raw)
    return { kind: 'ignore' }
  }

  const hashAt = raw.indexOf('#')
  const fragment = hashAt === -1 ? null : decode(raw.slice(hashAt + 1))
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  const path = decode(queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt))

  if (!path) return { kind: 'anchor', fragment: fragment ?? '' }
  // \\server\share and //host/...: following one would make Windows contact that machine.
  if (NETWORK.test(path)) return { kind: 'ignore' }
  if (DRIVE.test(path)) return { kind: 'path', path, base: 'absolute', fragment }
  if (path.startsWith('/') || path.startsWith('\\')) return { kind: 'path', path, base: 'repo', fragment }
  return { kind: 'path', path, base: 'file', fragment }
}

function parseFileUrl(raw: string): MarkdownLink {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'ignore' }
  }
  if (url.host && url.host.toLowerCase() !== 'localhost') return { kind: 'ignore' }
  let path = decode(url.pathname)
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1) // file:///C:/x -> C:/x
  if (!path || NETWORK.test(path)) return { kind: 'ignore' }
  const fragment = url.hash ? decode(url.hash.slice(1)) : null
  return { kind: 'path', path, base: 'absolute', fragment }
}

interface SplitPath {
  /** 'C:\', '\\server\share\', '/' or '' (relative). */
  root: string
  segments: string[]
  windows: boolean
}

function rawSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
}

/** Apply "..": never above a root; kept at the front of a relative path. */
function collapse(segments: string[], relative: boolean): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (segment !== '..') out.push(segment)
    else if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (relative) out.push('..')
  }
  return out
}

function splitPath(path: string): SplitPath {
  const drive = /^([a-zA-Z]:)(?:[\\/]+|$)/.exec(path)
  if (drive) return { root: `${drive[1]}\\`, segments: collapse(rawSegments(path.slice(drive[0].length)), false), windows: true }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*/.exec(path)
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}\\`, segments: collapse(rawSegments(path.slice(unc[0].length)), false), windows: true }
  if (path.startsWith('/')) return { root: '/', segments: collapse(rawSegments(path), false), windows: false }
  return { root: '', segments: collapse(rawSegments(path), true), windows: path.includes('\\') }
}

function format(split: SplitPath): string {
  return split.root + split.segments.join(split.windows ? '\\' : '/')
}

/** `path` with ".", "..", repeated and trailing separators resolved; Windows paths use "\". */
export function normalizePath(path: string): string {
  return format(splitPath(path))
}

/** `relative` resolved against the folder `baseDir` (an absolute `relative` wins). */
export function resolvePath(baseDir: string, relative: string): string {
  const rel = splitPath(relative)
  if (rel.root) return format(rel)
  const base = splitPath(baseDir)
  return format({
    root: base.root,
    segments: collapse([...base.segments, ...rawSegments(relative)], base.root === ''),
    windows: base.windows || rel.windows
  })
}

/** The folder containing `path` (a root is its own folder). */
export function dirName(path: string): string {
  return resolvePath(path, '..')
}

/** The last segment of `path` ('' for a root). */
export function baseName(path: string): string {
  const { segments } = splitPath(path)
  return segments[segments.length - 1] ?? ''
}

function sameSegment(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The segments of `child` below `parent` ([] when they're the same folder), or null when `child`
 * isn't inside `parent`. Case-insensitive for Windows paths.
 */
export function relativeSegments(parent: string, child: string): string[] | null {
  const p = splitPath(parent)
  const c = splitPath(child)
  const windows = p.windows || c.windows
  if (!p.root || !sameSegment(p.root, c.root, windows)) return null
  if (c.segments.length < p.segments.length) return null
  for (let i = 0; i < p.segments.length; i++) {
    if (!sameSegment(p.segments[i], c.segments[i], windows)) return null
  }
  return c.segments.slice(p.segments.length)
}

export function isInside(child: string, parent: string): boolean {
  return relativeSegments(parent, child) !== null
}

export function samePath(a: string, b: string): boolean {
  return relativeSegments(a, b)?.length === 0
}

/**
 * The absolute path a `path` link points to, from the Markdown file it's in. `repoRoot` is what
 * a leading "/" counts from: the file's repository root, or the drawer's folder outside a repo.
 */
export function resolveLinkPath(
  link: Extract<MarkdownLink, { kind: 'path' }>,
  fromFile: string,
  repoRoot: string
): string {
  if (link.base === 'absolute') return normalizePath(link.path)
  if (link.base === 'repo') return resolvePath(repoRoot, link.path.replace(/^[\\/]+/, ''))
  return resolvePath(dirName(fromFile), link.path)
}

/**
 * GitHub's heading anchors (github-slugger): lowercase, punctuation and symbols dropped, each
 * space a "-", and "-1", "-2", ... added to repeats. One slugger per rendered document.
 */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>()
  return (text) => {
    const original = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    let slug = original
    while (occurrences.has(slug)) {
      const count = (occurrences.get(original) ?? 0) + 1
      occurrences.set(original, count)
      slug = `${original}-${count}`
    }
    occurrences.set(slug, 0)
    return slug
  }
}
