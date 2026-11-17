import { EditorSelection, EditorState, RangeSet, type ChangeSpec, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { SECTION_SEP } from '../thread/cmEditor'
import { compactionBlockRange } from './compactionBlock'
import { lineBlocks } from './lineBlocks'

// The compaction block (src/model/chat/compaction.ts) is the first lines of
// the doc. It is no text for people: the editor shows the AGENT pill of the
// section in place of its tag line (`buildSeparatorDecorations`,
// cmEditor.ts), and the two compaction chips in place of its other lines
// (compactionChip.ts). The reply that ran at the compaction goes on after
// it, in the same section. The rules here keep it as one whole line block
// (`compactionBlockRange`): no caret in it, no text typed into it or
// before it, and no delete key next to it deletes it or joins text to it.
// Only a selection that holds it deletes it, and a delete of the whole
// block makes the first section a user section again. The actions of an
// asset in the panel of the assets chip (the trash, the Save of a clip)
// change the text of the block: no rule here stops them.

/** The first place of a caret in a doc that starts with a compaction
 *  block: the start of the line after the block, where the text of the
 *  reply after the block starts. With no such line (the doc ends, or the
 *  separator of the next section comes), it is the end of the block, where
 *  typed text gets its own line (`lineBlocks.ts`). Null for a doc with no
 *  block. */
export function caretAfterCompactionBlock(doc: Text): number | null {
  const [block] = compactionBlockRange(doc)
  if (!block) return null
  const last = doc.lineAt(block.to)
  if (last.number === doc.lines) return block.to
  return doc.line(last.number + 1).text === SECTION_SEP ? block.to : block.to + 1
}

/** A delete key next to the block leaves it as it is: Backspace, Delete,
 *  and the keys that delete a word or up to a line start, on every
 *  platform (the user events `delete.backward` and `delete.forward`). The
 *  text after the block is the reply. With the block gone, the role of the
 *  first section would follow that text, so one key would drop every note
 *  and make the reply a message of the user (`firstSectionRole`). With the
 *  line break after the end line gone, the reply would join the end line:
 *  the block would then run to the end of the section, and the reply would
 *  be part of the notes. So such a key does nothing. CM's own key on an
 *  empty line after the block, a section merge, and a delete of a
 *  selection that holds the block (`delete.selection`) still work. */
const keepBlockOnDeleteKeys = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward'))) return tr
  const [block] = compactionBlockRange(tr.startState.doc)
  if (!block) return tr
  let changesBlock = false
  tr.changes.iterChangedRanges((fromA) => {
    if (fromA < block.to) changesBlock = true
  })
  // With no change before its end, the block keeps its offsets.
  const joinsEndLine = !changesBlock && tr.newDoc.lineAt(block.to).to > block.to
  return changesBlock || joinsEndLine ? [] : tr
})

/** A caret before the end of the block goes to the first place after it
 *  (`caretAfterCompactionBlock`): text typed before the tag would make it
 *  plain text of a user section. A selection that holds the block stays,
 *  so that Select All, a copy, and a delete of the whole section work. */
const keepCaretOffBlock = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr
  const caret = caretAfterCompactionBlock(tr.newDoc)
  if (caret === null) return tr
  const selection = tr.newSelection
  const beforeText = (range: { empty: boolean, head: number }): boolean => range.empty && range.head < caret
  if (!selection.ranges.some(beforeText)) return tr
  const ranges = selection.ranges.map((range) => (beforeText(range) ? EditorSelection.cursor(caret) : range))
  return [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }]
})

/** Text that goes in before the block (a file or a text drag that the
 *  user drops on the left part of the first pill) is put after the block:
 *  the block moves back to the start of the doc, as whole lines. A drop on
 *  the right part of the pill goes into the block: `keepTextOutOfBlock`.
 *  An insert in place of a selection that held the block removes the
 *  block, and is left alone. An IME composition is left alone too, as in
 *  `keepTextOffLineBlocks`. */
const keepBlockFirst = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('move.drop')) || tr.isUserEvent('input.type.compose')) return tr
  const [block] = compactionBlockRange(tr.startState.doc)
  if (!block) return tr
  const from = tr.changes.mapPos(block.from, 1)
  const to = tr.changes.mapPos(block.to, -1)
  const blockText = tr.startState.sliceDoc(block.from, block.to)
  if (from === 0 || tr.newDoc.sliceString(from, to) !== blockText) return tr
  // The line break before the block goes with it, so the new text keeps
  // one line break between it and the text of the section.
  const lineBreakBefore = tr.newDoc.sliceString(from - 1, from) === '\n'
  return [tr, {
    changes: [{ from: 0, insert: `${blockText}\n` }, { from: lineBreakBefore ? from - 1 : from, to }],
    sequential: true,
  }]
})

/** Text that goes in inside the block is put after the block, on a line of
 *  its own. A drop on the right part of the first pill, and a native file
 *  drop (Linux) on the chips, are inserts at the end of the tag line
 *  (`posAtCoords` gives the end of an inline widget there, and the edge of
 *  the chips' block widget). In the block, an image reference or a dragged
 *  text would join the tag line, and the first section would be a user
 *  section; a clip tag would be a line of the notes. Dragged text stays
 *  selected at its new place. An IME composition is left alone, as in
 *  `keepTextOffLineBlocks`. */
const keepTextOutOfBlock = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('move.drop')) || tr.isUserEvent('input.type.compose')) return tr
  const [block] = compactionBlockRange(tr.startState.doc)
  if (!block) return tr
  const removals: ChangeSpec[] = []
  let text = ''
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (fromA !== toA || fromA <= block.from || fromA >= block.to) return
    removals.push({ from: fromB, to: toB })
    text += inserted.toString()
  })
  if (removals.length === 0) return tr
  const end = tr.changes.mapPos(block.to, -1)
  const insert = text.startsWith('\n') ? text : `\n${text}`
  // Every removal is before `end`: the moved text ends at `to`.
  const to = end - text.length + insert.length
  // A follow-up spec keeps the effects of `tr` (the end of a pending range
  // of a file drop, `insertFiles` in imageInsert.ts).
  return [tr, {
    changes: [...removals, { from: end, insert }],
    selection: tr.newSelection.main.empty ? { anchor: to } : { anchor: to - text.length, head: to },
    sequential: true,
  }]
})

const atomicBlocks = new WeakMap<Text, RangeSet<Decoration>>()
const ATOMIC_MARK = Decoration.mark({})

/** The block as one atomic range: the pill of the tag line and the hidden
 *  lines of the chips are two ranges, and the line break between them
 *  would be a place for the caret. */
const atomicBlock = EditorView.atomicRanges.of((view) => {
  const { doc } = view.state
  let set = atomicBlocks.get(doc)
  if (!set) {
    const [block] = compactionBlockRange(doc)
    set = block ? RangeSet.of([ATOMIC_MARK.range(block.from, block.to)]) : RangeSet.empty
    atomicBlocks.set(doc, set)
  }
  return set
})

/** The rules of the compaction block, for the thread editor (`buildState()`
 *  in `ThreadEditor.vue`). `keepCaretOffBlock` is before `keepBlockFirst`:
 *  the transaction filters run from the last to the first, and the caret
 *  rule must read the doc that the move of the block gives.
 *  `keepTextOutOfBlock` is after `keepBlockFirst`, so that `keepBlockFirst`
 *  reads a block with no new text inside it. `keepBlockOnDeleteKeys` is
 *  last, so that it runs first, and the other filters see no change when
 *  it stops one. */
export function compactionBlockRules(): Extension {
  return [lineBlocks((state) => compactionBlockRange(state.doc)), keepCaretOffBlock, keepBlockFirst, keepTextOutOfBlock, atomicBlock, keepBlockOnDeleteKeys]
}
