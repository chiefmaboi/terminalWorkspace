import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findRepoRoot } from '../git'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pitwall-repo-root-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('findRepoRoot', () => {
  it('finds the nearest folder with a .git folder at or above the start', async () => {
    const repo = join(base, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    expect(await findRepoRoot(join(repo, 'packages', 'web'))).toBe(repo)
    expect(await findRepoRoot(repo)).toBe(repo)
  })

  it('stops at a worktree or submodule (.git is a file there)', async () => {
    const outer = join(base, 'outer')
    const inner = join(outer, 'vendor', 'lib')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(inner, 'src'), { recursive: true })
    writeFileSync(join(inner, '.git'), 'gitdir: ../../.git/modules/lib\n')
    expect(await findRepoRoot(join(inner, 'src'))).toBe(inner)
    expect(await findRepoRoot(join(outer, 'vendor'))).toBe(outer)
  })

  it('is null outside any repository, and for a folder that does not exist', async () => {
    // The temp folder itself could sit inside a repository on some machines; only claim null
    // when nothing above it has a .git either.
    const above = await findRepoRoot(base)
    const plain = join(base, 'plain', 'deeper')
    mkdirSync(plain, { recursive: true })
    expect(await findRepoRoot(plain)).toBe(above)
    expect(await findRepoRoot(join(base, 'missing', 'x'))).toBe(above)
  })
})
