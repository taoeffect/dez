import { errorText } from '../../utils/errorText'
import { TIMED_CALL_MIN_MS } from '../chat/duration'
import { toolBlockText, type ToolBlockData } from '../chat/toolBlocks'
import { parseToolArguments } from '../tools/arguments'
import { JOBS_WAIT_TOOL } from '../tools/jobs'
import { toolDefinition, unknownToolText } from '../tools/registry'
import type { StreamedToolCall, ToolArguments, ToolRunResult } from '../tools/types'

// The pure parts of the tool loop of one reply (`dez.stream/start`): each
// request round that ends with tool calls adds one group of `<dez:tool>`
// blocks to the streaming agent section, runs the calls, and sends the next
// round. No count limits the rounds of a reply: it ends when its model
// answers with no tool call, or when the user stops it.

/** The result of a call that was not done when the user stopped the reply. */
export const STOPPED_TOOL_RESULT: ToolRunResult = { content: 'Stopped.', isError: true }

/** The result of a call of the tool `name` that was not done when the user
 *  stopped the reply or sent a new message. A `jobs_wait` call tells that
 *  only the wait ended: the jobs go on, for the next reply (`TabJobs`,
 *  controller/jobs.ts). */
export function stoppedToolResult(name: string): ToolRunResult {
  return name === JOBS_WAIT_TOOL.name
    ? { content: 'The reply stopped before the jobs ended, so this wait ended. The jobs go on: the next reply gets their results with jobs_wait.', isError: true }
    : STOPPED_TOOL_RESULT
}

/** True for the result text of a call that the round limit of an older Dez
 *  stopped ("Not run: the reply reached the limit of 40 tool rounds.", with
 *  the limit of its release). Dez has no round limit now and writes no such
 *  result, but saved conversations hold these blocks. Such a call did not
 *  run, which the chip of its block tells apart from a call that ran and
 *  failed. */
export function isRoundLimitResult(result: string): boolean {
  return /^Not run: the reply reached the limit of \d+ tool rounds\.$/.test(result)
}

/** A call from a reply stream after Dez checked it. */
export interface CheckedToolCall {
  /** Unique in the agent section. */
  id: string
  /** The tool name as the model wrote it. */
  name: string
  /** Empty when the call is refused. */
  arguments: ToolArguments
  /** The error result of a call that Dez does not run: the tool is unknown,
   *  or its definition refuses the arguments. */
  refusal?: string
}

/** A call id for a call that came with none, or with an id that the
 *  section already holds. */
export function newToolCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Checks a round's calls, in order. `takenIds` are the call ids that the
 *  agent section already holds: a later request pairs a round's thinking
 *  with its group by the first call id (`agentSectionMessages`), so every
 *  id in a section must be unique. A blank id or one already taken gets a
 *  new one; any other id stays byte for byte, as the provider wants it
 *  back. */
export function checkToolCalls(calls: readonly StreamedToolCall[], takenIds: Iterable<string>, newId = newToolCallId): CheckedToolCall[] {
  const used = new Set(takenIds)
  return calls.map((call) => {
    let id = call.id
    while (id === '' || used.has(id)) id = newId()
    used.add(id)

    const definition = toolDefinition(call.name)
    if (!definition) return { id, name: call.name, arguments: {}, refusal: unknownToolText(call.name) }
    const parsed = parseToolArguments(definition, call.argumentsText)
    if (!parsed.ok) {
      const sent = call.argumentsText.trim() === '' ? '' : `The call sent ${call.argumentsText}`
      const refusal = errorText(`Dez did not run this call. ${parsed.error}`, sent)
      return { id, name: call.name, arguments: {}, refusal }
    }
    return { id, name: call.name, arguments: parsed.arguments }
  })
}

/** The block of a call: a refused call has its error at once; any other
 *  call runs until it has `result`. `durationMs` is how long the call ran;
 *  the block keeps it only from `TIMED_CALL_MIN_MS` on. */
export function toolCallBlock(call: CheckedToolCall, result?: ToolRunResult, durationMs?: number): ToolBlockData {
  const block = { id: call.id, name: call.name, arguments: call.arguments }
  if (call.refusal !== undefined) return { ...block, status: 'error', result: call.refusal }
  if (!result) return { ...block, status: 'running', result: '' }
  const pictures = result.pictures?.length ? { pictures: result.pictures } : {}
  const bridged = result.bridged ? { bridged: result.bridged } : {}
  const timed = durationMs !== undefined && durationMs >= TIMED_CALL_MIN_MS ? { durationMs: Math.round(durationMs) } : {}
  return { ...block, status: result.isError ? 'error' : 'success', result: result.content, ...timed, ...pictures, ...bridged }
}

/** The text of a group of blocks: each block and a `\n` after it, as
 *  `agentRounds` reads them. */
export function toolGroupText(blocks: readonly ToolBlockData[]): string {
  return blocks.map((block) => `${toolBlockText(block)}\n`).join('')
}

/** The text that adds a group of blocks to a reply with `replyText`: one
 *  `\n` first, also after text that ends with one, and none for a reply
 *  with no text; then the group text. The request builder drops one `\n`
 *  next to a block, so the model's own line breaks go back as they came,
 *  and after a round that wrote no text this gives the blank line that
 *  keeps two groups apart (`agentRounds` in `messages.ts`). */
export function toolGroupAppendText(replyText: string, blocks: readonly ToolBlockData[]): string {
  return (replyText === '' ? '' : '\n') + toolGroupText(blocks)
}
