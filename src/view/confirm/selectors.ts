import sbp from '@sbp/sbp'
import { shallowRef } from 'vue'

export interface ConfirmOptions {
  message: string
  /** The default button: it has the focus when the prompt opens, so Enter
   *  picks it. */
  confirmLabel?: string
  cancelLabel?: string
}

export interface ConfirmRequest {
  message: string
  confirmLabel: string
  cancelLabel: string
  resolve: (confirmed: boolean) => void
}

/** The open prompt, drawn by `ConfirmDialog.vue`; `null` while none is
 *  open. */
export const confirmRequest = shallowRef<ConfirmRequest | null>(null)

/** Closes the open prompt with the user's answer. Does nothing when no
 *  prompt is open. */
export function answerConfirm(confirmed: boolean): void {
  const request = confirmRequest.value
  if (!request) return
  confirmRequest.value = null
  request.resolve(confirmed)
}

export default sbp('sbp/selectors/register', {
  /** Asks the user a yes-or-no question in the app's own dialog. Resolves
   *  `true` for the confirm button, and `false` for the cancel button, Esc,
   *  or a click outside the dialog. A new prompt while one is open answers
   *  the open one `false` and takes its place. */
  'dez.ui/confirm' ({ message, confirmLabel = 'Yes', cancelLabel = 'No' }: ConfirmOptions): Promise<boolean> {
    answerConfirm(false)
    return new Promise((resolve) => {
      confirmRequest.value = { message, confirmLabel, cancelLabel, resolve }
    })
  },
})
