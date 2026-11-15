import { describe, expect, it } from 'vitest'
import { DEFAULT_FAMILY, modelFamily, type ModelFamily } from '../providers/modelFamilies'
import type { ToolDefinition } from '../tools/types'
import { estimatedRequestTokens, type EstimatedRequest } from './contextEstimate'
import type { StreamMessage } from './types'

// 4 characters per token, so that the counts are easy to read.
const family: ModelFamily = { ...DEFAULT_FAMILY, charsPerToken: 4 }

function tokens(request: Partial<EstimatedRequest>, of: ModelFamily = family): number {
  return estimatedRequestTokens({ tools: [], messages: [], ...request }, of)
}

describe('estimatedRequestTokens', () => {
  it('is 0 for a request that holds nothing', () => {
    expect(tokens({})).toBe(0)
    expect(tokens({ system: '' })).toBe(0)
  })

  // Each text is 40 characters: 10 tokens.
  const forty = 'x'.repeat(40)
  it.each<[string, Partial<EstimatedRequest>]>([
    ['the system prompt', { system: forty }],
    ['a user message', { messages: [{ role: 'user', content: forty }] }],
    ['the text parts of a user message', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30) }, { type: 'text', text: 'x'.repeat(10) }] }] }],
    ['an agent message', { messages: [{ role: 'agent', content: forty }] }],
    ['the thinking that goes back', { messages: [{ role: 'agent', content: '', thinking: { text: forty, replay: { kind: 'field', field: 'reasoning' } } }] }],
    // `{"text":"…"}` is 11 characters around the value.
    ['a tool call', { messages: [{ role: 'agent', content: '', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'x'.repeat(25) } }] }] }],
    ['a tool result', { messages: [{ role: 'tool', results: [{ callId: 'call_1', content: 'x'.repeat(15), isError: false }, { callId: 'call_2', content: 'x'.repeat(25), isError: true }] }] }],
    ['a tool call of the newest answer', { answerCalls: [{ id: 'call_1', name: 'echo', argumentsText: 'x'.repeat(36) }] }],
  ])('counts %s', (_name, request) => {
    expect(tokens(request)).toBe(10)
  })

  it('counts the tools as the JSON of their names, descriptions, and schemas', () => {
    const tool: ToolDefinition = {
      name: 'echo',
      description: 'Says it.',
      parameters: [
        { name: 'text', type: 'string', description: 'What.', required: true },
        { name: 'loud', type: 'boolean', description: 'How.', required: false },
      ],
    }
    const json = '[{"name":"echo","description":"Says it.","parameters":{"type":"object","properties":{'
      + '"text":{"type":"string","description":"What."},"loud":{"type":"boolean","description":"How."}},"required":["text"]}}]'

    expect(tokens({ tools: [tool] })).toBe(Math.ceil(json.length / 4))
  })

  it('adds the characters of the whole request before it rounds up', () => {
    const messages: StreamMessage[] = [{ role: 'user', content: 'a' }, { role: 'agent', content: 'b' }, { role: 'user', content: 'c' }]

    expect(tokens({ system: 'd', messages })).toBe(1)
    expect(tokens({ system: 'de', messages })).toBe(2)
  })

  it('uses the characters per token of the family', () => {
    const messages: StreamMessage[] = [{ role: 'user', content: 'x'.repeat(100) }]

    expect(tokens({ messages }, { ...DEFAULT_FAMILY, charsPerToken: 2.5 })).toBe(40)
    expect(tokens({ messages }, { ...DEFAULT_FAMILY, charsPerToken: 3.3 })).toBe(31)
  })

  it('counts a kana, Han, or Hangul character as one token, not by the ratio', () => {
    expect(tokens({ messages: [{ role: 'user', content: '日本語のテキスト' }] })).toBe(8)
    expect(tokens({ messages: [{ role: 'user', content: '한국어' }] })).toBe(3)
    // 8 other characters (2 tokens) and 2 Han characters.
    expect(tokens({ messages: [{ role: 'user', content: 'abcd 中文 ef' }] })).toBe(4)
  })

  // An image of 1568 by 1568 pixels: 56 by 56 patches of 28 pixels, 49 by
  // 49 patches of 32 pixels at 1.2 tokens each, or the fixed count.
  it('counts each image of a user message by the image rule of the family, at one size for all', () => {
    const messages: StreamMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'x'.repeat(40) },
        { type: 'image', path: '/home/u/.config/dez/assets/images/a.png' },
        { type: 'image', path: '/home/u/.config/dez/assets/images/b.png' },
      ],
    }]
    const text = (of: ModelFamily) => Math.ceil(40 / of.charsPerToken)

    const claude = modelFamily('claude-sonnet-4-5')
    const gpt = modelFamily('gpt-5.4')
    const gemini = modelFamily('gemini-3-pro')
    expect(tokens({ messages }, claude)).toBe(text(claude) + 2 * 3136)
    expect(tokens({ messages }, gpt)).toBe(text(gpt) + 2 * 2882)
    expect(tokens({ messages }, gemini)).toBe(text(gemini) + 2 * 1120)
    expect(tokens({ messages }, DEFAULT_FAMILY)).toBe(text(DEFAULT_FAMILY) + 2 * 3136)
  })

  // A picture of an older Dez can have a side of 3000 pixels, larger than
  // an image of a user message: it counts as the most patches of the rule
  // (at 1.2 tokens each for GPT), or the fixed count. One side alone is no
  // size.
  it('counts a picture whose copy tells no size as the most that the image rule of the family gives', () => {
    const old = { file: 'f1.png', label: 'The copy of an older Dez.' }
    const messages: StreamMessage[] = [{
      role: 'user',
      content: [{ type: 'picture', picture: old }, { type: 'picture', picture: { ...old, width: 3000 } }],
    }]

    expect(tokens({ messages }, modelFamily('claude-sonnet-4-5'))).toBe(2 * 4784)
    expect(tokens({ messages }, modelFamily('gpt-5.4'))).toBe(2 * 36000)
    expect(tokens({ messages }, modelFamily('gemini-3-pro'))).toBe(2 * 1120)
    expect(tokens({ messages }, DEFAULT_FAMILY)).toBe(2 * 4784)
  })

  // A wave picture of 800 by 200 pixels: 29 by 8 patches of 28 pixels, 25
  // by 7 patches of 32 pixels at 1.2 tokens each, or the fixed count.
  it('counts a picture whose copy tells its size by that size', () => {
    const messages: StreamMessage[] = [{
      role: 'user',
      content: [{ type: 'picture', picture: { file: 'w1.jpg', label: 'The wave of @b.', width: 800, height: 200, bytes: 3000 } }],
    }]

    expect(tokens({ messages }, DEFAULT_FAMILY)).toBe(232)
    expect(tokens({ messages }, modelFamily('gpt-5.4'))).toBe(210)
    expect(tokens({ messages }, modelFamily('gemini-3-pro'))).toBe(1120)
  })
})
