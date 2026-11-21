import { MapMode, type EditorState, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, closeHoverTooltips, type ViewUpdate } from '@codemirror/view'
import type { HiddenAsset } from '../../model/chat/hiddenAssets'
import { sectionsField } from '../thread/cmEditor'
import { compactionBlockEnd } from './compactionBlock'
import { openCompactionChips, showKeptAssetRow, toggleCompactionChipEffect } from './compactionChip'
import { ASSET_FLASH_MS, drawnAssetAt, flashDrawnAsset } from './drawnAssets'
import { hiddenAssets } from './hiddenAssets'
import { renderedImages } from './images'
import { sectionTexts } from './lineBlocks'
import { renderedMedia } from './media'
import type { ShownMention } from './mentions'
import { openToolCallEffects, renderedToolCalls } from './toolCalls'

// A click on a mention chip (mentions.ts) shows the asset that the chip
// names: the editor opens the chip that hides it (a tool call chip, or the
// assets chip of a compaction), scrolls it into view, and flashes a ring
// around it (`flashDrawnAsset`). The panel stays open, as after a click
// on its chip.
//
// CodeMirror can scroll only to a doc offset, and it draws only the lines
// near its view: a far asset, and the asset of a panel that opens, have no
// element yet. So CM first scrolls to the place of the text that it knows,
// and then, in each frame for a short time, the jump looks for the drawn
// element (drawnAssets.ts) and scrolls that element into view. It does so
// again when the element moves (an image above it loads and gets its
// height). A wheel, a key, or a press of the user ends the jump.

/** Where the asset of a mention is drawn: the chip whose panel shows it,
 *  or null for an asset at its own place. */
export type AssetHolder =
  /** The tool call chip of the call `id`, whose text starts at `from`. */
  | { kind: 'call', id: string, from: number }
  /** Row `row` of the kept assets of the compaction (`AssetList.vue`). */
  | { kind: 'compaction', row: number }

/** The asset that a click on a mention chip shows: `from` is where its
 *  text starts in the doc, the place of its drawn element
 *  (`drawnAssetAt`). */
export interface AssetTarget {
  from: number
  holder: AssetHolder | null
}

/** The asset that a click on `mention` shows in `state`: the first drawn
 *  asset in doc order that has the id and the kind of the mention, up to
 *  the end of the section of the mention (the assets that the mention can
 *  name, `namedMentions`). Null when the editor draws none: an image
 *  reference on a table row line or on a line with a pill marker is
 *  shown as text (`renderedImages`). An asset of the compaction block
 *  is drawn only in the assets panel of the compaction, and a hidden asset
 *  only in the panel of its chip (`hiddenAssets`). */
export function mentionTarget(state: EditorState, mention: Pick<ShownMention, 'from' | 'id' | 'kind'>): AssetTarget | null {
  const sections = state.field(sectionsField, false)
  if (!sections) return null
  const section = sectionTexts(state.doc.toString(), sections).find(({ from, text }) => from <= mention.from && mention.from <= from + text.length)
  if (!section) return null
  const sectionEnd = section.from + section.text.length
  const hidden = hiddenAssets(state)
  const hiddenStarts = new Set(hidden.map(({ from }) => from))
  const blockEnd = compactionBlockEnd(state.doc)
  const shown = mention.kind === 'image' ? renderedImages(state) : renderedMedia(state).filter(({ kind }) => kind === mention.kind)
  const atOwnPlace = shown
    .filter(({ id, from }) => id === mention.id && from >= blockEnd && !hiddenStarts.has(from))
    .map(({ from }): AssetTarget => ({ from, holder: null }))
  const inPanels = hiddenTargets(state, hidden, mention)
  return [...atOwnPlace, ...inPanels]
    .filter(({ from }) => from < sectionEnd)
    .reduce<AssetTarget | null>((first, target) => first && first.from <= target.from ? first : target, null)
}

/** The targets of the hidden assets that `mention` names, each in the
 *  panel of its chip. A linked image of the compaction block is only in
 *  these: `renderedImages` reads the compaction section with the agent
 *  rule, where a linked path does not count. */
function hiddenTargets(state: EditorState, hidden: readonly HiddenAsset[], mention: Pick<ShownMention, 'id' | 'kind'>): AssetTarget[] {
  const calls = renderedToolCalls(state)
  // The rows of the kept assets are the hidden assets of the compaction,
  // in doc order (`compactionChipData`).
  let keptRow = 0
  return hidden.flatMap((asset): AssetTarget[] => {
    const row = asset.owner.kind === 'compaction' ? keptRow++ : -1
    const named = asset.kind === 'image'
      ? mention.kind === 'image' && asset.image.id === mention.id
      : asset.tag.kind === mention.kind && asset.tag.id === mention.id
    if (!named) return []
    const { owner } = asset
    if (owner.kind === 'compaction') return [{ from: asset.from, holder: { kind: 'compaction', row } }]
    const call = calls.find(({ id, intermediate }) => id === owner.callId && intermediate?.jobIds.includes(owner.jobId))
    return call ? [{ from: asset.from, holder: { kind: 'call', id: call.id, from: call.from } }] : []
  })
}

/** A jump that runs. */
interface Jump {
  view: EditorView
  /** The state that `from` is an offset of. */
  state: EditorState
  /** Where the text of the asset starts in `state`. */
  from: number
  /** The row of the kept assets list that holds the asset; null when the
   *  asset is in no such list. */
  keptRow: number | null
  /** Whether the kept assets list took the request to draw `keptRow`. */
  rowAsked: boolean
  /** The drawn element of the asset, once found. */
  element: HTMLElement | null
  /** Where `element` was after the last scroll. */
  shownRect: DOMRect | null
  /** When the jump ends (`performance.now()` time): a time to find the
   *  element, then the time of its flash. */
  endTime: number
  frame: number
}

let running: Jump | null = null

// Any of these from the user ends a jump: the user scrolls or does
// something else, and a later scroll of the jump would fight the user.
const USER_ACTIONS = ['wheel', 'keydown', 'pointerdown'] as const

function endJump(): void {
  if (!running) return
  cancelAnimationFrame(running.frame)
  running = null
  for (const type of USER_ACTIONS) window.removeEventListener(type, endJump, true)
}

/** The doc changes while a jump runs (a stream adds text): the offset of
 *  the asset follows them. A change that deletes or replaces the first
 *  character of the asset ends the jump: else the jump could flash another
 *  asset that then starts there, such as the next asset after a delete of
 *  the asset's line. A Save that writes the tag of the asset again ends it
 *  too. A new state of the view (`setState`, a tab switch) calls no update
 *  listener, so the jump sees that `state` is not the view's any more. */
function followDocChanges(update: ViewUpdate): void {
  const jump = running
  if (!jump || jump.view !== update.view || jump.state !== update.startState) return
  const from = update.changes.mapPos(jump.from, 1, MapMode.TrackAfter)
  if (from === null) {
    endJump()
    return
  }
  jump.from = from
  jump.state = update.state
}

/** The extension that keeps the asset of a running jump at its text
 *  (`mentionChips()`). */
export function assetJumps(): Extension {
  return EditorView.updateListener.of(followDocChanges)
}

/** Opens what hides the asset of `target`, scrolls the asset into view,
 *  and flashes it. Ends any jump that runs. */
export function jumpToAsset(view: EditorView, target: AssetTarget): void {
  endJump()
  const { state } = view
  const { holder } = target
  const effects: StateEffect<unknown>[] = [closeHoverTooltips]
  if (holder?.kind === 'call') effects.push(...openToolCallEffects(state, holder.id))
  if (holder?.kind === 'compaction' && !openCompactionChips(state).assets) effects.push(toggleCompactionChipEffect.of('assets'))
  // CM scrolls to a doc offset only when the asset has no element yet: to
  // its own place, or to the chip whose panel holds it (the compaction
  // chips are at the end of the first line). A drawn asset scrolls in the
  // first frame of the jump, to its middle.
  if (!drawnAssetAt(view, target.from)) {
    const place = holder === null ? target.from : holder.kind === 'call' ? holder.from : state.doc.line(1).to
    effects.push(EditorView.scrollIntoView(place, { y: holder === null ? 'center' : 'start' }))
  }
  view.dispatch({ effects })
  const jump: Jump = {
    view,
    state: view.state,
    from: target.from,
    keptRow: holder?.kind === 'compaction' ? holder.row : null,
    rowAsked: false,
    element: null,
    shownRect: null,
    endTime: performance.now() + ASSET_FLASH_MS,
    frame: 0,
  }
  running = jump
  for (const type of USER_ACTIONS) window.addEventListener(type, endJump, true)
  jump.frame = requestAnimationFrame(() => jumpFrame(jump))
}

// One frame of `jump`: find the element of the asset (a new one, when CM
// or a list drew it again), flash it, and scroll it into view when it
// moved. A jump that finds no element in time ends with no scroll and no
// flash.
function jumpFrame(jump: Jump): void {
  if (running !== jump) return
  const { view } = jump
  if (!view.dom.isConnected || view.state !== jump.state || performance.now() > jump.endTime) {
    endJump()
    return
  }
  if (!jump.element?.isConnected) {
    const found = drawnAssetAt(view, jump.from)
    if (found) {
      if (!jump.element) jump.endTime = performance.now() + ASSET_FLASH_MS
      jump.element = found
      jump.shownRect = null
      flashDrawnAsset(found)
    } else if (jump.keptRow !== null && !jump.rowAsked) {
      // A far row of the kept assets list has no element: the list draws
      // only the rows near its own view.
      jump.rowAsked = showKeptAssetRow(view, jump.keptRow)
    }
  }
  const { element } = jump
  if (element?.isConnected && !sameRect(element.getBoundingClientRect(), jump.shownRect)) {
    revealElement(view, element)
    jump.shownRect = element.getBoundingClientRect()
  }
  jump.frame = requestAnimationFrame(() => jumpFrame(jump))
}

function sameRect(rect: DOMRect, other: DOMRect | null): boolean {
  return !!other && rect.top === other.top && rect.bottom === other.bottom && rect.left === other.left && rect.right === other.right
}

/** Scrolls `element` into view: first in each scroll box between it and
 *  the scroller of `view` (the kept assets list), then in the scroller. */
function revealElement(view: EditorView, element: HTMLElement): void {
  for (let box = element.parentElement; box && box !== view.scrollDOM; box = box.parentElement) {
    if (isScrollBox(box)) revealIn(box, element, 0, 0)
  }
  // The find dropdown covers the top of the scroller (`ThreadEditor.vue`).
  let top = 0
  let bottom = 0
  for (const margins of view.state.facet(EditorView.scrollMargins)) {
    const rect = margins(view)
    top = Math.max(top, rect?.top ?? 0)
    bottom = Math.max(bottom, rect?.bottom ?? 0)
  }
  revealIn(view.scrollDOM, element, top, bottom)
}

function isScrollBox(element: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(element)
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight
}

/** Scrolls `box` so that `element` is in its visible part, less `top` and
 *  `bottom` px: not at all when it is there already, else to its middle,
 *  or to its top when it is taller than that part. The scroll is instant,
 *  as a find jump: the jump ends on the user's next scroll. Never with
 *  `Element.scrollIntoView`, which scrolls every box up to the window. */
function revealIn(box: HTMLElement, element: HTMLElement, top: number, bottom: number): void {
  const boxRect = box.getBoundingClientRect()
  const visibleTop = boxRect.top + box.clientTop + top
  const visibleBottom = boxRect.top + box.clientTop + box.clientHeight - bottom
  const rect = element.getBoundingClientRect()
  if (rect.top >= visibleTop && rect.bottom <= visibleBottom) return
  const visibleHeight = visibleBottom - visibleTop
  box.scrollTop += rect.height > visibleHeight
    ? rect.top - visibleTop
    : rect.top + rect.height / 2 - (visibleTop + visibleHeight / 2)
}
