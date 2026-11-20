import sbp from '@sbp/sbp'
import { answerConfirm, confirmRequest } from './confirm/request'

// The layers of Dez that cover the window: the confirm prompt, and the
// panels Settings, History, and Help. Escape closes the top one of them
// before anything under it, from each place that gets the key: Dez's own
// page (composables/useKeyboardShortcuts.ts), and the page of an app that
// has the keyboard under a panel (apps/appFrameHost.ts).

/** Whether the confirm prompt, Settings, History, or Help is open. */
export function isPanelOpen(): boolean {
  return (
    confirmRequest.value !== null ||
    (sbp('dez.model/settings/isOpen') as boolean) ||
    (sbp('dez.model/settings/isHistoryOpen') as boolean) ||
    (sbp('dez.model/settings/isHelpOpen') as boolean)
  )
}

/** Escape for the top one of them: answers the confirm prompt with its
 *  cancel button (the prompt can be over Settings or History), or closes
 *  Settings, History, or Help (only one of them is open at a time).
 *  Returns whether one was open. */
export function closeTopPanel(): boolean {
  if (confirmRequest.value) answerConfirm(false)
  else if (sbp('dez.model/settings/isOpen') as boolean) sbp('dez.model/settings/close')
  else if (sbp('dez.model/settings/isHistoryOpen') as boolean) sbp('dez.model/settings/historyClose')
  else if (sbp('dez.model/settings/isHelpOpen') as boolean) sbp('dez.model/settings/helpClose')
  else return false
  return true
}
