import sbp from '@sbp/sbp'
import { tempMediaFile } from '../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER } from '../model/chat/shownPictures'
import {
  STORED_FILE_FOLDERS,
  cacheEntryKind,
  cleanupAppName,
  cleanupNoun,
  hasUnnamed,
  isHeldCacheEntry,
  isNamed,
  oldAppFolder,
  oldCacheEntries,
  oldStoredFiles,
  removeNamed,
  removeNamedFiles,
  storedFilePath,
  unnamedFiles,
  type CleanupKind,
  type FileRef,
  type StoredFile,
  type UnusedFiles,
  type UnusedFilesDeleted,
} from '../model/chat/unusedFiles'
import { isAppName, isBuiltInApp } from '../model/tools/appManifest'
import { APPS_MAX_ENTRIES, APPS_ROOT, pathIn } from '../model/tools/appsTool'
import { WORK_ROOT } from '../model/tools/workFolders'
import { REPORT_ADVICE, errorText, explainedError, rawErrorText } from '../utils/errorText'
import { fileNameOf } from '../utils/fileName'
import { heldCachePaths } from './cacheHolds'
import type { AppFileEntry, FileTree } from './nativeTypes'

// The two cleanups of Settings › General (`CleanupKind`). Delete
// Unreferenced Files takes the stored files (pasted, dropped, and generated
// images and clips, and the copies of the pictures that tools showed their
// model) that no text uses any more, and the entries of Dez's cache folder
// that nothing uses (temp copies of clips, left-over downloads, and work
// folders). Delete Unreferenced Apps takes the apps that no text names. The
// rules are in src/model/chat/unusedFiles.ts. A compaction deletes some of
// its files at once, by the same rules
// (`dez.controller/unusedFiles/deleteUnnamed`).

// One scan or delete at a time: a scan that ran together with a delete
// would count files that are gone a moment later.
const QUEUE = 'dez.controller/unusedFiles'

// The texts that can name a file or an app that a cleanup must keep, other
// than the conversation files: the texts in memory, and the files that the
// work of a reply made and that no text names yet
// (`dez.stream/unnamedMadeFiles`). The cleanups delete each old file and
// each old app that no text they read names. So a new place of such text (a
// store, a file in the app folder) must join `dez.model/heldTexts` or
// `dez.persistence/eachConversationText`. A new kind of made file that no
// text names yet must join `dez.stream/unnamedMadeFiles`. The files of the
// apps are no such text: Dez writes no path of a stored file into an app
// (src/model/chat/unusedFiles.ts).
function textsInMemory(): string[] {
  return [...sbp('dez.model/heldTexts') as string[], ...sbp('dez.stream/unnamedMadeFiles') as string[]]
}

// Deletes one file of a cleanup of the kind `kind`. In a cleanup of the
// apps only the folder of an app (`cleanupAppName`) goes; in a cleanup of
// the files only a stored file (`storedFilePath`) and a cache entry of the
// cleanup (`cacheEntryKind`) go. It throws for any other file, so no
// selector of this module deletes one, and a cleanup of the files never
// deletes an app.
async function deleteCleanupFile(file: FileRef, kind: CleanupKind, appDir: string, cacheDir: string): Promise<void> {
  if (kind === 'apps') {
    if (cleanupAppName(file) === null) throw new Error('Not the folder of an app')
    await sbp('dez.native/deleteAppFile', file.path, 'app', { folder: true })
    return
  }
  if (file.root === 'app') {
    if (storedFilePath(`${appDir}/${file.path}`, appDir) !== file.path) {
      throw new Error('Not a stored image, a saved clip, or a copy of a shown picture')
    }
    await sbp('dez.native/deleteAppFile', file.path)
    return
  }
  const entry = cacheEntryKind(file.path, cacheDir)
  if (entry === null) throw new Error('Not a temp copy, a download, or a work folder of the cache folder')
  await sbp('dez.native/deleteAppFile', file.path, 'cache', { folder: entry === 'work' })
}

// The stored files and the cache entries that are old enough for the
// cleanup of the files, without the cache entries that live work of this
// app uses (cacheHolds.ts), whatever their age.
async function oldFiles(appDir: string, cacheDir: string, now: number): Promise<StoredFile[]> {
  const held = heldCachePaths()
  const files: StoredFile[] = []
  for (const folder of STORED_FILE_FOLDERS) {
    const entries = await sbp('dez.native/listAppFiles', folder) as AppFileEntry[]
    files.push(...oldStoredFiles(folder, entries, appDir, now))
  }
  const media = await sbp('dez.native/listAppFiles', MEDIA_CACHE_FOLDER, 'cache') as AppFileEntry[]
  files.push(...oldCacheEntries(MEDIA_CACHE_FOLDER, media, cacheDir, held, now))
  const workFolders = await sbp('dez.native/listAppFiles', WORK_ROOT, 'cache', { folders: true }) as AppFileEntry[]
  for (const folder of oldCacheEntries(WORK_ROOT, workFolders, cacheDir, held, now)) {
    // A listing of folders gives no size: the size of a work folder is the
    // size of the files in it.
    const entries = await sbp('dez.native/listAppFiles', folder.path, 'cache') as AppFileEntry[]
    files.push({ ...folder, size: entries.reduce((sum, entry) => sum + entry.size, 0) })
  }
  return files
}

// The app folders that are old enough for the cleanup of the apps
// (`oldAppFolder`).
async function oldApps(now: number): Promise<StoredFile[]> {
  const folders = await sbp('dez.native/listAppFiles', APPS_ROOT.file, 'app', { folders: true }) as AppFileEntry[]
  const apps: StoredFile[] = []
  for (const { name } of folders) {
    // The cleanup never deletes a folder that is no app, so it does not
    // read one: a folder of the user that Dez cannot read must not fail
    // the scan. A folder with the name of a built-in app is of an older
    // Dez, and no path of the `apps` tool reaches it (`oldAppFolder`).
    if (!isAppName(name) || isBuiltInApp(name)) continue
    // The listing of the folders gives the time of the folder only: the
    // age rule of an app needs the time of each file in it.
    const tree = await sbp('dez.native/listFileTree', pathIn(APPS_ROOT, name).file, APPS_MAX_ENTRIES) as FileTree
    const app = oldAppFolder(name, tree, now)
    if (app !== null) apps.push(app)
  }
  return apps
}

export default sbp('sbp/selectors/register', {
  // Finds what a cleanup of the kind `kind` deletes: for `files`, the
  // stored files that no conversation, open or closed tab, saved prompt, or
  // work of a reply that runs (a job result, a picture copy of a tool
  // round) names, and the cache entries that nothing uses; for `apps`, the
  // apps that no such text names. It adds up their size. `onProgress` gets
  // the part of the scan that is done, from 0 to 1: the conversation files
  // are the slow part, so it counts them. Nothing is deleted here.
  //
  // The files are listed first, and the texts are read after that: the
  // conversation files, and then the texts in memory, which hold what is
  // not saved yet. The other order could miss the text of a new file. A
  // file gets its text in two ways:
  // - A paste, a reply, and a Save that downloads write a new file, and
  //   its text after that. The age rule keeps such a file.
  // - A Save of a temp copy moves the file with its old file time, and
  //   writes the path into the clip's tag a moment later. The texts in
  //   memory are read after the listing, and once more before the delete.
  // An app gets its text in the first way: `apps init` makes its folder,
  // and the block of the call names it after that.
  //
  // A failure is logged, shows an error toast, and rejects: a scan that did
  // not read everything must not give a list of files to delete.
  async 'dez.controller/unusedFiles/find' (kind: CleanupKind, onProgress: (fraction: number) => void): Promise<UnusedFiles> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<UnusedFiles> => {
        onProgress(0)
        const appDir = await sbp('dez.native/getAppDir') as string
        const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
        const now = Date.now()
        const candidates = kind === 'apps' ? await oldApps(now) : await oldFiles(appDir, cacheDir, now)
        const unnamed = unnamedFiles(candidates, cacheDir)
        // With no file and no app that a text can name, no text needs a
        // read.
        if (hasUnnamed(unnamed)) {
          await sbp('dez.persistence/eachConversationText', (text: string, index: number, count: number) => {
            removeNamed(unnamed, text)
            onProgress((index + 1) / count)
          })
          for (const text of textsInMemory()) removeNamed(unnamed, text)
        }
        onProgress(1)
        const files = candidates.filter((file) => !isNamed(file, unnamed, cacheDir))
        return { kind, files, bytes: files.reduce((sum, file) => sum + file.size, 0) }
      }) as UnusedFiles
    } catch (error) {
      console.error(`Failed to look for unreferenced ${kind}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: `Could not look for unreferenced ${kind}`,
        message: errorText(`The system did not let Dez read all of its files, so Dez deletes no ${cleanupNoun(kind)}. The details tell why (for example, Dez has no permission to read a file). Fix that, and try again.`, rawErrorText(error)),
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes what a scan found (`dez.controller/unusedFiles/find`), and
  // tells what it did. Only a file of the kind of the scan goes
  // (`deleteCleanupFile`), so a cleanup of the files never deletes an app.
  // The user answered a prompt since the scan, and a reply can write text
  // or start work in that time, so the texts in memory and the held cache
  // entries are read again: a file or an app that one of them names or
  // holds now stays. A file that cannot be deleted is logged and counted,
  // and the other files still go. A missing file counts as deleted. The
  // editor learns of each deleted app (`dez.editor/appDeleted`): a card of
  // the app that it shows tells that the app is gone.
  async 'dez.controller/unusedFiles/delete' (unused: UnusedFiles): Promise<UnusedFilesDeleted> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<UnusedFilesDeleted> => {
        const appDir = await sbp('dez.native/getAppDir') as string
        const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
        const unnamed = unnamedFiles(unused.files, cacheDir)
        for (const text of textsInMemory()) removeNamed(unnamed, text)
        const held = heldCachePaths()
        const result: UnusedFilesDeleted = { deleted: 0, bytes: 0, inUse: 0, failed: 0 }
        for (const file of unused.files) {
          if (isNamed(file, unnamed, cacheDir) || (file.root === 'cache' && isHeldCacheEntry(file.path, held))) {
            result.inUse++
            continue
          }
          try {
            await deleteCleanupFile(file, unused.kind, appDir, cacheDir)
          } catch (error) {
            console.error(`Failed to delete the unreferenced ${cleanupNoun(unused.kind)} ${file.root}:${file.path}:`, error)
            result.failed++
            continue
          }
          result.deleted++
          result.bytes += file.size
          const app = cleanupAppName(file)
          if (app !== null) sbp('dez.editor/appDeleted', app)
        }
        return result
      }) as UnusedFilesDeleted
    } catch (error) {
      // A file that cannot be deleted is only counted (above), so this is a
      // failure before the first delete.
      console.error(`Failed to delete the unreferenced ${unused.kind}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: `Could not delete the unreferenced ${unused.kind}`,
        message: explainedError(error, `Dez hit an error that it did not expect, and deleted no ${cleanupNoun(unused.kind)}. Try again. ${REPORT_ADVICE}`).message,
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes files that their text left, at once, with no age rule: a
  // compaction calls it for the files of the text that it took out
  // (`compactionLeftFiles`, model/streams/compactionFiles.ts). `sources`
  // are sources of assets (the path of an image, the `src` of a clip), and
  // `pictures` names of picture copies in the views folder.
  //
  // Only a stored file and a temp copy of a clip go. Any other source (a
  // linked file of the user, a URL) is left out, so Dez never deletes a
  // file that it did not store. A file stays when a text still names it (a
  // conversation file, a text in memory, the result of a job that no reply
  // took yet), or when live work holds it: Delete Unreferenced Files finds
  // it later. The caller saves its conversation first, so that the text on
  // disk is the new one.
  //
  // It never rejects. A failure is only logged: a file that stays is not a
  // fault that the user must know of, and Delete Unreferenced Files finds
  // it.
  async 'dez.controller/unusedFiles/deleteUnnamed' ({ sources, pictures }: { sources: readonly string[], pictures: readonly string[] }): Promise<void> {
    try {
      await sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<void> => {
        const appDir = await sbp('dez.native/getAppDir') as string
        const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
        const files = new Map<string, FileRef>()
        const add = (root: FileRef['root'], path: string | null) => {
          if (path !== null) files.set(`${root}:${path}`, { root, path })
        }
        for (const source of sources) {
          add('app', storedFilePath(source, appDir))
          add('cache', tempMediaFile(source, cacheDir))
        }
        for (const name of pictures) add('app', storedFilePath(`${appDir}/${SHOWN_PICTURE_FOLDER}/${name}`, appDir))
        if (files.size === 0) return
        const unnamed = new Set([...files.values()].map((file) => fileNameOf(file.path)))
        await sbp('dez.persistence/eachConversationText', (text: string) => removeNamedFiles(unnamed, text))
        for (const text of textsInMemory()) removeNamedFiles(unnamed, text)
        const held = heldCachePaths()
        for (const file of files.values()) {
          if (!unnamed.has(fileNameOf(file.path)) || (file.root === 'cache' && isHeldCacheEntry(file.path, held))) continue
          try {
            await deleteCleanupFile(file, 'files', appDir, cacheDir)
          } catch (error) {
            console.error(`Failed to delete the file ${file.root}:${file.path}, which its text left:`, error)
          }
        }
      })
    } catch (error) {
      console.error('Failed to delete the files that their text left:', error)
    }
  },
})
