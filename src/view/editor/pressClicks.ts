import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** The click rule of a clickable mark of the editor (a rendered link, a
 *  mention chip). A plain primary-button press on an element of `selector`
 *  whose item `find` gives runs `act` when the button goes up on the same
 *  item (`same`). The handler takes the press, so the caret and the focus
 *  stay where they are. A press with a modifier key (Ctrl/Cmd adds a
 *  selection range, Shift extends the selection) or with another button,
 *  or one that `takes` refuses, goes to CodeMirror. The button can go up
 *  outside the editor, so the window watches the release.
 *
 *  High precedence: the press must run before
 *  `focusKeepingScrollOnMouseDown` (focus.ts), which focuses an editor that
 *  does not have the focus. */
export function pressClicks<T>(
  selector: string,
  find: (state: EditorState, pos: number, side: -1 | 1) => T | null,
  same: (pressed: T, released: T) => boolean,
  act: (view: EditorView, released: T) => void,
  takes: (view: EditorView, event: MouseEvent, pressed: T) => boolean = () => true,
): Extension {
  // The item whose mark holds `target`, the mark or an element in it.
  const itemAt = (view: EditorView, target: EventTarget | null): T | null => {
    const mark = target instanceof Element ? target.closest(selector) : null
    if (!mark || !view.contentDOM.contains(mark)) return null
    return find(view.state, view.posAtDOM(mark), 1)
  }
  return Prec.high(EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false
      const pressed = itemAt(view, event.target)
      if (pressed === null || !takes(view, event, pressed)) return false
      const onMouseUp = (release: MouseEvent) => {
        if (release.button !== 0) return
        window.removeEventListener('mouseup', onMouseUp, true)
        const released = itemAt(view, release.target)
        if (released !== null && same(pressed, released)) act(view, released)
      }
      window.addEventListener('mouseup', onMouseUp, true)
      return true
    },
  }))
}
