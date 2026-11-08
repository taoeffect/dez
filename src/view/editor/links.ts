import sbp from '@sbp/sbp'
import { syntaxTree } from '@codemirror/language'
import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { renderedImages } from './images'
import { tableRowStarts } from './tables'

/** A markdown link that the editor can show as a link. */
export interface MarkdownLink {
  /** Doc range of the whole link source. */
  from: number
  to: number
  /** Doc range of the text that the rendered link shows: the link text, or
   *  the address of an autolink. The source before and after it is
   *  hidden. */
  textFrom: number
  textTo: number
  /** The destination that opens. */
  url: string
}

/** The URLs that `dez.controller/openUrl` can open: the URL scope of the
 *  opener plugin's `opener:default` permission
 *  (`src-tauri/capabilities/default.json`). Other links stay source text.
 *  Like the plugin, it matches case-sensitively; link URLs get a lower-case
 *  scheme first (`withLowerCaseScheme`). */
const OPENABLE_URL = /^(?:https?:\/\/|mailto:|tel:)/

/** The scheme of a CommonMark URI autolink. An autolink without one is an
 *  email autolink, whose destination is `mailto:` + the address. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]{1,31}:/i

/** A CommonMark backslash escape of an ASCII punctuation char. */
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g

/** `url` with its scheme in lower case. A scheme does not depend on case
 *  (RFC 3986 §3.1), but the opener plugin matches its URL scope
 *  (`https://*`, …) case-sensitively, so `HTTPS://…` would not open. */
function withLowerCaseScheme(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:/i, (scheme) => scheme.toLowerCase())
}

/** An inline link, `[text](url "title")`. Its link marks are `[`, `]`, `(`,
 *  and `)`; a reference link (`[text][ref]`, `[text]`) has no `(`. The
 *  destination loses its `<` `>` and its backslash escapes, as CommonMark
 *  reads it (entity references are kept as written). */
function inlineLink(state: EditorState, node: SyntaxNode): MarkdownLink | null {
  const marks = node.getChildren('LinkMark')
  const url = node.getChild('URL')
  if (marks.length !== 4 || !url || state.sliceDoc(marks[2].from, marks[2].to) !== '(') return null
  const destination = state.sliceDoc(url.from, url.to)
  const unbracketed = destination.startsWith('<') ? destination.slice(1, -1) : destination
  return { from: node.from, to: node.to, textFrom: marks[0].to, textTo: marks[1].from, url: withLowerCaseScheme(unbracketed.replace(BACKSLASH_ESCAPE, '$1')) }
}

/** An autolink, `<url>` or `<address>`. Backslash escapes do not work in
 *  autolinks (CommonMark). */
function autolink(state: EditorState, node: SyntaxNode): MarkdownLink | null {
  const url = node.getChild('URL')
  if (!url) return null
  const address = state.sliceDoc(url.from, url.to)
  return { from: node.from, to: node.to, textFrom: url.from, textTo: url.to, url: URI_SCHEME.test(address) ? withLowerCaseScheme(address) : `mailto:${address}` }
}

/** Whether the lines of `link` let it render. Not, so left as source text:
 *  - a link on a line with a sentinel (a section separator or a pill
 *    marker), whose widgets and atomic ranges must stay the only ones
 *    there;
 *  - a link that touches a rendered image (`renderedImages`), as in
 *    `[![…](id=a)](https://…)`: the image widget is atomic and the link
 *    markup is not;
 *  - a link on a table row line: a replace decoration there becomes an
 *    extra table cell (see `tableDecorationsField` in `tables.ts`). */
function linesLetLinkRender(state: EditorState, link: MarkdownLink): boolean {
  const { doc } = state
  const firstLine = doc.lineAt(link.from)
  const lastLine = doc.lineAt(link.to)
  if (SENTINEL_CHAR.test(doc.sliceString(firstLine.from, lastLine.to))) return false
  if (renderedImages(state).some((image) => image.from <= link.to && image.to >= link.from)) return false
  const rowStarts = tableRowStarts(doc)
  for (let line = firstLine.number; line <= lastLine.number; line++) {
    if (rowStarts.has(doc.line(line).from)) return false
  }
  return true
}

/** The links in `from`–`to` that the editor can render, rendered or not:
 *  inline links and autolinks from the markdown syntax tree, so links in
 *  code and image descriptions never count, and a Dez image reference with
 *  no `!` (`[path](id=a)`) is a link to `id=a`, which does not open. Also
 *  left as source text: a link with no text to show, and a link whose
 *  hidden markup crosses a line break (a view plugin cannot replace one). */
function findRenderableLinks(state: EditorState, from: number, to: number): MarkdownLink[] {
  const links: MarkdownLink[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === 'Image') return false
      if (node.name !== 'Link' && node.name !== 'Autolink') return
      const link = node.name === 'Link' ? inlineLink(state, node.node) : autolink(state, node.node)
      if (
        link &&
        OPENABLE_URL.test(link.url) &&
        state.sliceDoc(link.textFrom, link.textTo).trim() !== '' &&
        !state.sliceDoc(link.from, link.textFrom).includes('\n') &&
        !state.sliceDoc(link.textTo, link.to).includes('\n') &&
        linesLetLinkRender(state, link)
      ) {
        links.push(link)
      }
      // A link holds no other link.
      return false
    },
  })
  return links
}

/** The links in `from`–`to` (all the doc by default) that the editor shows
 *  rendered in `state`, in doc order. A link shows its source while any
 *  selection range touches it, also at its two ends, so the arrow keys and
 *  a click right after it go into the source one char at a time. */
export function renderedLinks(state: EditorState, from = 0, to = state.doc.length): MarkdownLink[] {
  const { ranges } = state.selection
  return findRenderableLinks(state, from, to).filter((link) => !ranges.some((range) => range.from <= link.to && range.to >= link.from))
}

/** The rendered link under the pointer, from a doc position and a side as
 *  CodeMirror gives them (`hoverTooltip`): `side` is -1 when the pointer is
 *  before `pos`, 1 when it is after. All the positions of a link's hidden
 *  markup show at one point, the edge of its text, so at those positions
 *  only the side tells the link from the char next to it. */
export function renderedLinkAt(state: EditorState, pos: number, side: -1 | 1): MarkdownLink | null {
  return renderedLinks(state, pos, pos).find((link) =>
    (link.textFrom < pos && pos < link.textTo) ||
    (side > 0 && link.from <= pos && pos <= link.textFrom) ||
    (side < 0 && link.textTo <= pos && pos <= link.to),
  ) ?? null
}

const hiddenMarkup = Decoration.replace({})
const linkText = Decoration.mark({ class: 'dez-link' })

function buildLinkDecorations(view: EditorView): DecorationSet {
  const { from, to } = view.viewport
  return Decoration.set(renderedLinks(view.state, from, to).flatMap((link) => [
    hiddenMarkup.range(link.from, link.textFrom),
    linkText.range(link.textFrom, link.textTo),
    hiddenMarkup.range(link.textTo, link.to),
  ]))
}

/** Each rendered link (`renderedLinks`) shows only its text, as a link; its
 *  markup (`[`, `](url "title")`, or `<` and `>`) is hidden. Unlike images
 *  and tables, the result depends on the selection and the syntax tree, so
 *  this is a view plugin over the viewport, rebuilt on each change of
 *  either. The hidden ranges are not atomic: a caret that touches a link
 *  shows its source. */
const linkRenderer = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLinkDecorations(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildLinkDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** The rendered link whose text holds `target`, a `.dez-link` mark or an
 *  element in it. */
function renderedLinkAtElement(view: EditorView, target: EventTarget | null): MarkdownLink | null {
  const text = target instanceof Element ? target.closest('.dez-link') : null
  if (!text || !view.contentDOM.contains(text)) return null
  return renderedLinkAt(view.state, view.posAtDOM(text), 1)
}

/** A plain primary-button press on a rendered link opens its URL when the
 *  button goes up on the same link. The handler takes the press, so the
 *  caret does not go into the link (which would show its source under the
 *  pointer) and the focus stays where it is, as for a press on a pill. A
 *  press with a modifier key (Ctrl/Cmd adds a selection range, Shift
 *  extends the selection) or with another button is left to CodeMirror.
 *  The button can go up outside the editor, so the window watches the
 *  release. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false
    const pressed = renderedLinkAtElement(view, event.target)
    if (!pressed) return false
    const onMouseUp = (release: MouseEvent) => {
      if (release.button !== 0) return
      window.removeEventListener('mouseup', onMouseUp, true)
      const released = renderedLinkAtElement(view, release.target)
      if (released && released.from === pressed.from && released.url === pressed.url) {
        sbp('dez.controller/openUrl', pressed.url)
      }
    }
    window.addEventListener('mouseup', onMouseUp, true)
    return true
  },
})

/** Hovering a rendered link shows its full URL in a tooltip above it, not
 *  below, where the hand of the pointer cursor would cover its start. A
 *  link that shows its source shows its URL already, so it gets none, and
 *  the tooltip goes when its link stops being rendered (a selection
 *  touches it, or an edit changes it). */
const linkUrlTooltip = hoverTooltip(
  (view, pos, side) => {
    const link = renderedLinkAt(view.state, pos, side)
    if (!link) return null
    return {
      pos: link.textFrom,
      end: link.textTo,
      above: true,
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'dez-link-tooltip'
        dom.textContent = link.url
        return { dom }
      },
    }
  },
  { hideOn: (tr, tooltip) => renderedLinkAt(tr.state, tr.changes.mapPos(tooltip.pos), 1) === null },
)

/** Markdown links for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`): rendered, opened by a click, and their URL shown on
 *  hover. The CSS is in `dezTheme`. */
export function markdownLinks(): Extension {
  // High precedence: the link press must run before
  // `focusKeepingScrollOnMouseDown` (focus.ts), which focuses an editor
  // that does not have the focus.
  return [linkRenderer, Prec.high(linkClicks), linkUrlTooltip]
}
