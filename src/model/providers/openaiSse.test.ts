import { describe, expect, it } from 'vitest'
import { OpenAiStreamParser } from './openaiSse'
import type { SseStreamEnd, SseTokenEvent } from './types'

type Delta = Record<string, unknown>

function chunk(delta: Delta, finishReason: string | null = null): string {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })
}

// Feeds the payloads in order and returns every event, with the events of
// `finish()` last, plus the replay.
function run(payloads: string[], thinking = true): { events: SseTokenEvent[], end: SseStreamEnd } {
  const parser = new OpenAiStreamParser(thinking)
  const events = payloads.flatMap((data) => parser.parse(data))
  const end = parser.finish()
  return { events: [...events, ...end.events], end }
}

// Joins neighboring events of one kind, so tests do not depend on how the
// parser cuts the text.
function joined(events: SseTokenEvent[]): SseTokenEvent[] {
  const result: SseTokenEvent[] = []
  for (const event of events) {
    const last = result[result.length - 1]
    if (event.kind !== 'done' && last && last.kind === event.kind) {
      result[result.length - 1] = { kind: event.kind, token: last.token + event.token }
    } else {
      result.push(event)
    }
  }
  return result
}

describe('OpenAiStreamParser reasoning text', () => {
  it.each(['reasoning_content', 'reasoning', 'reasoning_text'])('reads %s as thinking', (field) => {
    const { events } = run([chunk({ [field]: 'Plan.' }), chunk({ content: 'Answer.' }), '[DONE]'])

    expect(events).toStrictEqual([
      { kind: 'thinking', token: 'Plan.' },
      { kind: 'token', token: 'Answer.' },
      { kind: 'done' },
    ])
  })

  it('ignores null and empty reasoning fields', () => {
    const { events, end } = run([
      chunk({ reasoning_content: null, reasoning: '', content: 'Hi' }),
      '[DONE]',
    ])

    expect(events).toStrictEqual([{ kind: 'token', token: 'Hi' }, { kind: 'done' }])
    expect(end.replay).toBeUndefined()
  })

  it('takes the text of one field per chunk when a server sends it twice', () => {
    const { events } = run([
      chunk({
        reasoning_content: 'Once.',
        reasoning: 'Once.',
        reasoning_details: [{ type: 'reasoning.text', text: 'Once.', index: 0 }],
      }),
    ])

    expect(events).toStrictEqual([{ kind: 'thinking', token: 'Once.' }])
  })

  it('shows the text and summary of reasoning_details when no text field is set', () => {
    const { events } = run([
      chunk({ reasoning_details: [{ type: 'reasoning.summary', summary: 'Short. ', index: 0 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Long.', index: 1 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'xyz', index: 2 }] }),
    ])

    expect(events).toStrictEqual([
      { kind: 'thinking', token: 'Short. ' },
      { kind: 'thinking', token: 'Long.' },
    ])
  })

  it('drops all reasoning and keeps the content as it is without thinking support', () => {
    const { events, end } = run([
      chunk({ reasoning_content: 'Plan.', content: '<think>x</think>Answer' }),
      '[DONE]',
    ], false)

    expect(events).toStrictEqual([
      { kind: 'token', token: '<think>x</think>Answer' },
      { kind: 'done' },
    ])
    expect(end).toStrictEqual({ events: [] })
  })
})

describe('OpenAiStreamParser replay', () => {
  it('names the text field of the first reasoning', () => {
    expect(run([chunk({ reasoning_content: 'a' }), chunk({ reasoning: 'b' }), '[DONE]']).end.replay)
      .toStrictEqual({ kind: 'field', field: 'reasoning_content' })
    expect(run([chunk({ reasoning: 'a' }), chunk({}, 'stop')]).end.replay)
      .toStrictEqual({ kind: 'field', field: 'reasoning' })
  })

  it('gives no field replay for reasoning_text, which servers do not take back', () => {
    expect(run([chunk({ reasoning_text: 'a' }), '[DONE]']).end.replay).toBeUndefined()
  })

  it('gives no replay when the stream ends before [DONE] or a finish_reason', () => {
    expect(run([chunk({ reasoning_content: 'a' }), chunk({ content: 'b' })]).end.replay).toBeUndefined()
  })

  // OpenRouter reports a failure after the 200 status as a chunk with a
  // top-level `error` and `finish_reason: "error"`. The last detail can then
  // lack the signature that a later piece would bring.
  it('gives no replay when the server reports an error inside the stream', () => {
    const details = chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Th', index: 0 }] })
    const errorChunk = JSON.stringify({
      error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })

    expect(run([details, errorChunk, '[DONE]']).end.replay).toBeUndefined()
    expect(run([details, chunk({}, 'error')]).end.replay).toBeUndefined()
    expect(run([details, chunk({}, 'stop'), '{"error":{"message":"late"}}']).end.replay).toBeUndefined()
  })

  it('merges reasoning_details pieces by index, in stream order', () => {
    const { end } = run([
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'Th', index: 0, format: 'anthropic-claude-v1', signature: null }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'ink.', index: 0 }] }),
      chunk({ reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'sig' }] }),
      // An object literal cannot hold an own `__proto__` key; JSON text can.
      '{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"xyz","index":1,"__proto__":{"polluted":true}}]}}]}',
      chunk({ content: 'Answer' }, 'stop'),
    ])

    expect(end.replay).toStrictEqual({
      kind: 'reasoningDetails',
      details: [
        { type: 'reasoning.text', text: 'Think.', index: 0, format: 'anthropic-claude-v1', signature: 'sig' },
        { type: 'reasoning.encrypted', data: 'xyz', index: 1 },
      ],
    })
  })

  it('prefers reasoning_details over the text field it came with', () => {
    const { end } = run([
      chunk({ reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', text: 'a', index: 0 }] }),
      '[DONE]',
    ])

    expect(end.replay?.kind).toBe('reasoningDetails')
  })

  it('keeps the last GitHub Copilot reasoning_opaque', () => {
    const { events, end } = run([
      chunk({ reasoning_text: 'Plan.' }),
      chunk({ reasoning_opaque: 'first' }),
      chunk({ reasoning_opaque: 'last' }),
      chunk({ content: 'Answer' }, 'stop'),
    ])

    expect(events).toStrictEqual([{ kind: 'thinking', token: 'Plan.' }, { kind: 'token', token: 'Answer' }])
    expect(end.replay).toStrictEqual({ kind: 'copilot', opaque: 'last' })
  })
})

describe('OpenAiStreamParser inline tags', () => {
  it('moves a leading <think> block to thinking, with tags split across chunks', () => {
    const { events, end } = run([
      chunk({ content: '\n<th' }),
      chunk({ content: 'ink>\nStep one.' }),
      chunk({ content: ' Step two.\n</th' }),
      chunk({ content: 'ink>\n\nThe answer' }),
      chunk({ content: ' is 4.' }),
      '[DONE]',
    ])

    expect(joined(events)).toStrictEqual([
      { kind: 'thinking', token: 'Step one. Step two.' },
      { kind: 'token', token: 'The answer is 4.' },
      { kind: 'done' },
    ])
    expect(end.replay).toBeUndefined()
  })

  it('handles <thought> and a whole block in one chunk', () => {
    const { events } = run([chunk({ content: '<thought>Hmm.</thought>Yes.' })])

    expect(events).toStrictEqual([{ kind: 'thinking', token: 'Hmm.' }, { kind: 'token', token: 'Yes.' }])
  })

  it('shows the thinking of a stream that ends inside the tag', () => {
    const { events } = run([chunk({ content: '<think>Cut ' }), chunk({ content: 'off </thi' })])

    expect(joined(events)).toStrictEqual([{ kind: 'thinking', token: 'Cut off </thi' }])
  })

  it('leaves a tag that is not at the start, and a partial tag at the end, as text', () => {
    expect(joined(run([chunk({ content: 'Use <think> tags.' })]).events))
      .toStrictEqual([{ kind: 'token', token: 'Use <think> tags.' }])
    expect(joined(run([chunk({ content: ' <thi' })]).events))
      .toStrictEqual([{ kind: 'token', token: ' <thi' }])
  })

  it('does not split tags after a reasoning field', () => {
    const { events, end } = run([
      chunk({ reasoning_content: 'Plan.' }),
      chunk({ content: '<think>literal</think>' }),
      '[DONE]',
    ])

    expect(events).toStrictEqual([
      { kind: 'thinking', token: 'Plan.' },
      { kind: 'token', token: '<think>literal</think>' },
      { kind: 'done' },
    ])
    expect(end.replay).toStrictEqual({ kind: 'field', field: 'reasoning_content' })
  })
})

describe('OpenAiStreamParser tool calls', () => {
  const toolCalls = (pieces: Delta[], finishReason: string | null = null) => chunk({ tool_calls: pieces }, finishReason)

  it.each([true, false])('joins the argument pieces of two calls by index, in stream order (thinking %s)', (thinking) => {
    const { events, end } = run([
      chunk({ content: 'Let me look.' }),
      toolCalls([{ index: 0, id: 'call_a', type: 'function', function: { name: 'model_list', arguments: '' } }]),
      toolCalls([{ index: 0, function: { arguments: '{"fil' } }]),
      toolCalls([{ index: 1, id: 'call_b', type: 'function', function: { name: 'model_list', arguments: '{}' } }]),
      toolCalls([{ index: 0, function: { arguments: 'ter":"gemini"}' } }]),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ], thinking)

    expect(events).toStrictEqual([{ kind: 'token', token: 'Let me look.' }, { kind: 'done' }])
    expect(end).toStrictEqual({
      events: [],
      toolCalls: [
        { id: 'call_a', name: 'model_list', argumentsText: '{"filter":"gemini"}' },
        { id: 'call_b', name: 'model_list', argumentsText: '{}' },
      ],
    })
  })

  it('starts a new call when a new id comes at the same index', () => {
    const { end } = run([
      toolCalls([{ index: 0, id: 'a', function: { name: 'model_list', arguments: '{"filter":' } }]),
      toolCalls([{ index: 0, function: { arguments: '"x"}' } }]),
      toolCalls([{ index: 0, id: 'b', function: { name: 'model_list', arguments: '{}' } }], 'tool_calls'),
    ])

    expect(end.toolCalls).toStrictEqual([
      { id: 'a', name: 'model_list', argumentsText: '{"filter":"x"}' },
      { id: 'b', name: 'model_list', argumentsText: '{}' },
    ])
  })

  it('goes on with the last call for a piece with no index, and takes a repeated id and name once', () => {
    const { end } = run([
      toolCalls([{ id: 'a', function: { name: 'model_list', arguments: '{"filter"' } }]),
      toolCalls([{ id: 'a', function: { name: 'model_list', arguments: ':"x"}' } }]),
      toolCalls([{ id: 'b', function: { name: 'model_list' } }]),
      // Some servers end a reply with tool calls with `stop`.
      chunk({}, 'stop'),
    ])

    expect(end.toolCalls).toStrictEqual([
      { id: 'a', name: 'model_list', argumentsText: '{"filter":"x"}' },
      { id: 'b', name: 'model_list', argumentsText: '' },
    ])
  })

  it('gives no calls from a stream that was cut off or failed', () => {
    const call = toolCalls([{ index: 0, id: 'a', function: { name: 'model_list', arguments: '{"filter":"ge' } }])

    expect(run([call]).end).toStrictEqual({ events: [] })
    expect(run([call, chunk({}, 'error')]).end).toStrictEqual({ events: [] })
  })
})
