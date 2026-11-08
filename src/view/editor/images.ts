import sbp from '@sbp/sbp'
import { StateField, Transaction, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { findImageReferences, type ImageReference } from '../../model/chat/images'
import { IMAGE_MAX_HEIGHT_PX, SECTION_SEP } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { addPendingRange, pendingRange, pendingRanges, removePendingRange, type DocRange } from './pendingRanges'
import { findMarkdownTables } from './tables'

interface ImageDecorations {
  /** In doc order. */
  images: readonly ImageReference[]
  decorations: DecorationSet
}

interface ImageSize {
  width: number
  height: number
}

/** The natural size of each image that loaded, by path. A widget that CM
 *  draws again (tab switch, stream end, scroll back into view) sizes its box
 *  from here before its image loads, so the text below does not jump. */
const naturalSizes = new Map<string, ImageSize>()

/** Gives the box of `img` the size that the theme computes from its natural
 *  size (`.dez-image__img` in `dezTheme`). */
function setBoxSize(img: HTMLImageElement, size: ImageSize): void {
  img.style.setProperty('--dez-image-width', String(size.width))
  img.style.setProperty('--dez-image-height', String(size.height))
}

/** The badge with an image's id (`.dez-image__id` in `dezTheme`). */
function idBadge(id: string): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'dez-image__id'
  badge.textContent = id
  return badge
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The trash can of the History and Prompts lists. */
function trashIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M2.5 3.5h7m-5.5 0V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3.5m-3 0v6a.5.5 0 00.5.5h4a.5.5 0 00.5-.5v-6')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.1')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/** The button that deletes the image of `widget` (`deleteImage`). Its
 *  press keeps the focus and the caret where they are (as the Submit
 *  button's does), and `ImageWidget.ignoreEvent` keeps its events from
 *  CodeMirror. It is out of the Tab order, so Tab in the editor never lands
 *  on it while it is hidden. */
function trashButton(view: EditorView, widget: HTMLElement, path: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dez-image__trash'
  button.title = 'Delete image'
  button.setAttribute('aria-label', 'Delete image')
  button.tabIndex = -1
  button.appendChild(trashIcon())
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    void deleteImage(view, view.posAtDOM(widget), path)
  })
  return button
}

/** An image, with an overlay that shows while the pointer is over the
 *  image: its id (null for an old reference with no id) in a badge, and a
 *  trash button. A reference to a file that does not load shows an "Image
 *  not found" box with the same overlay, so that its text can go too. */
class ImageWidget extends WidgetType {
  constructor(readonly path: string, readonly id: string | null) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.path === this.path && other.id === this.id
  }
  toDOM(view: EditorView): HTMLElement {
    // The image is in an inline wrapper, so that the widget's root element
    // stays the same when an image that fails to load becomes a box, and so
    // that a `%` width of the image is a part of the line's width.
    const wrapper = document.createElement('span')
    wrapper.className = 'dez-image'
    const img = document.createElement('img')
    img.className = 'dez-image__img'
    img.alt = this.path.slice(this.path.lastIndexOf('/') + 1)
    img.draggable = false
    const overlay = document.createElement('span')
    overlay.className = 'dez-image__overlay'
    if (this.id !== null) overlay.appendChild(idBadge(this.id))
    overlay.appendChild(trashButton(view, wrapper, this.path))
    const cached = naturalSizes.get(this.path)
    if (cached) setBoxSize(img, cached)
    // A load or an error changes the line's height in place, which CM does
    // not see (see `measureLineHeights`).
    img.addEventListener('load', () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight }
      naturalSizes.set(this.path, size)
      setBoxSize(img, size)
      if (!cached || cached.width !== size.width || cached.height !== size.height) measureLineHeights(view)
    })
    img.addEventListener('error', () => {
      naturalSizes.delete(this.path)
      const box = document.createElement('span')
      box.className = 'dez-image-missing'
      box.textContent = `Image not found: ${img.alt}`
      // The box is one short line of text, so an overlay over a corner
      // would hide a part of it: the overlay goes after the text, in the
      // box.
      box.append(overlay)
      wrapper.replaceChildren(box)
      measureLineHeights(view)
    })
    img.src = sbp('dez.controller/images/displayUrl', this.path) as string
    // A zero-size box right after the image, with its bottom on the image's
    // bottom (both on the line's bottom): the overlay is positioned from it,
    // so it is over the image's bottom-right corner and changes no size.
    // The inline wrapper cannot hold it: the box of an inline element is
    // only as tall as its text, not as its image.
    const corner = document.createElement('span')
    corner.className = 'dez-image__corner'
    corner.appendChild(overlay)
    wrapper.append(img, corner)
    return wrapper
  }
  // CM uses this for the lines that it has not drawn yet. The real box can
  // be smaller (a narrow editor, a smaller font size).
  get estimatedHeight(): number {
    const size = naturalSizes.get(this.path)
    return size ? Math.min(size.height, IMAGE_MAX_HEIGHT_PX) : -1
  }
  // CM takes the mouse events, so a click on an image puts the caret before
  // or after it. The trash button takes its own (`trashButton`).
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest('.dez-image__trash') !== null
  }
}

/** The image references that the editor shows as images, in doc order. Not
 *  shown, so left as source text:
 *  - a reference on a line with a sentinel (a section separator or a pill
 *    marker), whose widgets and atomic ranges must stay the only ones there;
 *  - a reference on a table row line (`findMarkdownTables`): a widget there
 *    becomes an extra table cell (see `tableDecorationsField` in
 *    `tables.ts`). */
function findRenderedImages(doc: Text): ImageReference[] {
  const images: ImageReference[] = []
  // Only a doc with an image reference needs the table scan.
  let tableRowStarts: Set<number> | null = null
  let lineFrom = 0
  for (const text of doc.iterLines()) {
    const from = lineFrom
    lineFrom += text.length + 1
    if (!text.includes('![') || SENTINEL_CHAR.test(text)) continue
    const references = findImageReferences(text)
    if (references.length === 0) continue
    tableRowStarts ??= new Set(findMarkdownTables(doc).flatMap((table) => table.rows.map((row) => row.from)))
    if (tableRowStarts.has(from)) continue
    for (const reference of references) images.push({ ...reference, from: from + reference.from, to: from + reference.to })
  }
  return images
}

function buildImageDecorations(doc: Text): ImageDecorations {
  const images = findRenderedImages(doc)
  const decorations = Decoration.set(images.map((image) => Decoration.replace({ widget: new ImageWidget(image.path, image.id) }).range(image.from, image.to)))
  return { images, decorations }
}

/** Each image reference (`src/model/chat/images.ts`) is replaced by its
 *  image. Like the tables, the decorations come only from the doc text,
 *  never from the cursor: an edit that breaks a reference shows its source,
 *  and the image comes back as soon as the source is valid again (a typed
 *  `)`, an undo). The ranges are atomic, so the caret is never inside the
 *  hidden source. */
const imageDecorationsField = StateField.define<ImageDecorations>({
  create: (state) => buildImageDecorations(state.doc),
  update: (value, tr) => tr.docChanged ? buildImageDecorations(tr.state.doc) : value,
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

const NO_IMAGES: readonly ImageReference[] = []

/** The images that the editor shows in `state`, in doc order; none for a
 *  state without `markdownImages()`. The array is the same object until the
 *  doc changes, so callers can cache by it. */
export function renderedImages(state: EditorState): readonly ImageReference[] {
  return state.field(imageDecorationsField, false)?.images ?? NO_IMAGES
}

/** Backspace with one caret right after an image deletes only the image's
 *  `)`, so the source shows with the caret in place of the `)`:
 *  `![path](id=a|`.
 *  Typing `)` shows the image again. Without this rule, CM's Backspace
 *  deletes the whole atomic range. With many carets,
 *  `strictMultiCursorBackspace` (`cmEditor.ts`) also deletes one char at
 *  each caret, so each image before a caret shows its source too. */
export function deleteImageParen(view: EditorView): boolean {
  const { selection } = view.state
  if (selection.ranges.length !== 1 || !selection.main.empty) return false
  const caret = selection.main.head
  const image = renderedImages(view.state).find((image) => image.to === caret)
  if (!image) return false
  view.dispatch({
    changes: { from: caret - 1, to: caret },
    selection: { anchor: caret - 1 },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  })
  return true
}

/** Delete with one caret right before an image deletes only the image's
 *  `!`, so the source shows as `[path](id=a)` and typing `!` shows the image
 *  again: one key deletes one source char on both sides of an image. */
export function deleteImageBang(view: EditorView): boolean {
  const { selection } = view.state
  if (selection.ranges.length !== 1 || !selection.main.empty) return false
  const caret = selection.main.head
  const image = renderedImages(view.state).find((image) => image.from === caret)
  if (!image) return false
  view.dispatch({
    changes: { from: caret, to: caret + 1 },
    selection: { anchor: caret },
    scrollIntoView: true,
    userEvent: 'delete.forward',
  })
  return true
}

/** The doc range to delete to take the image reference at `range` out of
 *  `doc`. When the reference is the only text on its line (white space
 *  aside), the line goes too, with one of its line breaks, so no empty line
 *  stays. A line that is the only one of its section keeps its place as an
 *  empty line: its line breaks frame the section separators
 *  (`sectionsToDoc` in cmEditor.ts). */
export function imageRemovalRange(doc: Text, { from, to }: DocRange): DocRange {
  const line = doc.lineAt(from)
  const rest = line.text.slice(0, from - line.from) + line.text.slice(to - line.from)
  if (rest.trim() !== '') return { from, to }
  const isSectionText = (number: number): boolean => number >= 1 && number <= doc.lines && !doc.line(number).text.includes(SECTION_SEP)
  if (isSectionText(line.number + 1)) return { from: line.from, to: line.to + 1 }
  if (isSectionText(line.number - 1)) return { from: line.from - 1, to: line.to }
  return { from: line.from, to: line.to }
}

/** The image trash (`trashButton`): asks whether to delete the image whose
 *  reference starts at `from`, and on "Yes" deletes its file
 *  (`dez.controller/images/delete`), then takes the reference out of the
 *  doc (`imageRemovalRange`). The doc can change while the prompt is open
 *  or the file is being deleted (a stream, a tab switch), so the reference
 *  is followed (`addPendingRange`): when it is gone (its text changed,
 *  another state, another tab), no file is deleted. A failed file delete
 *  (the controller has shown a toast) keeps the reference. If the reference
 *  goes while its file is being deleted, its text stays and shows "Image
 *  not found". The removal is not in the undo history: the file is gone,
 *  so an undo could only bring back a broken reference. Other references
 *  to the same file are left as they are. */
export async function deleteImage(view: EditorView, from: number, path: string): Promise<void> {
  const image = renderedImages(view.state).find((image) => image.from === from && image.path === path)
  if (!image) return
  const tabId = sbp('dez.model/tabs/activeId') as string
  const id = addPendingRange(view, image)
  const currentRange = (): DocRange | null => {
    const range = pendingRange(view.state, id)
    if (!range || sbp('dez.model/tabs/activeId') !== tabId) return null
    const same = renderedImages(view.state).some((image) => image.from === range.from && image.to === range.to && image.path === path)
    return same ? range : null
  }
  let range: DocRange | null = null
  const confirmed = await sbp('dez.ui/confirm', { message: 'Are you sure you want to delete this image?' }) as boolean
  if (confirmed && currentRange()) {
    try {
      await sbp('dez.controller/images/delete', path)
      range = currentRange()
    } catch {
      // The controller has logged the failure and shown a toast.
    }
  }
  // In another state the range is gone already.
  if (!pendingRange(view.state, id)) return
  view.dispatch({
    ...(range && {
      changes: imageRemovalRange(view.state.doc, range),
      annotations: Transaction.addToHistory.of(false),
    }),
    effects: removePendingRange(id),
  })
}

/** Images for the thread editor (`buildState()` in `ThreadEditor.vue`).
 *  The Backspace and Delete rules (`deleteImageParen`, `deleteImageBang`)
 *  are in its `sectionKeymap`, and find skips the hidden source
 *  (`protectedRanges` in `find.ts`). The CSS is in `dezTheme`. */
export function markdownImages(): Extension {
  return [imageDecorationsField, pendingRanges()]
}
