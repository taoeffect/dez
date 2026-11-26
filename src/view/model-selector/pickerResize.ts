import { computed, onBeforeUnmount, readonly, ref, watch, type ComputedRef, type Ref } from 'vue'

// The resize of the two boxes that open up from the left end of the bottom
// bar: the model picker (`ModelSelector.vue`) and the settings panel of the
// gear (`ProviderSettingsPopup.vue`). A drag of the top edge, the right
// edge, or the top right corner (`PickerHandles.vue`). Both boxes open up
// and to the right from the bar's left end, so their bottom left corner
// stays where it is, and the room of the window is the same for both.

export type PickerEdge = 'top' | 'right' | 'corner'

export const PICKER_EDGES: readonly PickerEdge[] = ['top', 'right', 'corner']

// A box stays this far from the window's top and right edges. It must be at
// least the part of a handle that is outside the box's border, so that no
// handle leaves the window.
export const PICKER_ROOM_MARGIN_PX = 8

// The size of a box, in px: its width, and the limit of its height (a box
// is as tall as its content, up to the limit). A `maxHeight` of `Infinity`
// is no limit: then only the room counts.
export interface BoxSize {
  width: number
  maxHeight: number
}

// The largest box that fits in the window, in whole px.
export interface PickerRoom {
  width: number
  height: number
}

export function pickerRoom(box: Pick<DOMRect, 'left' | 'bottom'>, windowWidth: number): PickerRoom {
  return {
    width: Math.floor(windowWidth - box.left - PICKER_ROOM_MARGIN_PX),
    height: Math.floor(box.bottom - PICKER_ROOM_MARGIN_PX),
  }
}

// The size that the box shows: the user's size, made smaller when the
// window has no room for it. The stored size does not change, so the box
// gets it back in a larger window.
export function fitPickerSize(size: BoxSize, room: PickerRoom | null): BoxSize {
  if (!room) return size
  return { width: Math.min(size.width, room.width), maxHeight: Math.min(size.maxHeight, room.height) }
}

export interface PickerDragStart {
  edge: PickerEdge
  // The size of the box on the screen at the press. It can be smaller than
  // the stored size: a short list draws a picker shorter than its height
  // limit, and a small window draws a smaller box (`fitPickerSize`). A move
  // that makes a dimension smaller starts from it, so that the edge moves
  // with the pointer at once.
  rendered: { width: number; height: number }
  // The stored size: a dimension that the edge does not move keeps it.
  size: BoxSize
  room: PickerRoom
  // The smallest size that a drag gives, when the room allows it.
  min: BoxSize
  // Whether a drag up that reaches the top of the room gives no height
  // limit (`Infinity`). The settings panel has no limit by default, so this
  // gives the default back. The picker has a limit by default.
  noLimitAtRoomTop: boolean
}

// The size after a move of the pointer by (dx, dy) from the press. Up and
// to the right make the box larger. Each dimension that the edge moves is
// rounded and stays between the minimum and the room; when the window is
// too small for the minimum, the room wins, as in `fitPickerSize`. A move
// that makes a dimension smaller starts from the drawn box. A move that
// makes it larger never lowers the stored size: a short list or a small
// window stops the edge, and the stored size comes back with a long list or
// a larger window. A dimension with no move keeps its stored size.
export function draggedPickerSize(start: PickerDragStart, dx: number, dy: number): BoxSize {
  const within = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)))
  const dragged = (drawn: number, stored: number, grow: number, min: number, room: number) => {
    if (grow === 0) return stored
    const size = within(drawn + grow, min, room)
    return grow > 0 ? Math.max(stored, size) : size
  }
  const height = (): number => {
    if (start.edge === 'right') return start.size.maxHeight
    const limit = dragged(start.rendered.height, start.size.maxHeight, -dy, start.min.maxHeight, start.room.height)
    return start.noLimitAtRoomTop && dy < 0 && limit >= start.room.height ? Infinity : limit
  }
  return {
    width: start.edge === 'top'
      ? start.size.width
      : dragged(start.rendered.width, start.size.width, dx, start.min.width, start.room.width),
    maxHeight: height(),
  }
}

interface PickerDrag extends PickerDragStart {
  pointerId: number
  handle: Element
  startX: number
  startY: number
}

export interface BoxResize {
  storedSize: () => BoxSize
  min: Readonly<BoxSize>
  noLimitAtRoomTop?: boolean
  // Gets the new size once, at the release of a drag that moved.
  save: (size: BoxSize) => void
}

// The drag of a handle of the box `box` (an element that a `v-if` can
// remove). `shownSize` is the size to give the box. During a drag a local
// size drives the box, and `save` gets the new size once, at the release.
// Escape or a close of the box during a drag ends it with no save. `room`
// is the room of the open box, null before its first measure.
export function usePickerResize(
  box: Readonly<Ref<HTMLElement | null>>,
  resize: BoxResize,
): {
  shownSize: ComputedRef<BoxSize>
  room: Readonly<Ref<PickerRoom | null>>
  startResize: (edge: PickerEdge, e: PointerEvent) => void
} {
  const room = ref<PickerRoom | null>(null)
  const dragSize = ref<BoxSize | null>(null)
  let drag: PickerDrag | null = null

  const shownSize = computed(() => fitPickerSize(dragSize.value ?? resize.storedSize(), room.value))

  function measureRoom() {
    room.value = box.value ? pickerRoom(box.value.getBoundingClientRect(), window.innerWidth) : null
  }

  function startResize(edge: PickerEdge, e: PointerEvent) {
    const element = box.value
    if (e.button !== 0 || !element) return
    endResize(false)
    const rect = element.getBoundingClientRect()
    const handle = e.currentTarget as Element
    room.value = pickerRoom(rect, window.innerWidth)
    drag = {
      edge,
      rendered: { width: rect.width, height: rect.height },
      size: resize.storedSize(),
      room: room.value,
      min: resize.min,
      noLimitAtRoomTop: resize.noLimitAtRoomTop ?? false,
      pointerId: e.pointerId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
    }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('lostpointercapture', onLostPointerCapture)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    // The cursor of the handle for the whole drag, also when the pointer
    // leaves the handle (past the room, or after a fast move): pointer
    // capture does not keep the cursor in every WebKit. The rule is the
    // global style of `PickerHandles.vue`.
    document.documentElement.classList.add(`picker-resizing--${edge}`)
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== drag?.pointerId) return
    // No button down: the release was missed.
    if ((e.buttons & 1) === 0) {
      endResize(true)
      return
    }
    dragSize.value = draggedPickerSize(drag, e.clientX - drag.startX, e.clientY - drag.startY)
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId === drag?.pointerId) endResize(true)
  }

  function onPointerCancel(e: PointerEvent) {
    if (e.pointerId === drag?.pointerId) endResize(false)
  }

  function onLostPointerCapture(e: Event) {
    if ((e as PointerEvent).pointerId === drag?.pointerId) endResize(false)
  }

  // A press with no move saves nothing: `dragSize` is still null.
  function endResize(save: boolean) {
    const state = drag
    if (!state) return
    drag = null
    state.handle.removeEventListener('lostpointercapture', onLostPointerCapture)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    document.documentElement.classList.remove(`picker-resizing--${state.edge}`)
    const size = dragSize.value
    dragSize.value = null
    if (save && size) resize.save(size)
  }

  // The room follows the window while the box is open.
  watch(box, (element) => {
    if (element) {
      measureRoom()
      window.addEventListener('resize', measureRoom)
    } else {
      endResize(false)
      window.removeEventListener('resize', measureRoom)
      room.value = null
    }
  }, { flush: 'post' })

  onBeforeUnmount(() => {
    endResize(false)
    window.removeEventListener('resize', measureRoom)
  })

  return { shownSize, room: readonly(room), startResize }
}
