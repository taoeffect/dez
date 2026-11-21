import sbp from '@sbp/sbp'
import { answerConfirm, confirmRequest } from './confirm/request'
import { closeImageZoom, isImageZoomOpen } from './editor/imageZoom'

// The layers of Dez that cover the window: the confirm prompt, and the
// panels Settings, History, and Help; and the image zoom, which covers the
// conversation view under them. Escape closes the top one of them before
// anything under it, from each place that gets the key: Dez's own page
// (composables/useKeyboardShortcuts.ts), and the page of an app that has
// the keyboard under a panel (apps/appFrameHost.ts).

/** Whether the confirm prompt, Settings, History, Help, or the image zoom
 *  is open. */
export function isPanelOpen(): boolean {
  return (
    confirmRequest.value !== null ||
    (sbp('dez.model/settings/isOpen') as boolean) ||
    (sbp('dez.model/settings/isHistoryOpen') as boolean) ||
    (sbp('dez.model/settings/isHelpOpen') as boolean) ||
    isImageZoomOpen()
  )
}

/** Escape for the top one of them: answers the confirm prompt `false`, as
 *  its cancel button does (the prompt can be over Settings or History; a
 *  prompt with only an OK button closes too), or closes
 *  Settings, History, or Help (only one of them is open at a time), or
 *  else the image zoom, which is under them. Returns whether one was
 *  open. */
export function closeTopPanel(): boolean {
  if (confirmRequest.value) answerConfirm(false)
  else if (sbp('dez.model/settings/isOpen') as boolean) sbp('dez.model/settings/close')
  else if (sbp('dez.model/settings/isHistoryOpen') as boolean) sbp('dez.model/settings/historyClose')
  else if (sbp('dez.model/settings/isHelpOpen') as boolean) sbp('dez.model/settings/helpClose')
  else return closeImageZoom()
  return true
}
