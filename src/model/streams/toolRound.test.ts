import { describe, expect, it } from 'vitest'
import type { ToolBlockData } from '../chat/toolBlocks'
import type { ModelRef, Section } from '../chat/types'
import { unknownToolText } from '../tools/registry'
import type { StreamedToolCall } from '../tools/types'
import { agentSectionMessages } from './messages'
import {
  checkToolCalls,
  isRoundLimitResult,
  ROUND_LIMIT_TOOL_RESULT,
  ROUNDS_LEFT_NOTE_FROM,
  roundsLeftNote,
  STOPPED_TOOL_RESULT,
  toolCallBlock,
  toolGroupAppendText,
  toolRoundBlocks,
  type CheckedToolCall,
} from './toolRound'

const streamed = (id: string, argumentsText: string, name = 'model_list'): StreamedToolCall => ({ id, name, argumentsText })

// Gives `call_new1`, `call_new2`, … in order.
function counterIds(): () => string {
  let count = 0
  return () => `call_new${++count}`
}

describe('checkToolCalls', () => {
  it('keeps the provider ids byte for byte and gives the arguments in definition order', () => {
    expect(checkToolCalls([streamed('functions.model_list:0', '{"filter":"gemini"}'), streamed('A1TYsnfLr', '')], [])).toStrictEqual([
      { id: 'functions.model_list:0', name: 'model_list', arguments: { filter: 'gemini' } },
      { id: 'A1TYsnfLr', name: 'model_list', arguments: {} },
    ])
  })

  // `model_info` then gives the model of the reply.
  it('takes a model_info call with no arguments', () => {
    expect(checkToolCalls([streamed('c1', '', 'model_info'), streamed('c2', '{}', 'model_info')], [])).toStrictEqual([
      { id: 'c1', name: 'model_info', arguments: {} },
      { id: 'c2', name: 'model_info', arguments: {} },
    ])
  })

  // Blank arguments mean `{}`, which lacks the parameter.
  it('refuses a call with blank arguments of a tool that has a required parameter, and tells how to add it', () => {
    expect(checkToolCalls([streamed('c1', '', 'job_inspect')], [])).toStrictEqual([{
      id: 'c1',
      name: 'job_inspect',
      arguments: {},
      refusal: 'Dez did not run this call. The required parameter "job_id" is missing. Add it as a string, as in {"job_id": "..."}.',
    }])
  })

  it('gives a new id to a call with none, and to an id that the section or an earlier call of the group holds', () => {
    const calls = [streamed('', '{}'), streamed('call_1', '{}'), streamed('call_2', '{}'), streamed('call_2', '{}')]

    const ids = checkToolCalls(calls, ['call_1', 'call_new2'], counterIds()).map((call) => call.id)

    expect(ids).toStrictEqual(['call_new1', 'call_new3', 'call_2', 'call_new4'])
  })

  it('makes new ids that fit the Anthropic id rule', () => {
    const [call] = checkToolCalls([streamed('', '{}')], [])
    expect(call.id).toMatch(/^call_[0-9a-f]{12}$/)
  })

  it('refuses an unknown tool and arguments that the definition refuses, with the fix and the raw text for the model', () => {
    const calls = [
      streamed('c1', '{"query":"x"}', 'web_search'),
      streamed('c2', '{"filter":"gem'),
      streamed('c3', '{"filter":3}'),
      streamed('c4', '{"limit":3}'),
      streamed('c5', '{}', ''),
    ]
    const parameters = 'The parameters of model_list are: filter (string), type (string), inputs (string), sort (string), sort_dir (string).'

    expect(checkToolCalls(calls, [])).toStrictEqual([
      { id: 'c1', name: 'web_search', arguments: {}, refusal: unknownToolText('web_search') },
      {
        id: 'c2',
        name: 'model_list',
        arguments: {},
        refusal: `Dez did not run this call. The arguments are not valid JSON. Send one JSON object, as in {"filter": "..."}. ${parameters}`
          + '\n\nDetails: The call sent {"filter":"gem',
      },
      {
        id: 'c3',
        name: 'model_list',
        arguments: {},
        refusal: 'Dez did not run this call. The parameter "filter" must be a string, as in {"filter": "..."}.\n\nDetails: The call sent {"filter":3}',
      },
      {
        id: 'c4',
        name: 'model_list',
        arguments: {},
        refusal: `Dez did not run this call. model_list has no parameter "limit". ${parameters}\n\nDetails: The call sent {"limit":3}`,
      },
      { id: 'c5', name: '', arguments: {}, refusal: unknownToolText('') },
    ])
  })

  // The `video` tool has only `command` and `parameters`; a model that
  // knows `timeout_seconds` from model_invoke writes it next to them.
  it('tells a video call with a parameter of its subcommand next to "command" where the parameter goes', () => {
    const sent = '{"command":"ffmpeg","parameters":"{\\"arguments\\":\\"-i @c out.mp4\\"}","timeout_seconds":900}'

    expect(checkToolCalls([streamed('c1', sent, 'video')], [])).toStrictEqual([{
      id: 'c1',
      name: 'video',
      arguments: {},
      refusal: 'Dez did not run this call. video has no parameter "timeout_seconds". '
        + '"timeout_seconds" is a parameter of the subcommand ffmpeg, so it goes inside "parameters", the text of a JSON object, and not next to "command", '
        + 'as in {"command":"ffmpeg","parameters":"{\\"arguments\\":\\"-i @c -i @b -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4\\",\\"timeout_seconds\\":900}"}.'
        + `\n\nDetails: The call sent ${sent}`,
    }])
  })
})

describe('toolCallBlock', () => {
  const call: CheckedToolCall = { id: 'c1', name: 'model_list', arguments: { filter: 'gemini' } }
  const unknownTool = unknownToolText('web_search')
  const refused: CheckedToolCall = { id: 'c2', name: 'web_search', arguments: {}, refusal: unknownTool }

  it('runs a call until it has a result, then gives the result and its status', () => {
    expect(toolCallBlock(call)).toStrictEqual({ ...call, status: 'running', result: '' })
    expect(toolCallBlock(call, { content: '1 model', isError: false })).toStrictEqual({ ...call, status: 'success', result: '1 model' })
    expect(toolCallBlock(call, STOPPED_TOOL_RESULT)).toStrictEqual({ ...call, status: 'error', result: 'Stopped.' })
  })

  it('keeps the refusal of a refused call, also past the round limit', () => {
    const expected = { id: 'c2', name: 'web_search', arguments: {}, status: 'error', result: unknownTool }
    expect(toolCallBlock(refused)).toStrictEqual(expected)
    expect(toolCallBlock(refused, ROUND_LIMIT_TOOL_RESULT)).toStrictEqual(expected)
  })
})

// No other text tells a model the limit of the tool rounds of a reply.
describe('the rounds that a reply has left', () => {
  const NOTE_START = 'Note from Dez: this reply can run'
  const NOTE_END = '(the calls of one answer of yours are one round; a new message of the user starts the count again). Calls after that do not run. '
    + 'So make the calls that the result needs most, and then tell the user what is not done.'
  const LAST_ROUND = 'Note from Dez: this was the last round of tool calls that this reply can run: a call that you make now does not run. '
    + 'Write your answer to the user now, and tell what is not done. The user can send a new message to let you go on.'
  const calls: CheckedToolCall[] = [
    { id: 'c1', name: 'model_list', arguments: {} },
    { id: 'c2', name: 'model_list', arguments: { filter: 'gemini' } },
  ]
  const results = [{ content: '1 model', isError: false }, { content: 'No model.', isError: true }]

  it('gives no note while more rounds are left than the note starts from', () => {
    expect([roundsLeftNote(ROUNDS_LEFT_NOTE_FROM + 1), roundsLeftNote(40)]).toStrictEqual([null, null])
  })

  it('tells how many rounds are left, and at the last round to answer the user now', () => {
    expect([roundsLeftNote(ROUNDS_LEFT_NOTE_FROM), roundsLeftNote(1), roundsLeftNote(0), roundsLeftNote(-1)]).toStrictEqual([
      `${NOTE_START} ${ROUNDS_LEFT_NOTE_FROM} more rounds of tool calls ${NOTE_END}`,
      `${NOTE_START} 1 more round of tool calls ${NOTE_END}`,
      LAST_ROUND,
      LAST_ROUND,
    ])
  })

  it('gives the blocks of a round as they are while no note is due', () => {
    expect(toolRoundBlocks(calls, results, ROUNDS_LEFT_NOTE_FROM + 1)).toStrictEqual([toolCallBlock(calls[0], results[0]), toolCallBlock(calls[1], results[1])])
  })

  // A reader of a result's start (a job id) or of its job parts still
  // reads a result with a note after it.
  it('puts the note after the result of the last block only, after a blank line, and keeps the status', () => {
    expect(toolRoundBlocks(calls, results, 2)).toStrictEqual([
      { ...calls[0], status: 'success', result: '1 model' },
      { ...calls[1], status: 'error', result: `No model.\n\n${roundsLeftNote(2)}` },
    ])
  })

  it('puts the note after the refusal of a last call that Dez did not run', () => {
    const refused: CheckedToolCall = { id: 'c3', name: 'web_search', arguments: {}, refusal: unknownToolText('web_search') }

    expect(toolRoundBlocks([calls[0], refused], [results[0], undefined], 0).map((block) => block.result))
      .toStrictEqual(['1 model', `${unknownToolText('web_search')}\n\n${LAST_ROUND}`])
  })
})

// The chip of a block tells a call that did not run apart from one that
// ran and failed, by the result text.
describe('isRoundLimitResult', () => {
  it('knows the result of a call that the round limit stopped, also with the limit of another release of Dez', () => {
    expect([ROUND_LIMIT_TOOL_RESULT.content, 'Not run: the reply reached the limit of 20 tool rounds.'].map(isRoundLimitResult)).toStrictEqual([true, true])
  })

  it.each([
    ['the result of a stopped call', STOPPED_TOOL_RESULT.content],
    ['a result that only starts with the text', `${ROUND_LIMIT_TOOL_RESULT.content}\n\nMore text`],
    ['a result that holds the text', `The tool said: ${ROUND_LIMIT_TOOL_RESULT.content}`],
    ['an empty result', ''],
  ])('does not take %s for one', (_name, result) => {
    expect(isRoundLimitResult(result)).toBe(false)
  })
})

// The loop writes each round's text, then the group start and the group; the
// request builder must read the same rounds back.
describe('the group text and the request builder', () => {
  const model: ModelRef = { providerId: 'local', modelId: 'm' }
  const block = (id: string, filter: string, result: string): ToolBlockData =>
    toolCallBlock({ id, name: 'model_list', arguments: { filter } }, { content: result, isError: false })

  function writeRounds(rounds: { text: string, blocks: ToolBlockData[] }[]): Section {
    let text = ''
    for (const round of rounds) {
      text += round.text
      if (round.blocks.length > 0) text += toolGroupAppendText(text, round.blocks)
    }
    return { id: 'a1', role: 'agent', model, content: [{ kind: 'text', text }] }
  }

  it('gives back each round with its own text, also a round that wrote no text or ended with line breaks', () => {
    const section = writeRounds([
      { text: '', blocks: [block('c1', 'gemini', '1 model'), block('c2', 'mistral', '2 models')] },
      { text: '', blocks: [block('c3', 'qwen', '3 models')] },
      { text: 'Two more:\n\n', blocks: [block('c4', 'kimi', '4 models')] },
      { text: '\nDone.\n', blocks: [] },
    ])

    const call = (id: string, filter: string) => ({ id, name: 'model_list', arguments: { filter } })
    const result = (callId: string, content: string) => ({ callId, content, isError: false })
    expect(agentSectionMessages(section, model, true)).toStrictEqual([
      { role: 'agent', content: '', toolCalls: [call('c1', 'gemini'), call('c2', 'mistral')] },
      { role: 'tool', results: [result('c1', '1 model'), result('c2', '2 models')] },
      { role: 'agent', content: '', toolCalls: [call('c3', 'qwen')] },
      { role: 'tool', results: [result('c3', '3 models')] },
      { role: 'agent', content: 'Two more:\n\n', toolCalls: [call('c4', 'kimi')] },
      { role: 'tool', results: [result('c4', '4 models')] },
      { role: 'agent', content: '\nDone.\n' },
    ])
  })
})
