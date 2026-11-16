import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { readCompactionTag } from '../../model/chat/compaction'
import type { ShownPicture } from '../../model/chat/shownPictures'
import { countOf } from '../../utils/countText'
import { SECTION_SEP } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { hiddenAssets, hiddenAssetsOfChips } from './hiddenAssets'
import { sectionRolesChanged } from './lineBlocks'
import { isInSelectableTooltip } from './media'
import { ROUND_STROKE, svgIcon } from './svgIcon'
import {
  CHIP_CLASS,
  NAME_CLASS,
  PANEL_CLASS,
  ROOT_CLASS,
  createChip,
  createPictures,
  destroyPanelPlayers,
  disclosureTriangle,
  panelAsset,
  renderHiddenPart,
  renderOpenState,
  span,
  type PanelAsset,
} from './toolCalls'

// The compaction chip: a chip right under the AGENT pill of a compaction
// section (compaction.ts), with the look of a tool call chip and its
// builders (toolCalls.ts). It has no text in the doc. Its panel shows what
// the compaction keeps out of view: the kept images and clips of the
// conversation (hiddenAssets.ts), and the pictures that the model was shown
// (the `pictures` of the tag). Its counts also tell how many assets the
// compaction took out of the conversation (the `dropped` of the tag).

/** What the compaction chip of a state shows. */
export interface CompactionChipData {
  /** The `count` of the compaction tag. */
  count: number
  /** The `dropped` of the compaction tag: how many assets the compaction
   *  took out; null when the tag does not tell it (a tag of an older
   *  Dez). */
  dropped: number | null
  /** The kept assets of the conversation, in doc order. */
  assets: readonly PanelAsset[]
  /** The pictures of the compaction tag. */
  pictures: readonly ShownPicture[]
}

/** What the compaction chip of `state` shows; null when the doc does not
 *  start with a compaction tag. A kept asset before the first section
 *  separator is in the compaction section, which has the role agent. Each
 *  other one is in a user section that holds the carried assets of the
 *  user (`findKeptAssets`). */
export function compactionChipData(state: EditorState): CompactionChipData | null {
  const tag = readCompactionTag(state.doc.line(1).text)
  if (!tag) return null
  const kept = hiddenAssets(state).filter((asset) => asset.owner.kind === 'compaction')
  const firstSeparator = kept.length === 0 ? -1 : state.doc.toString().indexOf(SECTION_SEP)
  return {
    count: tag.count,
    dropped: tag.dropped ?? null,
    assets: kept.map((asset) => panelAsset(asset, firstSeparator < 0 || asset.from < firstSeparator ? 'agent' : 'user')),
    pictures: tag.pictures,
  }
}

const COMPACTION_CHIP_CLASS = 'dez-compaction-chip'
const COUNT_CLASS = 'dez-compaction-chip__count'

function hasPanel(data: CompactionChipData): boolean {
  return data.assets.length > 0 || data.pictures.length > 0
}

/** Two arrows that point at a line from above and below. */
function compressIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['path', { d: 'M8 1.5v4.5M5.5 3.5L8 6l2.5-2.5M8 14.5V10M5.5 12.5L8 10l2.5 2.5M2.5 8h11', ...ROUND_STROKE, 'stroke-width': '1.4' }],
  ])
}

/** Draws the counts at the end of `chip`: the kept assets and the
 *  pictures, each one only when it is not zero, and between them the
 *  dropped assets, whenever the tag tells their count (also 0). A chip
 *  with a panel gets an accessible name that holds them, as screen readers
 *  skip the triangle. */
function renderCounts(chip: HTMLElement, data: CompactionChipData): void {
  for (const count of chip.querySelectorAll(`.${COUNT_CLASS}`)) count.remove()
  const counts = [
    ...(data.assets.length > 0 ? [countOf(data.assets.length, 'kept asset')] : []),
    ...(data.dropped === null ? [] : [`${data.dropped} dropped`]),
    ...(data.pictures.length > 0 ? [countOf(data.pictures.length, 'picture')] : []),
  ]
  chip.append(...counts.map((text) => span(COUNT_CLASS, text)))
  if (hasPanel(data)) chip.setAttribute('aria-label', [`Compaction ${data.count}`, ...counts].join(', '))
}

/** Draws the kept assets as the first part of the open `panel`
 *  (`renderHiddenPart`); none when there are none. */
function renderKeptPart(view: EditorView, panel: HTMLElement, data: CompactionChipData): void {
  renderHiddenPart(view, panel, { kind: 'compaction' }, 'Kept assets', data.assets)
}

function createPanel(view: EditorView, data: CompactionChipData): HTMLElement {
  const panel = span(PANEL_CLASS)
  if (data.pictures.length > 0) panel.append(...createPictures(view, data.pictures, 'Pictures shown to the model'))
  renderKeptPart(view, panel, data)
  return panel
}

/** Opens or closes the panel of the compaction chip. */
export const toggleCompactionChipEffect = StateEffect.define<null>()

/** Whether the panel of the compaction chip is open. View state, never
 *  saved: ThreadEditor starts each tab with the panel closed and copies the
 *  value when it builds the state of the same tab again. */
const compactionChipOpenField = StateField.define<boolean>({
  create: () => false,
  update: (open, tr) => tr.effects.reduce((value, effect) => effect.is(toggleCompactionChipEffect) ? !value : value, open),
})

/** Whether the panel of the compaction chip is open in `state`. */
export function openCompactionChip(state: EditorState): boolean {
  return state.field(compactionChipOpenField, false) ?? false
}

/** The data that each drawn chip root shows. The open state changes the
 *  drawn DOM in place (`compactionChipOpenUpdater`), which needs it. */
const drawnData = new WeakMap<HTMLElement, CompactionChipData>()

/** `renderOpenState` for the chip root `root`; nothing for a chip with no
 *  panel. */
function renderCompactionOpenState(view: EditorView, root: HTMLElement, data: CompactionChipData, open: boolean): boolean {
  if (!hasPanel(data)) return false
  return renderOpenState(root, open, open ? 'Hide compaction' : 'Show compaction', () => createPanel(view, data))
}

class CompactionChipWidget extends WidgetType {
  constructor(readonly data: CompactionChipData) {
    super()
  }
  // The data holds no doc offsets, and its fields keep one order.
  eq(other: WidgetType): boolean {
    return other instanceof CompactionChipWidget && JSON.stringify(other.data) === JSON.stringify(this.data)
  }
  toDOM(view: EditorView): HTMLElement {
    // A block widget is a child of the content element, so a block element.
    const root = document.createElement('div')
    root.className = `${ROOT_CLASS} ${COMPACTION_CHIP_CLASS}`
    const toggle = hasPanel(this.data) ? () => view.dispatch({ effects: toggleCompactionChipEffect.of(null) }) : null
    const chip = createChip(toggle && disclosureTriangle(), compressIcon(), [span(NAME_CLASS, `Compaction ${this.data.count}`)], toggle)
    renderCounts(chip, this.data)
    root.appendChild(chip)
    renderCompactionOpenState(view, root, this.data, openCompactionChip(view.state))
    drawnData.set(root, this.data)
    // As on a tool call chip: a press keeps the caret and the focus where
    // they are, but in the clock's tooltip of a kept clip's player.
    root.addEventListener('mousedown', (event) => {
      if (!isInSelectableTooltip(event.target)) event.preventDefault()
    })
    return root
  }
  // A Save or a Delete changes the tag of a kept clip, and the trash takes
  // a kept image out of the doc. A new chip would make new players (a clip
  // that plays would stop), so the drawn chip takes the new assets in
  // place (`renderAssets`: a clip whose section changed its role gets a
  // new player). A change of the count, of the pictures, or of whether the
  // chip has a panel makes a new chip.
  updateDOM(dom: HTMLElement, view: EditorView, from: CompactionChipWidget): boolean {
    const chip = dom.querySelector<HTMLElement>(`.${CHIP_CLASS}`)
    const { data } = this
    if (!chip || !drawnData.has(dom) || from.data.count !== data.count || hasPanel(from.data) !== hasPanel(data)
      || JSON.stringify(from.data.pictures) !== JSON.stringify(data.pictures)) return false
    drawnData.set(dom, data)
    renderCounts(chip, data)
    const panel = dom.querySelector<HTMLElement>(`.${PANEL_CLASS}`)
    if (panel) renderKeptPart(view, panel, data)
    // The panel can have a new height.
    measureLineHeights(view)
    return true
  }
  destroy(dom: HTMLElement): void {
    destroyPanelPlayers(dom)
  }
  // The widget takes its own events (the chip's press and keys, the
  // controls of a kept asset); CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

function buildCompactionChip(state: EditorState): DecorationSet {
  const data = compactionChipData(state)
  if (!data) return Decoration.none
  const widget = Decoration.widget({ widget: new CompactionChipWidget(data), block: true, side: 1 })
  return Decoration.set(widget.range(state.doc.line(1).to))
}

/** The chip, as a block after the tag line, which shows as the pill of the
 *  section. Block decorations must come from a state field. */
const compactionChipField = StateField.define<DecorationSet>({
  create: buildCompactionChip,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? buildCompactionChip(tr.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})

/** Opens and closes the drawn panel in place when the open state changes;
 *  `toDOM` reads the state, so a chip that CM draws again is up to date. */
const compactionChipOpenUpdater = ViewPlugin.define(() => ({
  update({ startState, state, view }: ViewUpdate) {
    const open = openCompactionChip(state)
    if (open === openCompactionChip(startState)) return
    const root = view.contentDOM.querySelector<HTMLElement>(`.${COMPACTION_CHIP_CLASS}`)
    const data = root && drawnData.get(root)
    if (root && data && renderCompactionOpenState(view, root, data, open)) measureLineHeights(view)
  },
}))

/** The compaction chip for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), with its panel open when `open`, and the hidden
 *  assets (`hiddenAssetsOfChips`), which hold the kept assets. The CSS is
 *  in `dezTheme`. The state needs `sectionsField`. */
export function compactionChip(open = false): Extension {
  return [
    hiddenAssetsOfChips(),
    compactionChipField,
    open ? compactionChipOpenField.init(() => true) : compactionChipOpenField,
    compactionChipOpenUpdater,
  ]
}
