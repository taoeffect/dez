import * as z from 'zod'
import { countText } from '../../utils/countText'
import { parseJsonAttribute } from '../../utils/markerAttribute'
import { startOf } from '../../utils/textCut'
import type { ToolArguments } from '../tools/types'

// The bridged calls of a `js_eval` call: the tool calls that its code made
// with `dez.sbp` (tools/toolBridge.ts). A bridged call is no `<dez:tool>`
// block, as the rounds of a reply are read from its blocks. The block of
// the `js_eval` call keeps a list of them in its `bridged` attribute
// (toolBlocks.ts); this module is the one writer and recognizer of that
// value.
//
// The list is for the user and for the editor, never for a model: the
// panel of the chip of the call shows it (view/editor/toolCalls.ts), and
// the rule of the jobs reads which jobs the calls started
// (`blockJobStarts`, tools/jobs.ts). No request sends the attribute. Its
// texts are the arguments and the results of tool calls, which hold no
// local path.
//
// The editor reads every block of the doc again at each change of the
// doc, and the conversation file keeps the list, so the list is small
// (`cappedBridgedCalls`).

/** How a bridged call ended. `error`: its tool gave an error, or Dez
 *  refused its call line. `cut`: the code ended before the call did, so
 *  Dez stopped it or did not run it. */
export type BridgedCallStatus = 'success' | 'error' | 'cut'

/** One tool call of the code of a `js_eval` call. */
export interface BridgedCall {
  /** The tool. For a call line that Dez refused, the selector that the
   *  code gave, as it is no call of a tool. */
  name: string
  /** The arguments that the tool got, as a block of the call would hold
   *  them; none for a call line that Dez refused. */
  arguments: ToolArguments
  status: BridgedCallStatus
  /** What the code got: the result of the tool, or the error text. Blank
   *  for a call that the end of the code cut. Only its start, for a long
   *  one (`cappedBridgedCalls`). */
  result: string
}

/** The tool calls of the code of a `js_eval` call, in their order. */
export interface BridgedCalls {
  calls: readonly BridgedCall[]
  /** How many more calls the code made that `calls` does not hold. */
  more: number
}

/** The most characters of a result that a list keeps. The start of a
 *  result tells what the call did (the job that it started, the asset
 *  that it made). */
export const BRIDGED_RESULT_CHARS = 1000

/** The most characters of the JSON text of the calls of a list: room for
 *  the calls of a whole run (`JS_EVAL_MAX_TOOL_CALLS`) with results of
 *  `BRIDGED_RESULT_CHARS` and short arguments. */
export const BRIDGED_LIST_CHARS = 50_000

// The start of `result`, with a note of the cut after it. The start stays
// as it is: `startedJob` (tools/jobs.ts) reads it.
function keptResult(result: string): string {
  if (result.length <= BRIDGED_RESULT_CHARS) return result
  return `${startOf(result, BRIDGED_RESULT_CHARS)}…\n\n(The result has ${countText(result.length)} characters. Dez keeps only its start in this list.)`
}

/** The list of `calls`, the tool calls of the code of one run in their
 *  order, as a block keeps it, with `more` calls that have no entry in
 *  `calls`. Two limits keep the list small:
 *  - a result keeps only its start (`BRIDGED_RESULT_CHARS`);
 *  - a call that would take the list past `BRIDGED_LIST_CHARS` is left
 *    out, and counts in `more`. A later call that fits stays. The
 *    arguments of a call stay whole: the label of a job is read from them
 *    (`callLabel`, tools/registry.ts). */
export function cappedBridgedCalls(calls: readonly BridgedCall[], more: number): BridgedCalls {
  const kept: BridgedCall[] = []
  let size = 0
  for (const { name, arguments: args, status, result } of calls) {
    const call: BridgedCall = { name, arguments: args, status, result: keptResult(result) }
    const callSize = JSON.stringify(call).length
    if (size + callSize > BRIDGED_LIST_CHARS) continue
    size += callSize
    kept.push(call)
  }
  return { calls: kept, more: more + calls.length - kept.length }
}

/** Whether `bridged` tells of a call: a block of a run whose code made no
 *  tool call has no `bridged` attribute. */
export function hasBridgedCalls(bridged: BridgedCalls): boolean {
  return bridged.calls.length > 0 || bridged.more > 0
}

const bridgedCallsSchema = z.object({
  calls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    status: z.enum(['success', 'error', 'cut']),
    result: z.string(),
  })),
  more: z.number().int().nonnegative(),
})

/** The value of the `bridged` attribute of a block. */
export function bridgedCallsText({ calls, more }: BridgedCalls): string {
  return JSON.stringify({ calls: calls.map(({ name, arguments: args, status, result }) => ({ name, arguments: args, status, result })), more })
}

/** The list of a `bridged` attribute value. Null for a value that is not
 *  the writer's form (a hand edit). */
export function readBridgedCalls(text: string): BridgedCalls | null {
  return parseJsonAttribute(text, bridgedCallsSchema)
}
