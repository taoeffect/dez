import { sectionTextParts } from '../chat/compaction'
import { findToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { EDIT_HINT } from './appsTool'

// When the result of an `apps edit` call gets the hint of `edit`
// (`EDIT_HINT`, appsTool.ts): whenever the context that the model reads
// does not hold the hint. So the first `edit` call of each tab gets it, and
// a call gets it again after the user deleted the block that held it, or
// after a compaction took that block out. Dez reads this from the
// conversation of the tab each time, and keeps no flag that it would have
// to reset. A request sends every tool result in full
// (streams/messages.ts), so a result that holds the hint is what the model
// read.
//
// The bridged calls of `js_eval` code never count: they are no blocks of
// their own but a part of the `js_eval` block (`ToolBlockData.bridged`),
// and their results go to the code, not to the model.

/** True when the result of an `apps edit` call of the model must end with
 *  the hint: no tool result in the agent sections of the call's tab holds
 *  it, and none of `roundResults`, the results of the earlier calls of the
 *  call's round, which the section gets only at the end of the round. */
export function editHintIsDue(sections: readonly Section[], roundResults: readonly string[]): boolean {
  const holdsHint = (result: string) => result.includes(EDIT_HINT)
  if (roundResults.some(holdsHint)) return false
  // A tool block counts only in the text of an agent section.
  return !sections.some((section, index) => section.role === 'agent'
    && findToolBlocks(sectionTextParts(section, index).text).some((block) => holdsHint(block.result)))
}
