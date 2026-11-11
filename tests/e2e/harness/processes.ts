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
