import { describe, expect, it, vi } from 'vitest'
import { useOverlayDismiss } from './modal'

const overlay = { name: 'overlay' }
const modalText = { name: 'text in the modal' }

// The repo's tests run with no DOM, so the events are plain objects with
// the fields that the overlay handlers read.
function mouseEvent(target: object): MouseEvent {
  let defaultPrevented = false
  return {
    target,
    currentTarget: overlay,
    preventDefault() { defaultPrevented = true },
    get defaultPrevented() { return defaultPrevented },
  } as unknown as MouseEvent
}

describe('useOverlayDismiss', () => {
  // The default of a press on the overlay moves the focus out of the modal,
  // and Tab could then reach the editor behind it while the update window
  // cannot close (an install runs).
  it('keeps the focus in the modal on a press on the overlay, and dismisses on the click', () => {
    const dismiss = vi.fn()
    const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(dismiss)
    const press = mouseEvent(overlay)
    onOverlayMouseDown(press)
    expect(press.defaultPrevented).toBe(true)
    onOverlayClick(mouseEvent(overlay))
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('keeps the default of a press in the modal, so its text can be selected', () => {
    const dismiss = vi.fn()
    const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(dismiss)
    const press = mouseEvent(modalText)
    onOverlayMouseDown(press)
    expect(press.defaultPrevented).toBe(false)
    // A selection drag that ends on the overlay gives the overlay a click.
    onOverlayClick(mouseEvent(overlay))
    expect(dismiss).not.toHaveBeenCalled()
  })
})
