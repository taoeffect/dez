import fs from 'node:fs'

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

/**
 * The pids of the processes whose working folder is `folder`; none when the
 * folder does not exist. This finds a program that Dez runs in a work
 * folder: Dez gives such a program an empty environment, so its HOME does
 * not tell which app started it.
 *
 * It finds no program once its folder is deleted, also when the program
 * still runs (`/proc/<pid>/cwd` then ends with ` (deleted)`). To see that a
 * program ended, keep its pid while it runs and check it with
 * `processExists`.
 */
export function pidsWithCwd (folder: string): number[] {
  let wanted: string
  try {
    // `/proc/<pid>/cwd` has no symlink in it.
    wanted = fs.realpathSync(folder)
  } catch {
    return []
  }
  const pids: number[] = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (fs.readlinkSync(`/proc/${entry}/cwd`) === wanted) pids.push(Number(entry))
    } catch {
      // The process ended, or it is another user's.
    }
  }
  return pids
}

/**
 * Whether the process `pid` still exists. Dez waits for the end of each
 * program that it runs, so a program that ended leaves no zombie here.
 */
export function processExists (pid: number): boolean {
  return fs.existsSync(`/proc/${pid}`)
}
