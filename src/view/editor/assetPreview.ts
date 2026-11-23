import { Prec, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, type PluginValue, type Rect, type ViewUpdate } from '@codemirror/view'
import type { AssetKind } from '../../model/chat/assetMentions'
import { confirmRequest } from '../confirm/request'
import { sameModelFacts } from '../modelLabel'
import { editorSizePx, sectionsField } from '../thread/cmEditor'
import { modelDisplayNames } from '../thread/modelChip'
import { mentionTarget, type AssetTarget } from './assetJump'
import { compactionChipData } from './compactionChip'
import type { AssetPlace } from './drawnAssets'
import { focusKeepingScroll } from './focus'
import { isImageZoomOpen } from './imageZoom'
import { createImage, shownImageAt, updateImageModel } from './images'
import { createPlayer, destroyPlayer, isInSelectableTooltip, samePlayerFacts, shownClipAt, updatePlayer } from './media'
import { mentionAt, type ShownMention } from './mentions'
import { renderedToolCalls, type PanelAsset } from './toolCalls'

// When the pointer rests on a mention chip (mentions.ts), a box shows the
// asset that the chip names, next to the chip: the same image or player
// that the editor draws at the asset's place or in the panel of its chip,
// with its toolbar, its menu, its zoom, and its trash, and a clip plays in
// it. A click on the chip still goes to the asset (assetJump.ts).
//
// The box is Dez's own layer, not a CodeMirror tooltip: CM hides a hover
// tooltip as soon as the pointer is off its rect, and its tooltips draw
// over the image zoom. The box is a fixed element in the editor root
// (`view.dom`), outside `contentDOM`, as the zoom is. So CM's input
// handlers do not see its events, and `drawnAssetAt` and
// `selectedAssetLook`, which look only in `contentDOM`, never take the
// asset in the box for the asset at its place: a jump or a flash goes to
// that one.
//
// The box stays while the pointer is in its hover region: the chip, the
// box, and the "bridge", an invisible rect that fills the gap between the
// two (`previewPlace`). Off the region, it goes after a short grace time,
// so a pointer that cuts a corner does not lose it.

/** The asset that the box of a mention chip shows: the target of the
 *  mention (`mentionTarget`, the asset that a click goes to), and that
 *  asset as its place or its panel draws it. */
export interface PreviewAsset {
  target: AssetTarget
  asset: PanelAsset
}

/** What the box of `mention` shows in `state`; null when the editor draws
 *  no asset for the mention (`mentionTarget`). */
export function mentionPreviewAsset(state: EditorState, mention: Pick<ShownMention, 'from' | 'id' | 'kind'>): PreviewAsset | null {
  const target = mentionTarget(state, mention)
  const asset = target && targetAsset(state, target, mention.kind)
  return target && asset ? { target, asset } : null
}

// The asset of `target` as the place that draws it now draws it: its own
// place, a row of the panel of a tool call chip, or a row of the kept
// assets of the compaction.
function targetAsset(state: EditorState, { from, holder }: AssetTarget, kind: AssetKind): PanelAsset | null {
  if (holder?.kind === 'call') {
    const call = renderedToolCalls(state).find((rendered) => rendered.id === holder.id && rendered.from === holder.from)
    return call?.intermediate?.assets[holder.row] ?? null
  }
  if (holder?.kind === 'compaction') return compactionChipData(state)?.assets[holder.row] ?? null
  if (kind === 'image') {
    const image = shownImageAt(state, from)
    return image && { kind: 'image', ...image }
  }
  const clip = shownClipAt(state, from)
  return clip && { kind: 'clip', ...clip }
}

/** Which side of its chip the box is on. */
export type PreviewSide = 'above' | 'below'

/** Where the box goes (`previewPlace`), in window px. */
export interface PreviewPlace {
  side: PreviewSide
  left: number
  top: number
  /** The invisible part of the hover region between the box and the chip:
   *  as wide as the two together, from the edge of the box to the near
   *  edge of the chip, so that it never covers the chip. */
  bridge: Rect
}

/** The gap between a chip and its box. The fill of a chip hangs out of its
 *  text, so a box with no gap would touch the fill. */
export const PREVIEW_GAP_PX = 6

/** The place of a box of `size` for the chip at `chip`, in `area`, the part
 *  of the window that the box can use.
 *
 *  Down: on `keepSide` while the box fits there (a box that shows does not
 *  jump over its chip when it grows), else above the chip when it fits
 *  there, else below when it fits there, else on the side with more room.
 *  A box that fits on neither side is not moved into the area: it would
 *  cover its chip.
 *
 *  Across: from the chip's left edge, moved left as far as needed to stay
 *  in the area, but never past the area's left edge. */
export function previewPlace(chip: Rect, size: { width: number, height: number }, area: Rect, keepSide: PreviewSide | null): PreviewPlace {
  const roomAbove = chip.top - PREVIEW_GAP_PX - area.top
  const roomBelow = area.bottom - (chip.bottom + PREVIEW_GAP_PX)
  const fits = (side: PreviewSide): boolean => (side === 'above' ? roomAbove : roomBelow) >= size.height
  let side: PreviewSide
  if (keepSide && fits(keepSide)) side = keepSide
  else if (fits('above')) side = 'above'
  else if (fits('below')) side = 'below'
  else side = roomAbove >= roomBelow ? 'above' : 'below'
  const top = side === 'above' ? chip.top - PREVIEW_GAP_PX - size.height : chip.bottom + PREVIEW_GAP_PX
  const left = Math.max(area.left, Math.min(chip.left, area.right - size.width))
  const bridge = {
    left: Math.min(left, chip.left),
    right: Math.max(left + size.width, chip.right),
    top: side === 'above' ? top + size.height : chip.bottom,
    bottom: side === 'above' ? chip.top : top,
  }
  return { side, left, top, bridge }
}

/** How long the pointer rests on a chip before its box shows: the hover
 *  time of CM's `hoverTooltip`, as for the item tooltips of an image. */
const SHOW_DELAY_MS = 300

/** How long the box stays after the pointer left its hover region. */
const HIDE_GRACE_MS = 200

/** The space that the box keeps from the top and the bottom of the
 *  scroller, as the other tooltips of the editor do (`tooltipSpace` in
 *  ThreadEditor.vue). */
const AREA_MARGIN_PX = 8

/** The largest and the smallest size of the asset in the box, in px at the
 *  default editor font size (`editorSizePx`). The largest size is never
 *  more than the room of the box, and the smallest is for a window with
 *  almost no room. */
const ASSET_MAX_WIDTH_PX = 560
const ASSET_MAX_HEIGHT_PX = 420
const ASSET_MIN_WIDTH_PX = 160
const ASSET_MIN_HEIGHT_PX = 80

/** The length of the entrance of the box. */
const ENTRANCE_MS = 140

/** A mention, by what stays the same for it across doc changes that keep
 *  it (with `from` mapped through them). */
type MentionKey = Pick<ShownMention, 'from' | 'id' | 'kind'>

function sameMention(a: MentionKey, b: MentionKey): boolean {
  return a.from === b.from && a.id === b.id && a.kind === b.kind
}

/** What tells that the box must draw its asset again: an image of another
 *  file, or another clip. A new model label, and a new source of the same
 *  clip (a Save), change the drawn asset in place. */
function assetKey(asset: PanelAsset): string {
  return asset.kind === 'image'
    ? `image ${asset.id} ${asset.linked} ${asset.path}`
    : `${asset.tag.kind} ${asset.tag.id} ${asset.linkedSrc}`
}

/** The bottom of the part of the scroller that the find dropdown covers,
 *  from the scroller's top (`EditorView.scrollMargins`). */
function scrollMarginTop(view: EditorView): number {
  let top = 0
  for (const margins of view.state.facet(EditorView.scrollMargins)) top = Math.max(top, margins(view)?.top ?? 0)
  return top
}

function contains(rect: Rect | null, x: number, y: number): boolean {
  return rect !== null && rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom
}

/** A box that waits for its chip's rest time. */
interface Pending {
  mention: MentionKey
  /** The chip element under the pointer. */
  element: Element
  timer: number
}

/** The box that shows. */
interface Shown {
  mention: ShownMention
  key: string
  asset: PanelAsset
  box: HTMLDivElement
  /** The root element of the image or the player in the box. */
  root: HTMLElement
  /** Whether the asset has its size: the box shows only from then on. */
  ready: boolean
  revealed: boolean
  side: PreviewSide | null
  chip: Rect | null
  bridge: Rect | null
  /** The max sizes of the asset that the box has now (CSS values). */
  caps: string
  hideTimer: number | null
  /** A press that started in the box, until its end: a drag on a slider
   *  of a player can go out of the box. */
  pressInBox: boolean
  /** A native menu of the asset is open: the page gets no pointer events
   *  under it, until the first one after it closes. */
  menuOpen: boolean
  /** Takes off the listeners of the box and of the window. */
  dispose: () => void
}

/** The layout facts that place the box (`AssetPreview.readLayout`). */
interface Layout {
  chip: Rect
  area: Rect
  width: number
  height: number
  /** The width of the padding and the border of the box. */
  chromeWidth: number
  /** The height of the box less that of its picture (an image, a video). */
  extraHeight: number
}

/** The box of the mention chips of one editor. */
class AssetPreview implements PluginValue {
  pending: Pending | null = null
  shown: Shown | null = null
  /** The chip that the user pressed: it shows no box again until the
   *  pointer leaves it. */
  private pressed: MentionKey | null = null

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      const { changes } = update
      if (this.pending) this.pending.mention = { ...this.pending.mention, from: changes.mapPos(this.pending.mention.from, 1) }
      if (this.pressed) this.pressed = { ...this.pressed, from: changes.mapPos(this.pressed.from, 1) }
    }
    const shown = this.shown
    if (!shown) return
    const assetsCanChange = update.docChanged
      || update.startState.field(sectionsField, false) !== update.state.field(sectionsField, false)
      || modelDisplayNames(update.startState) !== modelDisplayNames(update.state)
    if (assetsCanChange && !this.follow(shown, update)) return
    this.measure()
  }

  destroy(): void {
    this.cancelPending()
    this.hide()
  }

  /** The pointer moves in `contentDOM`: a rest on a chip shows its box. */
  onEditorMove(event: MouseEvent): void {
    const hovered = event.buttons === 0 ? this.chipAt(event.target) : null
    if (!hovered) {
      this.cancelPending()
      if (event.buttons === 0) this.pressed = null
      return
    }
    const { mention, element } = hovered
    if (this.pressed && sameMention(this.pressed, mention)) return
    this.pressed = null
    // While a box shows, the window's listener takes the moves
    // (`onPointerMove`).
    if (this.shown || (this.pending && sameMention(this.pending.mention, mention))) return
    this.cancelPending()
    this.pending = { mention, element, timer: window.setTimeout(() => this.showPending(), SHOW_DELAY_MS) }
  }

  /** A press in `contentDOM`: a box that waits does not show, and the
   *  pressed chip shows none until the pointer leaves it. */
  onEditorPress(event: MouseEvent): void {
    this.cancelPending()
    this.pressed = this.chipAt(event.target)?.mention ?? null
  }

  /** Escape: closes the box, unless a layer over it (the image zoom, the
   *  confirm prompt) takes the key. */
  closeByKey(): boolean {
    this.cancelPending()
    if (!this.shown || isImageZoomOpen() || confirmRequest.value !== null) return false
    this.hide()
    return true
  }

  /** Asks for a new place of the box after the layout changed. */
  measure(): void {
    this.view.requestMeasure({
      key: this,
      read: () => {
        const { shown } = this
        return shown && { shown, layout: this.readLayout(shown) }
      },
      write: (measured) => {
        if (measured && measured.shown === this.shown) this.writeLayout(measured.shown, measured.layout)
      },
    })
  }

  // The chip of `target`, an element in `contentDOM`, and that element.
  private chipAt(target: EventTarget | null): { mention: ShownMention, element: Element } | null {
    const element = target instanceof Element && this.view.contentDOM.contains(target) ? target.closest('.dez-mention') : null
    const mention = element && mentionAt(this.view.state, this.view.posAtDOM(element), 1)
    return element && mention ? { mention, element } : null
  }

  private cancelPending(): void {
    if (this.pending) window.clearTimeout(this.pending.timer)
    this.pending = null
  }

  // The rest time is over: shows the box, if the pointer is still on the
  // chip and the chip still names the same asset.
  private showPending(): void {
    const { pending } = this
    this.pending = null
    if (!pending || !pending.element.isConnected || !pending.element.matches(':hover')) return
    const mention = mentionAt(this.view.state, pending.mention.from, 1)
    if (mention && sameMention(mention, pending.mention)) this.show(mention)
  }

  private show(mention: ShownMention): void {
    const { view } = this
    const found = mentionPreviewAsset(view.state, mention)
    this.hide()
    if (!found) return
    const { asset } = found
    const box = document.createElement('div')
    box.className = 'dez-asset-preview'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', `Preview of @${mention.id}`)
    // The Save, the Delete, and the trash of the asset find its text by
    // this: the mention's asset in the state of now. Null once the box is
    // gone, as for a widget that left the doc.
    let shown: Shown | null = null
    const place: AssetPlace = () => shown !== null && this.shown === shown ? mentionPreviewAsset(view.state, shown.mention)?.target.from ?? null : null
    const root = asset.kind === 'image' ? createImage(view, asset, place) : createPlayer(view, asset.tag, asset.linkedSrc, asset.model, place)
    box.append(root)
    const caps = this.writeCaps(box, editorSizePx(ASSET_MAX_WIDTH_PX), editorSizePx(ASSET_MAX_HEIGHT_PX))
    const record: Shown = {
      mention,
      key: assetKey(asset),
      asset,
      box,
      root,
      // An image whose size the editor knew gets it at once (`setBoxSize`
      // in images.ts); another one gets it at its load. A player has its
      // size at once.
      ready: asset.kind === 'clip' || root.querySelector<HTMLElement>('.dez-image__img')?.style.getPropertyValue('--dez-image-width') !== '',
      revealed: false,
      side: null,
      chip: null,
      bridge: null,
      caps,
      hideTimer: null,
      pressInBox: false,
      menuOpen: false,
      dispose: () => {},
    }
    shown = record
    this.shown = record
    record.dispose = this.listen(record)
    view.dom.append(box)
    this.measure()
  }

  // The listeners of the box `shown`; returns what takes them off.
  private listen(shown: Shown): () => void {
    const { box } = shown
    const ready = (): void => {
      if (shown.ready) return
      shown.ready = true
      this.measure()
    }
    const onPointerMove = (event: PointerEvent): void => {
      shown.menuOpen = false
      if (box.contains(event.target as Node) || this.inRegion(shown, event.clientX, event.clientY)) {
        this.cancelHide(shown)
        return
      }
      // A move onto another chip shows that chip's box at once.
      const other = this.chipAt(event.target)?.mention
      if (other && !sameMention(other, shown.mention)) this.show(other)
      else this.armHide(shown)
    }
    const onPointerDown = (event: PointerEvent): void => {
      shown.menuOpen = false
      if (box.contains(event.target as Node)) {
        // A context press opens a native menu, which can take its release.
        shown.pressInBox = event.button === 0
        return
      }
      // A press anywhere else closes the box at once (a press on a chip
      // too: its jump still goes). A press on the image zoom or on the
      // confirm prompt (of the trash of the asset) is for that layer.
      if (isImageZoomOpen() || confirmRequest.value !== null) return
      this.pressed = this.chipAt(event.target)?.mention ?? null
      this.hide()
    }
    const onPressEnd = (): void => {
      shown.pressInBox = false
    }
    // The pointer left the window: the moves stop, so the grace time runs.
    const onMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null) this.armHide(shown)
    }
    const onContextMenu = (): void => {
      shown.menuOpen = true
    }
    // Escape with the keyboard in the box (on a player). A player's own
    // popup takes its Escape first, and fullscreen ends on its own.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.fullscreenElement) return
      event.preventDefault()
      const hadFocus = box.contains(document.activeElement)
      this.hide()
      if (hadFocus) focusKeepingScroll(this.view)
    }
    // A press in the box keeps the caret and the focus where they are, as
    // a press on a player in the text does, but for the text of a player
    // tooltip that can be selected.
    const onMouseDown = (event: MouseEvent): void => {
      if (!isInSelectableTooltip(event.target)) event.preventDefault()
    }
    // The box is outside the scroller, so a wheel on it would scroll
    // nothing: it scrolls the conversation, as on the text that it covers.
    // The box follows its chip, and goes when the chip leaves the view.
    const onWheel = (event: WheelEvent): void => {
      if (event.defaultPrevented) return
      const { scrollDOM } = this.view
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scrollDOM.clientHeight
        : 1
      scrollDOM.scrollBy(event.deltaX * unit, event.deltaY * unit)
    }
    // A load or an error of the image gives the asset its size; neither
    // goes up the tree, so the box takes them as they go down.
    box.addEventListener('load', ready, true)
    box.addEventListener('error', ready, true)
    box.addEventListener('contextmenu', onContextMenu, true)
    box.addEventListener('keydown', onKeyDown)
    box.addEventListener('mousedown', onMouseDown)
    box.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPressEnd, true)
    window.addEventListener('pointercancel', onPressEnd, true)
    document.addEventListener('mouseout', onMouseOut)
    // The size of the asset changes in place (an image loads, a video gets
    // its size, the font size changes).
    const observer = new ResizeObserver(() => this.measure())
    observer.observe(box)
    return () => {
      observer.disconnect()
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPressEnd, true)
      window.removeEventListener('pointercancel', onPressEnd, true)
      document.removeEventListener('mouseout', onMouseOut)
    }
  }

  // The hover region of the box: the chip, the box, and the bridge.
  private inRegion(shown: Shown, x: number, y: number): boolean {
    return contains(shown.chip, x, y) || contains(shown.bridge, x, y) || contains(shown.box.getBoundingClientRect(), x, y)
  }

  // Starts the grace time of the box, which closes it at its end, unless
  // the user still works with the asset: a press that started in the box,
  // an open menu, a player in fullscreen, the image zoom (which can show
  // the image of the box), or the confirm prompt of the trash. Then the
  // grace time starts again.
  private armHide(shown: Shown): void {
    if (shown.hideTimer !== null) return
    shown.hideTimer = window.setTimeout(() => {
      shown.hideTimer = null
      if (this.shown !== shown) return
      const fullscreen = document.fullscreenElement
      const working = shown.pressInBox || shown.menuOpen || (fullscreen !== null && shown.box.contains(fullscreen))
        || isImageZoomOpen() || confirmRequest.value !== null
      if (working) this.armHide(shown)
      else this.hide()
    }, HIDE_GRACE_MS)
  }

  private cancelHide(shown: Shown): void {
    if (shown.hideTimer !== null) window.clearTimeout(shown.hideTimer)
    shown.hideTimer = null
  }

  private hide(): void {
    const { shown } = this
    if (!shown) return
    this.shown = null
    this.cancelHide(shown)
    shown.dispose()
    if (shown.asset.kind === 'clip') destroyPlayer(shown.root)
    shown.box.remove()
  }

  // The doc, the roles, or the model names changed: the box follows its
  // mention, and the asset in it changes in place. It closes when the
  // mention is gone or names another asset now. Only a changed fact goes
  // to the drawn asset, as the widgets do (`ImageWidget.eq`,
  // `samePlayerFacts`): each stream token and each key comes here, and a
  // new model label would end the tooltip that shows on the old one.
  private follow(shown: Shown, update: ViewUpdate): boolean {
    const mention = mentionAt(update.state, update.changes.mapPos(shown.mention.from, 1), 1)
    const found = mention && mention.id === shown.mention.id && mention.kind === shown.mention.kind ? mentionPreviewAsset(update.state, mention) : null
    if (!mention || !found || assetKey(found.asset) !== shown.key) {
      this.hide()
      return false
    }
    const before = shown.asset
    const after = found.asset
    shown.mention = mention
    shown.asset = after
    if (after.kind === 'image') {
      if (!sameModelFacts(before.model, after.model)) updateImageModel(shown.root, after.model)
    } else if (before.kind !== 'clip' || !samePlayerFacts(before, after)) {
      updatePlayer(shown.root, after.tag, after.model)
    }
    return true
  }

  // Null when the chip is not drawn or not in the visible part of the
  // scroller: the box closes then.
  private readLayout(shown: Shown): Layout | null {
    const { view } = this
    const start = view.coordsAtPos(shown.mention.from, 1)
    const end = view.coordsAtPos(shown.mention.to, -1)
    if (!start || !end) return null
    // A chip can wrap: its rect then holds both of its lines.
    const chip = {
      left: Math.min(start.left, end.left),
      right: Math.max(start.right, end.right),
      top: Math.min(start.top, end.top),
      bottom: Math.max(start.bottom, end.bottom),
    }
    const scroller = view.scrollDOM.getBoundingClientRect()
    const visibleTop = scroller.top + scrollMarginTop(view)
    if (chip.bottom <= visibleTop || chip.top >= scroller.bottom) return null
    // Across, the text column, as for the other tooltips of the editor.
    const content = view.contentDOM.getBoundingClientRect()
    const area = { left: content.left, right: content.right, top: visibleTop + AREA_MARGIN_PX, bottom: scroller.bottom - AREA_MARGIN_PX }
    const { box } = shown
    const style = getComputedStyle(box)
    const chrome = (...sides: string[]): number => sides.reduce((sum, side) => sum + (parseFloat(style.getPropertyValue(side)) || 0), 0)
    const picture = box.querySelector<HTMLElement>('.dez-image__img, .media-player__video')
    const height = box.offsetHeight
    return {
      chip,
      area,
      width: box.offsetWidth,
      height,
      chromeWidth: chrome('padding-left', 'padding-right', 'border-left-width', 'border-right-width'),
      extraHeight: picture ? height - picture.offsetHeight : chrome('padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width'),
    }
  }

  private writeLayout(shown: Shown, layout: Layout | null): void {
    if (!layout) {
      this.hide()
      return
    }
    const { chip, area } = layout
    // The asset is as large as the room of the side with more room allows,
    // so the box fits on one side of its chip.
    const room = Math.max(chip.top - PREVIEW_GAP_PX - area.top, area.bottom - chip.bottom - PREVIEW_GAP_PX)
    const maxWidth = Math.max(editorSizePx(ASSET_MIN_WIDTH_PX), Math.min(editorSizePx(ASSET_MAX_WIDTH_PX), area.right - area.left - layout.chromeWidth))
    const maxHeight = Math.max(editorSizePx(ASSET_MIN_HEIGHT_PX), Math.min(editorSizePx(ASSET_MAX_HEIGHT_PX), room - layout.extraHeight))
    const caps = this.writeCaps(shown.box, maxWidth, maxHeight, shown.caps)
    const resized = caps !== shown.caps
    shown.caps = caps
    const place = previewPlace(chip, layout, area, shown.revealed ? shown.side : null)
    shown.box.style.left = `${place.left}px`
    shown.box.style.top = `${place.top}px`
    shown.side = place.side
    shown.chip = chip
    shown.bridge = place.bridge
    // New max sizes give the box a new size: it shows at the place of
    // that size, at the next measure.
    if (resized) this.measure()
    else if (shown.ready && !shown.revealed) this.reveal(shown)
  }

  // Gives `box` the max sizes of its asset (`.dez-asset-preview` in
  // `dezTheme`), when they are not `written` already; returns them.
  private writeCaps(box: HTMLElement, maxWidth: number, maxHeight: number, written = ''): string {
    const width = `${Math.floor(maxWidth)}px`
    const height = `${Math.floor(maxHeight)}px`
    const caps = `${width} ${height}`
    if (caps !== written) {
      box.style.setProperty('--dez-preview-max-width', width)
      box.style.setProperty('--dez-preview-max-height', height)
    }
    return caps
  }

  // The entrance: a fade, and a short slide away from the chip unless the
  // user asks for less motion.
  private reveal(shown: Shown): void {
    shown.revealed = true
    shown.box.setAttribute('data-shown', '')
    const shift = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : `translateY(${shown.side === 'above' ? 4 : -4}px)`
    shown.box.animate([{ opacity: 0, transform: shift }, { opacity: 1, transform: 'none' }], { duration: ENTRANCE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  }
}

const assetPreviewPlugin = ViewPlugin.fromClass(AssetPreview, {
  eventHandlers: {
    mousemove(event) {
      this.onEditorMove(event)
    },
    mousedown(event) {
      this.onEditorPress(event)
    },
    scroll() {
      if (this.shown) this.measure()
    },
  },
})

/** The preview box of the mention chips (`mentionChips()`). Escape closes
 *  the box first, before the other uses of the key (Stop, the close of
 *  find). The CSS is in `dezTheme`. */
export function assetPreview(): Extension {
  return [
    assetPreviewPlugin,
    Prec.highest(keymap.of([{ key: 'Escape', run: (view) => view.plugin(assetPreviewPlugin)?.closeByKey() ?? false }])),
  ]
}
