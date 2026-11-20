import { execFile } from 'child_process'
import { promises as fs } from 'fs'

/**
 * macOS / Linux: the cwd of a PTY's foreground process, read from the OS.
 *
 * The foreground process is taken to be the shell's newest direct child (an agent such as
 * `claude`, which may have moved itself into a git worktree), or the shell itself when nothing
 * is running in it. Both platforms expose another process's cwd cheaply and without special
 * privileges. Windows has no such API (see oscStream.ts: the shell reports its cwd instead).
 */
export interface ProcessCwd {
  pid: number
  cwd: string
}

const TIMEOUT_MS = 2000

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      // pgrep exits 1 when there are no matches; that's an answer, not a failure.
      resolve(error && !stdout ? '' : String(stdout))
    })
  })
}

/** PIDs from `pgrep -P` or /proc/<pid>/task/<pid>/children output (whitespace separated). */
export function parsePidList(output: string): number[] {
  return output
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** The cwd from `lsof -a -n -P -p <pid> -d cwd -Fn` output (the line starting with "n"). */
export function parseLsofCwd(output: string): string | null {
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1)
  }
  return null
}

async function childPids(pid: number): Promise<number[]> {
  if (process.platform === 'linux') {
    try {
      return parsePidList(await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf-8'))
    } catch {
      // Kernel built without CONFIG_PROC_CHILDREN: fall through to pgrep.
    }
  }
  return parsePidList(await run('pgrep', ['-P', String(pid)]))
}

async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  return parseLsofCwd(await run('lsof', ['-a', '-n', '-P', '-p', String(pid), '-d', 'cwd', '-Fn']))
}

export async function foregroundCwd(shellPid: number): Promise<ProcessCwd | null> {
  if (process.platform === 'win32') return null
  const children = await childPids(shellPid)
  // Newest child: highest pid. PIDs only wrap after a very long uptime, and a wrong pick just
  // falls back to the shell's own cwd below if that child has already exited.
  const newest = children.length > 0 ? Math.max(...children) : null
  if (newest !== null) {
    const cwd = await cwdOf(newest)
    if (cwd) return { pid: newest, cwd }
  }
  const cwd = await cwdOf(shellPid)
  return cwd ? { pid: shellPid, cwd } : null
}
