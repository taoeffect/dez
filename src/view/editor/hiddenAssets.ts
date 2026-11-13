import { StateField, type EditorState, type Extension, type Line, type Text } from '@codemirror/state'
import { WidgetType, type EditorView } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { findHiddenAssets, type HiddenAsset } from '../../model/chat/hiddenAssets'
import { IMAGE_HIDDEN_KEY } from '../../model/chat/images'
import { MEDIA_HIDDEN_ATTRIBUTE } from '../../model/chat/mediaTags'
import { ASSET_NAMES, type JobAssetKind } from '../../model/tools/jobs'
import { SECTION_SEP, sectionsField } from '../thread/cmEditor'
import { agentSectionTexts, chipBlocks, sectionRolesChanged } from './lineBlocks'
import type { DocRange } from './pendingRanges'
import { ROUND_STROKE, svgIcon } from './svgIcon'
import { tableRowStarts } from './tables'

// The editor's side of the hidden assets (src/model/chat/hiddenAssets.ts):
// which assets of the doc a chip hides now, the lines that go out of view
// with them, and what shows at the place of such an asset. The asset itself
// shows in the panel of its chip (toolCalls.ts).
//
// The text of a hidden asset stays where it is, and the editor still knows
// it as an image or a clip (`renderedImages`, `renderedMedia`): find skips
// its source, the caret cannot go into it, and its trash finds it. Only its
// widget is another one (`HiddenAssetWidget`), on a line of no height.
//
// images.ts, media.ts, and toolCalls.ts read this module. It must import
// none of them.

/** Tells where the text of a drawn image or player starts in the doc now;
 *  null when it is not in the doc any more. The trash, the Save, and the
 *  tooltips of an asset work on its text. An asset at its own place finds
 *  its text by its DOM. A hidden asset is drawn in the panel of its chip,
 *  whose DOM is at the place of the chip, so the chip gives this. */
export type AssetPlace = () => number | null

interface HiddenAssetsInDoc {
  /** In doc order, with doc offsets. */
  assets: readonly HiddenAsset[]
  /** The start of each line that the assets take out of view, in doc
   *  order (`hiddenLines`). */
  lines: readonly number[]
  /** For the asset at the same index of `assets`: the whole lines that go
   *  out of the doc with it (`hiddenLines`). */
  removals: readonly DocRange[]
}

const NOTHING_HIDDEN: HiddenAssetsInDoc = { assets: [], lines: [], removals: [] }

// `edge`: no line of the same section (the doc start or end, or the line
// of a section separator).
function lineKind(doc: Text, number: number): 'edge' | 'blank' | 'text' {
  if (number < 1 || number > doc.lines) return 'edge'
  const { text } = doc.line(number)
  if (text.includes(SECTION_SEP)) return 'edge'
  return text.trim() === '' ? 'blank' : 'text'
}

/** The lines that `assets` (in doc order, one on a line) take out of view,
 *  and the lines that go out of the doc with each asset.
 *
 *  The writer of an asset puts a blank line before it, and the text that
 *  follows starts after one more (`writeAsset` in stream.ts). With only
 *  the asset's line out of view, two blank lines would show where the
 *  reader sees no reason for them. So one blank line goes with the asset:
 *  the line before it, else the line after it. That holds only when blank
 *  lines (or the section's start or end) are on both sides: next to text
 *  on one side, the one blank line there is what keeps that text apart
 *  from the other side. Assets on lines that follow each other count as
 *  one, and no blank line goes with two of them.
 *
 *  The trash of an asset takes the same lines out of the doc, so that the
 *  text looks the same before and after. */
function hiddenLines(doc: Text, assets: readonly HiddenAsset[]): Pick<HiddenAssetsInDoc, 'lines' | 'removals'> {
  const lines: number[] = []
  const removals: DocRange[] = []
  // The number of the last blank line that went with an asset.
  let taken = 0
  for (let index = 0; index < assets.length;) {
    const first = doc.lineAt(assets[index].from)
    let last = first
    let end = index + 1
    while (end < assets.length && doc.lineAt(assets[end].from).number === last.number + 1) last = doc.lineAt(assets[end++].from)
    const before = lineKind(doc, first.number - 1)
    const after = lineKind(doc, last.number + 1)
    let blank: Line | null = null
    if (before !== 'text' && after !== 'text') {
      if (before === 'blank' && first.number - 1 !== taken) blank = doc.line(first.number - 1)
      else if (after === 'blank') blank = doc.line(last.number + 1)
    }
    if (blank) taken = blank.number
    if (blank && blank.number < first.number) lines.push(blank.from)
    for (let number = first.number; number <= last.number; number++) {
      const line = doc.line(number)
      lines.push(line.from)
      // The blank line goes with an asset only when no other asset needs
      // it.
      removals.push(blank && first.number === last.number
        ? { from: Math.min(line.from, blank.from), to: Math.max(line.to, blank.to) }
        : { from: line.from, to: line.to })
    }
    if (blank && blank.number > last.number) lines.push(blank.from)
    index = end
  }
  return { lines, removals }
}

/** The hidden assets of a state. Each agent section is read on its own,
 *  with the blocks that show as chips (`chipBlocks`): an asset is hidden
 *  only while a chip can show it. An asset that images.ts or media.ts
 *  leaves as source text stays in view too: one on a line with a sentinel
 *  (a prompt pill), and an image reference on a table row line (its
 *  metadata holds `|`). */
function findHiddenAssetsInDoc(state: EditorState): HiddenAssetsInDoc {
  const doc = state.doc.toString()
  // Most docs have none, and this runs on every doc change.
  if (!doc.includes(`${IMAGE_HIDDEN_KEY}=`) && !doc.includes(`${MEDIA_HIDDEN_ATTRIBUTE}=`)) return NOTHING_HIDDEN
  const assets: HiddenAsset[] = []
  for (const { from: offset, text } of agentSectionTexts(doc, state.field(sectionsField, false) ?? [])) {
    for (const asset of findHiddenAssets(text, chipBlocks(text))) {
      const from = offset + asset.from
      const to = offset + asset.to
      const line = state.doc.lineAt(from)
      if (SENTINEL_CHAR.test(line.text) || (asset.kind === 'image' && tableRowStarts(state.doc).has(line.from))) continue
      assets.push(asset.kind === 'image'
        ? { ...asset, from, to, image: { ...asset.image, from, to } }
        : { ...asset, from, to, tag: { ...asset.tag, from, to } })
    }
  }
  return assets.length === 0 ? NOTHING_HIDDEN : { assets, ...hiddenLines(state.doc, assets) }
}

const hiddenAssetsField = StateField.define<HiddenAssetsInDoc>({
  create: findHiddenAssetsInDoc,
  update: (value, tr) => tr.docChanged || sectionRolesChanged(tr) ? findHiddenAssetsInDoc(tr.state) : value,
})

/** The assets that a chip hides in `state`, in doc order, with doc offsets;
 *  none for a state without `markdownToolCalls()`. The array is the same
 *  object until the doc or the sections change. */
export function hiddenAssets(state: EditorState): readonly HiddenAsset[] {
  return (state.field(hiddenAssetsField, false) ?? NOTHING_HIDDEN).assets
}

/** The start of each line that the hidden assets of `state` take out of
 *  view, in doc order (`hiddenLines`). toolCalls.ts gives these lines no
 *  height, with the blank lines between chips. */
export function hiddenLineStarts(state: EditorState): readonly number[] {
  return (state.field(hiddenAssetsField, false) ?? NOTHING_HIDDEN).lines
}

/** The whole lines that go out of the doc with the hidden asset that
 *  starts at `from` (`hiddenLines`); null when no hidden asset starts
 *  there. */
export function hiddenAssetLines(state: EditorState, from: number): DocRange | null {
  const { assets, removals } = state.field(hiddenAssetsField, false) ?? NOTHING_HIDDEN
  const index = assets.findIndex((asset) => asset.from === from)
  return index < 0 ? null : removals[index]
}

/** An eye: open for an asset that shows, closed (an eyelid with lashes)
 *  for one that is hidden. Both have their middle at the middle of the
 *  box, so that the symbol does not move down when the eye closes. */
export function eyeIcon(open: boolean): SVGSVGElement {
  return svgIcon('0 0 16 16', open
    ? [
        ['path', { d: 'M1.5 8c1.7-2.8 3.9-4.2 6.5-4.2s4.8 1.4 6.5 4.2c-1.7 2.8-3.9 4.2-6.5 4.2S3.2 10.8 1.5 8z', ...ROUND_STROKE, 'stroke-width': '1.3' }],
        ['circle', { cx: '8', cy: '8', r: '2', ...ROUND_STROKE, 'stroke-width': '1.3' }],
      ]
    : [
        ['path', { d: 'M1.7 5.2c1.6 2.3 3.7 3.5 6.3 3.5s4.7-1.2 6.3-3.5', ...ROUND_STROKE, 'stroke-width': '1.3' }],
        ['path', { d: 'M8 8.7v2.2M4.7 8l-1.1 1.9M11.3 8l1.1 1.9', ...ROUND_STROKE, 'stroke-width': '1.3' }],
      ])
}

/** What shows at the place of a hidden asset, in place of its image or its
 *  player: one quiet line that names the asset and tells where it shows.
 *  Its line has no height while no caret is on it (`hiddenLineStarts`), so
 *  the user sees it only after a key put the caret there. Every size of it
 *  is in `em` (`dezTheme`), so that it has no size on such a line. */
export class HiddenAssetWidget extends WidgetType {
  constructor(readonly kind: JobAssetKind, readonly id: string | null) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof HiddenAssetWidget && other.kind === this.kind && other.id === this.id
  }
  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = 'dez-hidden-asset'
    const name = this.id === null ? ASSET_NAMES[this.kind] : `${ASSET_NAMES[this.kind]} @${this.id}`
    root.append(eyeIcon(false), `Hidden intermediate ${name}. Open its tool call to see it.`)
    return root
  }
}

// Backspace at the start of the line after a hidden asset, or Delete at the
// end of the line before it (`forward`).
function revealHiddenLine(view: EditorView, forward: boolean): boolean {
  const { doc, selection } = view.state
  if (selection.ranges.length !== 1 || !selection.main.empty) return false
  const caret = selection.main.head
  const line = doc.lineAt(caret)
  const number = line.number + (forward ? 1 : -1)
  if (caret !== (forward ? line.to : line.from) || number < 1 || number > doc.lines) return false
  const hidden = doc.line(number)
  if (!hiddenAssets(view.state).some((asset) => asset.from >= hidden.from && asset.to <= hidden.to)) return false
  view.dispatch({ selection: { anchor: forward ? hidden.from : hidden.to }, scrollIntoView: true, userEvent: 'select' })
  return true
}

/** Backspace with one caret at the start of the line after a hidden asset
 *  only puts the caret onto the asset's line, which then shows
 *  (`HiddenAssetWidget`). The line above has no height, so without this
 *  rule the key would delete an asset (a clip is a line block) or join its
 *  line to the text, and the user would not have seen what the key works
 *  on. The next Backspace is the normal one. */
export function revealHiddenLineBackward(view: EditorView): boolean {
  return revealHiddenLine(view, false)
}

/** Delete with one caret at the end of the line before a hidden asset (see
 *  `revealHiddenLineBackward`). */
export function revealHiddenLineForward(view: EditorView): boolean {
  return revealHiddenLine(view, true)
}

/** The field of the hidden assets. `markdownToolCalls()` includes it: with
 *  no chips, nothing is hidden. */
export function hiddenAssetsOfChips(): Extension {
  return hiddenAssetsField
}
