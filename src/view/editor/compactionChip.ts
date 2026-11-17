import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { blockLinkedRule, readCompactionBlock, type CompactionBlock } from '../../model/chat/compaction'
import { compactionNotesParts } from '../../model/chat/compactionNotes'
import { linkedPathCounts } from '../../model/chat/images'
import type { ShownPicture } from '../../model/chat/shownPictures'
import { countOf } from '../../utils/countText'
import { measureLineHeights } from '../thread/editorMeasure'
import { compactionBlockRange } from './compactionBlock'
import { hiddenAssets, hiddenAssetsOfChips } from './hiddenAssets'
import { sectionRolesChanged } from './lineBlocks'
import { isInSelectableTooltip } from './media'
import { ROUND_STROKE, svgIcon } from './svgIcon'
import {
  CHIP_CLASS,
  HEADING_CLASS,
  NAME_CLASS,
  PANEL_CLASS,
  ROOT_CLASS,
  createChip,
  createField,
  createPictures,
  destroyPanelPlayers,
  disclosureTriangle,
  panelAsset,
  renderHiddenPart,
  renderOpenState,
  span,
  type PanelAsset,
} from './toolCalls'

// The compaction chips: two chips right under the AGENT pill of a
// compaction section, in place of the lines of the compaction block after
// its tag line (compactionBlock.ts). They have the look of a tool call chip
// and its builders (toolCalls.ts), and start closed, as every chip.
//
// - The assets chip: its counts tell how many assets the compaction kept
//   and dropped (the `dropped` of the tag), and how many pictures the model
//   was shown (the `pictures` of the tag). Its panel shows every asset of
//   the block (hiddenAssets.ts), the pictures, and the assets part of the
//   notes. In a conversation of an older Dez, it also shows the kept
//   assets of the section of the carried assets of the user.
// - The summary chip: its panel shows every other part of the notes.
//
// The notes show as text for people (`compactionNotesParts`), in read-only
// fields: the user can no longer edit them.

/** What the compaction chips of a state show. */
export interface CompactionChipData {
  /** The `count` of the compaction tag. */
  count: number
  /** The `dropped` of the compaction tag: how many assets the compaction
   *  took out; null when the tag does not tell it (a tag of an older
   *  Dez). */
  dropped: number | null
  /** The assets of the block and, in a conversation of an older Dez, the
   *  kept assets of the carried assets of the user, in doc order. */
  assets: readonly PanelAsset[]
  /** The pictures of the compaction tag. */
  pictures: readonly ShownPicture[]
  /** The assets part of the notes, for people. */
  assetsText: string
  /** Every other part of the notes, for people. */
  summary: string
}

/** The two chips. */
export type CompactionChipPart = 'assets' | 'summary'

/** Whether the panel of each chip is open. */
export type CompactionChipsOpen = Readonly<Record<CompactionChipPart, boolean>>

const CLOSED: CompactionChipsOpen = { assets: false, summary: false }

/** The last block text that `notesParts` read, and the parts of its notes.
 *  Each doc change (a token of a reply) reads the chips again, and the
 *  block stays the same. The key is the whole block, as the rule of its
 *  linked paths is in its tag. */
let lastNotes: { blockText: string, parts: ReturnType<typeof compactionNotesParts> } | null = null

function notesParts(blockText: string, block: CompactionBlock): ReturnType<typeof compactionNotesParts> {
  if (lastNotes?.blockText !== blockText) lastNotes = { blockText, parts: compactionNotesParts(block.notes, blockLinkedRule(block)) }
  return lastNotes.parts
}

/** What the compaction chips of `state` show; null when the doc does not
 *  start with a compaction block. An asset before the end of the block is
 *  in the compaction block, where a linked path counts only when the tag
 *  lists it. Each other one is in a user section of an older Dez that
 *  holds the carried assets of the user (`findKeptAssets`). */
export function compactionChipData(state: EditorState): CompactionChipData | null {
  const [range] = compactionBlockRange(state.doc)
  const blockText = range ? state.sliceDoc(range.from, range.to) : ''
  const block = range && readCompactionBlock(blockText)
  if (!block) return null
  const rule = blockLinkedRule(block)
  const kept = hiddenAssets(state).filter((asset) => asset.owner.kind === 'compaction')
  const { assets, summary } = notesParts(blockText, block)
  return {
    count: block.count,
    dropped: block.dropped ?? null,
    assets: kept.map((asset) => {
      const inBlock = asset.from < blockText.length
      const src = asset.kind === 'clip' ? asset.tag.src : null
      return panelAsset(asset, inBlock ? src !== null && linkedPathCounts(src, rule) : true)
    }),
    pictures: block.pictures,
    assetsText: assets,
    summary,
  }
}

const CHIPS_CLASS = 'dez-compaction-chips'
const COMPACTION_CHIP_CLASS = 'dez-compaction-chip'
const COUNT_CLASS = 'dez-compaction-chip__count'
const NOTES_CLASS = 'dez-compaction-chip__notes'
const PART_ATTRIBUTE = 'data-part'

const PARTS: readonly CompactionChipPart[] = ['assets', 'summary']

function hasPanel(part: CompactionChipPart, data: CompactionChipData): boolean {
  if (part === 'summary') return data.summary !== ''
  return data.assets.length > 0 || data.pictures.length > 0 || data.assetsText !== ''
}

function chipName(part: CompactionChipPart, data: CompactionChipData): string {
  return `Compaction ${data.count} ${part}`
}

/** Two arrows that point at a line from above and below. */
function compressIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['path', { d: 'M8 1.5v4.5M5.5 3.5L8 6l2.5-2.5M8 14.5V10M5.5 12.5L8 10l2.5 2.5M2.5 8h11', ...ROUND_STROKE, 'stroke-width': '1.4' }],
  ])
}

/** A picture frame with a hill and a sun. */
function assetsIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['rect', { x: '2', y: '3', width: '12', height: '10', rx: '1.5', ...ROUND_STROKE, 'stroke-width': '1.3' }],
    ['path', { d: 'M2.5 11.5l3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5', ...ROUND_STROKE, 'stroke-width': '1.3' }],
    ['circle', { cx: '10.5', cy: '6', r: '1', ...ROUND_STROKE, 'stroke-width': '1.3' }],
  ])
}

/** Draws the counts at the end of the assets chip `chip`: the kept assets,
 *  the dropped assets whenever the tag tells their count (also 0), and the
 *  pictures when there are some. A chip with a panel gets an accessible
 *  name that holds them, as screen readers skip the triangle. */
function renderCounts(chip: HTMLElement, data: CompactionChipData): void {
  for (const count of chip.querySelectorAll(`.${COUNT_CLASS}`)) count.remove()
  const counts = [
    `${data.assets.length} kept`,
    ...(data.dropped === null ? [] : [`${data.dropped} dropped`]),
    ...(data.pictures.length > 0 ? [countOf(data.pictures.length, 'picture')] : []),
  ]
  chip.append(...counts.map((text) => span(COUNT_CLASS, text)))
  if (hasPanel('assets', data)) chip.setAttribute('aria-label', [chipName('assets', data), ...counts].join(', '))
}

/** Draws the assets as the first part of the open assets `panel`
 *  (`renderHiddenPart`), in a long list: a conversation can keep some
 *  hundred of them. None when there are none. */
function renderKeptPart(view: EditorView, panel: HTMLElement, data: CompactionChipData): void {
  renderHiddenPart(view, panel, { kind: 'compaction' }, 'Kept assets', data.assets, { long: true })
}

/** Draws `text` in its own part at the end of `panel`, in a read-only field
 *  (`createField`) under `heading`; none for no text. A new text takes the
 *  place of the drawn one. */
function renderNotesPart(panel: HTMLElement, heading: string | null, text: string): void {
  const drawn = panel.querySelector<HTMLElement>(`.${NOTES_CLASS}`)
  if (drawn?.dataset.text === text) return
  drawn?.remove()
  if (text === '') return
  const part = span(NOTES_CLASS)
  part.dataset.text = text
  if (heading) part.appendChild(span(HEADING_CLASS, heading))
  part.appendChild(createField(text, heading ?? 'Compaction summary', ''))
  panel.appendChild(part)
}

const NOTES_HEADING = 'What each asset is'

function createPanel(view: EditorView, part: CompactionChipPart, data: CompactionChipData): HTMLElement {
  const panel = span(PANEL_CLASS)
  if (part === 'summary') {
    renderNotesPart(panel, null, data.summary)
    return panel
  }
  if (data.pictures.length > 0) panel.append(...createPictures(view, data.pictures, 'Pictures shown to the model'))
  renderNotesPart(panel, NOTES_HEADING, data.assetsText)
  renderKeptPart(view, panel, data)
  return panel
}

/** Opens or closes the panel of one compaction chip. */
export const toggleCompactionChipEffect = StateEffect.define<CompactionChipPart>()

/** Whether the panel of each compaction chip is open. View state, never
 *  saved: ThreadEditor starts each tab with both closed and copies the
 *  value when it builds the state of the same tab again. */
const compactionChipOpenField = StateField.define<CompactionChipsOpen>({
  create: () => CLOSED,
  update: (open, tr) => tr.effects.reduce((value, effect) => effect.is(toggleCompactionChipEffect) ? { ...value, [effect.value]: !value[effect.value] } : value, open),
})

/** Whether the panel of each compaction chip is open in `state`. */
export function openCompactionChips(state: EditorState): CompactionChipsOpen {
  return state.field(compactionChipOpenField, false) ?? CLOSED
}

/** The data that each drawn widget root shows. The open state changes the
 *  drawn DOM in place (`compactionChipOpenUpdater`), which needs it. */
const drawnData = new WeakMap<HTMLElement, CompactionChipData>()

function partRoot(root: HTMLElement, part: CompactionChipPart): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${PART_ATTRIBUTE}="${part}"]`)
}

/** `renderOpenState` for the chip `part` of the widget root `root`;
 *  nothing for a chip with no panel. */
function renderPartOpenState(view: EditorView, root: HTMLElement, part: CompactionChipPart, data: CompactionChipData, open: boolean): boolean {
  const chipRoot = partRoot(root, part)
  if (!chipRoot || !hasPanel(part, data)) return false
  const words = `compaction ${part}`
  return renderOpenState(chipRoot, open, open ? `Hide ${words}` : `Show ${words}`, () => createPanel(view, part, data))
}

function createChipRoot(view: EditorView, part: CompactionChipPart, data: CompactionChipData): HTMLElement {
  // A block widget is a child of the content element, so a block element.
  const root = document.createElement('div')
  root.className = `${ROOT_CLASS} ${COMPACTION_CHIP_CLASS}`
  root.setAttribute(PART_ATTRIBUTE, part)
  const toggle = hasPanel(part, data) ? () => view.dispatch({ effects: toggleCompactionChipEffect.of(part) }) : null
  const icon = part === 'assets' ? assetsIcon() : compressIcon()
  const chip = createChip(toggle && disclosureTriangle(), icon, [span(NAME_CLASS, chipName(part, data))], toggle)
  if (part === 'assets') renderCounts(chip, data)
  root.appendChild(chip)
  return root
}

// The parts of the data that a drawn widget cannot take in place.
function sameShape(a: CompactionChipData, b: CompactionChipData): boolean {
  return a.count === b.count && JSON.stringify(a.pictures) === JSON.stringify(b.pictures) && PARTS.every((part) => hasPanel(part, a) === hasPanel(part, b))
}

class CompactionChipsWidget extends WidgetType {
  constructor(readonly data: CompactionChipData) {
    super()
  }
  // The data holds no doc offsets, and its fields keep one order.
  eq(other: WidgetType): boolean {
    if (!(other instanceof CompactionChipsWidget)) return false
    const { data } = other
    return sameShape(data, this.data) && data.dropped === this.data.dropped && data.assetsText === this.data.assetsText
      && data.summary === this.data.summary && JSON.stringify(data.assets) === JSON.stringify(this.data.assets)
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = CHIPS_CLASS
    const open = openCompactionChips(view.state)
    for (const part of PARTS) {
      root.appendChild(createChipRoot(view, part, this.data))
      renderPartOpenState(view, root, part, this.data, open[part])
    }
    drawnData.set(root, this.data)
    // As on a tool call chip: a press keeps the caret and the focus where
    // they are, but in the clock's tooltip of a clip's player.
    root.addEventListener('mousedown', (event) => {
      if (!isInSelectableTooltip(event.target)) event.preventDefault()
    })
    return root
  }
  // A Save or a Delete changes the tag of a clip, and the trash takes an
  // image out of the doc. New chips would make new players (a clip that
  // plays would stop), so the drawn chips take the new assets in place
  // (`AssetList.vue`: a clip whose `linkedSrc` changed gets a new player).
  // A change of the count, of the pictures, or of whether a chip has a
  // panel makes new chips.
  updateDOM(dom: HTMLElement, view: EditorView, from: CompactionChipsWidget): boolean {
    const assetsRoot = partRoot(dom, 'assets')
    const chip = assetsRoot?.querySelector<HTMLElement>(`.${CHIP_CLASS}`)
    const { data } = this
    if (!assetsRoot || !chip || !drawnData.has(dom) || !sameShape(from.data, data)) return false
    drawnData.set(dom, data)
    renderCounts(chip, data)
    const assetsPanel = assetsRoot.querySelector<HTMLElement>(`.${PANEL_CLASS}`)
    if (assetsPanel) {
      renderNotesPart(assetsPanel, NOTES_HEADING, data.assetsText)
      renderKeptPart(view, assetsPanel, data)
    }
    const summaryPanel = partRoot(dom, 'summary')?.querySelector<HTMLElement>(`.${PANEL_CLASS}`)
    if (summaryPanel) renderNotesPart(summaryPanel, null, data.summary)
    // A panel can have a new height.
    measureLineHeights(view)
    return true
  }
  destroy(dom: HTMLElement): void {
    destroyPanelPlayers(dom)
  }
  // The widget takes its own events (the chips' presses and keys, the
  // controls of an asset); CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

/** The lines of the block after its tag line: the chips show in their
 *  place. */
const hiddenBlockLines = Decoration.replace({ block: true })

function buildCompactionChips(state: EditorState): DecorationSet {
  const data = compactionChipData(state)
  const [block] = compactionBlockRange(state.doc)
  if (!data || !block) return Decoration.none
  const tagLine = state.doc.line(1)
  const chips = Decoration.widget({ widget: new CompactionChipsWidget(data), block: true, side: 1 }).range(tagLine.to)
  return Decoration.set(block.to > tagLine.to ? [chips, hiddenBlockLines.range(tagLine.to + 1, block.to)] : [chips])
}

/** The chips, as a block after the tag line, which shows as the pill of
 *  the section, and the other lines of the block out of view. Block
 *  decorations must come from a state field. */
const compactionChipField = StateField.define<DecorationSet>({
  create: buildCompactionChips,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? buildCompactionChips(tr.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})

/** Opens and closes the drawn panels in place when the open state changes;
 *  `toDOM` reads the state, so chips that CM draws again are up to date. */
const compactionChipOpenUpdater = ViewPlugin.define(() => ({
  update({ startState, state, view }: ViewUpdate) {
    const open = openCompactionChips(state)
    const before = openCompactionChips(startState)
    if (open === before) return
    const root = view.contentDOM.querySelector<HTMLElement>(`.${CHIPS_CLASS}`)
    const data = root && drawnData.get(root)
    if (!root || !data) return
    let changed = false
    for (const part of PARTS) {
      if (open[part] !== before[part] && renderPartOpenState(view, root, part, data, open[part])) changed = true
    }
    if (changed) measureLineHeights(view)
  },
}))

/** The compaction chips for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), with the panels of `open` open, and the hidden
 *  assets (`hiddenAssetsOfChips`), which hold the assets of the assets
 *  chip. The CSS is in `dezTheme`. The state needs `sectionsField`. */
export function compactionChip(open: CompactionChipsOpen = CLOSED): Extension {
  return [
    hiddenAssetsOfChips(),
    compactionChipField,
    open === CLOSED ? compactionChipOpenField : compactionChipOpenField.init(() => open),
    compactionChipOpenUpdater,
  ]
}
