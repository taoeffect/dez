import sbp from '@sbp/sbp'
import { WORK_ROOT, oldWorkFolders } from '../model/tools/workFolders'
import type { AppFileEntry } from './nativeTypes'

// Deletes the work folders that are older than their lifetime
// (model/tools/workFolders.ts), each with all that it holds. The owner of a
// work folder deletes it at the end of its work; this takes the ones that
// stayed because the app stopped first (a quit, a crash). A failure is only
// logged: the next run tries again, and the user did nothing to tell about.
export async function deleteOldWorkFolders(): Promise<void> {
  try {
    const folders = await sbp('dez.native/listAppFiles', WORK_ROOT, 'cache', { folders: true }) as AppFileEntry[]
    for (const folder of oldWorkFolders(folders, Date.now())) {
      try {
        await sbp('dez.native/deleteAppFile', folder, 'cache', { folder: true })
      } catch (error) {
        console.error(`Failed to delete the old work folder ${folder}:`, error)
      }
    }
  } catch (error) {
    console.error('Failed to list the work folders:', error)
  }
}
