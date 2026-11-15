import { WORK_ROOT } from '../tools/workFolders'
import { IMAGE_FOLDERS, storedImageFile } from './images'
import { savedMediaFile, tempMediaFile } from './mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS } from './mediaTags'
import { SHOWN_PICTURE_FOLDER, shownPictureFile } from './shownPictures'

// The stored files that no text uses any more, for the cleanup in Settings ›
// General. Dez stores a file for each pasted or dropped image and clip, for
// each image that a model or a Dez tool made, for each clip that the user
// saved or a Dez tool made, and for each picture that an `asset_view` call
// showed its model (shownPictures.ts). A text names the file by its path:
// in an image reference (images.ts) or in the `src` of a media tag
// (mediaTags.ts); or by its name, in the `pictures` attribute of a tool
// block (toolBlocks.ts) or of a compaction tag (compaction.ts). A text
// edit or a conversation delete leaves the file on disk.
//
// The rule here: a file is in use when a text holds its file name, in any
// form (a reference, a tag, a path as plain text, with any route to the
// folder). That is more than the recognizers of images.ts and mediaTags.ts
// find, so the cleanup can keep a file that nothing shows, but it never
// deletes a file that Dez shows or sends.
//
// The cleanup also takes the files of Dez's cache folder that nothing uses
// (`cacheEntryKind`): a temp copy of a clip that no text names, and what
// work of Dez left there (a download or a work folder whose app stopped
// before its end). The hourly cleanup (controller/media.ts) deletes them
// too, but only at the end of their lifetime (`MEDIA_TEMP_LIFETIME_MS`,
// `WORK_FOLDER_LIFETIME_MS`).

/** The folders of the stored files, relative to the app folder. */
export const STORED_FILE_FOLDERS: readonly string[] = [
  ...Object.values(IMAGE_FOLDERS),
  ...Object.values(MEDIA_FOLDERS).flatMap((folders) => Object.values(folders)),
  SHOWN_PICTURE_FOLDER,
]

/** A stored file that is younger than this is in use: a reply and a paste
 *  write the file first, and the text that names it after that. */
export const UNUSED_FILE_MIN_AGE_MS = 5 * 60 * 1000

/** The root folder of a file of the cleanup (the `root` of the app-file
 *  selectors): the app folder, or Dez's folder in the OS cache folder. */
export type StoredFileRoot = 'app' | 'cache'

export interface StoredFile {
  root: StoredFileRoot
  /** Relative to the root: `assets/images/<name>` in the app folder;
   *  `media/<name>` or `work/<id>` (a folder) in the cache folder. */
  path: string
  /** In bytes; for a work folder, the size of the files in it. */
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
  /** The number of the files that are in use since the scan: a text names
   *  them, or work of Dez holds them. They stay. */
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

/** The app-file path of `path` when it names a stored file: a file directly
 *  in a stored-file folder of the app folder `appDir`, with the name form
 *  of that folder's files (an image type that Dez stores; a clip of any
 *  file type). Null for any other path. */
export function storedFilePath(path: string, appDir: string): string | null {
  return storedImageFile(path, appDir) ?? savedMediaFile(path, appDir) ?? shownPictureFile(path, appDir)
}

/** The files of the listing `entries` of `folder` (relative to the app
 *  folder `appDir`) that the cleanup can delete when no text names them.
 *  Left out:
 *  - a file that does not have the name form of a stored file
 *    (`storedFilePath`), such as the temp file of a download that runs
 *    (`<name>.<pid>.<n>.tmp`);
 *  - a file that is younger than `UNUSED_FILE_MIN_AGE_MS` at the time `now`,
 *    or that has a time after `now`. */
export function oldStoredFiles(folder: string, entries: readonly ListedFile[], appDir: string, now: number): StoredFile[] {
  return entries.flatMap(({ name, updatedAt, size }) => {
    if (updatedAt + UNUSED_FILE_MIN_AGE_MS > now) return []
    const path = storedFilePath(`${appDir}/${folder}/${name}`, appDir)
    return path === null ? [] : [{ root: 'app', path, size }]
  })
}

/** What an entry of the cache folder is for the cleanup, by its path
 *  (relative to the cache folder):
 *  - `copy`: a temp copy of a clip (`tempMediaFile`). It is in use while a
 *    text names it.
 *  - `download`: the part file of a clip download (`<name>.part`), which
 *    Dez moves or deletes when the download ends, or the temp file of a
 *    write (`<name>.<process id>.<count>.tmp`, `PrivateFileWriter` in
 *    src-tauri/src/persistence.rs), which becomes `<name>` when the write
 *    ends. No text names it.
 *  - `work`: a work folder of a bundled tool (model/tools/workFolders.ts),
 *    which its owner deletes when the work ends. No text names it. */
export type CacheEntryKind = 'copy' | 'download' | 'work'

// The end that `PrivateFileWriter` adds to the name of the file that it
// writes, until the write ends.
const WRITE_TEMP_END = /\.\d+\.\d+\.tmp$/
// A file name with one `.`, as Dez names the files of the media folder of
// the cache: `<uuid>.<extension>`, `<uuid>.part`.
const MEDIA_FILE_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/
// The name of a work folder (a UUID).
const WORK_FOLDER_NAME = /^[A-Za-z0-9_-]+$/

/** The kind of the cache entry `path` (relative to the cache folder
 *  `cacheDir`): a file directly in the media folder, or a folder directly
 *  in the work root. Null for any other path, which the cleanup never
 *  deletes. */
export function cacheEntryKind(path: string, cacheDir: string): CacheEntryKind | null {
  const [folder, name, ...below] = path.split('/')
  if (name === undefined || below.length > 0) return null
  if (folder === WORK_ROOT) return WORK_FOLDER_NAME.test(name) ? 'work' : null
  if (folder !== MEDIA_CACHE_FOLDER) return null
  const written = name.replace(WRITE_TEMP_END, '')
  if (!MEDIA_FILE_NAME.test(written)) return null
  if (written !== name || written.endsWith('.part')) return 'download'
  return tempMediaFile(`${cacheDir}/${path}`, cacheDir) === path ? 'copy' : null
}

/** Whether live work of this app holds the cache entry `path`: `held`
 *  (`heldCachePaths`, controller/cacheHolds.ts) holds the entry itself (a
 *  work folder, the target of a download), or the file of the write whose
 *  temp file it is. */
export function isHeldCacheEntry(path: string, held: ReadonlySet<string>): boolean {
  return held.has(path.replace(WRITE_TEMP_END, ''))
}

/** Whether a text can name the file `file` of the cleanup, and so keep it
 *  (`removeNamedFiles`): a stored file, or a temp copy of a clip in the
 *  cache folder `cacheDir`. A download and a work folder have no name that
 *  a text holds: only live work keeps them (`isHeldCacheEntry`). */
export function textCanName(file: StoredFile, cacheDir: string): boolean {
  return file.root === 'app' || cacheEntryKind(file.path, cacheDir) === 'copy'
}

/** The entries of the listing `entries` of `folder` (relative to the cache
 *  folder `cacheDir`) that the cleanup can delete: each one of a
 *  `CacheEntryKind`, at least `UNUSED_FILE_MIN_AGE_MS` old at the time
 *  `now`, that no live work holds (`held`). A temp copy among them is
 *  still in use when a text names it. A work folder has the size 0: a
 *  listing of folders gives no size. */
export function oldCacheEntries(folder: string, entries: readonly ListedFile[], cacheDir: string, held: ReadonlySet<string>, now: number): StoredFile[] {
  return entries.flatMap(({ name, updatedAt, size }) => {
    const path = `${folder}/${name}`
    if (updatedAt + UNUSED_FILE_MIN_AGE_MS > now || cacheEntryKind(path, cacheDir) === null || isHeldCacheEntry(path, held)) return []
    return [{ root: 'cache', path, size }]
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
