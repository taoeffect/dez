// The entries of the cache root that live work of this app uses now: a
// work folder while its program runs, and the target of a download while
// it runs. Delete Unused Files (controller/unusedFiles.ts) never takes
// them, whatever their age: a long run or a slow download can be older
// than the age rule (`UNUSED_FILE_MIN_AGE_MS`). So any new work in the
// cache root that can run longer than that holds its entry with
// `holdingCachePath`. This module registers no selector.
//
// Only the work of this app is known here. A second Dez app with the same
// cache folder (a release build and a development build) is not, so the
// cleanup of one can delete an entry of a run of the other that is older
// than the age rule; that run then fails, and its job tells the model.

const held = new Set<string>()

/** Runs `work`, and holds the cache entry `path` (relative to the cache
 *  root) until it ends, also after an error. */
export async function holdingCachePath<T>(path: string, work: () => Promise<T>): Promise<T> {
  held.add(path)
  try {
    return await work()
  } finally {
    held.delete(path)
  }
}

/** The cache entries that live work holds now. */
export function heldCachePaths(): ReadonlySet<string> {
  return new Set(held)
}
