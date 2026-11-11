import sbp from '@sbp/sbp'
import {
  STORED_FILE_FOLDERS,
  oldStoredFiles,
  removeNamedFiles,
  storedFilePath,
  type StoredFile,
  type UnusedFiles,
  type UnusedFilesDeleted,
} from '../model/chat/unusedFiles'
import { fileNameOf } from '../utils/fileName'
import type { AppFileEntry } from './nativeTypes'

// The cleanup of the stored files (pasted images, generated images, saved
// clips) that no text uses any more: Settings › General › Unused files. The
// rules for "unused" are in src/model/chat/unusedFiles.ts.

// One scan or delete at a time: a scan that ran together with a delete
// would count files that are gone a moment later.
const QUEUE = 'dez.controller/unusedFiles'

export default sbp('sbp/selectors/register', {
  // Finds the stored files that no conversation, open or closed tab, or
  // saved prompt names, and adds up their size. `onProgress` gets the part
  // of the scan that is done, from 0 to 1: the conversation files are the
  // slow part, so it counts them. Nothing is deleted here.
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
  //
  // A failure is logged, shows an error toast, and rejects: a scan that did
  // not read everything must not give a list of files to delete.
  async 'dez.controller/unusedFiles/find' (onProgress: (fraction: number) => void): Promise<UnusedFiles> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<UnusedFiles> => {
        onProgress(0)
        const appDir = await sbp('dez.native/getAppDir') as string
        const now = Date.now()
        const candidates: StoredFile[] = []
        for (const folder of STORED_FILE_FOLDERS) {
          const entries = await sbp('dez.native/listAppFiles', folder) as AppFileEntry[]
          candidates.push(...oldStoredFiles(folder, entries, appDir, now))
        }
        const unnamed = new Set(candidates.map((file) => fileNameOf(file.path)))
        // With no file to look for, no text needs a read.
        if (unnamed.size > 0) {
          await sbp('dez.persistence/eachConversationText', (text: string, index: number, count: number) => {
            removeNamedFiles(unnamed, text)
            onProgress((index + 1) / count)
          })
          for (const text of sbp('dez.model/heldTexts') as string[]) removeNamedFiles(unnamed, text)
        }
        onProgress(1)
        const files = candidates.filter((file) => unnamed.has(fileNameOf(file.path)))
        return { files, bytes: files.reduce((sum, file) => sum + file.size, 0) }
      }) as UnusedFiles
    } catch (error) {
      console.error('Failed to look for unused files:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not look for unused files',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes the files of a scan (`dez.controller/unusedFiles/find`), and
  // tells what it did. The user answered a prompt since the scan, and a
  // reply can write text in that time, so the texts in memory are read
  // again: a file that one of them names now stays. Only a file that a
  // trash can delete goes (`storedFilePath`), so no other app file is
  // deleted through this selector. A file that cannot be deleted is logged
  // and counted, and the other files still go. A missing file counts as
  // deleted.
  async 'dez.controller/unusedFiles/delete' (unused: UnusedFiles): Promise<UnusedFilesDeleted> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', QUEUE, async (): Promise<UnusedFilesDeleted> => {
        const appDir = await sbp('dez.native/getAppDir') as string
        const unnamed = new Set(unused.files.map((file) => fileNameOf(file.path)))
        for (const text of sbp('dez.model/heldTexts') as string[]) removeNamedFiles(unnamed, text)
        const result: UnusedFilesDeleted = { deleted: 0, bytes: 0, inUse: 0, failed: 0 }
        for (const file of unused.files) {
          if (!unnamed.has(fileNameOf(file.path))) {
            result.inUse++
            continue
          }
          try {
            if (storedFilePath(`${appDir}/${file.path}`, appDir) !== file.path) {
              throw new Error('Not a stored image or a saved clip')
            }
            await sbp('dez.native/deleteAppFile', file.path)
            result.deleted++
            result.bytes += file.size
          } catch (error) {
            console.error(`Failed to delete the unused file ${file.path}:`, error)
            result.failed++
          }
        }
        return result
      }) as UnusedFilesDeleted
    } catch (error) {
      console.error('Failed to delete the unused files:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not delete the unused files',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
      throw error
    }
  },
})
