// Work folders: the folders in which the programs that Dez ships run
// (`dez.native/runBundledTool`). A program gets copies of its input files
// in its folder and writes its new files there. Each one is a folder of the
// cache root, so it is outside the Dez folder, and nothing in it is a
// stored file. Its owner deletes it when the work ends.

/** The folder of the cache root that holds the work folders. */
export const WORK_ROOT = 'work'

/** How long a work folder stays when its owner did not delete it (the app
 *  stopped or failed before the end of the work). It is far longer than the
 *  longest job, so a folder of this age has no program that runs in it. */
export const WORK_FOLDER_LIFETIME_MS = 24 * 60 * 60 * 1000

/** One folder of a listing of `WORK_ROOT` (`dez.native/listAppFiles`). */
interface ListedFolder {
  name: string
  /** Milliseconds since the Unix epoch. */
  updatedAt: number
}

/** The path of a work folder in the cache root. `id` must be a path segment
 *  that the app-file selectors take (a UUID is one). */
export function workFolderPath(id: string): string {
  return `${WORK_ROOT}/${id}`
}

/** The paths of the listed work folders that the cleanup deletes: each one
 *  whose last change is at least the lifetime ago.
 *
 *  The rule is the age and not "every folder at the app start", as two Dez
 *  apps can run at the same time with one cache folder (a release build and
 *  a development build): the start of one must not take the folder of a
 *  program that runs for the other. */
export function oldWorkFolders(folders: readonly ListedFolder[], now: number): string[] {
  return folders
    .filter(({ updatedAt }) => updatedAt + WORK_FOLDER_LIFETIME_MS <= now)
    .map(({ name }) => workFolderPath(name))
}
