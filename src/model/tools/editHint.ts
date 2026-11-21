import { sectionTextParts } from '../chat/compaction'
import { findToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import type { CheckedToolCall } from '../streams/toolRound'
import { APPS_EDIT, APPS_TOOL, EDIT_HINT, withEditHint } from './appsTool'
import type { StreamedToolCall } from './types'

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
// A first `edit` call often has wrong parameters, so a call that Dez
// refuses gets the hint too: at its run (`withEditHintWhenDue`,
// controller/tools.ts), and before the runs of its round
// (`withEditHintRefusals`). The help of `edit` holds the hint, so a model
// that read the help gets it no more.
//
// The bridged calls of `js_eval` code never count: they are no blocks of
// their own but a part of the `js_eval` block (`ToolBlockData.bridged`),
// and their results go to the code, not to the model.

/** True when the result of an `apps edit` call of the model must end with
 *  the hint: no tool result in the agent sections of the call's tab holds
 *  it (the result of the help of `edit` holds it too), and none of
 *  `roundResults`, the results of the earlier calls of the call's round,
 *  which the section gets only at the end of the round. */
export function editHintIsDue(sections: readonly Section[], roundResults: readonly string[]): boolean {
  const holdsHint = (result: string) => result.includes(EDIT_HINT)
  if (roundResults.some(holdsHint)) return false
  // A tool block counts only in the text of an agent section.
  return !sections.some((section, index) => section.role === 'agent'
    && findToolBlocks(sectionTextParts(section, index).text).some((block) => holdsHint(block.result)))
}

/** True for a call of the `apps` tool that names the subcommand `edit` as
 *  Dez reads the name (`parseSubcommandCall` trims it), whatever its
 *  parameters are: a call that Dez refuses counts too. `args` is the
 *  arguments object of the call, of any shape. */
export function isEditCall(toolName: string, args: unknown): boolean {
  if (toolName !== APPS_TOOL.name || args === null || typeof args !== 'object') return false
  const { command } = args as { command?: unknown }
  return typeof command === 'string' && command.trim() === APPS_EDIT
}

/** The checked calls of a round (`checkToolCalls`: one for each of
 *  `streamedCalls`, in order), with the hint after the refusal of an
 *  `apps edit` call while it is due. Dez refuses such a call before any
 *  call of the round runs (a `parameters` object in place of its text, a
 *  parameter of `edit` next to `command`), and it is often a first call.
 *  `sections` are the sections of the tab before the round; a run call
 *  of the round finds a hinted refusal in them, as Dez writes the
 *  refusals into the reply before the runs. Arguments that are no JSON
 *  give no hint: Dez cannot tell what the call was. */
export function withEditHintRefusals(calls: readonly CheckedToolCall[], streamedCalls: readonly StreamedToolCall[], sections: readonly Section[]): CheckedToolCall[] {
  const refusals: string[] = []
  return calls.map((call, index) => {
    if (call.refusal === undefined) return call
    let args: unknown
    try {
      args = JSON.parse(streamedCalls[index].argumentsText)
    } catch {
      args = undefined
    }
    const refusal = isEditCall(call.name, args) && editHintIsDue(sections, refusals) ? withEditHint(call.refusal) : call.refusal
    refusals.push(refusal)
    return { ...call, refusal }
  })
}
