import fs from 'node:fs'
import path from 'node:path'
import { waitForValue } from './dom'
import { filesIn } from './fixtures'
import type { E2EBrowser } from './session'

// Reads of the app's processes from `/proc` (the e2e suite is Linux only).

/**
 * The pid of the process that runs the page (`WebKitWebProcess`) of the app
 * whose HOME is `home`. Each e2e app has its own HOME, so this finds the
 * process of that app also while other apps run.
 */
export function webProcessPid (home: string): number {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (!fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes('WebKitWebProcess')) continue
      if (fs.readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) return Number(entry)
    } catch {
      // The process ended, or it is another user's.
    }
  }
  throw new Error('webProcessPid: the app has no web process')
}

/** How many threads the process `pid` has. */
export function threadCount (pid: number): number {
  return fs.readdirSync(`/proc/${pid}/task`).length
}

// The pids of the processes whose working folder (`/proc/<pid>/cwd`) passes
// `test`.
function pidsWhoseCwd (test: (cwd: string) => boolean): number[] {
  const pids: number[] = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (test(fs.readlinkSync(`/proc/${entry}/cwd`))) pids.push(Number(entry))
    } catch {
      // The process ended, or it is another user's.
    }
  }
  return pids
}

// The real path of `folder`, as `/proc/<pid>/cwd` names it (it has no
// symlink in it); null when the folder does not exist.
function realFolder (folder: string): string | null {
  try {
    return fs.realpathSync(folder)
  } catch {
    return null
  }
}

/**
 * The pids of the processes whose working folder is `folder`; none when the
 * folder does not exist. This finds a program that Dez runs in a work
 * folder: Dez gives such a program an empty environment, so its HOME does
 * not tell which app started it.
 *
 * It finds no program once its folder is deleted, also when the program
 * still runs (`/proc/<pid>/cwd` then ends with ` (deleted)`). To see that a
 * program ended, keep its pid while it runs and check it with
 * `processExists`, or read `pidsWithCwdIn` of the folder above.
 */
export function pidsWithCwd (folder: string): number[] {
  const wanted = realFolder(folder)
  return wanted === null ? [] : pidsWhoseCwd((cwd) => cwd === wanted)
}

/**
 * The pids of the processes whose working folder is a folder in `root`,
 * also one that is deleted; none when `root` does not exist. With the
 * folder of the work folders (`workDir`), these are the programs that Dez
 * still runs for its tools, with no pid known before.
 */
export function pidsWithCwdIn (root: string): number[] {
  const wanted = realFolder(root)
  return wanted === null ? [] : pidsWhoseCwd((cwd) => cwd.startsWith(`${wanted}/`))
}

/**
 * Whether the process `pid` still exists. Dez waits for the end of each
 * program that it runs, so a program that ended leaves no zombie here.
 */
export function processExists (pid: number): boolean {
  return fs.existsSync(`/proc/${pid}`)
}

/**
 * The pid of the program of the one tool call that runs: waits until
 * `workRoot` (`workDir`) holds one folder, and one program works in it. Dez
 * deletes the folder at the end of the call, so a check that the program
 * ended reads this pid, not the folder (`pidsWithCwd`).
 */
export async function runningProgram (browser: E2EBrowser, workRoot: string): Promise<number> {
  await waitForValue(browser, 'programs in the work folders', async () => (await filesIn(workRoot)).map((name) => pidsWithCwd(path.join(workRoot, name)).length), [1])
  const [name] = await filesIn(workRoot)
  const [pid] = pidsWithCwd(path.join(workRoot, name))
  return pid
}
