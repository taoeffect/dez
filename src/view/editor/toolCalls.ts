import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { EMPTY_TOOL_RESULT, INTERRUPTED_TOOL_RESULT, findToolBlocks, type ToolBlock } from '../../model/chat/toolBlocks'
import { toolDefinition } from '../../model/tools/registry'
import type { ToolArguments } from '../../model/tools/types'
import { sectionsField, type SectionModel } from '../thread/cmEditor'
import { measureLineHeights } from '../thread/editorMeasure'
import { streamingSectionField } from '../thread/modelChip'
import { agentSectionTexts, lineBlocks, sectionRolesChanged } from './lineBlocks'
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

/** How a chip shows its call. `running`: a reply runs the tool now.
 *  `interrupted`: a `running` block that no reply runs (the app stopped
 *  while the tool ran); requests send it as an error. */
export type ToolCallState = 'success' | 'error' | 'running' | 'interrupted'

/** A block that the editor shows as a chip; `from` and `to` are doc
 *  offsets. */
export interface RenderedToolCall extends ToolBlock {
  state: ToolCallState
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
 *  player); the start and the end of a section are not content. Positions
 *  are doc offsets, in doc order. */
interface ChipSpacing {
  /** The start of each blank line between two chips. Such a line takes no
   *  height (`collapsedGapLines`). */
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
  /** `ChipSpacing.gapLines`. */
  gapLines: readonly number[]
  /** A line of no height at each of `gapLines`. */
  collapsedGaps: DecorationSet
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

/** The blocks that the editor shows as chips, in doc order, and the spacing
 *  of their lines. Each agent section is read on its own: the recognizer
 *  stops only at the next `dez:` tag, so an opening line in one section
 *  could pair with a closing line in a later one. Left as text: blocks in
 *  user sections (plain text there), and blocks that hold a sentinel (a
 *  prompt pill), whose widgets and atomic ranges must stay the only ones
 *  there. A `running` block runs only in the section that the active tab's
 *  stream writes into. */
function findRenderedToolCalls(doc: string, sections: readonly SectionModel[], streamingSectionId: string | null): { calls: RenderedToolCall[], spacing: ChipSpacing } {
  const calls: RenderedToolCall[] = []
  const spacing: ChipSpacing = { gapLines: [], contentAbove: [], contentBelow: [] }
  if (!doc.includes('<dez:tool')) return { calls, spacing }
  for (const { section, from, text } of agentSectionTexts(doc, sections)) {
    const chips = findToolBlocks(text).filter((block) => !SENTINEL_CHAR.test(text.slice(block.from, block.to)))
    for (const block of chips) {
      const state = block.status !== 'running' ? block.status : section.id === streamingSectionId ? 'running' : 'interrupted'
      calls.push({ ...block, from: from + block.from, to: from + block.to, state })
    }
    addSectionSpacing(spacing, text, from, chips)
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
const RESULT_TEXT_CLASS = 'dez-tool-call__result-text'

/** An open-end wrench. */
function wrenchIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', [
    ['path', { d: 'M13.42 4.37A3 3 0 1 1 11.63 2.58L11.45 4.55Z', ...ROUND_STROKE, 'stroke-width': '1.4' }],
    ['path', { d: 'M8.48 7.52L3.2 12.8', ...ROUND_STROKE, 'stroke-width': '1.8' }],
  ])
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
 *  "running" stands for the spinner, which screen readers skip. Empty parts
 *  are left out. A tool that Dez does not have is named as its chip names
 *  it. */
export function toolCallLabel(name: string, summary: string, state: ToolCallState): string {
  const word = state === 'running' ? 'running' : STATE_WORDS[state]
  const tool = isUnrecognizedTool(name) ? `Tool call, ${UNRECOGNIZED_TOOL_TEXT} ${name}` : `Tool call ${name}`
  return [tool, summary, word].filter(Boolean).join(', ')
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
  chip.setAttribute('aria-label', toolCallLabel(call.name, summary, call.state))
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

/** A read-only text field for the result, with the thinking panel's
 *  sizing (`renderPillThinking` in thinkingPill.ts): a hidden mirror of the
 *  text and the textarea share one grid cell, so the field is as tall as its
 *  text without script measuring, and the result box scrolls past its max
 *  height. The CSS shares the thinking field's rules in `dezTheme`. A text
 *  field gives native selection, select all, and copy of the result. */
function createResult(call: RenderedToolCall): HTMLElement {
  const result = span('dez-tool-call__result')
  if (call.state === 'error' || call.state === 'interrupted') result.setAttribute('data-error', '')
  const text = call.state === 'interrupted' ? INTERRUPTED_TOOL_RESULT : call.result
  const mirror = span('dez-tool-call__result-mirror', text)
  mirror.setAttribute('aria-hidden', 'true')
  const field = document.createElement('textarea')
  field.className = RESULT_TEXT_CLASS
  field.readOnly = true
  field.rows = 1
  field.spellcheck = false
  field.value = text
  field.placeholder = call.state === 'running' ? 'Running…' : EMPTY_TOOL_RESULT
  field.setAttribute('aria-label', 'Result')
  result.append(mirror, field)
  return result
}

function createPanel(call: RenderedToolCall): HTMLElement {
  const panel = span(PANEL_CLASS)
  const parameters = Object.entries(call.arguments)
  if (parameters.length > 0) {
    const rows = span('dez-tool-call__parameters')
    for (const [name, value] of parameters) {
      rows.append(span('dez-tool-call__parameter-name', name), span('dez-tool-call__parameter-value', typeof value === 'string' ? value : JSON.stringify(value)))
    }
    panel.append(span('dez-tool-call__heading', 'Parameters'), rows)
  }
  panel.append(span('dez-tool-call__heading', 'Result'), createResult(call))
  return panel
}

/** Draws the open or closed state of the chip root `root`: the chip's
 *  state for screen readers and its title, and the panel. Returns whether
 *  the drawn DOM changed. */
function renderOpenState(root: HTMLElement, call: RenderedToolCall, open: boolean): boolean {
  const chip = root.querySelector<HTMLElement>(`.${CHIP_CLASS}`)
  chip?.setAttribute('aria-expanded', String(open))
  if (chip) chip.title = open ? 'Hide tool call' : 'Show tool call'
  const panel = root.querySelector(`.${PANEL_CLASS}`)
  if (open === (panel !== null)) return false
  if (panel) {
    panel.remove()
    root.removeAttribute('data-open')
  } else {
    root.appendChild(createPanel(call))
    root.setAttribute('data-open', '')
  }
  return true
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
  eq(other: WidgetType): boolean {
    if (!(other instanceof ToolCallWidget)) return false
    const a = this.call
    const b = other.call
    // Arguments keep their definition order, so equal ones give equal JSON.
    return a.id === b.id && a.name === b.name && a.state === b.state && a.result === b.result && JSON.stringify(a.arguments) === JSON.stringify(b.arguments)
  }
  toDOM(view: EditorView): HTMLElement {
    const root = span(ROOT_CLASS)
    root.setAttribute('data-state', this.call.state)
    root.appendChild(createChip(view, this.call))
    renderOpenState(root, this.call, openToolCalls(view.state).has(this.call.id))
    drawnCalls.set(root, this.call)
    // A press anywhere on the widget but the result field keeps the caret
    // and the focus where they are, as a press on a role pill does: the
    // caret never goes onto the chip's line by the mouse.
    root.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Element && event.target.closest(`.${RESULT_TEXT_CLASS}`))) event.preventDefault()
    })
    return root
  }
  // The widget takes its own events (the chip's press and keys, the result
  // field's selection, select all, and copy); CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

const collapsedLine = Decoration.line({ class: 'dez-tool-call-gap' })
const spaceAboveChip = Decoration.line({ class: 'dez-tool-call-line--after-content' })
const spaceBelowChip = Decoration.line({ class: 'dez-tool-call-line--before-content' })

function buildToolCallDecorations(state: EditorState): ToolCallDecorations {
  const { calls, spacing } = findRenderedToolCalls(state.doc.toString(), state.field(sectionsField, false) ?? [], state.field(streamingSectionField, false) ?? null)
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
    gapLines: spacing.gapLines,
    collapsedGaps: Decoration.set(spacing.gapLines.map((line) => collapsedLine.range(line))),
  }
}

/** The blank lines between chips that take no height in `state`: each of
 *  `gapLines`, but a line with a caret on it. On a line of no height the
 *  caret would not show, and the keys can put it there (an arrow key, or
 *  Enter at the end of a chip). Such a line is not an atomic range: the
 *  caret would still get into it (Enter, a stream that appends a group at
 *  the caret), and CM's Backspace and Delete take a whole atomic range, here
 *  both line breaks, which would join the two chips into one line of
 *  source. A selection that is not empty draws no caret, so it shows no
 *  line: Select All moves nothing. */
function collapsedGapLines(state: EditorState, { gapLines, collapsedGaps }: ToolCallDecorations): DecorationSet {
  if (gapLines.length === 0) return collapsedGaps
  const caretLines = state.selection.ranges.filter((range) => range.empty).map((range) => state.doc.lineAt(range.head).from)
  if (!caretLines.some((line) => gapLines.includes(line))) return collapsedGaps
  return Decoration.set(gapLines.filter((line) => !caretLines.includes(line)).map((line) => collapsedLine.range(line)))
}

/** Each tool block of an agent section is replaced by its chip. The block
 *  spans lines, which only decorations from a state field can replace. The
 *  ranges are atomic, so the caret is never inside the hidden text. The
 *  lines around the chips get their spacing (`ChipSpacing`). */
const toolCallDecorationsField = StateField.define<ToolCallDecorations>({
  create: buildToolCallDecorations,
  update(value, tr) {
    const changed = tr.docChanged || sectionRolesChanged(tr) || tr.state.field(streamingSectionField, false) !== tr.startState.field(streamingSectionField, false)
    return changed ? buildToolCallDecorations(tr.state) : value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.chips),
    EditorView.decorations.from(field, (value) => value.space),
    EditorView.decorations.compute([field, 'selection'], (state) => collapsedGapLines(state, state.field(field))),
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
      if (call && renderOpenState(root, call, open.has(call.id))) changed = true
    }
    if (changed) measureLineHeights(view)
  },
}))

/** Tool call chips for the thread editor (`buildState()` in
 *  `ThreadEditor.vue`), with the panels of `openCalls` open. The chips are
 *  line blocks (`lineBlocks.ts`): that module has the rules that keep text
 *  off their lines, and the Backspace and Delete rules, which the editor's
 *  `sectionKeymap` binds. Find skips the hidden text (`protectedRanges` in
 *  `find.ts`). The CSS is in `dezTheme`. The state needs `sectionsField`
 *  and `streamingSectionField`. */
export function markdownToolCalls(openCalls?: ReadonlySet<string>): Extension {
  return [
    toolCallDecorationsField,
    openCalls ? toolCallsOpenField.init(() => openCalls) : toolCallsOpenField,
    toolCallOpenUpdater,
    lineBlocks(renderedToolCalls),
  ]
}
