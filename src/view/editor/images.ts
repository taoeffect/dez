import sbp from '@sbp/sbp'
import { StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { findImageReferences, type ImageReference } from '../../model/chat/images'
import { IMAGE_MAX_HEIGHT_PX } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
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

/** An image, with its id (null for an old reference with no id) in a
 *  badge that shows while the pointer is over the image. */
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
    const badge = this.id === null ? null : idBadge(this.id)
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
      // The box is one short line of text, so a badge over a corner would
      // hide a part of it: the badge goes after the text, in the box.
      if (badge) box.append(badge)
      wrapper.replaceChildren(box)
      measureLineHeights(view)
    })
    img.src = sbp('dez.controller/images/displayUrl', this.path) as string
    wrapper.appendChild(img)
    if (badge) {
      // A zero-size box right after the image, with its bottom on the
      // image's bottom (both on the line's bottom): the badge is positioned
      // from it, so it is over the image's bottom-right corner and changes
      // no size. The inline wrapper cannot hold it: the box of an inline
      // element is only as tall as its text, not as its image.
      const corner = document.createElement('span')
      corner.className = 'dez-image__corner'
      corner.appendChild(badge)
      wrapper.appendChild(corner)
    }
    return wrapper
  }
  // CM uses this for the lines that it has not drawn yet. The real box can
  // be smaller (a narrow editor, a smaller font size).
  get estimatedHeight(): number {
    const size = naturalSizes.get(this.path)
    return size ? Math.min(size.height, IMAGE_MAX_HEIGHT_PX) : -1
  }
  // CM takes the mouse events, so a click on an image puts the caret before
  // or after it.
  ignoreEvent(): boolean {
    return false
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

/** Images for the thread editor (`buildState()` in `ThreadEditor.vue`).
 *  The Backspace and Delete rules (`deleteImageParen`, `deleteImageBang`)
 *  are in its `sectionKeymap`, and find skips the hidden source
 *  (`protectedRanges` in `find.ts`). The CSS is in `dezTheme`. */
export function markdownImages(): Extension {
  return imageDecorationsField
}
