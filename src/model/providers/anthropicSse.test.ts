import { describe, expect, it } from 'vitest'
import { AnthropicStreamParser } from './anthropicSse'
import type { SseStreamEnd, SseTokenEvent } from './types'

const event = (payload: Record<string, unknown>): string => JSON.stringify(payload)

const thinkingStart = (index: number) => event({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
const thinkingDelta = (index: number, thinking: string) => event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
const signatureDelta = (index: number, signature: string) => event({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } })
const textStart = (index: number) => event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const textDelta = (index: number, text: string) => event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const stop = (index: number) => event({ type: 'content_block_stop', index })
const toolUseStart = (index: number, id: string) => event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'model_list', input: {} } })
const inputDelta = (index: number, partialJson: string) => event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } })
const messageDelta = event({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
const messageStop = event({ type: 'message_stop' })

function run(payloads: string[], thinking = true): { events: SseTokenEvent[], end: SseStreamEnd } {
  const parser = new AnthropicStreamParser(thinking)
  const events = payloads.flatMap((data) => parser.parse(data))
  return { events, end: parser.finish() }
}

describe('AnthropicStreamParser', () => {
  it('streams thinking, then text, and keeps the signed block for the replay', () => {
    const { events, end } = run([
      event({ type: 'message_start', message: { id: 'msg' } }),
      thinkingStart(0),
      thinkingDelta(0, 'Let me '),
      thinkingDelta(0, 'think.'),
      signatureDelta(0, 'sig-0'),
      stop(0),
      textStart(1),
      textDelta(1, 'Answer.'),
      stop(1),
      messageStop,
    ])

    expect(events).toStrictEqual([
      { kind: 'thinking', token: 'Let me ' },
      { kind: 'thinking', token: 'think.' },
      { kind: 'token', token: 'Answer.' },
      { kind: 'done' },
    ])
    expect(end).toStrictEqual({
      events: [],
      replay: { kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'Let me think.', signature: 'sig-0' }] },
    })
  })

  it('puts a blank line between blocks in the shown text only', () => {
    const { events, end } = run([
      thinkingStart(0), thinkingDelta(0, 'First.'), signatureDelta(0, 's0'), stop(0),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'enc' } }), stop(1),
      thinkingStart(2), thinkingDelta(2, 'Second.'), signatureDelta(2, 's2'), stop(2),
      textStart(3), textDelta(3, 'Done.'), stop(3),
    ])

    expect(events.filter((entry) => entry.kind === 'thinking')).toStrictEqual([
      { kind: 'thinking', token: 'First.' },
      { kind: 'thinking', token: '\n\nSecond.' },
    ])
    expect(end.replay).toStrictEqual({
      kind: 'anthropicBlocks',
      blocks: [
        { type: 'thinking', thinking: 'First.', signature: 's0' },
        { type: 'redacted_thinking', data: 'enc' },
        { type: 'thinking', thinking: 'Second.', signature: 's2' },
      ],
    })
  })

  it('keeps a redacted-only reply for the replay without showing anything', () => {
    const { events, end } = run([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'enc' } }),
      stop(0),
      textStart(1), textDelta(1, 'Hi'), stop(1),
    ])

    expect(events).toStrictEqual([{ kind: 'token', token: 'Hi' }])
    expect(end.replay).toStrictEqual({ kind: 'anthropicBlocks', blocks: [{ type: 'redacted_thinking', data: 'enc' }] })
  })

  it('gives no replay when a thinking block never stopped', () => {
    const { events, end } = run([thinkingStart(0), thinkingDelta(0, 'Cut')])

    expect(events).toStrictEqual([{ kind: 'thinking', token: 'Cut' }])
    expect(end).toStrictEqual({ events: [] })
  })

  it('takes back a block without a signature, as compatible servers may send none', () => {
    const { end } = run([thinkingStart(0), thinkingDelta(0, 'Plan.'), stop(0), messageStop])

    expect(end.replay).toStrictEqual({ kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'Plan.', signature: '' }] })
  })

  it('reads text only and keeps no blocks without thinking support', () => {
    const { events, end } = run([
      thinkingStart(0), thinkingDelta(0, 'Plan.'), signatureDelta(0, 's'), stop(0),
      textStart(1), textDelta(1, 'Answer.'), stop(1),
      messageStop,
    ], false)

    expect(events).toStrictEqual([{ kind: 'token', token: 'Answer.' }, { kind: 'done' }])
    expect(end).toStrictEqual({ events: [] })
  })
})

describe('AnthropicStreamParser tool calls', () => {
  it.each([true, false])('collects two tool_use blocks with their input pieces after the text (thinking %s)', (thinking) => {
    const { events, end } = run([
      event({ type: 'message_start', message: { id: 'msg' } }),
      textStart(0), textDelta(0, 'Let me look.'), stop(0),
      toolUseStart(1, 'toolu_a'), inputDelta(1, ''), inputDelta(1, '{"filter": '), inputDelta(1, '"gemini"}'), stop(1),
      toolUseStart(2, 'toolu_b'), stop(2),
      messageDelta,
      messageStop,
    ], thinking)

    expect(events).toStrictEqual([{ kind: 'token', token: 'Let me look.' }, { kind: 'done' }])
    expect(end).toStrictEqual({
      events: [],
      toolCalls: [
        { id: 'toolu_a', name: 'model_list', argumentsText: '{"filter": "gemini"}' },
        { id: 'toolu_b', name: 'model_list', argumentsText: '' },
      ],
    })
  })

  it('keeps the thinking of a round for the replay next to its tool calls', () => {
    const { end } = run([
      thinkingStart(0), thinkingDelta(0, 'Look it up.'), signatureDelta(0, 's0'), stop(0),
      toolUseStart(1, 'toolu_a'), inputDelta(1, '{}'), stop(1),
      messageDelta,
      messageStop,
    ])

    expect(end).toStrictEqual({
      events: [],
      replay: { kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'Look it up.', signature: 's0' }] },
      toolCalls: [{ id: 'toolu_a', name: 'model_list', argumentsText: '{}' }],
    })
  })

  it('gives no calls when a tool_use block never stopped', () => {
    const { end } = run([
      toolUseStart(0, 'toolu_a'), inputDelta(0, '{}'), stop(0),
      toolUseStart(1, 'toolu_b'), inputDelta(1, '{"filter":"ge'),
      messageStop,
    ])

    expect(end).toStrictEqual({ events: [] })
  })

  const overloaded = event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
  const completeCall = [toolUseStart(0, 'toolu_a'), inputDelta(0, '{}'), stop(0)]

  it.each([
    ['the stream was cut off before message_stop', [...completeCall, messageDelta]],
    ['an error event came', [...completeCall, overloaded]],
    ['an error event came before message_stop', [...completeCall, overloaded, messageStop]],
    ['an error event came before [DONE]', [...completeCall, overloaded, '[DONE]']],
  ])('gives no calls when %s', (_case, payloads) => {
    expect(run(payloads).end).toStrictEqual({ events: [] })
  })

  it('gives the calls when [DONE] ends the stream', () => {
    expect(run([...completeCall, '[DONE]']).end).toStrictEqual({
      events: [],
      toolCalls: [{ id: 'toolu_a', name: 'model_list', argumentsText: '{}' }],
    })
  })
})
