import type { EditorView } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { coverBox, type Box } from './coverBox'
import { focusKeepingScroll } from './focus'
import { ROUND_STROKE, svgIcon } from './svgIcon'

// The image zoom: one image of the conversation, as large as it fits in the
// conversation view, over a dimmed and blurred backdrop. The magnifier of
// an image's toolbar opens it (images.ts); the X, Escape, or a click on the
// backdrop closes it.
//
// The layer is a child of the editor's root (`view.dom`), so the editor's
// theme styles it (`.dez-image-zoom` in `dezTheme`), with a fixed place on
// the box of the scroller (`coverBox`). It is not in the scroller: there
// the scroller's stacking context would put it under the scrollbar, and the
// wheel turns and clicks on it would go to CodeMirror, which listens on the
// scroller and the content. The zoom is a modal for the keys of Dez, as an
// expanded app is (`isPanelOpen`, view/panels.ts), and Escape closes it
// after the panels that show over it.
//
// The image grows from its place in the text to its zoomed place (a FLIP:
// the zoomed image is drawn at its final place, and a transform animation
// starts it at the drawn image's rect), and goes back to it on close. The
// drawn image hides while the zoom shows it (`data-zoomed`). With reduced
// motion the image only fades.
//
// This module knows nothing of the editor state: images.ts tells it which
// image to show, and closes it when that image goes (`ImageZoomFollow`).

const ZOOM_CLASS = 'dez-image-zoom'

/** The room between the zoomed image and each edge of the conversation
 *  view, in px. The X is in the room of the top-right corner (32px at 12px
 *  from the edges, `.dez-image-zoom__close` in `dezTheme`), so it never
 *  covers the image. */
export const ZOOM_MARGIN_PX = 52

/** The attribute of a drawn image whose image the zoom shows: `dezTheme`
 *  hides it. CodeMirror ignores an attribute change in a widget. */
const ZOOMED_ATTRIBUTE = 'data-zoomed'

const OPEN_MS = 240
const CLOSE_MS = 200
const FADE_MS = 160
/** The easing of the image toolbar's entrance (`.dez-image__overlay`). */
const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)'

export interface Size {
  width: number
  height: number
}

/** Where the zoomed image of natural size `natural` goes in an area of
 *  size `area`, relative to the area: as large as it fits with `margin` on
 *  each side, at its aspect ratio, in the middle. A small image grows to
 *  fit too. An image with no natural size (an SVG file with none) gets the
 *  whole room inside the margin. Whole px, at least 1 each way. */
export function zoomedImageRect(area: Size, natural: Size, margin: number): Box {
  const roomWidth = Math.max(1, area.width - 2 * margin)
  const roomHeight = Math.max(1, area.height - 2 * margin)
  const sized = natural.width > 0 && natural.height > 0
  const scale = sized ? Math.min(roomWidth / natural.width, roomHeight / natural.height) : 1
  const width = sized ? Math.max(1, Math.round(natural.width * scale)) : roomWidth
  const height = sized ? Math.max(1, Math.round(natural.height * scale)) : roomHeight
  return {
    left: Math.round((area.width - width) / 2),
    top: Math.round((area.height - height) / 2),
    width,
    height,
  }
}

/** What the zoom shows. */
export interface ZoomRequest {
  /** The id of the tab whose conversation the editor shows. */
  tabId: string
  /** The path of the image file. */
  path: string
  /** The id of the image; null for an old reference with none. */
  id: string | null
  /** The URL of the image file (the `src` of the drawn image). */
  url: string
  /** The alt text of the drawn image. */
  alt: string
  /** The drawn image of the same reference now (the one that was clicked
   *  while it is in the page); null when the editor draws none. The zoom
   *  grows from it and goes back to it. */
  findSource: () => HTMLImageElement | null
}

/** The image that the zoom shows, in `view`. */
export interface ZoomedImage {
  view: EditorView
  tabId: string
  path: string
  id: string | null
}

interface OpenZoom extends ZoomedImage {
  findSource: () => HTMLImageElement | null
  layer: HTMLDivElement
  backdrop: HTMLDivElement
  image: HTMLImageElement
  closeButton: HTMLButtonElement
  /** The natural size of the image, once it is decoded; null before. */
  natural: Size | null
  /** The place that the styles of the layer have now, in the window. */
  layerBox: Box | null
  /** The place that the styles of the image have now, in the layer. */
  imageBox: Box | null
  /** Closes the zoom when the editor gets the keyboard. */
  onEditorFocus: () => void
}

// The zoom that shows; null when none does. A closed zoom stops being a
// modal at once, while its close animation runs (`closing`).
let shown: OpenZoom | null = null

// The layer of the zoom whose close animation runs, and what ends it at
// once.
let closing: { layer: HTMLDivElement, finish: () => void } | null = null

/** Whether the zoom shows an image. */
export function isImageZoomOpen(): boolean {
  return shown !== null
}

/** The image that the zoom shows; null when none. */
export function zoomedImage(): ZoomedImage | null {
  return shown
}

/** Hides the drawn image `img` of `view` when the zoom shows its image: the
 *  editor drew the image again (a rebuild of the tab, a panel that opened)
 *  while the zoom showed it. */
export function hideIfZoomed(view: EditorView, img: HTMLImageElement, path: string, id: string | null): void {
  if (shown?.view === view && shown.natural && shown.path === path && shown.id === id) img.setAttribute(ZOOMED_ATTRIBUTE, '')
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, part: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = `${ZOOM_CLASS}__${part}`
  return made
}

// The X: two strokes that cross.
function closeIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [['path', { d: 'M4 4l8 8M12 4l-8 8', ...ROUND_STROKE, 'stroke-width': '1.6' }]])
}

// The layer of `request`, not yet in the page.
function buildZoom(view: EditorView, request: ZoomRequest): OpenZoom {
  const layer = document.createElement('div')
  layer.className = ZOOM_CLASS
  layer.setAttribute('role', 'dialog')
  layer.setAttribute('aria-modal', 'true')
  layer.setAttribute('aria-label', `Zoom of image ${request.id ?? request.alt}`)
  // The layer itself takes the keyboard at the open, not the X: WebKit
  // shows the focus ring of a button that a script focuses after a press
  // in the editor, and a mouse user should not see it.
  layer.tabIndex = -1
  const backdrop = element('div', 'backdrop')
  const image = element('img', 'img')
  image.alt = request.alt
  image.draggable = false
  // Hidden until it is decoded and placed (`showImage`).
  image.style.visibility = 'hidden'
  image.src = request.url
  const closeButton = element('button', 'close')
  closeButton.type = 'button'
  closeButton.title = 'Close (Escape)'
  closeButton.setAttribute('aria-label', 'Close the zoom')
  closeButton.append(closeIcon())
  layer.append(backdrop, image, closeButton)
  const zoom: OpenZoom = {
    view,
    tabId: request.tabId,
    path: request.path,
    id: request.id,
    findSource: request.findSource,
    layer,
    backdrop,
    image,
    closeButton,
    natural: null,
    layerBox: null,
    imageBox: null,
    onEditorFocus: () => closeImageZoom(),
  }

  // A click on the backdrop closes the zoom, when the press started there
  // too: a press on the image that ends on the backdrop is no click on it.
  // A press keeps the keyboard in the layer, and starts no text selection
  // and no drag of the image.
  let pressedOnBackdrop = false
  layer.addEventListener('mousedown', (event) => {
    pressedOnBackdrop = event.button === 0 && event.target === backdrop
    if (!closeButton.contains(event.target as Node)) event.preventDefault()
  })
  layer.addEventListener('click', (event) => {
    if (event.target === backdrop && pressedOnBackdrop) closeImageZoom()
  })
  closeButton.addEventListener('click', () => closeImageZoom())
  // The X is the only control, so Tab puts the keyboard on it, and keeps
  // it there: the text under the layer must not get the keyboard. Escape
  // goes on to the window, whose handler closes the top layer
  // (`closeTopPanel`).
  layer.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    closeButton.focus({ preventScroll: true })
  })
  // A context click on the image pops up its asset menu, as on the drawn
  // image (`addAssetMenu` in images.ts), in place of the webview's own
  // menu; the backdrop has none.
  layer.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (event.target === image) void sbp('dez.controller/menu/popupAsset', zoom.path)
  })
  return zoom
}

// Writes only the styles that change: a write of the same place would
// still make the browser check the layout again.
function placeElement(target: HTMLElement, box: Box, styled: Box | null): void {
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    if (styled?.[side] !== box[side]) target.style[side] = `${box[side]}px`
  }
}

// Puts the layer of `zoom` at `box` (in the window), and its image, once
// its size is known, at its zoomed place in it.
function placeZoom(zoom: OpenZoom, box: Box): void {
  placeElement(zoom.layer, box, zoom.layerBox)
  zoom.layerBox = box
  if (!zoom.natural) return
  const imageBox = zoomedImageRect(box, zoom.natural, ZOOM_MARGIN_PX)
  placeElement(zoom.image, imageBox, zoom.imageBox)
  zoom.imageBox = imageBox
}

/** Puts the zoom of `view` on `box`, the box of its conversation view now
 *  (`coverBox`), after a change of the layout. Does nothing when the zoom
 *  is not of `view`. */
export function placeImageZoom(view: EditorView, box: Box): void {
  if (shown?.view === view) placeZoom(shown, box)
}

// The place of the zoomed image of `zoom` in the window, with no
// transform.
function imageWindowBox(zoom: OpenZoom): Box | null {
  const { layerBox, imageBox } = zoom
  if (!layerBox || !imageBox) return null
  return { left: layerBox.left + imageBox.left, top: layerBox.top + imageBox.top, width: imageBox.width, height: imageBox.height }
}

// The transform that draws the image placed at `box` at `rect`, both in
// the window. The image's transform origin is its top-left corner
// (`dezTheme`).
function transformTo(rect: Box, box: Box): string {
  return `translate(${rect.left - box.left}px, ${rect.top - box.top}px) scale(${rect.width / box.width}, ${rect.height / box.height})`
}

// The rect of the drawn image `source` in the window when a part of it is
// in the conversation view `box`; null when none is.
function visibleRect(source: HTMLImageElement | null, box: Box | null): Box | null {
  if (!source?.isConnected || !box) return null
  const rect = source.getBoundingClientRect()
  const inView = rect.width > 0 && rect.height > 0 && rect.right > box.left && rect.left < box.left + box.width
    && rect.bottom > box.top && rect.top < box.top + box.height
  return inView ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
}

// Shows the image of `zoom` once it is decoded, so that its first frame is
// whole: it grows from the drawn image, or fades in when that is out of
// view.
async function showImage(zoom: OpenZoom): Promise<void> {
  const { image } = zoom
  try {
    await image.decode()
  } catch {
    // The error can name the URL of the file, which stays out of the log.
    if (shown === zoom) {
      console.error('[imageZoom] The image could not be decoded')
      closeImageZoom('now')
    }
    return
  }
  if (shown !== zoom) return
  zoom.natural = { width: image.naturalWidth, height: image.naturalHeight }
  placeZoom(zoom, coverBox(zoom.view))
  image.style.visibility = ''
  const source = zoom.findSource()
  const from = visibleRect(source, zoom.layerBox)
  source?.setAttribute(ZOOMED_ATTRIBUTE, '')
  const box = imageWindowBox(zoom)
  if (from && box && !reducedMotion()) {
    image.animate([{ transform: transformTo(from, box) }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE_OUT })
  } else {
    image.animate(fadeFrames(1, 0), { duration: FADE_MS, easing: EASE_OUT })
  }
}

// The frames of a fade of the image to `to` from `from` (both opacities):
// with a small change of size about its middle, unless the user asked for
// reduced motion.
function fadeFrames(to: number, from: number): Keyframe[] {
  if (reducedMotion()) return [{ opacity: from }, { opacity: to }]
  const small = 'scale(0.96)'
  return [
    { opacity: from, transform: to > from ? small : 'none', transformOrigin: 'center' },
    { opacity: to, transform: to > from ? 'none' : small, transformOrigin: 'center' },
  ]
}

/** Shows the image of `request` over the conversation view of `view`, with
 *  the keyboard in the layer. The press on the magnifier keeps the keyboard
 *  where it was: the zoom gives it back to the editor on close. */
export function openImageZoom(view: EditorView, request: ZoomRequest): void {
  closeImageZoom('now')
  closing?.finish()
  // Find has no text to show under the zoom. The close gives the keyboard
  // to the editor, before the listener below is there.
  sbp('dez.editor/closeFind')
  const zoom = buildZoom(view, request)
  shown = zoom
  // The user must never type into text that the zoom covers: the zoom
  // closes when the editor gets the keyboard.
  view.contentDOM.addEventListener('focusin', zoom.onEditorFocus)
  placeZoom(zoom, coverBox(view))
  view.dom.append(zoom.layer)
  zoom.layer.focus({ preventScroll: true })
  zoom.backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' })
  // The X comes in a little after the backdrop, so the eye goes to the
  // image first.
  zoom.closeButton.animate(
    reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'none' }],
    { duration: FADE_MS, delay: 80, easing: EASE_OUT, fill: 'backwards' },
  )
  void showImage(zoom)
}

// Takes the layer of `zoom` out of the page, and shows the drawn images
// that it hid.
function removeZoom(zoom: OpenZoom): void {
  zoom.layer.remove()
  for (const hidden of zoom.view.dom.querySelectorAll(`[${ZOOMED_ATTRIBUTE}]`)) hidden.removeAttribute(ZOOMED_ATTRIBUTE)
}

/** How a close looks: `back` goes back to the drawn image when it is in
 *  view (else as `fade`), `fade` fades out where it is, `now` ends at once.
 *  With reduced motion `back` fades too. */
export type ZoomClose = 'back' | 'fade' | 'now'

/** Closes the zoom: it stops being a modal at once, and the editor gets
 *  the keyboard back when the zoom had it. Returns whether one showed. */
export function closeImageZoom(how: ZoomClose = 'back'): boolean {
  const zoom = shown
  if (!zoom) return false
  shown = null
  const { view, layer, backdrop, image, closeButton } = zoom
  view.contentDOM.removeEventListener('focusin', zoom.onEditorFocus)
  layer.setAttribute('data-closing', '')
  const focused = document.activeElement
  if (!focused || focused === document.body || layer.contains(focused)) {
    // Later, as a close can come from inside an editor update (a new state
    // of the editor), where the editor takes no focus.
    queueMicrotask(() => {
      if (view.dom.isConnected) focusKeepingScroll(view)
    })
  }
  if (how === 'now' || !layer.isConnected) {
    removeZoom(zoom)
    return true
  }

  // Each animation goes on from where the open left it.
  const box = imageWindowBox(zoom)
  const now = image.getBoundingClientRect()
  const opacities = [backdrop, image, closeButton].map((part) => Number(getComputedStyle(part).opacity))
  const target = how === 'back' && box && !reducedMotion() ? visibleRect(zoom.findSource(), zoom.layerBox) : null
  for (const animation of layer.getAnimations({ subtree: true })) animation.cancel()

  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (closing?.layer === layer) closing = null
    removeZoom(zoom)
  }
  closing = { layer, finish }
  const options: KeyframeAnimationOptions = { duration: CLOSE_MS, easing: EASE_IN_OUT, fill: 'forwards' }
  // The longest animation, so the layer goes when all of them are over.
  const fade = backdrop.animate([{ opacity: opacities[0] }, { opacity: 0 }], options)
  closeButton.animate([{ opacity: opacities[2] }, { opacity: 0 }], { duration: 100, fill: 'forwards' })
  if (target && box) {
    const from = { left: now.left, top: now.top, width: now.width, height: now.height }
    image.animate([{ transform: transformTo(from, box) }, { transform: transformTo(target, box) }], options)
  } else if (zoom.natural) {
    image.animate(fadeFrames(0, opacities[1]), { ...options, duration: FADE_MS })
  }
  // A cancel (the layer left the page) rejects `finished`.
  fade.finished.then(finish, finish)
  return true
}
