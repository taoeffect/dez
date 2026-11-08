import { EditorView } from '@codemirror/view'

/** Focuses the editor and then puts back each scroll position that the
 *  focus changed, from the editor up to the page.
 *
 *  Why: when the editor gets focus again, WebKit 26 scrolls to show the
 *  old DOM selection even with `focus({ preventScroll: true })`. In a long
 *  doc the view jumps from where the user scrolled to the old caret or
 *  selection. CodeMirror (from 6.38.5) knows this bug, but it uses its
 *  save-and-restore fallback only when the user agent has `Version/26` or
 *  more. The macOS WKWebView of Tauri has no `Version/` token, so there
 *  CodeMirror trusts `preventScroll` and the jump stays. WebKitGTK sends
 *  `Version/60.5`, so Linux gets the fallback and does not show the bug.
 *
 *  This does the same as that fallback on every platform. It only puts
 *  back the place where the user left the view; it never scrolls the view
 *  to a new place. When the focus does not scroll, it writes nothing.
 *
 *  https://github.com/codemirror/dev/issues/1626
 *  https://github.com/codemirror/view/commit/b4a5a0261fe4
 *  https://github.com/markrahq/markra/pull/737 */
export function focusKeepingScroll(view: EditorView): void {
  const saved: { element: Element, top: number, left: number }[] = []
  for (let element = view.contentDOM.parentElement; element; element = element.parentElement) {
    saved.push({ element, top: element.scrollTop, left: element.scrollLeft })
  }
  view.focus()
  for (const { element, top, left } of saved) {
    if (element.scrollTop !== top) element.scrollTop = top
    if (element.scrollLeft !== left) element.scrollLeft = left
  }
}

/** Puts the DOM selection back where the editor state has it, after a
 *  change that code dispatched while the editor has the focus.
 *
 *  Why: when text next to a text node goes, CodeMirror rewrites the whole
 *  value of that node, and the browser then moves a DOM caret in it to the
 *  node's start. CodeMirror normally reads that back and writes its caret
 *  again. But for 200 ms after the editor gets the focus, it takes a caret
 *  at the very start of the editor for the one that WebKit puts there on
 *  focus, and it writes nothing, because its record of the DOM selection
 *  still matches the state. The next `selectionchange` then moves the
 *  state's caret to the doc start. So a change that comes right after the
 *  focus comes back (the image trash, after its confirm prompt) moved a
 *  caret on the first line to the doc start (@codemirror/view 6.41.1,
 *  `readSelectionRange`). A selection that is already right is left as it
 *  is. */
export function syncDomSelection(view: EditorView): void {
  const selection = view.hasFocus ? document.getSelection() : null
  const { anchorNode, focusNode } = selection ?? {}
  if (!selection || !anchorNode || !focusNode || !view.contentDOM.contains(anchorNode) || !view.contentDOM.contains(focusNode)) return
  const { main } = view.state.selection
  if (view.posAtDOM(anchorNode, selection.anchorOffset) === main.anchor && view.posAtDOM(focusNode, selection.focusOffset) === main.head) return
  const anchor = view.domAtPos(main.anchor)
  const head = view.domAtPos(main.head)
  selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset)
}

/** A primary-button press in the text of an editor without focus: focus it
 *  with `focusKeepingScroll` before CodeMirror's own mousedown handler
 *  runs. That handler then sees an editor with focus, does not focus it a
 *  second time, and reads the click position on the view the user sees.
 *  The usual route: a press on the scrollbar moves the focus to
 *  `.cm-scroller` (CodeMirror gives it `tabIndex = -1`), the user drags the
 *  view away from the selection, then clicks or Shift-clicks in the text.
 *  Put this after the pill mousedown handlers, so that a pill press that
 *  they take keeps the focus where it is, as before. */
export const focusKeepingScrollOnMouseDown = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button === 0 && !view.hasFocus) focusKeepingScroll(view)
    return false
  },
})
