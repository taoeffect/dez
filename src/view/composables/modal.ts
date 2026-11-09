import sbp from '@sbp/sbp'

// Shared by the in-app modals (ConfirmDialog.vue, UpdateWindow.vue), so a
// fix to either rule reaches every modal.

// Gives the focus back to the element that had it before a modal opened, so
// the user can go on typing. Does nothing when that element left the DOM.
// `dez.editor/focus` puts back the editor's scroll, which WebKit can move
// when the editor gets the focus again (focus.ts).
export function restoreFocus(element: Element | null): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) return
  if (element.closest('.cm-editor')) sbp('dez.editor/focus')
  else element.focus({ preventScroll: true })
}

// Tab and Shift+Tab (with any modifier: in WebKit on macOS, Option+Tab
// moves the focus too) move only between the modal's enabled buttons, so
// the focus never goes to the editor behind the overlay, where a key could
// start a reply. Use it in a keydown listener on the modal element (the
// event's `currentTarget`). From no button (the modal itself has the
// focus), Tab goes to the first and Shift+Tab to the last, as a browser
// does. With no button, the focus stays where it is.
export function keepTabInModal(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !(event.currentTarget instanceof HTMLElement)) return
  event.preventDefault()
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (!buttons.length) return
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.shiftKey ? -1 : 1
  const next = index === -1
    ? (event.shiftKey ? buttons.length - 1 : 0)
    : (index + step + buttons.length) % buttons.length
  buttons[next].focus()
}

// Overlay handlers that dismiss the modal only for a press that started on
// the overlay itself. A drag that starts in the modal (a text selection) and
// ends outside it also gives the overlay a click; that click keeps it open.
export function useOverlayDismiss(dismiss: () => void) {
  let pressOnOverlay = false
  return {
    onOverlayMouseDown(event: MouseEvent) {
      pressOnOverlay = event.target === event.currentTarget
    },
    onOverlayClick(event: MouseEvent) {
      if (pressOnOverlay && event.target === event.currentTarget) dismiss()
      pressOnOverlay = false
    },
  }
}
