import { IMAGE_FOLDERS, storedImageFile } from './images'
import { savedMediaFile } from './mediaFiles'
import { MEDIA_FOLDERS } from './mediaTags'

// The stored files that no text uses any more, for the cleanup in Settings ›
// General. Dez stores a file for each pasted image, and for each image and
// saved clip that a model made. A text names the file by its path: in an
// image reference (images.ts) or in the `src` of a media tag (mediaTags.ts).
// A text edit or a conversation delete leaves the file on disk.
//
// The rule here: a file is in use when a text holds its file name, in any
// form (a reference, a tag, a path as plain text, with any route to the
// folder). That is more than the recognizers of images.ts and mediaTags.ts
// find, so the cleanup can keep a file that nothing shows, but it never
// deletes a file that Dez shows or sends.

/** The folders of the stored files, relative to the app folder. */
export const STORED_FILE_FOLDERS: readonly string[] = [
  ...Object.values(IMAGE_FOLDERS),
  ...Object.values(MEDIA_FOLDERS).flatMap((folders) => Object.values(folders)),
]

/** A stored file that is younger than this is in use: a reply and a paste
 *  write the file first, and the text that names it after that. */
export const UNUSED_FILE_MIN_AGE_MS = 5 * 60 * 1000

export interface StoredFile {
  /** Relative to the app folder: `assets/images/<name>`. */
  path: string
  /** In bytes. */
  size: number
}

/** What a scan for unused files found (`dez.controller/unusedFiles/find`). */
export interface UnusedFiles {
  files: StoredFile[]
  /** The total size of `files`, in bytes. */
  bytes: number
}

/** What a delete did with the files of a scan
 *  (`dez.controller/unusedFiles/delete`). */
export interface UnusedFilesDeleted {
  /** The number of the files that are deleted. */
  deleted: number
  /** The total size of the deleted files, in bytes. */
  bytes: number
  /** The number of the files that a text names again; they stay. */
  inUse: number
  /** The number of the files that could not be deleted. */
  failed: number
}

/** One file of a folder listing (`dez.native/listAppFiles`). */
interface ListedFile {
  name: string
  /** Milliseconds since the Unix epoch. */
  updatedAt: number
  size: number
}

/** The app-file path of `path` when it names a file that the image trash or
 *  the player's trash can delete: a file directly in a stored-file folder of
 *  the app folder `appDir`, with the name form of that folder's files (an
 *  image type that Dez stores; a clip of any file type). Null for any other
 *  path. */
export function storedFilePath(path: string, appDir: string): string | null {
  return storedImageFile(path, appDir) ?? savedMediaFile(path, appDir)
}

/** The files of the listing `entries` of `folder` (relative to the app
 *  folder `appDir`) that the cleanup can delete when no text names them.
 *  Left out:
 *  - a file that no trash can delete (`storedFilePath`), such as the temp
 *    file of a download that runs (`<name>.<pid>.<n>.tmp`);
 *  - a file that is younger than `UNUSED_FILE_MIN_AGE_MS` at the time `now`,
 *    or that has a time after `now`. */
export function oldStoredFiles(folder: string, entries: readonly ListedFile[], appDir: string, now: number): StoredFile[] {
  return entries.flatMap(({ name, updatedAt, size }) => {
    if (updatedAt + UNUSED_FILE_MIN_AGE_MS > now) return []
    const path = storedFilePath(`${appDir}/${folder}/${name}`, appDir)
    return path === null ? [] : [{ path, size }]
  })
}

// A character of the part of a stored file's name before its `.`
// (`[A-Za-z0-9_-]`, as in the name rules of images.ts and mediaTags.ts).
function isStemChar(code: number): boolean {
  return isExtensionChar(code) || code === 0x2d || code === 0x5f
}

// A character of a file extension (`[A-Za-z0-9]`).
function isExtensionChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/** Takes out of `names` each file name (`<stem>.<extension>`) that `text`
 *  holds as a whole name: `x.png` is in `/a/x.png`, `"x.png"`, and
 *  `b.x.png`, but not in `ax.png` or `x.pngs`, which are other names.
 *
 *  Each name has one `.`, so the search goes from `.` to `.` and reads the
 *  name characters on both sides of it. It reads each character at most
 *  twice. A regex for a name is not used: on a long run of name characters
 *  with no `.` (a base64 block of thinking), it starts again at each
 *  character and reads the rest of the run each time. */
export function removeNamedFiles(names: Set<string>, text: string): void {
  for (let dot = text.indexOf('.'); dot !== -1 && names.size > 0; dot = text.indexOf('.', dot + 1)) {
    let start = dot
    while (start > 0 && isStemChar(text.charCodeAt(start - 1))) start--
    let end = dot + 1
    while (end < text.length && isExtensionChar(text.charCodeAt(end))) end++
    if (start < dot && end > dot + 1) names.delete(text.slice(start, end))
  }
}
