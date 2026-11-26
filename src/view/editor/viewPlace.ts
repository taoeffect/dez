import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { StoredViewPlace } from '../../model/persistence/types'

// The place of a view that the next start of Dez shows again
// (`dez.model/viewPlace/*`): the line block at the top edge of the view,
// the px from its top to that edge, and the main selection. A new editor
// state has only estimates of the line heights, and the window can have
// another size, so the place is a line and an offset, never a scrollTop.

/** Runs a measure of CodeMirror that is due, so that its line heights and
 *  its scroll position are those of the screen. `lineBlockAtHeight` does it
 *  first (CodeMirror's private `readMeasured`); `lineBlockAt` does not. */
function measureNow(view: EditorView): void {
  view.lineBlockAtHeight(0)
}

/** The height of the top edge of the view in the doc. It is negative when
 *  the view shows the top padding of the editor. */
function viewTop(view: EditorView): number {
  return view.scrollDOM.getBoundingClientRect().top - view.documentTop
}

/** The place of the view now. */
export function readViewPlace(view: EditorView, conversationId: string): StoredViewPlace {
  measureNow(view)
  const top = viewTop(view)
  const block = view.lineBlockAtHeight(top)
  const { anchor, head } = view.state.selection.main
  return { conversationId, pos: block.from, offset: top - block.top, anchor, head }
}

/** Shows a stored place, with its caret, and gives the place that it
 *  shows. The conversation file can be older than the place, so each
 *  position is kept within the doc.
 *
 *  `scrollIntoView` makes CodeMirror draw and measure the lines at `pos`,
 *  but it puts the rectangle of the character at the top, not the top of
 *  the block plus the offset. So `putViewTop` sets the scrollTop after it. */
export function showViewPlace(view: EditorView, stored: StoredViewPlace): StoredViewPlace {
  const length = view.state.doc.length
  const place = {
    ...stored,
    pos: Math.min(stored.pos, length),
    anchor: Math.min(stored.anchor, length),
    head: Math.min(stored.head, length),
  }
  view.dispatch({
    selection: EditorSelection.single(place.anchor, place.head),
    effects: EditorView.scrollIntoView(place.pos, { y: 'start' }),
    userEvent: 'select',
  })
  putViewTop(view, place)
  return place
}

/** Puts the top edge of the view `offset` px below the top of the line
 *  block at `pos`, of a place within the doc. The offset is cut to the
 *  height of the block: the block can be shorter than in the last session
 *  (an image that has not loaded, a panel that was open).
 *
 *  The write is out of CodeMirror's measure: a write in a `requestMeasure`
 *  pair would read before CodeMirror handles a pending scroll target, and
 *  CodeMirror adds its own scroll anchor move after each such write. The
 *  scroll event of this write makes CodeMirror take a new anchor, so
 *  nothing moves the view twice. Call it only while CodeMirror runs no
 *  update (an update listener is fine). */
export function putViewTop(view: EditorView, place: StoredViewPlace): void {
  measureNow(view)
  const block = view.lineBlockAt(place.pos)
  view.scrollDOM.scrollTop += block.top + Math.min(place.offset, block.height) - viewTop(view)
}
