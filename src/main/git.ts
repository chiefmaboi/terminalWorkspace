import { execFile } from 'child_process'
import { promises as fsPromises } from 'fs'
import { dirname, join, resolve } from 'path'

export function getGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const branch = stdout.trim()
        resolve(branch.length > 0 ? branch : null)
      }
    )
  })
}

/**
 * The repository a folder belongs to: the nearest folder at or above it holding a `.git` entry
 * (a folder in a normal clone, a file in a worktree or submodule). Found without running git,
 * so nothing in an untrusted repository's config can execute.
 */
export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = resolve(start)
  for (;;) {
    try {
      await fsPromises.stat(join(dir, '.git'))
      return dir
    } catch {
      // not here: keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const POLL_INTERVAL_MS = 5000

export class GitBranchPoller {
  private timer: NodeJS.Timeout | null = null
  private lastKnown = new Map<string, string | null>()

  constructor(
    private getTerminalPaths: () => { id: string; path: string }[],
    private onBranchChanged: (terminalId: string, branch: string | null) => void
  ) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS)
    void this.pollOnce()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Drop a deleted terminal's cached branch so `lastKnown` doesn't grow forever across a long
   * session with heavy terminal churn — it otherwise only ever gains entries, never loses them. */
  forget(terminalId: string): void {
    this.lastKnown.delete(terminalId)
  }

  private async pollOnce(): Promise<void> {
    const terminals = this.getTerminalPaths()
    await Promise.all(
      terminals.map(async ({ id, path }) => {
        const branch = await getGitBranch(path)
        if (this.lastKnown.get(id) !== branch) {
          this.lastKnown.set(id, branch)
          this.onBranchChanged(id, branch)
        }
      })
    )
  }
}
