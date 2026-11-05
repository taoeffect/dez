import type { EditorView } from '@codemirror/view'

/** Sets CodeMirror's internal `mustMeasureContent` flag, then asks for a
 *  measure. CodeMirror sets this flag itself when it draws lines (`true`)
 *  and when the web fonts finish loading (`'refresh'`); it is internal (seen
 *  in @codemirror/view 6.41.1 to 6.43.15). If a new version removes it, this
 *  does only `requestMeasure()`, and the close checks in
 *  `tests/e2e/thinking.e2e.ts` and the line checks in
 *  `tests/e2e/font-size.e2e.ts` fail. */
function measureContent(view: EditorView, mode: true | 'refresh'): void {
  const viewState: unknown = Reflect.get(view, 'viewState')
  if (typeof viewState === 'object' && viewState !== null && 'mustMeasureContent' in viewState) {
    Reflect.set(viewState, 'mustMeasureContent', mode)
  }
  view.requestMeasure()
}

/** Makes CodeMirror read the line heights again at its next measure, after
 *  a widget changed its height in place.
 *
 *  `requestMeasure()` alone is not enough. CodeMirror reads the line heights
 *  only after it draws lines again, or when the height of `.cm-content`
 *  changes. When the doc is shorter than the editor, `.cm-content` keeps
 *  its height (`min-height: 100%`), so CodeMirror keeps the old height: it
 *  draws the caret at the old place, and clicks below the widget land on
 *  the wrong line. */
export function measureLineHeights(view: EditorView): void {
  measureContent(view, true)
}

/** Makes CodeMirror measure the text size and every line again at its next
 *  measure, after the editor font size changed. Line heights alone are not
 *  enough: CodeMirror also keeps the default line height and character
 *  width, which it uses for the lines out of view. It measures them again
 *  only when a visible line has a height that is not in its samples for the
 *  old size. If every visible line height at the new size was also a height
 *  at the old size, it keeps the old text size. `'refresh'` (the value that
 *  CodeMirror uses after the fonts load) always measures it. */
export function measureTextSize(view: EditorView): void {
  measureContent(view, 'refresh')
}
