import { EditorSelection, EditorState, type Extension, type Text } from '@codemirror/state'
import { firstSectionRole } from '../../model/chat/compaction'
import { SECTION_SEP } from '../thread/cmEditor'
import { lineBlocks } from './lineBlocks'
import type { DocRange } from './pendingRanges'

// The tag line of a compaction section (src/model/chat/compaction.ts) is
// the first line of the doc. It is no text for people: the editor shows the
// AGENT pill of the section in its place (`buildSeparatorDecorations`,
// cmEditor.ts). The rules here keep it as the pill of a later section is:
// a whole line with no text on it, with no caret on it, and with no text
// before it. Without the tag, the first section is a user section again.

/** The tag line of the compaction section of `state`, as a list for the
 *  line blocks (`lineBlocks.ts`): empty when the first section is a user
 *  section. */
export function compactionTagRange(state: EditorState): readonly DocRange[] {
  const line = state.doc.line(1)
  return firstSectionRole(line.text) === 'agent' ? [{ from: 0, to: line.to }] : []
}

/** The first place of a caret in a doc that starts with a compaction tag:
 *  the start of the line after the tag, where the text of the section
 *  starts. A section that is only its tag has no such line (the doc ends,
 *  or the separator of the next section comes): its place is the end of
 *  the tag line, where typed text gets its own line (`lineBlocks.ts`).
 *  Null for a doc with no tag. */
export function caretAfterCompactionTag(doc: Text): number | null {
  const tagLine = doc.line(1)
  if (firstSectionRole(tagLine.text) !== 'agent') return null
  return doc.lines === 1 || doc.line(2).text === SECTION_SEP ? tagLine.to : tagLine.to + 1
}

/** A caret before the tag line or in it goes to the first place after it
 *  (`caretAfterCompactionTag`): text typed before the tag would make it
 *  plain text of a user section. A selection that holds the tag stays, so
 *  that Select All, a copy, and a delete of the whole section work. */
const keepCaretOffTag = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr
  const caret = caretAfterCompactionTag(tr.newDoc)
  if (caret === null) return tr
  const selection = tr.newSelection
  const beforeText = (range: { empty: boolean, head: number }): boolean => range.empty && range.head < caret
  if (!selection.ranges.some(beforeText)) return tr
  const ranges = selection.ranges.map((range) => (beforeText(range) ? EditorSelection.cursor(caret) : range))
  return [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }]
})

/** Text that goes in before the tag (a file or a text drag that the user
 *  drops on the left part of the first pill) is put after the tag line:
 *  the tag moves back to the start of the doc, as one line. An insert in
 *  place of a selection that held the tag removes the tag, and is left
 *  alone. An IME composition is left alone too, as in
 *  `keepTextOffLineBlocks`. */
const keepTagFirst = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('move.drop')) || tr.isUserEvent('input.type.compose')) return tr
  const [tag] = compactionTagRange(tr.startState)
  if (!tag) return tr
  const from = tr.changes.mapPos(tag.from, 1)
  const to = tr.changes.mapPos(tag.to, -1)
  const tagText = tr.startState.sliceDoc(tag.from, tag.to)
  if (from === 0 || tr.newDoc.sliceString(from, to) !== tagText) return tr
  // The line break before the tag goes with it, so the new text keeps one
  // line break between it and the text of the section.
  const lineBreakBefore = tr.newDoc.sliceString(from - 1, from) === '\n'
  return [tr, {
    changes: [{ from: 0, insert: `${tagText}\n` }, { from: lineBreakBefore ? from - 1 : from, to }],
    sequential: true,
  }]
})

/** The rules of the tag line of a compaction section, for the thread
 *  editor (`buildState()` in `ThreadEditor.vue`). `keepCaretOffTag` is
 *  before `keepTagFirst`: the transaction filters run from the last to the
 *  first, and the caret rule must read the doc that the move of the tag
 *  gives. */
export function compactionTagLine(): Extension {
  return [lineBlocks(compactionTagRange), keepCaretOffTag, keepTagFirst]
}
