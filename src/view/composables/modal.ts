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
