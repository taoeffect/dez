import { errorText } from '../../utils/errorText'
import { toolBlockText, type ToolBlockData } from '../chat/toolBlocks'
import { parseToolArguments } from '../tools/arguments'
import { toolDefinition, unknownToolText } from '../tools/registry'
import type { StreamedToolCall, ToolArguments, ToolRunResult } from '../tools/types'

// The pure parts of the tool loop of one reply (`dez.stream/start`): each
// request round that ends with tool calls adds one group of `<dez:tool>`
// blocks to the streaming agent section, runs the calls, and sends the next
// round.

/** The most tool rounds in one reply. A model that keeps calling tools
 *  would else send requests with no end. A reply that makes a video from
 *  parts needs about 25: the model lists, the calls of the parts, their
 *  waits, the join, and its wait. */
export const MAX_TOOL_ROUNDS = 40

/** The result of a call that was not done when the user stopped the reply. */
export const STOPPED_TOOL_RESULT: ToolRunResult = { content: 'Stopped.', isError: true }

/** The result of each call of a round past `MAX_TOOL_ROUNDS`. */
export const ROUND_LIMIT_TOOL_RESULT: ToolRunResult = {
  content: `Not run: the reply reached the limit of ${MAX_TOOL_ROUNDS} tool rounds.`,
  isError: true,
}

/** True for the result text of a call that the round limit stopped
 *  (`ROUND_LIMIT_TOOL_RESULT`), with any limit: a block of a release with
 *  another limit still reads. Such a call did not run, which the chip of
 *  its block tells apart from a call that ran and failed. */
export function isRoundLimitResult(result: string): boolean {
  return /^Not run: the reply reached the limit of \d+ tool rounds\.$/.test(result)
}

/** From this many rounds left, the results of a round tell the model how
 *  many rounds the reply has left (`roundsLeftNote`). */
export const ROUNDS_LEFT_NOTE_FROM = 5

/** What the last result of a tool round adds for the model when the reply
 *  can run only `roundsLeft` more tool rounds; null while more than
 *  `ROUNDS_LEFT_NOTE_FROM` are left. No other text tells the model the
 *  limit, and a model that meets it with no warning leaves its work half
 *  done and tells the user nothing of it. */
export function roundsLeftNote(roundsLeft: number): string | null {
  if (roundsLeft > ROUNDS_LEFT_NOTE_FROM) return null
  if (roundsLeft <= 0) {
    return 'Note from Dez: this was the last round of tool calls that this reply can run: a call that you make now does not run. '
      + 'Write your answer to the user now, and tell what is not done. The user can send a new message to let you go on.'
  }
  return `Note from Dez: this reply can run ${roundsLeft} more ${roundsLeft === 1 ? 'round' : 'rounds'} of tool calls `
    + '(the calls of one answer of yours are one round; a new message of the user starts the count again). Calls after that do not run. '
    + 'So make the calls that the result needs most, and then tell the user what is not done.'
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
 *  call runs until it has `result`. */
export function toolCallBlock(call: CheckedToolCall, result?: ToolRunResult): ToolBlockData {
  const block = { id: call.id, name: call.name, arguments: call.arguments }
  if (call.refusal !== undefined) return { ...block, status: 'error', result: call.refusal }
  if (!result) return { ...block, status: 'running', result: '' }
  return { ...block, status: result.isError ? 'error' : 'success', result: result.content }
}

/** The blocks of a round whose calls have their `results` (by the index
 *  of the call; none for a refused call), when the reply can run
 *  `roundsLeft` more rounds after this one. Near the limit, the result of
 *  the last block ends with `roundsLeftNote`, after a blank line: the note
 *  is a part of the stored result, so every later request sends the same
 *  bytes. It goes after the result, so a reader of a result's start
 *  (`startedJobId`) or of its job parts (`jobsWaitResults`) still reads
 *  it. */
export function toolRoundBlocks(calls: readonly CheckedToolCall[], results: readonly (ToolRunResult | undefined)[], roundsLeft: number): ToolBlockData[] {
  const note = roundsLeftNote(roundsLeft)
  return calls.map((call, index) => {
    const block = toolCallBlock(call, results[index])
    return note !== null && index === calls.length - 1 ? { ...block, result: `${block.result}\n\n${note}` } : block
  })
}

/** The text of a group of blocks: each block and a `\n` after it, as
 *  `agentRounds` reads them. */
export function toolGroupText(blocks: readonly ToolBlockData[]): string {
  return blocks.map((block) => `${toolBlockText(block)}\n`).join('')
}

/** The text that adds a group of blocks to a section with `sectionText`:
 *  one `\n` first, also after text that ends with one, and none in an
 *  empty section; then the group text. The request builder drops one `\n`
 *  next to a block, so the model's own line breaks go back as they came,
 *  and after a round that wrote no text this gives the blank line that
 *  keeps two groups apart (`agentRounds` in `messages.ts`). */
export function toolGroupAppendText(sectionText: string, blocks: readonly ToolBlockData[]): string {
  return (sectionText === '' ? '' : '\n') + toolGroupText(blocks)
}
