import type { EditorView } from '@codemirror/view'

/** A place in px: the left and top edges, and the size. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The place of a layer that covers the conversation view of `view`: the
 *  box of its scroller in the window, with its scrollbar. The expanded view
 *  of an app (view/apps/appFrameHost.ts) and the image zoom (imageZoom.ts)
 *  take it. */
export function coverBox(view: EditorView): Box {
  const { left, top, width, height } = view.scrollDOM.getBoundingClientRect()
  return { left, top, width, height }
}
