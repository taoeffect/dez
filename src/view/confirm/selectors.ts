import sbp from '@sbp/sbp'
import { answerConfirm, confirmRequest } from './request'

export interface ConfirmOptions {
  message: string
  /** The default button: it has the focus when the prompt opens, so Enter
   *  picks it. */
  confirmLabel?: string
  /** `null` gives a prompt with only the confirm button: a notice that the
   *  user can only take note of (an "OK"). */
  cancelLabel?: string | null
}

export default sbp('sbp/selectors/register', {
  /** Asks the user a yes-or-no question in the app's own dialog, or shows
   *  a notice with only its confirm button (`cancelLabel: null`). Resolves
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
