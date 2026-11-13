import { EditorSelection, type EditorState, type RangeSet, type RangeValue, type SelectionRange, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { findToolBlocks } from '../../model/chat/toolBlocks'
import { SECTION_SEP, pillsField, scanPills, sectionsField, setPillsEffect, type PillLocation, type PillMetadata } from '../thread/cmEditor'
import { linesRemovalRange } from './images'
import { agentSectionTexts, lineBlockRanges } from './lineBlocks'
import type { DocRange } from './pendingRanges'

// Delete Line and Duplicate Line, the `deleteLine` and `duplicateLine`
// shortcuts. CodeMirror's own line commands see only lines: they can take a
// section separator away (two sections merge), cut a tool chip, a player,
// or an expanded prompt pill in half, and copy a pill with its id. These
// commands act on whole blocks instead, and change nothing when a line is
// a separator. They always take the key, so Option+D on macOS never types
// `∂`.

/** Whole lines, from a line start to a line end, and the selection ranges
 *  in them. */
interface LineSpan extends DocRange {
  ranges: SelectionRange[]
}

/** The lines of each selection range, as CodeMirror's `selectedLineBlocks`
 *  gives them: a range that ends at a line start leaves that line out. */
function selectedLines(state: EditorState): LineSpan[] {
  const { doc } = state
  return state.selection.ranges.map((range) => {
    const end = !range.empty && range.to === doc.lineAt(range.to).from ? range.to - 1 : range.to
    return { from: doc.lineAt(range.from).from, to: doc.lineAt(end).to, ranges: [range] }
  })
}

/** Spans in doc order, with spans that overlap or are on adjacent lines
 *  joined, so that the line breaks that their removals take never meet. */
function joinTouching(spans: readonly LineSpan[]): LineSpan[] {
  const joined: LineSpan[] = []
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = joined[joined.length - 1]
    if (last && span.from <= last.to + 1) {
      joined[joined.length - 1] = { from: last.from, to: Math.max(last.to, span.to), ranges: [...last.ranges, ...span.ranges] }
    } else {
      joined.push(span)
    }
  }
  return joined
}

/** `span` with the whole lines of each line block that it touches, and of
 *  each prompt pill of which it holds one marker only (an expanded pill
 *  has its header on its first line and its close marker on its last).
 *  Lines inside an expanded pill's body hold neither marker: they are
 *  plain body text. */
function grow(doc: Text, span: LineSpan, lineBlocks: readonly DocRange[], pills: readonly PillLocation[]): LineSpan {
  let { from, to } = span
  for (const block of lineBlocks) {
    if (block.from <= to && block.to >= from) {
      from = Math.min(from, block.from)
      to = Math.max(to, block.to)
    }
  }
  for (const pill of pills) {
    if ((from <= pill.from && pill.from < to) !== (from <= pill.bodyTo && pill.bodyTo < to)) {
      from = Math.min(from, doc.lineAt(pill.from).from)
      to = Math.max(to, doc.lineAt(pill.to).to)
    }
  }
  return { from, to, ranges: span.ranges }
}

/** The line spans that the commands act on: the selected lines, grown until
 *  no line block or pill of `pills` (the doc's pills) is cut. A grown span
 *  can reach another block or another span, so this repeats until nothing
 *  changes. Null when a span holds a separator line: then the commands
 *  change nothing at all, as `strictMultiCursorBackspace` (cmEditor.ts)
 *  does. */
function wholeLineSpans(state: EditorState, pills: readonly PillLocation[]): LineSpan[] | null {
  const { doc } = state
  const lineBlocks = lineBlockRanges(state)
  let spans = joinTouching(selectedLines(state))
  for (;;) {
    const grown = joinTouching(spans.map((span) => grow(doc, span, lineBlocks, pills)))
    if (grown.length === spans.length && grown.every((span, index) => span.from === spans[index].from && span.to === spans[index].to)) {
      return grown.some((span) => state.sliceDoc(span.from, span.to).includes(SECTION_SEP)) ? null : grown
    }
    spans = grown
  }
}

/** Whether a span holds a tool block of an agent section, shown as a chip
 *  or not. Its id is the provider's call id, and two tool calls with one id
 *  break the next request. */
function holdsToolBlock(state: EditorState, docText: string, spans: readonly LineSpan[]): boolean {
  const toolBlocks = agentSectionTexts(docText, state.field(sectionsField))
    .flatMap(({ from, text }) => findToolBlocks(text).map((block) => ({ from: from + block.from, to: from + block.to })))
  return spans.some((span) => toolBlocks.some((block) => block.from <= span.to && block.to >= span.from))
}

/** `pos` moved out of the atomic ranges (widgets that a caret cannot be
 *  inside) that hold it strictly. The first move goes to the atom edge on
 *  `pos`'s line (a line block on the line above ends on this line), else
 *  to the nearer edge; later moves keep that way, so nested atoms cannot
 *  move it back and forth. */
function outsideAtoms(doc: Text, atoms: readonly RangeSet<RangeValue>[], pos: number): number {
  const line = doc.lineAt(pos)
  let forward: boolean | null = null
  for (let moved = true; moved;) {
    moved = false
    for (const set of atoms) {
      set.between(pos, pos, (from, to) => {
        if (from >= pos || to <= pos) return
        forward ??= to <= line.to && (from < line.from || to - pos < pos - from)
        pos = forward ? to : from
        moved = true
        return false
      })
    }
  }
  return pos
}

/** Deletes the lines of each selection range, with the whole line blocks
 *  and pills on them. Lines that are the only text of their section leave
 *  one empty line (`linesRemovalRange`). Each span leaves one caret, on the
 *  line that its removal joins, at the column of the span's first caret. */
export function deleteLines(view: EditorView): boolean {
  const { state } = view
  const { doc } = state
  const spans = wholeLineSpans(state, scanPills(doc.toString()))
  if (!spans) return true
  const removals = spans.map((span) => linesRemovalRange(doc, span))
  const changes = state.changes(removals)
  const atoms = state.facet(EditorView.atomicRanges).map((source) => source(view))
  const carets = spans.map((span, index) => {
    const removal = removals[index]
    const { head } = span.ranges.reduce((first, range) => (range.from < first.from ? range : first))
    const column = head - doc.lineAt(head).from
    const line = removal.to > span.to ? doc.lineAt(span.to + 1) : removal.from < span.from ? doc.lineAt(span.from - 1) : null
    const target = line ? outsideAtoms(doc, atoms, line.from + Math.min(column, line.length)) : span.from
    return EditorSelection.cursor(changes.mapPos(target, 1))
  })
  view.dispatch({
    changes,
    selection: EditorSelection.create(carets, spans.findIndex((span) => span.ranges.includes(state.selection.main))),
    scrollIntoView: true,
    userEvent: 'delete.line',
  })
  return true
}

/** The text of `span`, where each prompt pill has a new id: two pills with
 *  one id would share their metadata. Each new id gets a copy of the old
 *  pill's metadata in `copiedMeta`. */
function textWithNewPillIds(
  state: EditorState,
  span: LineSpan,
  pills: readonly PillLocation[],
  copiedMeta: Map<string, PillMetadata>,
): string {
  const meta = state.field(pillsField)
  let text = ''
  let at = span.from
  for (const pill of pills) {
    if (pill.from < span.from || pill.to > span.to) continue
    const id = crypto.randomUUID()
    const pillMeta = meta.get(pill.id)
    if (pillMeta) copiedMeta.set(id, { ...pillMeta })
    // The id is between the open marker and the body marker.
    text += state.sliceDoc(at, pill.from + 1) + id
    at = pill.bodyFrom - 1
  }
  return text + state.sliceDoc(at, span.to)
}

/** Puts a copy of the lines of each selection range, with the whole line
 *  blocks and pills on them, above them, and moves the selection down with
 *  its text, as CodeMirror's `copyLineDown` does. Images and clips keep
 *  their ids: a copy of the same image or clip can share its id
 *  (`mediaIds.ts`). Nothing is copied when a span holds a tool call of an
 *  agent section (`holdsToolBlock`). */
export function duplicateLines(view: EditorView): boolean {
  const { state } = view
  const text = state.doc.toString()
  const pills = scanPills(text)
  const spans = wholeLineSpans(state, pills)
  if (!spans || holdsToolBlock(state, text, spans)) return true
  const copiedMeta = new Map<string, PillMetadata>()
  const changes = state.changes(spans.map((span) => ({
    from: span.from,
    insert: textWithNewPillIds(state, span, pills, copiedMeta) + state.lineBreak,
  })))
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    effects: copiedMeta.size > 0 ? setPillsEffect.of(new Map([...state.field(pillsField), ...copiedMeta])) : [],
    scrollIntoView: true,
    userEvent: 'input.copyline',
  })
  return true
}
