import sbp from '@sbp/sbp'
import { StateEffect, StateField, Transaction, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type PluginValue, type Rect, type Tooltip } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { findImageReferences, type ImageReference } from '../../model/chat/images'
import { IMAGE_MAX_HEIGHT_PX, SECTION_SEP } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { syncDomSelection } from './focus'
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

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An inline SVG icon in `currentColor`, from the tag and attributes of
 *  each of its shapes. */
function svgIcon(viewBox: string, shapes: ReadonlyArray<readonly [string, Record<string, string>]>): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value)
    svg.appendChild(shape)
  }
  return svg
}

const ROUND_STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }

/** A picture frame with a sun and hills, so that the id badge reads as the
 *  label of the image. */
function imageIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['rect', { x: '2', y: '3', width: '12', height: '10', rx: '2', ...ROUND_STROKE, 'stroke-width': '1.3' }],
    ['circle', { cx: '6', cy: '6.5', r: '1.2', fill: 'currentColor' }],
    ['path', { d: 'M2.6 11.6l3.4-3.3 2.4 2.3 1.9-1.8 3.1 3', ...ROUND_STROKE, 'stroke-width': '1.3' }],
  ])
}

/** The badge with an image's id (`.dez-image__id` in `dezTheme`). Its text
 *  is only the id. */
function idBadge(id: string): HTMLElement {
  const badge = document.createElement('span')
  badge.className = 'dez-image__id'
  badge.setAttribute('role', 'img')
  badge.setAttribute('aria-label', `Image id: ${id}`)
  badge.append(imageIcon(), id)
  return badge
}

/** The trash can of the History and Prompts lists. */
function trashIcon(): SVGSVGElement {
  return svgIcon('0 0 12 12', [
    ['path', { d: 'M2.5 3.5h7m-5.5 0V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3.5m-3 0v6a.5.5 0 00.5.5h4a.5.5 0 00.5-.5v-6', ...ROUND_STROKE, 'stroke-width': '1.1' }],
  ])
}

/** The button that deletes the image of `widget` (`deleteImage`). Its
 *  press keeps the focus and the caret where they are (as the Submit
 *  button's does), and `ImageWidget.ignoreEvent` keeps its events from
 *  CodeMirror. It is out of the Tab order, so Tab in the editor never lands
 *  on it while it is hidden. It has no native `title`: its tooltip is
 *  Dez's own (`trashTooltip`). */
function trashButton(view: EditorView, widget: HTMLElement, path: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dez-image__trash'
  button.setAttribute('aria-label', 'Delete image')
  button.tabIndex = -1
  button.appendChild(trashIcon())
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    // The click opens the prompt, which the tooltip must not outlive.
    view.plugin(imageTooltipHover)?.hide()
  })
  button.addEventListener('click', () => {
    void deleteImage(view, view.posAtDOM(widget), path)
  })
  return button
}

/** The content of an overlay item's tooltip (`.dez-image-tooltip` in
 *  `dezTheme`): what the item is, then what it is for. */
function tooltipContent(title: string, ...text: Array<string | Node>): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'dez-image-tooltip'
  dom.setAttribute('role', 'tooltip')
  const titleLine = document.createElement('div')
  titleLine.className = 'dez-image-tooltip__title'
  titleLine.textContent = title
  const textLine = document.createElement('div')
  textLine.className = 'dez-image-tooltip__text'
  textLine.append(...text)
  dom.append(titleLine, textLine)
  return dom
}

/** The id badge's tooltip. The id only names the image for now (models do
 *  not get ids), so the text promises nothing more. */
function idTooltip(id: string): HTMLElement {
  const source = document.createElement('code')
  source.textContent = `id=${id}`
  return tooltipContent(`Image id: ${id}`, 'The short name of this image in this conversation. It is saved in the image\u2019s markdown as ', source, '.')
}

/** The trash's tooltip. The "Image not found" box has no file to delete
 *  (`dez.controller/images/delete` deletes none), so its text says that
 *  only the image's text goes. */
function trashTooltip(missing: boolean): HTMLElement {
  return tooltipContent(
    'Delete image',
    missing
      ? 'The image file is not found, so this removes only the image from the conversation. Dez asks you first. You cannot undo this.'
      : 'Removes the image from the conversation and deletes its file from the Dez folder. Dez asks you first. You cannot undo this.',
  )
}

/** Shows the tooltip `content` while the pointer rests on `item`, an
 *  overlay item of the image widget `widget` (`imageTooltipHover`). */
function addTooltip(view: EditorView, widget: HTMLElement, item: HTMLElement, content: () => HTMLElement): void {
  item.addEventListener('mouseenter', () => view.plugin(imageTooltipHover)?.enter(widget, item, content))
  item.addEventListener('mouseleave', () => view.plugin(imageTooltipHover)?.leave())
}

/** An image, with an overlay that shows while the pointer is over the
 *  image: a small toolbar in its top-right corner with its id (null for an
 *  old reference with no id) in a badge, and a trash button, each with a
 *  tooltip. A reference to a file that does not load shows an "Image not
 *  found" box with the same overlay after its text, so that its text can go
 *  too. */
class ImageWidget extends WidgetType {
  constructor(readonly path: string, readonly id: string | null) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.path === this.path && other.id === this.id
  }
  toDOM(view: EditorView): HTMLElement {
    // The image is in a wrapper, so that the widget's root element stays the
    // same when an image that fails to load becomes a box. The wrapper is as
    // big as the image (`.dez-image` in `dezTheme`), so the overlay can be
    // placed over the image.
    const wrapper = document.createElement('span')
    wrapper.className = 'dez-image'
    const img = document.createElement('img')
    img.className = 'dez-image__img'
    img.alt = this.path.slice(this.path.lastIndexOf('/') + 1)
    img.draggable = false
    const overlay = document.createElement('span')
    overlay.className = 'dez-image__overlay'
    const { id } = this
    if (id !== null) {
      const badge = idBadge(id)
      addTooltip(view, wrapper, badge, () => idTooltip(id))
      overlay.appendChild(badge)
    }
    const trash = trashButton(view, wrapper, this.path)
    addTooltip(view, wrapper, trash, () => trashTooltip(trash.closest('.dez-image-missing') !== null))
    overlay.appendChild(trash)
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
      // The box is one short line of text, so an overlay over its corner
      // would hide a part of it: the overlay goes after the text, in the
      // box.
      box.append(overlay)
      wrapper.replaceChildren(box)
      measureLineHeights(view)
    })
    img.src = sbp('dez.controller/images/displayUrl', this.path) as string
    // The row along the image's top edge in which the overlay sits, at the
    // right end (`.dez-image__overlay-row` in `dezTheme`).
    const row = document.createElement('span')
    row.className = 'dez-image__overlay-row'
    row.appendChild(overlay)
    wrapper.append(img, row)
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
  // The prompt gave the focus back a few ms ago (`syncDomSelection`).
  if (range) syncDomSelection(view)
}

/** The tooltip of an overlay item (the id badge or the trash) of the image
 *  whose reference starts at `from`. */
export interface ImageTooltip {
  from: number
  /** The image's path and id, so that the tooltip goes when they change. */
  path: string
  id: string | null
  tooltip: Tooltip
}

/** Shows an overlay item's tooltip (its `from` is in the doc before the
 *  transaction's changes), or hides it (null). */
export const setImageTooltip = StateEffect.define<ImageTooltip | null>()

/** The overlay item tooltip, if one shows. CM's `hoverTooltip` (the link
 *  tooltip) finds a tooltip from a doc position only, and both items are in
 *  one widget at one position, so the items show and hide theirs
 *  (`imageTooltipHover`). It never outlives its image: it follows the image
 *  through edits around it (a stream in another section), and goes when the
 *  image's reference changes or goes, as its widget is drawn again then, and
 *  with the state (a tab switch, `setState`). While it follows, its view
 *  and DOM stay (CM keeps a tooltip view while its `create` is the same). */
const imageTooltipField = StateField.define<ImageTooltip | null>({
  create: () => null,
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) if (effect.is(setImageTooltip)) next = effect.value
    if (!next || (next === value && !tr.docChanged)) return next
    const from = tr.changes.mapPos(next.from, 1)
    if (from !== next.from) next = { ...next, from, tooltip: { ...next.tooltip, pos: from } }
    const { path, id } = next
    return renderedImages(tr.state).some((image) => image.from === from && image.path === path && image.id === id) ? next : null
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null),
})

/** The overlay item tooltip that shows in `state`, if any. */
export function imageTooltip(state: EditorState): ImageTooltip | null {
  return state.field(imageTooltipField, false) ?? null
}

/** How long the pointer rests on an overlay item before its tooltip shows:
 *  the hover time of CM's `hoverTooltip`, as for the link URL tooltip. */
const IMAGE_TOOLTIP_DELAY_MS = 300

/** The wait before an overlay item's tooltip shows when the pointer comes
 *  onto the item at `now`. There is none for a short time after the
 *  pointer left an item whose tooltip showed (`lastHiddenAt`), so that a
 *  move from the id badge to the trash shows the next tooltip at once. */
export function imageTooltipDelay(now: number, lastHiddenAt: number): number {
  return now - lastHiddenAt < IMAGE_TOOLTIP_DELAY_MS ? 0 : IMAGE_TOOLTIP_DELAY_MS
}

/** The gap between a tooltip and the toolbar of its item. */
const IMAGE_TOOLTIP_GAP_PX = 6

/** A rect outside of every editor: CM hides a tooltip anchored there
 *  (`Tooltip.clip`). */
const OFF_SCREEN: Rect = { left: -1e5, right: -1e5, top: -1e5, bottom: -1e5 }

/** The rect that CM places the tooltip `dom` of `item` against (above, or
 *  below when there is no room above): the toolbar's top and bottom, so
 *  that the tooltip never covers the item, and the tooltip's width
 *  centered on the item. CM keeps it inside the window. An item that is no
 *  longer in the editor (its widget was drawn again, or scrolled out of
 *  the viewport) hides the tooltip. */
function tooltipAnchor(item: HTMLElement, dom: HTMLElement): Rect {
  if (!item.isConnected) return OFF_SCREEN
  const { left, right } = item.getBoundingClientRect()
  const { top, bottom } = (item.closest('.dez-image__overlay') ?? item).getBoundingClientRect()
  const halfWidth = dom.getBoundingClientRect().width / 2
  const center = (left + right) / 2
  return { left: center - halfWidth, right: center + halfWidth, top, bottom }
}

/** Shows and hides the overlay item tooltips (`imageTooltipField`) as the
 *  pointer comes onto an item and leaves it (`addTooltip`), and hides them
 *  when the trash is pressed (`trashButton`). */
class ImageTooltipHover implements PluginValue {
  // `number`, the browser's timer id type (see `closeTimer` in
  // ToastCard.vue).
  private timer: number | null = null
  private lastHiddenAt = -Infinity

  constructor(private readonly view: EditorView) {}

  enter(widget: HTMLElement, item: HTMLElement, content: () => HTMLElement): void {
    this.cancel()
    const show = (): void => {
      this.timer = null
      if (!this.view.contentDOM.contains(widget)) return
      const from = this.view.posAtDOM(widget)
      const image = renderedImages(this.view.state).find((image) => image.from === from)
      if (!image) return
      // A new `create` each time, so CM makes a new tooltip view.
      const tooltip: Tooltip = {
        pos: from,
        above: true,
        create: () => {
          const dom = content()
          return { dom, offset: { x: 0, y: IMAGE_TOOLTIP_GAP_PX }, getCoords: () => tooltipAnchor(item, dom) }
        },
      }
      this.view.dispatch({ effects: setImageTooltip.of({ from, path: image.path, id: image.id, tooltip }) })
    }
    const delay = imageTooltipDelay(Date.now(), this.lastHiddenAt)
    if (delay === 0) show()
    else this.timer = window.setTimeout(show, delay)
  }

  leave(): void {
    if (imageTooltip(this.view.state)) this.lastHiddenAt = Date.now()
    this.hide()
  }

  hide(): void {
    this.cancel()
    if (imageTooltip(this.view.state)) this.view.dispatch({ effects: setImageTooltip.of(null) })
  }

  destroy(): void {
    this.cancel()
  }

  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }
}

const imageTooltipHover = ViewPlugin.fromClass(ImageTooltipHover)

/** Images for the thread editor (`buildState()` in `ThreadEditor.vue`).
 *  The Backspace and Delete rules (`deleteImageParen`, `deleteImageBang`)
 *  are in its `sectionKeymap`, and find skips the hidden source
 *  (`protectedRanges` in `find.ts`). The CSS is in `dezTheme`. */
export function markdownImages(): Extension {
  return [imageDecorationsField, pendingRanges(), imageTooltipField, imageTooltipHover]
}
