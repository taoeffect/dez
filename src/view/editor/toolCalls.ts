import sbp from '@sbp/sbp'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { jobResultInBlocks, type HiddenAsset } from '../../model/chat/hiddenAssets'
import type { MediaTagData } from '../../model/chat/mediaTags'
import { parseModelRefKey } from '../../model/chat/modelRef'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, type ToolBlock } from '../../model/chat/toolBlocks'
import { MODEL_OUTPUT_IDS, effectiveOutputs, type ModelOutput } from '../../model/modelOutputs'
import type { ModelInfo } from '../../model/providers/types'
import { jobOwnText, startedJobId, type JobResultStatus } from '../../model/tools/jobs'
import { MODEL_INVOKE_TOOL } from '../../model/tools/modelInvoke'
import { toolDefinition } from '../../model/tools/registry'
import type { ToolArguments } from '../../model/tools/types'
import { sectionsField, type SectionModel } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { streamingSectionField } from '../thread/modelChip'
import { eyeIcon, hiddenAssets, hiddenAssetsOfChips, hiddenLineStarts, type AssetPlace } from './hiddenAssets'
import { createImage, imageIcon } from './images'
import { agentSectionTexts, chipBlocks, lineBlocks, sectionRolesChanged } from './lineBlocks'
import { createPlayer, destroyPlayer, isInSelectableTooltip, updatePlayer } from './media'
import type { DocRange } from './pendingRanges'
import { ROUND_STROKE, svgIcon } from './svgIcon'

// The editor shows each `<dez:tool>` block of an agent section
// (`src/model/chat/toolBlocks.ts`) as a quiet one-line chip: a disclosure
// triangle, a wrench, the tool name, and a short form of its arguments. A
// call to a tool that Dez does not have says so before the name, with no
// short form (`UNRECOGNIZED_TOOL_TEXT`). A click on the chip, or Enter or
// Space while it has the focus, opens a panel under it with the parameters
// and the result. The block's text stays in the doc as it is: the chip only
// hides it.
//
// The chip of an intermediate call (`IntermediateCall`) also has an eye, a
// symbol for the type of what the call made, and a label; its panel shows
// what the call hides: its images and clips (hiddenAssets.ts), or its text.

/** How a chip shows its call. `running`: a reply runs the tool now.
 *  `interrupted`: a `running` block that no reply runs (the app stopped
 *  while the tool ran); requests send it as an error. */
export type ToolCallState = 'success' | 'error' | 'running' | 'interrupted'

/** A hidden asset as the panel of its chip draws it, with no doc offsets:
 *  what `createImage` or `createPlayer` takes. */
export type IntermediateAsset =
  | { kind: 'image', path: string, id: string | null, linked: boolean }
  | { kind: 'clip', tag: MediaTagData }

/** What the chip of an intermediate call shows on top of the parts of
 *  every chip. A call is intermediate when its `model_invoke` call has
 *  `is_intermediate`, and it runs or started a job; or when it owns a
 *  hidden asset. A call that failed before it started a job is a failed
 *  call as any other. */
export interface IntermediateCall {
  /** The Dez job that the call started; null while the call runs. */
  jobId: string | null
  /** The images and clips of the job that the chip hides, in doc order. */
  assets: readonly IntermediateAsset[]
  /** The text that the job made, when that is all it made: it is in the
   *  result of a `jobs_wait` block, which few users open. Blank for a job
   *  with assets, and for one that did not finish. */
  text: string
  /** The status of the job's result in a `jobs_wait` block; null while no
   *  block has one (the job runs, or its reply ended first). */
  status: JobResultStatus | null
}

/** A block that the editor shows as a chip; `from` and `to` are doc
 *  offsets. */
export interface RenderedToolCall extends ToolBlock {
  state: ToolCallState
  /** Null for a call that is not intermediate. */
  intermediate: IntermediateCall | null
}

/** How the editor spaces the lines of the chips. The text of a reply has
 *  no blank line between its text and a group of calls, and one blank line
 *  between two groups with no text between them (`toolGroupAppendText` in
 *  toolRound.ts). That text must stay as it is: `agentRounds` (messages.ts)
 *  reads the rounds of a reply from it, and the bytes of every later
 *  request. So the look is made here, with no text change: chips that
 *  follow each other are always close together, and a chip is as far from
 *  content with no blank line between them as with one. Content is a line
 *  of the same section that is not blank and not a chip (text, an image, a
 *  player); the start and the end of a section are not content. A hidden
 *  asset (hiddenAssets.ts) is no content: its line counts as a blank line.
 *  Positions are doc offsets, in doc order. */
interface ChipSpacing {
  /** The start of each blank line between two chips. Such a line takes no
   *  height (`collapsedLines`). */
  gapLines: number[]
  /** The start of each chip whose line above is content. The chip's line
   *  gets the height of one blank line as space there. */
  contentAbove: number[]
  /** As `contentAbove`, for the line below. */
  contentBelow: number[]
}

interface ToolCallDecorations {
  /** In doc order. */
  calls: readonly RenderedToolCall[]
  chips: DecorationSet
  /** The space of the chips next to content (`ChipSpacing`). */
  space: DecorationSet
  /** The start of each line that takes no height, in doc order: the blank
   *  lines between chips (`ChipSpacing.gapLines`), and the lines that the
   *  hidden assets take out of view (`hiddenLineStarts`). */
  noHeightLines: readonly number[]
  /** A line of no height at each of `noHeightLines`. */
  collapsed: DecorationSet
}

/** The longest argument text that a chip shows, in characters, `…`
 *  included. */
const SUMMARY_MAX_CHARS = 40

/** What a chip says before the name of a tool that Dez does not have: an
 *  old tool that this Dez no longer has (such as `crop_scale_image`), or a
 *  name that a model made up, whose call `checkToolCalls` (toolRound.ts)
 *  refused. Requests still send such a call and its result as they are. */
const UNRECOGNIZED_TOOL_TEXT = 'old/unrecognized tool:'

function isUnrecognizedTool(name: string): boolean {
  return toolDefinition(name) === undefined
}

/** The chip's short form of a call's arguments: the value of the first one
 *  on one line, a string in quotes, cut with `…` past `SUMMARY_MAX_CHARS`;
 *  '' for a call with no arguments. A call to a tool that Dez does not have
 *  gets '' too: its chip text is long already, and its arguments follow no
 *  Dez schema (the panel shows them all). */
export function toolCallSummary(name: string, args: ToolArguments): string {
  if (isUnrecognizedTool(name)) return ''
  const [first] = Object.values(args)
  if (first === undefined) return ''
  const chars = [...(typeof first === 'string' ? first : JSON.stringify(first)).replace(/\s+/g, ' ').trim()]
  const text = chars.length > SUMMARY_MAX_CHARS ? `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join('').trimEnd()}…` : chars.join('')
  return typeof first === 'string' ? `"${text}"` : text
}

const WHITE_SPACE_RUN = /\s*/y

/** Whether `text` holds only white space from `from` to `to`. Sentinels
 *  (section separators, pill markers) are no white space. */
function isBlank(text: string, from: number, to: number): boolean {
  WHITE_SPACE_RUN.lastIndex = from
  WHITE_SPACE_RUN.test(text)
  return WHITE_SPACE_RUN.lastIndex >= to
}

/** Whether the line above the chip `chip` of `text` is not blank. A chip
 *  starts at a line start, so the line above ends one char before it. */
function hasTextAbove(text: string, chip: DocRange): boolean {
  if (chip.from === 0) return false
  const lineEnd = chip.from - 1
  return !isBlank(text, lineEnd === 0 ? 0 : text.lastIndexOf('\n', lineEnd - 1) + 1, lineEnd)
}

/** Whether the line below the chip `chip` of `text` is not blank. A chip
 *  ends at a line end. */
function hasTextBelow(text: string, chip: DocRange): boolean {
  if (chip.to === text.length) return false
  const lineEnd = text.indexOf('\n', chip.to + 1)
  return !isBlank(text, chip.to + 1, lineEnd < 0 ? text.length : lineEnd)
}

/** Adds the spacing of one section to `spacing`. `chips` are the chips of
 *  the section in order, as ranges in its `text`, which starts at `offset`
 *  in the doc. */
function addSectionSpacing(spacing: ChipSpacing, text: string, offset: number, chips: readonly DocRange[]): void {
  chips.forEach((chip, index) => {
    const previous: DocRange | undefined = chips[index - 1]
    // Only line breaks and blank lines are between the two chips: each
    // line between them is a gap line. Chips of one group have none.
    if (previous && isBlank(text, previous.to, chip.from)) {
      for (let line = previous.to + 1; line < chip.from; line = text.indexOf('\n', line) + 1) spacing.gapLines.push(offset + line)
      return
    }
    if (previous && hasTextBelow(text, previous)) spacing.contentBelow.push(offset + previous.from)
    if (hasTextAbove(text, chip)) spacing.contentAbove.push(offset + chip.from)
  })
  const last = chips.at(-1)
  if (last && hasTextBelow(text, last)) spacing.contentBelow.push(offset + last.from)
}

/** What the chip of `call` shows as an intermediate call, or null
 *  (`IntermediateCall`). `chips` are the chips of the call's section, and
 *  `hidden` the hidden assets of that section. */
function intermediateCall(call: ToolBlock, state: ToolCallState, chips: readonly ToolBlock[], hidden: readonly HiddenAsset[]): IntermediateCall | null {
  const jobId = startedJobId(call.result)
  const assets = jobId === null ? [] : hidden.filter((asset) => asset.jobId === jobId)
  const asked = call.name === MODEL_INVOKE_TOOL.name && call.arguments.is_intermediate === true && (state === 'running' || jobId !== null)
  if (assets.length === 0 && !asked) return null
  const result = jobId === null ? null : jobResultInBlocks(chips, jobId)
  const text = result?.status === 'finished' && assets.length === 0 ? jobOwnText(result.text) : ''
  return {
    jobId,
    assets: assets.map((asset): IntermediateAsset => {
      if (asset.kind === 'image') return { kind: 'image', path: asset.image.path, id: asset.image.id, linked: asset.image.linked }
      // Without the tag's offsets, which every token before it changes.
      const { kind, id, type, src, url, expires, other } = asset.tag
      return { kind: 'clip', tag: { kind, id, type, src, url, expires, other } }
    }),
    text: text.trim() === '' ? '' : text,
    status: result?.status ?? null,
  }
}

/** The blocks that the editor shows as chips, in doc order, and the spacing
 *  of their lines. Each agent section is read on its own: the recognizer
 *  stops only at the next `dez:` tag, so an opening line in one section
 *  could pair with a closing line in a later one. Left as text: blocks in
 *  user sections (plain text there), and blocks that hold a sentinel
 *  (`chipBlocks`). A `running` block runs only in the section that the
 *  active tab's stream writes into. `hidden` are the hidden assets of the
 *  doc, with doc offsets. */
function findRenderedToolCalls(doc: string, sections: readonly SectionModel[], streamingSectionId: string | null, hidden: readonly HiddenAsset[]): { calls: RenderedToolCall[], spacing: ChipSpacing } {
  const calls: RenderedToolCall[] = []
  const spacing: ChipSpacing = { gapLines: [], contentAbove: [], contentBelow: [] }
  if (!doc.includes('<dez:tool')) return { calls, spacing }
  for (const { section, from, text } of agentSectionTexts(doc, sections)) {
    const chips = chipBlocks(text)
    const sectionHidden = hidden.filter((asset) => asset.from >= from && asset.to <= from + text.length)
    for (const block of chips) {
      const state = block.status !== 'running' ? block.status : section.id === streamingSectionId ? 'running' : 'interrupted'
      calls.push({ ...block, from: from + block.from, to: from + block.to, state, intermediate: intermediateCall(block, state, chips, sectionHidden) })
    }
    // Spaces stand for the text of each hidden asset, so that its line
    // counts as a blank line (`ChipSpacing`). A chip with only a hidden
    // asset between it and text, and no blank line, gets no space there;
    // the writers of an asset always put a blank line on one side.
    let spaced = text
    for (const asset of sectionHidden) spaced = `${spaced.slice(0, asset.from - from)}${' '.repeat(asset.to - asset.from)}${spaced.slice(asset.to - from)}`
    addSectionSpacing(spacing, spaced, from, chips)
  }
  return { calls, spacing }
}

/** Opens or closes the panel of every chip whose call has this id. */
const toggleToolCallOpenEffect = StateEffect.define<string>()

/** The ids of the calls whose panel is open. Keyed by call id, so a panel
 *  stays open when its running block becomes the final block. View state,
 *  never saved: ThreadEditor starts each tab with all panels closed and
 *  copies the set when it builds the state of the same tab again. */
const toolCallsOpenField = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (!effect.is(toggleToolCallOpenEffect)) continue
      const copy = new Set(next)
      if (!copy.delete(effect.value)) copy.add(effect.value)
      next = copy
    }
    return next
  },
})

/** The ids of the calls whose panel is open in `state`. */
export function openToolCalls(state: EditorState): ReadonlySet<string> {
  return state.field(toolCallsOpenField, false) ?? new Set()
}

/** The call that each drawn chip root shows. The open state changes the
 *  drawn DOM in place (`toolCallOpenUpdater`), which needs the call. */
const drawnCalls = new WeakMap<HTMLElement, RenderedToolCall>()

const ROOT_CLASS = 'dez-tool-call'
const CHIP_CLASS = 'dez-tool-call__chip'
const PANEL_CLASS = 'dez-tool-call__panel'
const HEADING_CLASS = 'dez-tool-call__heading'
const RESULT_CLASS = 'dez-tool-call__result'
const RESULT_TEXT_CLASS = 'dez-tool-call__result-text'
const INTERMEDIATE_CLASS = 'dez-tool-call__intermediate'
const HIDDEN_PART_CLASS = 'dez-tool-call__hidden'
const ASSETS_CLASS = 'dez-tool-call__assets'

/** An open-end wrench. */
function wrenchIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['path', { d: 'M13.42 4.37A3 3 0 1 1 11.63 2.58L11.45 4.55Z', ...ROUND_STROKE, 'stroke-width': '1.4' }],
    ['path', { d: 'M8.48 7.52L3.2 12.8', ...ROUND_STROKE, 'stroke-width': '1.8' }],
  ])
}

// The symbol of each type of what an intermediate call made. The image,
// video, and audio symbols are the ones of the id badges of an image
// (`imageIcon`) and of a player (`MediaPlayer.vue`), so that a type has one
// symbol in the whole editor.
const TYPE_ICONS: Readonly<Record<ModelOutput, () => SVGSVGElement>> = {
  image: imageIcon,
  // A film camera.
  video: () => svgIcon('0 0 16 16', [
    ['rect', { x: '1.8', y: '4', width: '8.6', height: '8', rx: '1.8', ...ROUND_STROKE, 'stroke-width': '1.3' }],
    ['path', { d: 'M10.4 7.2l3.8-2.2v6l-3.8-2.2', ...ROUND_STROKE, 'stroke-width': '1.3' }],
  ]),
  // Sound bars.
  audio: () => svgIcon('0 0 16 16', [['path', { d: 'M3 6.5v3M5.5 4.4v7.2M8 2.8v10.4M10.5 5v6M13 6.7v2.6', ...ROUND_STROKE, 'stroke-width': '1.3' }]]),
  // Lines of text, the last one short.
  text: () => svgIcon('0 0 16 16', [['path', { d: 'M2.5 4.2h11M2.5 8h11M2.5 11.8h6.5', ...ROUND_STROKE, 'stroke-width': '1.3' }]]),
}

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

const STATE_WORDS: Partial<Record<ToolCallState, string>> = { error: 'failed', interrupted: 'interrupted' }

/** The chip's accessible name. Its `aria-label` replaces the text of the
 *  chip's parts, so it holds the summary and the state word too, and
 *  "running" stands for the spinner, which screen readers skip. `note` is
 *  the label of an intermediate call (`intermediateLabel`). Empty parts are
 *  left out. A tool that Dez does not have is named as its chip names
 *  it. */
export function toolCallLabel(name: string, summary: string, state: ToolCallState, note = ''): string {
  const word = state === 'running' ? 'running' : STATE_WORDS[state]
  const tool = isUnrecognizedTool(name) ? `Tool call, ${UNRECOGNIZED_TOOL_TEXT} ${name}` : `Tool call ${name}`
  return [tool, summary, word, note].filter(Boolean).join(', ')
}

/** The label of an intermediate chip: what the chip hides, and, while its
 *  panel is closed (`open` false), that it is hidden. A call that hides
 *  nothing (it runs, it failed, its reply ended first, or its assets are
 *  gone) is only named as intermediate. */
export function intermediateLabel({ assets, text }: IntermediateCall, open: boolean): string {
  const what = assets.length > 1 ? ' assets' : assets.length === 1 ? ' asset' : text !== '' ? ' text' : ''
  return `intermediate${what}${what === '' || open ? '' : ' hidden'}`
}

/** The type symbols of an intermediate chip, in the order of
 *  `MODEL_OUTPUTS`: each type of its hidden assets, or `text` for a hidden
 *  text. Before the job has a result, the chip tells what the call's model
 *  makes (`outputs`, null for a model that Dez does not know): the one type
 *  that is not text, or text for a model that makes only text. A job that
 *  ended with nothing to hide has no symbol: it made nothing of a type. */
export function intermediateSymbols({ assets, text, status }: IntermediateCall, outputs: readonly ModelOutput[] | null): ModelOutput[] {
  if (assets.length > 0) {
    const kinds = new Set<ModelOutput>(assets.map((asset) => asset.kind === 'image' ? 'image' : asset.tag.kind))
    return MODEL_OUTPUT_IDS.filter((id) => kinds.has(id))
  }
  if (text !== '') return ['text']
  if (status !== null || outputs === null) return []
  const made = outputs.filter((output) => output !== 'text')
  if (made.length === 0) return outputs.length > 0 ? ['text'] : []
  return made.length === 1 ? [made[0]] : []
}

// The outputs of the model that a `model_invoke` call names; null for a
// model that the model cache does not have.
function namedModelOutputs(call: RenderedToolCall): readonly ModelOutput[] | null {
  const ref = typeof call.arguments.model === 'string' ? parseModelRefKey(call.arguments.model) : null
  const model = ref && sbp('dez.model/modelCache/model', ref.providerId, ref.modelId) as ModelInfo | null
  return model ? effectiveOutputs(model) : null
}

/** Draws the intermediate part of `chip`, at its end, for an open or a
 *  closed panel, and the chip's accessible name, which holds the part's
 *  label: an eye, the type symbols, and the label. The eye is closed while
 *  the chip hides something. It is open, and lit (`data-revealed`,
 *  `dezTheme`), while the open panel shows that. A call that is not
 *  intermediate has no such part. */
function renderIntermediate(chip: HTMLElement, call: RenderedToolCall, open: boolean): void {
  chip.querySelector(`.${INTERMEDIATE_CLASS}`)?.remove()
  const { intermediate } = call
  const label = intermediate ? intermediateLabel(intermediate, open) : ''
  chip.setAttribute('aria-label', toolCallLabel(call.name, toolCallSummary(call.name, call.arguments), call.state, label))
  if (!intermediate) return
  const part = span(INTERMEDIATE_CLASS)
  const revealed = open && (intermediate.assets.length > 0 || intermediate.text !== '')
  if (revealed) part.setAttribute('data-revealed', '')
  const eye = span('dez-tool-call__eye')
  eye.appendChild(eyeIcon(revealed))
  part.appendChild(eye)
  // The model cache is read at each draw, not kept in the widget: a chip
  // that is drawn before the model list came has no symbol until its next
  // draw.
  for (const symbol of intermediateSymbols(intermediate, namedModelOutputs(call))) {
    const type = span('dez-tool-call__type')
    type.setAttribute('data-type', symbol)
    type.appendChild(TYPE_ICONS[symbol]())
    part.appendChild(type)
  }
  part.appendChild(span('dez-tool-call__intermediate-label', label))
  chip.appendChild(part)
}

function createChip(view: EditorView, call: RenderedToolCall): HTMLElement {
  const chip = span(CHIP_CLASS)
  chip.setAttribute('role', 'button')
  chip.tabIndex = 0
  // The spinner element stays as long as the widget, so its animation runs
  // without restarts until the call ends.
  const slot = call.state === 'running' ? span('dez-tool-call__spinner') : span('dez-tool-call__disclosure', '▶')
  slot.setAttribute('aria-hidden', 'true')
  const icon = span('dez-tool-call__icon')
  icon.appendChild(wrenchIcon())
  chip.append(slot, icon)
  // The words go in their own span, so the name keeps the name's look
  // (`dezTheme`) and the flex gap spaces the two.
  if (isUnrecognizedTool(call.name)) chip.appendChild(span('dez-tool-call__unrecognized', UNRECOGNIZED_TOOL_TEXT))
  chip.appendChild(span('dez-tool-call__name', call.name))
  const summary = toolCallSummary(call.name, call.arguments)
  if (summary !== '') chip.appendChild(span('dez-tool-call__summary', summary))
  const word = STATE_WORDS[call.state]
  if (word) chip.appendChild(span('dez-tool-call__state', word))
  const toggle = () => view.dispatch({ effects: toggleToolCallOpenEffect.of(call.id) })
  chip.addEventListener('mousedown', (event) => {
    if (event.button === 0) toggle()
  })
  chip.addEventListener('keydown', (event) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    toggle()
  })
  return chip
}

/** A read-only text field, with the thinking panel's sizing
 *  (`renderPillThinking` in thinkingPill.ts): a hidden mirror of the text
 *  and the textarea share one grid cell, so the field is as tall as its
 *  text without script measuring, and its box scrolls past its max height.
 *  The CSS shares the thinking field's rules in `dezTheme`. A text field
 *  gives native selection, select all, and copy of the text. `label` is the
 *  field's accessible name, and `placeholder` shows for a blank text. */
function createField(text: string, label: string, placeholder: string): HTMLElement {
  const box = span(RESULT_CLASS)
  const mirror = span('dez-tool-call__result-mirror', text)
  mirror.setAttribute('aria-hidden', 'true')
  const field = document.createElement('textarea')
  field.className = RESULT_TEXT_CLASS
  field.readOnly = true
  field.rows = 1
  field.spellcheck = false
  field.value = text
  field.placeholder = placeholder
  field.setAttribute('aria-label', label)
  box.append(mirror, field)
  return box
}

/** The key of a hidden asset among the assets of one call. A drawn asset
 *  whose key stays keeps its element: an image's path and id tell its
 *  file, and a clip's kind and id never change (a Save or a Delete changes
 *  only its `src`). */
function assetKey(asset: IntermediateAsset): string {
  return JSON.stringify(asset.kind === 'image' ? ['image', asset.path, asset.id, asset.linked] : [asset.tag.kind, asset.tag.id])
}

/** The key (`assetKey`, with a count before it) of each asset that a panel
 *  draws. */
const drawnAssetKeys = new WeakMap<Element, string>()

/** Draws `assets`, the hidden assets of the job `jobId`, in `list`, each
 *  as it shows at its own place when it is not hidden: an image with its
 *  toolbar, a clip in its player (`createImage`, `createPlayer`).
 *
 *  A drawn asset that is still there keeps its element, and a kept element
 *  moves only when the order changed: a player that leaves the document
 *  stops, and ends its fullscreen. So a Save of a hidden clip, which
 *  changes its tag, keeps its player (`updatePlayer`).
 *
 *  Each asset tells where its text is in the doc now (`AssetPlace`) by its
 *  job and its key, as its element is at the place of the chip. */
function renderAssets(view: EditorView, list: HTMLElement, jobId: string | null, assets: readonly IntermediateAsset[]): void {
  const drawn = new Map<string, HTMLElement>()
  for (const element of list.children) drawn.set(drawnAssetKeys.get(element) ?? '', element as HTMLElement)
  // How many of the assets so far have each key: two references to one
  // file (a duplicated line) are two elements.
  const counts = new Map<string, number>()
  const next = assets.map((asset) => {
    const key = assetKey(asset)
    const count = counts.get(key) ?? 0
    counts.set(key, count + 1)
    const kept = drawn.get(`${count}:${key}`)
    if (kept) {
      drawn.delete(`${count}:${key}`)
      if (asset.kind === 'clip') updatePlayer(kept, asset.tag)
      return kept
    }
    const place: AssetPlace = () => hiddenAssets(view.state)
      .filter((hidden) => hidden.jobId === jobId && assetKey(hidden.kind === 'image' ? { ...hidden.image, kind: 'image' } : hidden) === key)[count]?.from ?? null
    const element = asset.kind === 'image' ? createImage(view, asset, place) : createPlayer(view, asset.tag, 'agent', place)
    drawnAssetKeys.set(element, `${count}:${key}`)
    return element
  })
  for (const gone of drawn.values()) {
    destroyPlayer(gone)
    gone.remove()
  }
  next.forEach((element, index) => {
    if (list.children[index] !== element) list.insertBefore(element, list.children[index] ?? null)
  })
}

/** Takes down the players of the hidden clips that `panel` draws, before
 *  it leaves the document: only `destroyPlayer` frees a mounted player. */
function destroyPanelPlayers(panel: Element): void {
  for (const asset of panel.querySelectorAll<HTMLElement>(`.${ASSETS_CLASS} > *`)) destroyPlayer(asset)
}

/** Draws what the call hides as the first part of its open `panel`: its
 *  hidden assets (`renderAssets`), else the text of its job, as the reason
 *  to open the chip of an intermediate call is to see that. The part is
 *  gone when the call hides nothing (any more). */
function renderHiddenPart(view: EditorView, panel: HTMLElement, call: RenderedToolCall): void {
  const assets = call.intermediate?.assets ?? []
  const text = call.intermediate?.text ?? ''
  let part = panel.querySelector<HTMLElement>(`.${HIDDEN_PART_CLASS}`)
  if (assets.length === 0 && text === '') {
    if (part) destroyPanelPlayers(part)
    part?.remove()
    return
  }
  if (!part) {
    part = span(HIDDEN_PART_CLASS)
    part.append(span(HEADING_CLASS), span(ASSETS_CLASS))
    panel.prepend(part)
  }
  const [heading, list] = part.children
  renderAssets(view, list as HTMLElement, call.intermediate?.jobId ?? null, assets)
  part.querySelector(`.${RESULT_CLASS}`)?.remove()
  heading.textContent = assets.length > 1 ? 'Intermediate assets' : assets.length === 1 ? 'Intermediate asset' : 'Intermediate text'
  if (assets.length === 0) part.appendChild(createField(text, 'Intermediate text', ''))
}

function createPanel(view: EditorView, call: RenderedToolCall): HTMLElement {
  const panel = span(PANEL_CLASS)
  const parameters = Object.entries(call.arguments)
  if (parameters.length > 0) {
    const rows = span('dez-tool-call__parameters')
    for (const [name, value] of parameters) {
      rows.append(span('dez-tool-call__parameter-name', name), span('dez-tool-call__parameter-value', typeof value === 'string' ? value : JSON.stringify(value)))
    }
    panel.append(span(HEADING_CLASS, 'Parameters'), rows)
  }
  const result = createField(call.state === 'interrupted' ? INTERRUPTED_TOOL_RESULT : call.result, 'Result', call.state === 'running' ? 'Running…' : EMPTY_TOOL_RESULT)
  if (call.state === 'error' || call.state === 'interrupted') result.setAttribute('data-error', '')
  panel.append(span(HEADING_CLASS, 'Result'), result)
  renderHiddenPart(view, panel, call)
  return panel
}

/** Draws the open or closed state of the chip root `root`: the chip's
 *  state for screen readers, its title, its intermediate part, and the
 *  panel. Returns whether the panel came or went. */
function renderOpenState(view: EditorView, root: HTMLElement, call: RenderedToolCall, open: boolean): boolean {
  const chip = root.querySelector<HTMLElement>(`.${CHIP_CLASS}`)
  if (!chip || chip.getAttribute('aria-expanded') === String(open)) return false
  chip.setAttribute('aria-expanded', String(open))
  chip.title = open ? 'Hide tool call' : 'Show tool call'
  renderIntermediate(chip, call, open)
  const panel = root.querySelector(`.${PANEL_CLASS}`)
  if (open === (panel !== null)) return false
  if (panel) {
    destroyPanelPlayers(panel)
    panel.remove()
    root.removeAttribute('data-open')
  } else {
    root.appendChild(createPanel(view, call))
    root.setAttribute('data-open', '')
  }
  return true
}

// Every part of a call that the chip draws, but its intermediate data.
// Arguments keep their definition order, so equal ones give equal JSON.
function sameCall(a: RenderedToolCall, b: RenderedToolCall): boolean {
  return a.id === b.id && a.name === b.name && a.state === b.state && a.result === b.result && JSON.stringify(a.arguments) === JSON.stringify(b.arguments)
}

/** A chip and, while open, its panel. The open state is not part of the
 *  widget: `toolCallOpenUpdater` changes it in place, so a chip that has
 *  the focus keeps it when Enter opens its panel (CM puts a changed widget
 *  into a new line element, which takes the focus away). */
class ToolCallWidget extends WidgetType {
  constructor(readonly call: RenderedToolCall) {
    super()
  }
  // Every part that `toDOM` draws must be compared here, or CM keeps stale
  // DOM. Doc offsets are left out: a stream token before a chip moves it.
  // The intermediate data holds none, and its fields keep one order.
  eq(other: WidgetType): boolean {
    return other instanceof ToolCallWidget && sameCall(this.call, other.call) && JSON.stringify(this.call.intermediate) === JSON.stringify(other.call.intermediate)
  }
  toDOM(view: EditorView): HTMLElement {
    const root = span(ROOT_CLASS)
    root.setAttribute('data-state', this.call.state)
    root.appendChild(createChip(view, this.call))
    renderOpenState(view, root, this.call, openToolCalls(view.state).has(this.call.id))
    drawnCalls.set(root, this.call)
    // A press anywhere on the widget keeps the caret and the focus where
    // they are, as a press on a role pill does: the caret never goes onto
    // the chip's line by the mouse. The two texts of the widget that the
    // user can select keep the default: a text field of the panel, and the
    // clock's tooltip of a hidden clip's player.
    root.addEventListener('mousedown', (event) => {
      const inField = event.target instanceof Element && event.target.closest(`.${RESULT_TEXT_CLASS}`) !== null
      if (!inField && !isInSelectableTooltip(event.target)) event.preventDefault()
    })
    return root
  }
  // The hidden assets of a call change while its chip is drawn: the job's
  // result comes, a Save or a Delete changes the tag of a hidden clip, or
  // the trash takes a hidden image out of the doc. A new chip would make
  // new players (a clip that plays would stop, with no Save animation, as
  // `MediaWidget.updateDOM` tells), so the drawn chip takes the new data
  // in place. Any other change of the call makes a new chip.
  updateDOM(dom: HTMLElement, view: EditorView, from: ToolCallWidget): boolean {
    const chip = dom.querySelector<HTMLElement>(`.${CHIP_CLASS}`)
    if (!chip || !drawnCalls.has(dom) || !sameCall(from.call, this.call)) return false
    drawnCalls.set(dom, this.call)
    renderIntermediate(chip, this.call, chip.getAttribute('aria-expanded') === 'true')
    const panel = dom.querySelector<HTMLElement>(`.${PANEL_CLASS}`)
    if (panel) renderHiddenPart(view, panel, this.call)
    // The panel can have a new height.
    measureLineHeights(view)
    return true
  }
  destroy(dom: HTMLElement): void {
    destroyPanelPlayers(dom)
  }
  // The widget takes its own events (the chip's press and keys, the
  // selection, select all, and copy of a text field, the controls of a
  // hidden asset); CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

const collapsedLine = Decoration.line({ class: 'dez-tool-call-gap' })
const spaceAboveChip = Decoration.line({ class: 'dez-tool-call-line--after-content' })
const spaceBelowChip = Decoration.line({ class: 'dez-tool-call-line--before-content' })

function buildToolCallDecorations(state: EditorState): ToolCallDecorations {
  const { calls, spacing } = findRenderedToolCalls(state.doc.toString(), state.field(sectionsField, false) ?? [], state.field(streamingSectionField, false) ?? null, hiddenAssets(state))
  // A blank line between two chips can also be a line that goes out of
  // view with a hidden asset.
  const noHeightLines = [...new Set([...spacing.gapLines, ...hiddenLineStarts(state)])].sort((a, b) => a - b)
  return {
    calls,
    chips: Decoration.set(calls.map((call) => Decoration.replace({ widget: new ToolCallWidget(call) }).range(call.from, call.to))),
    // A line decoration goes at the start of a doc line. A chip starts at
    // one, but for a chip right after a separator char that lost its line
    // break.
    space: Decoration.set([
      ...spacing.contentAbove.map((chip) => spaceAboveChip.range(state.doc.lineAt(chip).from)),
      ...spacing.contentBelow.map((chip) => spaceBelowChip.range(state.doc.lineAt(chip).from)),
    ], true),
    noHeightLines,
    collapsed: Decoration.set(noHeightLines.map((line) => collapsedLine.range(line))),
  }
}

/** The lines that take no height in `state`: each of `noHeightLines`, but
 *  a line with a caret on it. On a line of no height the caret would not
 *  show, and the keys can put it there (an arrow key, or Enter at the end
 *  of a chip). Such a line is not an atomic range: the caret would still
 *  get into it (Enter, a stream that appends a group at the caret), and
 *  CM's Backspace and Delete take a whole atomic range, here both line
 *  breaks, which would join the two chips into one line of source. A
 *  selection that is not empty draws no caret, so it shows no line: Select
 *  All moves nothing. The line of a hidden asset that shows this way holds
 *  a short text in place of the asset (`HiddenAssetWidget`). */
function collapsedLines(state: EditorState, { noHeightLines, collapsed }: ToolCallDecorations): DecorationSet {
  if (noHeightLines.length === 0) return collapsed
  const caretLines = state.selection.ranges.filter((range) => range.empty).map((range) => state.doc.lineAt(range.head).from)
  if (!caretLines.some((line) => noHeightLines.includes(line))) return collapsed
  return Decoration.set(noHeightLines.filter((line) => !caretLines.includes(line)).map((line) => collapsedLine.range(line)))
}

/** Each tool block of an agent section is replaced by its chip. The block
 *  spans lines, which only decorations from a state field can replace. The
 *  ranges are atomic, so the caret is never inside the hidden text. The
 *  lines around the chips get their spacing (`ChipSpacing`), and the lines
 *  of the hidden assets take no height. */
const toolCallDecorationsField = StateField.define<ToolCallDecorations>({
  create: buildToolCallDecorations,
  update(value, tr) {
    const changed = tr.docChanged || sectionRolesChanged(tr) || tr.state.field(streamingSectionField, false) !== tr.startState.field(streamingSectionField, false)
    return changed ? buildToolCallDecorations(tr.state) : value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.chips),
    EditorView.decorations.from(field, (value) => value.space),
    EditorView.decorations.compute([field, 'selection'], (state) => collapsedLines(state, state.field(field))),
    EditorView.atomicRanges.of((view) => view.state.field(field).chips),
  ],
})

const NO_CALLS: readonly RenderedToolCall[] = []

/** The calls that the editor shows as chips in `state`, in doc order; none
 *  for a state without `markdownToolCalls()`. The array is the same object
 *  until the doc, the sections, or the streaming section change, so callers
 *  can cache by it. */
export function renderedToolCalls(state: EditorState): readonly RenderedToolCall[] {
  return state.field(toolCallDecorationsField, false)?.calls ?? NO_CALLS
}

/** Opens and closes the drawn panels in place when the open set changes;
 *  `toDOM` reads the set, so a chip that CM draws again is up to date. */
const toolCallOpenUpdater = ViewPlugin.define(() => ({
  update({ startState, state, view }: ViewUpdate) {
    const open = openToolCalls(state)
    if (open === openToolCalls(startState)) return
    let changed = false
    for (const root of view.contentDOM.querySelectorAll<HTMLElement>(`.${ROOT_CLASS}`)) {
      const call = drawnCalls.get(root)
      if (call && renderOpenState(view, root, call, open.has(call.id))) changed = true
    }
    if (changed) measureLineHeights(view)
  },
}))

/** Tool call chips for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), with the panels of `openCalls` open, and the hidden
 *  assets of the chips (`hiddenAssetsOfChips`). The chips are line blocks
 *  (`lineBlocks.ts`): that module has the rules that keep text off their
 *  lines, and the Backspace and Delete rules, which the editor's
 *  `sectionKeymap` binds. Find skips the hidden text (`protectedRanges` in
 *  `find.ts`). The CSS is in `dezTheme`. The state needs `sectionsField`
 *  and `streamingSectionField`. */
export function markdownToolCalls(openCalls?: ReadonlySet<string>): Extension {
  return [
    hiddenAssetsOfChips(),
    toolCallDecorationsField,
    openCalls ? toolCallsOpenField.init(() => openCalls) : toolCallsOpenField,
    toolCallOpenUpdater,
    lineBlocks(renderedToolCalls),
  ]
}
