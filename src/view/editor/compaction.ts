import { EditorSelection, EditorState, RangeSet, type Extension, type Text } from '@codemirror/state'
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
// before it, and no Backspace next to it deletes it. Only a selection that
// holds it deletes it, and a delete of the whole block makes the first
// section a user section again. The actions of an asset in the panel of
// the assets chip (the trash, the Save of a clip) change the text of the
// block: no rule here stops them.

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

/** Backspace with one caret right after the block, or at the start of the
 *  line after it when that line has text, does nothing. The text after the
 *  block is the reply; with the block gone, the role of the first section
 *  would follow that text, so one key would drop every note and make the
 *  reply a message of the user (`firstSectionRole`). Before the line block
 *  rule, which deletes a whole block there (`deleteLineBlockBackward`). */
export function keepCompactionBlockOnBackspace(view: EditorView): boolean {
  const { doc, selection } = view.state
  if (selection.ranges.length !== 1 || !selection.main.empty) return false
  const [block] = compactionBlockRange(doc)
  if (!block) return false
  const caret = selection.main.head
  return caret === block.to || (caret === block.to + 1 && doc.lineAt(caret).length > 0)
}

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
 *  the block moves back to the start of the doc, as whole lines. An insert
 *  in place of a selection that held the block removes the block, and is
 *  left alone. An IME composition is left alone too, as in
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
 *  rule must read the doc that the move of the block gives. */
export function compactionBlockRules(): Extension {
  return [lineBlocks((state) => compactionBlockRange(state.doc)), keepCaretOffBlock, keepBlockFirst, atomicBlock]
}
