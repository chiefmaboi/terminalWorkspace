import { describe, expect, it } from 'vitest'
import {
  baseName,
  createSlugger,
  dirName,
  isInside,
  normalizePath,
  parseMarkdownLink,
  relativeSegments,
  resolveLinkPath,
  resolvePath,
  samePath
} from '../markdownLinks'
import type { MarkdownLink } from '../markdownLinks'

const FILE = 'C:\\proj\\packages\\web\\README.md'
const REPO = 'C:\\proj'

/** Where `href`, written in FILE, leads. */
function target(href: string, repoRoot = REPO): string | MarkdownLink {
  const link = parseMarkdownLink(href)
  return link.kind === 'path' ? resolveLinkPath(link, FILE, repoRoot) : link
}

describe('parseMarkdownLink', () => {
  it('relative paths count from the file folder', () => {
    expect(target('guide.md')).toBe('C:\\proj\\packages\\web\\guide.md')
    expect(target('./docs/guide.md')).toBe('C:\\proj\\packages\\web\\docs\\guide.md')
    expect(target('docs\\guide.md')).toBe('C:\\proj\\packages\\web\\docs\\guide.md')
    expect(target('../../README.md')).toBe('C:\\proj\\README.md')
    expect(target('../../../../../../x.md')).toBe('C:\\x.md')
    expect(target('src/lib/')).toBe('C:\\proj\\packages\\web\\src\\lib')
  })

  it('decodes what marked percent-encodes', () => {
    expect(target('docs/my%20notes.md')).toBe('C:\\proj\\packages\\web\\docs\\my notes.md')
    expect(target('docs%5Cguide.md')).toBe('C:\\proj\\packages\\web\\docs\\guide.md')
    expect(target('%C3%A9t%C3%A9.md')).toBe('C:\\proj\\packages\\web\\été.md')
    expect(target('100%.md')).toBe('C:\\proj\\packages\\web\\100%.md')
    expect(target('a%23b.md')).toBe('C:\\proj\\packages\\web\\a#b.md')
  })

  it('splits off the section and the query', () => {
    expect(parseMarkdownLink('docs/guide.md#setup-steps')).toEqual({
      kind: 'path',
      path: 'docs/guide.md',
      base: 'file',
      fragment: 'setup-steps'
    })
    expect(parseMarkdownLink('guide.md?plain=1#L3')).toMatchObject({ path: 'guide.md', fragment: 'L3' })
    expect(parseMarkdownLink('guide.md?plain=1')).toMatchObject({ path: 'guide.md', fragment: null })
  })

  it('a leading slash counts from the repository root', () => {
    expect(target('/docs/setup.md')).toBe('C:\\proj\\docs\\setup.md')
    expect(target('\\docs\\setup.md')).toBe('C:\\proj\\docs\\setup.md')
    // Outside a repository the caller passes the drawer folder instead.
    expect(target('/docs/setup.md', 'C:\\proj\\packages\\web')).toBe('C:\\proj\\packages\\web\\docs\\setup.md')
  })

  it('absolute paths and file URLs are taken as they are', () => {
    expect(target('C:/other/notes.md')).toBe('C:\\other\\notes.md')
    expect(target('D:\\x\\..\\y.md')).toBe('D:\\y.md')
    expect(target('file:///C:/other/my%20notes.md')).toBe('C:\\other\\my notes.md')
    expect(parseMarkdownLink('file:///C:/other/notes.md#intro')).toMatchObject({ fragment: 'intro' })
  })

  it('sections of the same page', () => {
    expect(parseMarkdownLink('#setup')).toEqual({ kind: 'anchor', fragment: 'setup' })
    expect(parseMarkdownLink('#caf%C3%A9')).toEqual({ kind: 'anchor', fragment: 'café' })
    expect(parseMarkdownLink('#')).toEqual({ kind: 'anchor', fragment: '' })
    expect(parseMarkdownLink('?tab=readme')).toEqual({ kind: 'anchor', fragment: '' })
  })

  it('only http and https go to the browser', () => {
    expect(parseMarkdownLink('https://example.com/a?b=1#c')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1#c' })
    expect(parseMarkdownLink('HTTP://example.com')).toEqual({ kind: 'external', url: 'HTTP://example.com' })
  })

  it('everything else is not followed', () => {
    for (const href of [
      '',
      '   ',
      null,
      undefined,
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'vscode://file/C:/x',
      'ms-settings:display',
      'data:text/html,hi',
      // Network locations: Windows would contact the host.
      '//host/share/x.md',
      '%5C%5Chost%5Cshare%5Cx.md',
      'file://host/share/x.md'
    ]) {
      expect(parseMarkdownLink(href)).toEqual({ kind: 'ignore' })
    }
  })
})

describe('paths', () => {
  it('normalizes', () => {
    expect(normalizePath('C:/Users//me/./proj/../x/')).toBe('C:\\Users\\me\\x')
    expect(normalizePath('c:\\')).toBe('c:\\')
    expect(normalizePath('C:')).toBe('C:\\')
    expect(normalizePath('\\\\server\\share\\a\\..\\b')).toBe('\\\\server\\share\\b')
    expect(normalizePath('/home/me/../you/')).toBe('/home/you')
  })

  it('resolves, never above a root', () => {
    expect(resolvePath('C:\\a\\b', '..\\..\\..\\c')).toBe('C:\\c')
    expect(resolvePath('/home/me', '../../../etc')).toBe('/etc')
    expect(resolvePath('C:\\a', 'D:\\b')).toBe('D:\\b')
  })

  it('folder and name', () => {
    expect(dirName('C:\\a\\b\\c.md')).toBe('C:\\a\\b')
    expect(dirName('C:\\')).toBe('C:\\')
    expect(baseName('C:\\a\\b\\c.md')).toBe('c.md')
    expect(baseName('C:\\a\\b\\')).toBe('b')
    expect(baseName('C:\\')).toBe('')
  })

  it('inside checks ignore case and separators on Windows, and need a whole segment', () => {
    expect(isInside('C:\\Proj\\Docs\\x', 'c:/proj/')).toBe(true)
    expect(isInside('C:\\proj', 'C:\\proj')).toBe(true)
    expect(isInside('C:\\proj-old\\x', 'C:\\proj')).toBe(false)
    expect(isInside('C:\\', 'C:\\proj')).toBe(false)
    expect(isInside('D:\\proj\\x', 'C:\\proj')).toBe(false)
    expect(isInside('/home/Me/x', '/home/me')).toBe(false)
    expect(relativeSegments('C:\\proj', 'C:\\Proj\\src\\lib')).toEqual(['src', 'lib'])
    expect(relativeSegments('C:\\proj', 'C:\\proj')).toEqual([])
    expect(relativeSegments('C:\\proj', 'C:\\other')).toBeNull()
    expect(samePath('C:\\proj\\README.md', 'c:/PROJ/readme.md')).toBe(true)
    expect(samePath('C:\\proj', 'C:\\proj\\x')).toBe(false)
  })
})

describe('createSlugger', () => {
  it('builds GitHub heading anchors', () => {
    const slug = createSlugger()
    expect(slug('Setup steps')).toBe('setup-steps')
    expect(slug('What is "Pitwall"?')).toBe('what-is-pitwall')
    expect(slug('C++ & C#: a.b/c')).toBe('c--c-abc')
    expect(slug('snake_case and kebab-case')).toBe('snake_case-and-kebab-case')
    expect(slug('Café über Straße')).toBe('café-über-straße')
    expect(slug('日本語 見出し')).toBe('日本語-見出し')
    expect(slug('  Trimmed  ')).toBe('trimmed')
  })

  it('numbers repeated headings', () => {
    const slug = createSlugger()
    expect(slug('Usage')).toBe('usage')
    expect(slug('Usage')).toBe('usage-1')
    expect(slug('Usage')).toBe('usage-2')
    expect(slug('Usage 1')).toBe('usage-1-1')
    // A fresh document starts over.
    expect(createSlugger()('Usage')).toBe('usage')
  })
})
