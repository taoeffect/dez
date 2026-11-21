import { shallowRef } from 'vue'

// The state of the confirm prompt. It is in its own module, apart from the
// `dez.ui/confirm` selector (selectors.ts), so that code that only reads or
// answers the open prompt (the Escape rule of view/panels.ts, which the
// editor modules import) does not register the selector: a unit test of an
// editor module registers its own `dez.ui/confirm`.

export interface ConfirmRequest {
  message: string
  confirmLabel: string
  /** `null`: the prompt has no cancel button. */
  cancelLabel: string | null
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
