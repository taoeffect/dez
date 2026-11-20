import sbp from '@sbp/sbp'
import { ref } from 'vue'
import { unusedAppName, type UnusedFiles, type UnusedFilesDeleted } from '../../model/chat/unusedFiles'
import { byteSizeText } from '../../utils/byteSize'
import type { ToastData } from '../toast/selectors'

// The "Unused files" row of Settings › General: the scan with its progress,
// the prompt with the count and the size, the delete, and the toast that
// tells the result. The file work is in `dez.controller/unusedFiles/*`. A
// scan can find unused apps too: the texts count them apart from the
// files, and a text of a scan with no app is the text for files only.

/** The part of the scan that is done, from 0 to 1, while a cleanup runs
 *  (it stays 1 during the prompt and the delete); `null` while none runs.
 *  It is here and not in SettingsView.vue because a cleanup goes on when
 *  the user closes Settings: a Settings that opens again must show the bar
 *  and keep the button off. */
export const unusedFilesProgress = ref<number | null>(null)

// The most apps that the question names: a prompt with more is too long
// to read.
const MAX_NAMED_APPS = 10

// `1 file`, `12 files`.
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// `3 files and 1 app`, with no part for a count of 0.
function countedBoth(files: number, fileNoun: string, apps: number, appNoun: string): string {
  return [...(files > 0 ? [counted(files, fileNoun)] : []), ...(apps > 0 ? [counted(apps, appNoun)] : [])].join(' and ')
}

/** The question of the prompt that comes after a scan that found files.
 *  It names the apps that the delete takes, as an app is the work of a
 *  model for the user and not a copy of a file. */
export function deleteQuestion(unused: UnusedFiles): string {
  const apps = unused.files.flatMap((file) => unusedAppName(file) ?? [])
  const files = unused.files.length - apps.length
  const size = `This frees ${byteSizeText(unused.bytes)}, and it cannot be undone.`
  if (apps.length === 0) return `Are you sure you want to delete ${counted(files, 'unused file')}? ${size}`
  const more = apps.length - MAX_NAMED_APPS
  const names = `${apps.slice(0, MAX_NAMED_APPS).join(', ')}${more > 0 ? `, and ${more} more` : ''}`
  const what = [...(files > 0 ? [counted(files, 'unused file')] : []), `${counted(apps.length, 'unused app')} (${names})`].join(' and ')
  return `Are you sure you want to delete ${what}? ${size}`
}

/** The toast that tells what a delete did. One with a file or an app that
 *  could not be deleted stays until the user closes it. */
export function deletedToast({ deleted, bytes, inUse, failed, apps }: UnusedFilesDeleted): ToastData {
  const allDeleted = deleted + apps.deleted
  const allFailed = failed + apps.failed
  const sentences = [allDeleted > 0 ? `Deleted ${countedBoth(deleted, 'unused file', apps.deleted, 'unused app')} (${byteSizeText(bytes)}).` : 'Deleted no files.']
  if (inUse + apps.inUse > 0) sentences.push(`Kept ${countedBoth(inUse, 'file', apps.inUse, 'app')} now in use.`)
  if (allFailed > 0) {
    sentences.push(`Could not delete ${countedBoth(failed, 'file', apps.failed, 'app')}: the system did not let Dez delete ${allFailed === 1 ? 'it' : 'them'}. Help › Developer Console shows why. Fix that, and click Delete Unused Files again.`)
  }
  const message = sentences.join(' ')
  if (allFailed > 0) return { title: 'Unused files', message, variant: 'warning' }
  return { message, variant: allDeleted > 0 ? 'success' : 'default', duration: 5000 }
}

/** Runs one cleanup: scans for the stored files, the apps, and the cache
 *  entries that nothing uses, asks the user with the count and the size,
 *  and deletes them on a yes. Does nothing while a cleanup runs. */
export async function deleteUnusedFiles(): Promise<void> {
  if (unusedFilesProgress.value !== null) return
  unusedFilesProgress.value = 0
  try {
    const unused = await sbp('dez.controller/unusedFiles/find', (fraction: number) => {
      unusedFilesProgress.value = fraction
    }) as UnusedFiles
    if (unused.files.length === 0) {
      sbp('dez.ui/toast', 'app-global', { message: 'No unused files found', duration: 5000 })
      return
    }
    const confirmed = await sbp('dez.ui/confirm', { message: deleteQuestion(unused) }) as boolean
    if (!confirmed) return
    const result = await sbp('dez.controller/unusedFiles/delete', unused) as UnusedFilesDeleted
    sbp('dez.ui/toast', 'app-global', deletedToast(result))
  } catch {
    // The controller logged the failure and showed an error toast.
  } finally {
    unusedFilesProgress.value = null
  }
}
