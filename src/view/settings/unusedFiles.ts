import sbp from '@sbp/sbp'
import { ref } from 'vue'
import type { UnusedFiles, UnusedFilesDeleted } from '../../model/chat/unusedFiles'
import { byteSizeText } from '../../utils/byteSize'
import type { ToastData } from '../toast/selectors'

// The "Unused files" row of Settings › General: the scan with its progress,
// the prompt with the count and the size, the delete, and the toast that
// tells the result. The file work is in `dez.controller/unusedFiles/*`.

/** The part of the scan that is done, from 0 to 1, while a cleanup runs
 *  (it stays 1 during the prompt and the delete); `null` while none runs.
 *  It is here and not in SettingsView.vue because a cleanup goes on when
 *  the user closes Settings: a Settings that opens again must show the bar
 *  and keep the button off. */
export const unusedFilesProgress = ref<number | null>(null)

// `1 file`, `12 files`.
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The question of the prompt that comes after a scan that found files. */
export function deleteQuestion(unused: UnusedFiles): string {
  return `Are you sure you want to delete ${counted(unused.files.length, 'unused file')}? This frees ${byteSizeText(unused.bytes)}, and it cannot be undone.`
}

/** The toast that tells what a delete did. One with a file that could not
 *  be deleted stays until the user closes it. */
export function deletedToast({ deleted, bytes, inUse, failed }: UnusedFilesDeleted): ToastData {
  const sentences = [deleted > 0 ? `Deleted ${counted(deleted, 'unused file')} (${byteSizeText(bytes)}).` : 'Deleted no files.']
  if (inUse > 0) sentences.push(`Kept ${counted(inUse, 'file')} now in use.`)
  if (failed > 0) sentences.push(`Could not delete ${counted(failed, 'file')}.`)
  const message = sentences.join(' ')
  if (failed > 0) return { title: 'Unused files', message, variant: 'warning' }
  return { message, variant: deleted > 0 ? 'success' : 'default', duration: 5000 }
}

/** Runs one cleanup: scans for the stored files that nothing uses, asks the
 *  user with the count and the size, and deletes the files on a yes. Does
 *  nothing while a cleanup runs. */
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
