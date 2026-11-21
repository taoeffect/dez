import sbp from '@sbp/sbp'
import { ref } from 'vue'
import { cleanupAppName, cleanupNoun, type CleanupKind, type UnusedFiles, type UnusedFilesDeleted } from '../../model/chat/unusedFiles'
import { byteSizeText } from '../../utils/byteSize'
import type { ToastData } from '../toast/selectors'

// The two cleanup rows of Settings › General, "Unreferenced files" and
// "Unreferenced apps": the scan with its progress, the prompt with the
// count and the size, the delete, and the toast that tells the result. The
// file work is in `dez.controller/unusedFiles/*`.

/** The cleanup that runs, with the part of its scan that is done, from 0
 *  to 1 (it stays 1 during the prompt and the delete); `null` while none
 *  runs. One for both kinds, so that each button is off while the other
 *  cleanup runs. It is here and not in SettingsView.vue because a cleanup
 *  goes on when the user closes Settings: a Settings that opens again must
 *  show the bar and keep the buttons off. */
export const runningCleanup = ref<{ kind: CleanupKind, progress: number } | null>(null)

/** The label of the button of each cleanup in Settings › General. */
export const CLEANUP_BUTTONS: Readonly<Record<CleanupKind, string>> = {
  files: 'Delete Unreferenced Files',
  apps: 'Delete Unreferenced Apps',
}

// `1 file`, `12 files`.
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** The question of the prompt that comes after a scan that found
 *  something. The question of the apps names each app, as an app is the
 *  work of a model for the user and not a copy of a file. */
export function deleteQuestion(unused: UnusedFiles): string {
  const size = `This frees ${byteSizeText(unused.bytes)}, and it cannot be undone.`
  if (unused.kind === 'files') return `Are you sure you want to delete ${counted(unused.files.length, 'unreferenced file')}? ${size}`
  const names = unused.files.flatMap((file) => cleanupAppName(file) ?? [])
  return `Are you sure you want to delete ${counted(names.length, 'unreferenced app')} (${names.join(', ')}) with all ${names.length === 1 ? 'its' : 'their'} files? ${size}`
}

/** The toast that tells what a delete of a cleanup of the kind `kind` did.
 *  One with a file or an app that could not be deleted stays until the
 *  user closes it. */
export function deletedToast(kind: CleanupKind, { deleted, bytes, inUse, failed }: UnusedFilesDeleted): ToastData {
  const noun = cleanupNoun(kind)
  const sentences = [deleted > 0 ? `Deleted ${counted(deleted, `unreferenced ${noun}`)} (${byteSizeText(bytes)}).` : `Deleted no ${kind}.`]
  if (inUse > 0) sentences.push(`Kept ${counted(inUse, noun)} now in use.`)
  if (failed > 0) {
    sentences.push(`Could not delete ${counted(failed, noun)}: the system did not let Dez delete ${failed === 1 ? 'it' : 'them'}. Help › Developer Console shows why. Fix that, and click ${CLEANUP_BUTTONS[kind]} again.`)
  }
  const message = sentences.join(' ')
  if (failed > 0) return { title: `Unreferenced ${kind}`, message, variant: 'warning' }
  return { message, variant: deleted > 0 ? 'success' : 'default', duration: 5000 }
}

/** Runs one cleanup of the kind `kind`: scans for the stored files and the
 *  cache entries, or for the apps, that nothing uses, asks the user with
 *  the count and the size, and deletes them on a yes. Does nothing while a
 *  cleanup runs. */
export async function deleteUnreferenced(kind: CleanupKind): Promise<void> {
  if (runningCleanup.value !== null) return
  runningCleanup.value = { kind, progress: 0 }
  try {
    const unused = await sbp('dez.controller/unusedFiles/find', kind, (fraction: number) => {
      runningCleanup.value = { kind, progress: fraction }
    }) as UnusedFiles
    if (unused.files.length === 0) {
      sbp('dez.ui/toast', 'app-global', { message: `No unreferenced ${kind} found`, duration: 5000 })
      return
    }
    const confirmed = await sbp('dez.ui/confirm', { message: deleteQuestion(unused) }) as boolean
    if (!confirmed) return
    const result = await sbp('dez.controller/unusedFiles/delete', unused) as UnusedFilesDeleted
    sbp('dez.ui/toast', 'app-global', deletedToast(kind, result))
  } catch {
    // The controller logged the failure and showed an error toast.
  } finally {
    runningCleanup.value = null
  }
}
