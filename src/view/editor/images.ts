import sbp from '@sbp/sbp'
import { StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type PluginValue, type Rect, type Tooltip } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { findImageReferences, imageExtension, imageMediaType, type ImageReference } from '../../model/chat/images'
import { fileNameOf } from '../../utils/fileName'
import { isMacPlatform } from '../../utils/platform'
import { assetFactsText } from '../assetFacts'
import { IMAGE_MAX_HEIGHT_PX, SECTION_SEP, editorSizePx, sectionsField } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { selectedAssetLook } from './assetSelection'
import { syncDomSelection } from './focus'
import { HiddenAssetWidget, hiddenAssetLines, hiddenAssets, type AssetPlace } from './hiddenAssets'
import { sectionRolesChanged } from './lineBlocks'
import { followShownRange, pendingRanges, type DocRange } from './pendingRanges'
import { ROUND_STROKE, svgIcon } from './svgIcon'
import { tableRowStarts } from './tables'

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

/** The size in bytes of each image file whose size was read, by path, for
 *  the facts of the overlay. A stored image's path names one file for good
 *  (each new image gets a new file name, and no file is written again), so
 *  a widget that CM draws again needs no second read. A linked file can
 *  change in place, so its size is read at each load. */
const fileSizes = new Map<string, number>()

/** Gives the box of `img` the size that the theme computes from its natural
 *  size (`.dez-image__img` in `dezTheme`). */
function setBoxSize(img: HTMLImageElement, size: ImageSize): void {
  img.style.setProperty('--dez-image-width', String(size.width))
  img.style.setProperty('--dez-image-height', String(size.height))
}

/** A picture frame with a sun and hills, so that the id badge reads as the
 *  label of the image. The chip of a call that hides an image shows it too
 *  (toolCalls.ts). */
export function imageIcon(): SVGSVGElement {
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

/** The facts of the image at `path` in its overlay (`assetFactsText`): its
 *  pixels and its file size once they are known, and its format from its
 *  extension. */
function imageFactsText(path: string): string {
  const type = imageMediaType(path)
  return assetFactsText({
    pixels: naturalSizes.get(path) ?? null,
    extension: type && imageExtension(type),
    bytes: fileSizes.get(path) ?? null,
  })
}

/** Reads the size of the image file at `path` (`fileSizes`), and then shows
 *  it in the overlay facts `facts`. */
async function showFileSize(path: string, facts: HTMLElement): Promise<void> {
  let size: number | null = null
  try {
    size = await sbp('dez.controller/images/fileSize', path) as number | null
  } catch {
    // The error can name the path of the file, which stays out of the log.
    console.error('[images] The size of an image file could not be read')
  }
  if (size === null) return
  fileSizes.set(path, size)
  facts.textContent = imageFactsText(path)
}

/** The trash can of the History and Prompts lists. */
function trashIcon(): SVGSVGElement {
  return svgIcon('0 0 12 12', [
    ['path', { d: 'M2.5 3.5h7m-5.5 0V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5V3.5m-3 0v6a.5.5 0 00.5.5h4a.5.5 0 00.5-.5v-6', ...ROUND_STROKE, 'stroke-width': '1.1' }],
  ])
}

/** The button that deletes the image whose reference is at `place`
 *  (`deleteImage`). Its press keeps the focus and the caret where they are
 *  (as the Submit button's does), and `ImageWidget.ignoreEvent` keeps its
 *  events from CodeMirror. It is out of the Tab order, so Tab in the editor
 *  never lands on it while it is hidden. It has no native `title`: its
 *  tooltip is Dez's own (`trashTooltip`). */
function trashButton(view: EditorView, place: AssetPlace, path: string, linked: boolean): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dez-image__trash'
  button.setAttribute('aria-label', linked ? 'Remove image' : 'Delete image')
  button.tabIndex = -1
  button.appendChild(trashIcon())
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    // The click opens the prompt, which the tooltip must not outlive.
    view.plugin(imageTooltipHover)?.hide()
  })
  button.addEventListener('click', () => {
    const from = place()
    if (from !== null) void deleteImage(view, from, path)
  })
  return button
}

/** The content of a tooltip with a title (`.dez-image-tooltip` in
 *  `dezTheme`): what the item is, then what it is for. The items of an
 *  image overlay and the mention chips (mentions.ts) use it. */
export function tooltipContent(title: string, ...text: Array<string | Node>): HTMLElement {
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

/** The id badge's tooltip. Models get the id in the image's text
 *  (`withoutStoredFilePaths`), so a message can name the image by it. */
function idTooltip(id: string): HTMLElement {
  const source = document.createElement('code')
  source.textContent = `image @${id}`
  return tooltipContent(`Image id: ${id}`, 'Refer to this image in a message as ', source, '.')
}

/** The trash's tooltip. The "Image not found" box has no file to delete
 *  (`dez.controller/images/delete` deletes none), and Dez never deletes a
 *  linked file (linkedFiles.ts), so their texts say that only the image's
 *  text goes. */
function trashTooltip(missing: boolean, linked: boolean): HTMLElement {
  if (linked) {
    return tooltipContent(
      'Remove image',
      'Removes the image from the conversation. Its file stays where it is. Dez asks you first.',
    )
  }
  return tooltipContent(
    'Delete image',
    missing
      ? 'The image file is not found, so this removes only the image from the conversation. Dez asks you first. You cannot undo this.'
      : 'Removes the image from the conversation and deletes its file from the Dez folder. Dez asks you first. You cannot undo this.',
  )
}

/** Shows the tooltip `content` while the pointer rests on `item`, an
 *  overlay item of the image whose reference is at `place`
 *  (`imageTooltipHover`). */
function addTooltip(view: EditorView, place: AssetPlace, item: HTMLElement, content: () => HTMLElement): void {
  item.addEventListener('mouseenter', () => view.plugin(imageTooltipHover)?.enter(place, item, content))
  item.addEventListener('mouseleave', () => view.plugin(imageTooltipHover)?.leave())
}

/** Gives the image widget `wrapper` the asset menu: a context click on the
 *  image (or on its "Image not found" box) pops up the native menu with
 *  "Reveal in File Manager" (`dez.controller/menu/popupAsset`), in place of
 *  the webview's own menu. The item is disabled while the box shows, as
 *  the file is not there. The click leaves the caret, the selection, and
 *  the focus where they are. */
function addAssetMenu(view: EditorView, wrapper: HTMLElement, path: string): void {
  // A context press (the right button, or on macOS the main button with
  // Ctrl) is canceled: CodeMirror skips a canceled press, so the caret does
  // not move, and the focus does not change. The overlay's tooltip closes,
  // as the menu shows over it.
  wrapper.addEventListener('mousedown', (event) => {
    if (event.button !== 2 && !(isMacPlatform && event.button === 0 && event.ctrlKey)) return
    event.preventDefault()
    view.plugin(imageTooltipHover)?.hide()
  })
  // On macOS a context click selects the word next to the pointer before
  // its `contextmenu` event, also after a canceled press, when the editor
  // has the focus or the target is text (`sendContextMenuEvent` in WebKit's
  // EventHandler.cpp). That selection starts with `selectstart`, and is
  // canceled with it. No other selection starts in the image: CodeMirror
  // takes the presses of the main button itself.
  wrapper.addEventListener('selectstart', (event) => event.preventDefault())
  wrapper.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const missing = wrapper.querySelector('.dez-image-missing') !== null
    void sbp('dez.controller/menu/popupAsset', missing ? null : path)
  })
}

/** Draws an image, with an overlay that shows while the pointer is over
 *  the image: a small toolbar in its top-right corner with its id (null for
 *  an old reference with no id) in a badge, the facts of the image, and a
 *  trash button; the badge and the trash have a tooltip. A reference to a
 *  file that does not load shows an "Image not found" box with the same
 *  overlay after its text, with no facts, so that its text can go too.
 *  `linked`: the file is a linked file (linkedFiles.ts), which the trash
 *  does not delete.
 *
 *  `place` tells where the image's reference is in the doc now, for the
 *  trash and the tooltips. With none, the image is drawn in place of its
 *  reference, and its DOM tells (`ImageWidget`). A hidden image is drawn in
 *  the panel of its chip (toolCalls.ts), whose DOM is at the chip's place,
 *  so the chip gives the place. */
export function createImage(view: EditorView, { path, id, linked }: Pick<ImageReference, 'path' | 'id' | 'linked'>, place?: AssetPlace): HTMLElement {
  // The image is in a wrapper, so that the root element stays the same
  // when an image that fails to load becomes a box. The wrapper is as big
  // as the image (`.dez-image` in `dezTheme`), so the overlay can be placed
  // over the image.
  const wrapper = document.createElement('span')
  wrapper.className = 'dez-image'
  const placeNow = place ?? (() => view.contentDOM.contains(wrapper) ? view.posAtDOM(wrapper) : null)
  const img = document.createElement('img')
  img.className = 'dez-image__img'
  img.alt = fileNameOf(path)
  img.draggable = false
  const overlay = document.createElement('span')
  overlay.className = 'dez-image__overlay'
  if (id !== null) {
    const badge = idBadge(id)
    addTooltip(view, placeNow, badge, () => idTooltip(id))
    overlay.appendChild(badge)
  }
  // The pixels and the file size come in after the load.
  const facts = document.createElement('span')
  facts.className = 'dez-image__facts'
  facts.textContent = imageFactsText(path)
  overlay.appendChild(facts)
  const trash = trashButton(view, placeNow, path, linked)
  addTooltip(view, placeNow, trash, () => trashTooltip(trash.closest('.dez-image-missing') !== null, linked))
  overlay.appendChild(trash)
  const cached = naturalSizes.get(path)
  if (cached) setBoxSize(img, cached)
  // A load or an error changes the line's height in place, which CM does
  // not see (see `measureLineHeights`).
  img.addEventListener('load', () => {
    const size = { width: img.naturalWidth, height: img.naturalHeight }
    naturalSizes.set(path, size)
    setBoxSize(img, size)
    facts.textContent = imageFactsText(path)
    if (linked || !fileSizes.has(path)) void showFileSize(path, facts)
    if (!cached || cached.width !== size.width || cached.height !== size.height) measureLineHeights(view)
  })
  img.addEventListener('error', () => {
    naturalSizes.delete(path)
    facts.remove()
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
  img.src = sbp('dez.controller/images/displayUrl', path) as string
  // The row along the image's top edge in which the overlay sits, at the
  // right end (`.dez-image__overlay-row` in `dezTheme`).
  const row = document.createElement('span')
  row.className = 'dez-image__overlay-row'
  row.appendChild(overlay)
  wrapper.append(img, row)
  addAssetMenu(view, wrapper, path)
  return wrapper
}

/** An image in place of its reference (`createImage`). */
class ImageWidget extends WidgetType {
  constructor(readonly path: string, readonly id: string | null, readonly linked: boolean) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.path === this.path && other.id === this.id && other.linked === this.linked
  }
  toDOM(view: EditorView): HTMLElement {
    return createImage(view, this)
  }
  // CM uses this for the lines that it has not drawn yet: the image's box at
  // the editor font size of now, as `dezTheme` scales its max height. The
  // real box can be smaller (an editor narrower than the image).
  get estimatedHeight(): number {
    const size = naturalSizes.get(this.path)
    return size ? Math.min(size.height, editorSizePx(IMAGE_MAX_HEIGHT_PX)) : -1
  }
  // CM takes the mouse events, so a click on an image puts the caret before
  // or after it. The trash button takes its own (`trashButton`).
  ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest('.dez-image__trash') !== null
  }
}

/** The image references that the editor shows as images, in doc order, each
 *  read with the role of its section (`findImageReferences`): a linked
 *  reference shows only in a user section. With no `sectionsField`, every
 *  line has the agent rule (stored paths only). Not shown, so left as
 *  source text:
 *  - a reference on a line with a sentinel (a section separator or a pill
 *    marker), whose widgets and atomic ranges must stay the only ones there;
 *  - a reference on a table row line (`tableRowStarts`): a widget there
 *    becomes an extra table cell (see `tableDecorationsField` in
 *    `tables.ts`). */
function findRenderedImages(state: EditorState): ImageReference[] {
  const { doc } = state
  const sections = state.field(sectionsField, false)
  const images: ImageReference[] = []
  let lineFrom = 0
  // The section of a line is the count of the separators before it
  // (`sectionTexts` in lineBlocks.ts).
  let section = 0
  for (const text of doc.iterLines()) {
    const from = lineFrom
    lineFrom += text.length + 1
    const lineSection = section
    if (text.includes(SECTION_SEP)) section += text.split(SECTION_SEP).length - 1
    if (!text.includes('![') || SENTINEL_CHAR.test(text)) continue
    const references = findImageReferences(text, sections?.[lineSection]?.role ?? 'agent')
    if (references.length === 0) continue
    if (tableRowStarts(doc).has(from)) continue
    for (const reference of references) images.push({ ...reference, from: from + reference.from, to: from + reference.to })
  }
  return images
}

function buildImageDecorations(state: EditorState): ImageDecorations {
  const images = findRenderedImages(state)
  // A hidden image shows in the panel of its chip (hiddenAssets.ts). It
  // stays an image here, so that its source keeps every rule of an image's
  // source; only its widget is the one of a hidden asset.
  const hidden = new Set(hiddenAssets(state).map((asset) => asset.from))
  const decorations = Decoration.set(images.map((image) => Decoration.replace({
    widget: hidden.has(image.from) ? new HiddenAssetWidget('image', image.id) : new ImageWidget(image.path, image.id, image.linked),
  }).range(image.from, image.to)))
  return { images, decorations }
}

/** Each image reference (`src/model/chat/images.ts`) is replaced by its
 *  image. Like the tables, the decorations come only from the doc text,
 *  never from the cursor: an edit that breaks a reference shows its source,
 *  and the image comes back as soon as the source is valid again (a typed
 *  `)`, an undo). The ranges are atomic, so the caret is never inside the
 *  hidden source. */
const imageDecorationsField = StateField.define<ImageDecorations>({
  create: buildImageDecorations,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? buildImageDecorations(tr.state) : value,
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

/** The range to delete to take the whole lines `from`..`to` out of `doc`,
 *  with one of their line breaks, so no empty line stays. Lines that are the
 *  only text of their section keep their place as an empty line: their line
 *  breaks frame the section separators (`sectionsToDoc` in cmEditor.ts). */
export function linesRemovalRange(doc: Text, { from, to }: DocRange): DocRange {
  const isSectionText = (number: number): boolean => number >= 1 && number <= doc.lines && !doc.line(number).text.includes(SECTION_SEP)
  if (isSectionText(doc.lineAt(to).number + 1)) return { from, to: to + 1 }
  if (isSectionText(doc.lineAt(from).number - 1)) return { from: from - 1, to }
  return { from, to }
}

/** The doc range to delete to take the image reference at `range` out of
 *  `doc`. When the reference is the only text on its line (white space
 *  aside), the whole line goes (`linesRemovalRange`). */
export function imageRemovalRange(doc: Text, { from, to }: DocRange): DocRange {
  const line = doc.lineAt(from)
  const rest = line.text.slice(0, from - line.from) + line.text.slice(to - line.from)
  if (rest.trim() !== '') return { from, to }
  return linesRemovalRange(doc, line)
}

/** The image trash (`trashButton`): asks whether to delete the image whose
 *  reference starts at `from`, and on "Yes" deletes its file
 *  (`dez.controller/images/delete`), then takes the reference out of the
 *  doc (`imageRemovalRange`; a hidden image goes with the lines that it
 *  takes out of view, `hiddenAssetLines`). A linked image (linkedFiles.ts)
 *  keeps its file: its prompt says so, and only its reference goes. The
 *  doc can change while the prompt is open or the file is being deleted (a
 *  stream), so the reference is followed (`followShownRange`). A new state
 *  of the same tab (the rebuild at the end of a stream) has no pending
 *  ranges: there the reference is found again by its path and id, when
 *  exactly one shown image has them. When the reference is gone (its text
 *  changed, another tab, no single match), no file is deleted, and a toast
 *  tells the user. A failed file delete (the controller has shown a toast)
 *  keeps the reference. If the reference goes while its file is being
 *  deleted, its text stays and shows "Image not found". The removal of a
 *  stored image is not in the undo history: the file is gone, so an undo
 *  could only bring back a broken reference. A linked image's file stays,
 *  so its removal is a normal edit that an undo takes back. Other
 *  references to the same file are left as they are. */
export async function deleteImage(view: EditorView, from: number, path: string): Promise<void> {
  const image = renderedImages(view.state).find((image) => image.from === from && image.path === path)
  if (!image) return
  const followed = followShownRange(view, image, renderedImages, (other) => other.path === path && other.id === image.id)
  let range: DocRange | null = null
  const message = image.linked
    ? 'Are you sure you want to remove this image from the conversation? Its file stays where it is.'
    : 'Are you sure you want to delete this image?'
  const confirmed = await sbp('dez.ui/confirm', { message }) as boolean
  if (confirmed && !followed.current()) {
    sbp('dez.ui/toast', 'app-global', {
      title: image.linked ? 'Image not removed' : 'Image not deleted',
      message: 'The conversation changed while the prompt was open. Try again.',
      variant: 'warning',
      duration: 8000,
    })
  } else if (confirmed && image.linked) {
    range = followed.current()
  } else if (confirmed) {
    try {
      await sbp('dez.controller/images/delete', path)
      range = followed.current()
    } catch {
      // The controller has logged the failure and shown a toast.
    }
  }
  let removal: DocRange | undefined
  if (range) {
    const hiddenLines = hiddenAssetLines(view.state, range.from)
    removal = hiddenLines ? linesRemovalRange(view.state.doc, hiddenLines) : imageRemovalRange(view.state.doc, range)
  }
  followed.end(removal, { undoable: image.linked })
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

  enter(place: AssetPlace, item: HTMLElement, content: () => HTMLElement): void {
    this.cancel()
    const show = (): void => {
      this.timer = null
      const from = place()
      const image = from === null ? undefined : renderedImages(this.view.state).find((image) => image.from === from)
      if (from === null || !image) return
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
 *  (`protectedRanges` in `find.ts`). An image inside a selection looks
 *  selected (`assetSelection.ts`). The CSS is in `dezTheme`. */
export function markdownImages(): Extension {
  return [imageDecorationsField, pendingRanges(), imageTooltipField, imageTooltipHover, selectedAssetLook('dez-image', renderedImages)]
}
