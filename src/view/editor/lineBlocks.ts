import { EditorState, Facet, type ChangeSpec, type Extension, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { SENTINEL_CHAR, plainLiveText } from '../../model/chat/content'
import { findToolBlocks, type ToolBlock } from '../../model/chat/toolBlocks'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP, sectionsField, type SectionModel } from '../thread/cmEditor'
import { linesRemovalRange } from './images'
import type { DocRange } from './pendingRanges'

// A line block is a tag that the editor shows as one widget in place of its
// source lines: a tool call chip of an agent section (`toolCalls.ts`), a
// media player of any section (`media.ts`), or the compaction block, which
// shows as its pill and its chips (`compaction.ts`). The tag is a block
// only while it has its lines to itself; text on its first or last line
// turns it back into its source. The rules here keep text off those lines,
// for every kind of block.

/** The text of a section and where it starts in the doc. */
export interface SectionText {
  section: SectionModel
  from: number
  text: string
}

/** The text of each section of `doc`, in section order. A section's text
 *  is the text between the line breaks that frame the separators
 *  (`sectionsToDoc` in cmEditor.ts); `sectionsField` counts every separator
 *  char, so the text before separator `i` is the text of `sections[i]`.
 *  Blocks are read from one section at a time: a tag never runs from one
 *  section into the next. */
export function sectionTexts(doc: string, sections: readonly SectionModel[]): SectionText[] {
  const texts: SectionText[] = []
  let from = 0
  for (let index = 0; ; index++) {
    const separator = doc.indexOf(SECTION_SEP, from)
    const to = separator < 0 ? doc.length : doc[separator - 1] === '\n' ? separator - 1 : separator
    const section = sections[index]
    if (section) texts.push({ section, from, text: doc.slice(from, Math.max(from, to)) })
    if (separator < 0) return texts
    from = doc[separator + 1] === '\n' ? separator + 2 : separator + 1
  }
}

/** The text of each agent section of `doc` (`sectionTexts`), for the blocks
 *  of agent sections only: a tool call in a user section is plain text. */
export function agentSectionTexts(doc: string, sections: readonly SectionModel[]): SectionText[] {
  return sectionTexts(doc, sections).filter(({ section }) => section.role === 'agent')
}

/** The tool blocks of an agent section's `text` that the editor shows as
 *  chips, in order, as ranges in that text. A block that holds a sentinel
 *  (a prompt pill) stays text: the widgets and atomic ranges of the pill
 *  must stay the only ones there. */
export function chipBlocks(text: string): ToolBlock[] {
  return findToolBlocks(text).filter((block) => !SENTINEL_CHAR.test(text.slice(block.from, block.to)))
}

/** A tag that the editor shows as a widget, with its section; `from` and
 *  `to` are its range in the doc, and `tag` keeps the range in the text of
 *  its section. */
export interface ShownSectionTag<Tag extends DocRange> extends DocRange {
  tag: Tag
  section: SectionModel
}

/** The tags that `find` finds in the sections of `doc` that the editor
 *  shows as widgets, in doc order. Each section is read on its own
 *  (`sectionTexts`). Left as text: a line that `find` does not take, a tag
 *  that holds a sentinel (a prompt pill), whose widgets and atomic ranges
 *  must stay the only ones there, and a tag in Markdown code of the
 *  section's plain text (`plainLiveText`), which a request reads. */
export function shownSectionTags<Tag extends DocRange>(
  doc: string,
  sections: readonly SectionModel[],
  find: (text: string, role: Role, options?: { inCode?: boolean }) => Tag[],
): Array<ShownSectionTag<Tag>> {
  const shown: Array<ShownSectionTag<Tag>> = []
  for (const { section, from, text } of sectionTexts(doc, sections)) {
    const tags = find(text, section.role, { inCode: true }).filter((tag) => !SENTINEL_CHAR.test(text.slice(tag.from, tag.to)))
    if (tags.length === 0) continue
    const plain = plainLiveText(text)
    const outOfCode = new Set(find(plain.text, section.role).map((tag) => plain.liveOffset(tag.from)))
    for (const tag of tags) {
      if (outOfCode.has(tag.from)) shown.push({ tag, section, from: from + tag.from, to: from + tag.to })
    }
  }
  return shown
}

/** Whether `tr` changed which sections there are, or the role of one. Each
 *  thinking token gives `sectionsField` a new array too, but only the ids
 *  and roles of the sections change which tags are blocks. */
export function sectionRolesChanged(tr: Transaction): boolean {
  const sections = tr.state.field(sectionsField, false)
  const startSections = tr.startState.field(sectionsField, false)
  return sections !== startSections &&
    (sections?.length !== startSections?.length || !!sections?.some((section, index) => section.id !== startSections?.[index].id || section.role !== startSections?.[index].role))
}

/** The doc ranges of one kind of block in a state, in doc order. */
type LineBlockSource = (state: EditorState) => readonly DocRange[]

const lineBlockSources = Facet.define<LineBlockSource>()

function findLineBlock(state: EditorState, test: (block: DocRange) => boolean): DocRange | undefined {
  for (const source of state.facet(lineBlockSources)) {
    const block = source(state).find(test)
    if (block) return block
  }
  return undefined
}

/** Every line block of a state, of every kind, in doc order. */
export function lineBlockRanges(state: EditorState): DocRange[] {
  return state.facet(lineBlockSources).flatMap((source) => source(state)).sort((a, b) => a.from - b.from)
}

/** Text typed, pasted, or dragged right at a block's start or end would join
 *  the block's first or last line, and the block would show as its source.
 *  This puts a line break between the new text and the block instead. A text
 *  drag inside the doc is a `move.drop`, not an `input` event. An IME
 *  composition is left alone: a change to its text would disturb the
 *  composition. */
const keepTextOffLineBlocks = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('move.drop')) || tr.isUserEvent('input.type.compose')) return tr
  const state = tr.startState
  const lineBreaks: ChangeSpec[] = []
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (inserted.length === 0) return
    if (inserted.sliceString(0, 1) !== '\n' && findLineBlock(state, (block) => block.to === fromA)) lineBreaks.push({ from: fromB, insert: '\n' })
    if (inserted.sliceString(inserted.length - 1) !== '\n' && findLineBlock(state, (block) => block.from === toA)) lineBreaks.push({ from: toB, insert: '\n' })
  })
  return lineBreaks.length === 0 ? tr : [tr, { changes: lineBreaks, sequential: true }]
})

/** Makes the ranges of `source` line blocks: the rules of this module then
 *  apply to them. The filter is one value, so a state with more than one
 *  kind of block still has it once. */
export function lineBlocks(source: LineBlockSource): Extension {
  return [lineBlockSources.of(source), keepTextOffLineBlocks]
}

/** Whether deleting the doc range `from`–`to` would join a block's first or
 *  last line to text on one line, so that the block would show as its
 *  source. A section merge (`ThreadEditor.vue`) keeps a line break there. */
export function joinsLineBlock(state: EditorState, from: number, to: number): boolean {
  const { doc } = state
  const textBefore = doc.lineAt(from).from < from
  const textAfter = to < doc.lineAt(to).to
  return findLineBlock(state, (block) => (block.to === from && textAfter) || (block.from === to && textBefore)) !== undefined
}

function deleteLineBlock(view: EditorView, forward: boolean): boolean {
  const { doc, selection } = view.state
  if (selection.ranges.length !== 1 || !selection.main.empty) return false
  const caret = selection.main.head
  // On an empty line, CM's own key only takes that line away, and the block
  // keeps its own lines.
  const besideLineWithText = doc.lineAt(caret).length > 0
  const block = findLineBlock(view.state, (block) => forward
    ? block.from === caret || (besideLineWithText && block.from === caret + 1 && doc.sliceString(caret, block.from) === '\n')
    : block.to === caret || (besideLineWithText && block.to === caret - 1 && doc.sliceString(block.to, caret) === '\n'))
  if (block) {
    view.dispatch({
      changes: linesRemovalRange(doc, block),
      scrollIntoView: true,
      userEvent: forward ? 'delete.forward' : 'delete.backward',
    })
    return true
  }
  // Backspace at a block's start, or Delete at its end: CM's own key would
  // delete the line break there and join the block's line to the text
  // beside it. The caret goes over the line break instead, as it goes over
  // a prompt pill. An empty line there goes away under CM's own key, and a
  // separator line is the section merge's.
  const across = forward ? caret + 1 : caret - 1
  if (across < 0 || across > doc.length || !findLineBlock(view.state, (other) => (forward ? other.to : other.from) === caret)) return false
  const line = doc.lineAt(across)
  if (line.length === 0 || line.text.includes(SECTION_SEP)) return false
  view.dispatch({ selection: { anchor: across }, scrollIntoView: true, userEvent: 'select' })
  return true
}

/** Backspace with one caret right after a block, or at the start of a line
 *  with text after it, deletes the whole block. CM's own Backspace would
 *  delete the line break at that line start, and so join the line's text to
 *  the block's last line, which breaks the block into its source. Right
 *  before a block, with text on the line above, it moves the caret to the
 *  end of that line. */
export function deleteLineBlockBackward(view: EditorView): boolean {
  return deleteLineBlock(view, false)
}

/** Delete with one caret right before a block, or at the end of a line with
 *  text before it, deletes the whole block (see `deleteLineBlockBackward`).
 *  Right after a block, with text on the line below, it moves the caret to
 *  the start of that line. */
export function deleteLineBlockForward(view: EditorView): boolean {
  return deleteLineBlock(view, true)
}
