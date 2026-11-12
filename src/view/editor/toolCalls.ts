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

interface ToolCallDecorations {
  /** In doc order. */
  calls: readonly RenderedToolCall[]
  decorations: DecorationSet
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

/** The blocks that the editor shows as chips, in doc order. Each agent
 *  section is read on its own: the recognizer stops only at the next `dez:`
 *  tag, so an opening line in one section could pair with a closing line in
 *  a later one. Left as text: blocks in user sections (plain text there),
 *  and blocks that hold a sentinel (a prompt pill), whose widgets and atomic
 *  ranges must stay the only ones there. A `running` block runs only in the
 *  section that the active tab's stream writes into. */
function findRenderedToolCalls(doc: string, sections: readonly SectionModel[], streamingSectionId: string | null): RenderedToolCall[] {
  const calls: RenderedToolCall[] = []
  if (!doc.includes('<dez:tool')) return calls
  for (const { section, from, text } of agentSectionTexts(doc, sections)) {
    for (const block of findToolBlocks(text)) {
      if (SENTINEL_CHAR.test(text.slice(block.from, block.to))) continue
      const state = block.status !== 'running' ? block.status : section.id === streamingSectionId ? 'running' : 'interrupted'
      calls.push({ ...block, from: from + block.from, to: from + block.to, state })
    }
  }
  return calls
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

function buildToolCallDecorations(state: EditorState): ToolCallDecorations {
  const calls = findRenderedToolCalls(state.doc.toString(), state.field(sectionsField, false) ?? [], state.field(streamingSectionField, false) ?? null)
  const decorations = Decoration.set(calls.map((call) => Decoration.replace({ widget: new ToolCallWidget(call) }).range(call.from, call.to)))
  return { calls, decorations }
}

/** Each tool block of an agent section is replaced by its chip. The block
 *  spans lines, which only decorations from a state field can replace. The
 *  ranges are atomic, so the caret is never inside the hidden text. */
const toolCallDecorationsField = StateField.define<ToolCallDecorations>({
  create: buildToolCallDecorations,
  update(value, tr) {
    const changed = tr.docChanged || sectionRolesChanged(tr) || tr.state.field(streamingSectionField, false) !== tr.startState.field(streamingSectionField, false)
    return changed ? buildToolCallDecorations(tr.state) : value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
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
