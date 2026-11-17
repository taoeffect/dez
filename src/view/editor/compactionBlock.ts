import type { Text } from '@codemirror/state'
import { compactionBlockLineCount } from '../../model/chat/compaction'
import { SECTION_SEP } from '../thread/cmEditor'
import type { DocRange } from './pendingRanges'

// The compaction block (src/model/chat/compaction.ts) at the start of the
// doc. Its tag line shows as the AGENT pill of the first section, and its
// other lines show as the two compaction chips (compactionChip.ts). No
// other widget is drawn for its text, and the edit rules keep it as one
// whole block (compaction.ts).
//
// Each widget extension (images.ts, media.ts, tables.ts, ...) reads this
// module, so it must import none of them.

// The lines of the first section of `doc`: the lines before the first
// line that holds a section separator.
function* firstSectionLines(doc: Text): Generator<string> {
  for (const line of doc.iterLines()) {
    if (line.includes(SECTION_SEP)) return
    yield line
  }
}

const blockRanges = new WeakMap<Text, readonly DocRange[]>()

/** The compaction block of `doc`, as a list for the line blocks
 *  (`lineBlocks.ts`): from the tag line to the end line, or to the end of
 *  the first section for a block with no end line (an old form too).
 *  Empty when the first section is a user section. Cached per doc, as
 *  each widget extension reads it after each doc change. */
export function compactionBlockRange(doc: Text): readonly DocRange[] {
  let ranges = blockRanges.get(doc)
  if (!ranges) {
    const lines = compactionBlockLineCount(firstSectionLines(doc))
    ranges = lines === 0 ? [] : [{ from: 0, to: doc.line(lines).to }]
    blockRanges.set(doc, ranges)
  }
  return ranges
}

/** The end of the compaction block of `doc`; 0 for a doc with no block.
 *  A widget extension draws nothing for text that starts before it. */
export function compactionBlockEnd(doc: Text): number {
  return compactionBlockRange(doc)[0]?.to ?? 0
}
