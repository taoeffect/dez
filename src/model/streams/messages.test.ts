import { describe, expect, it } from 'vitest'
import { toolBlockText, type ToolBlockStatus } from '../chat/toolBlocks'
import type { ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import { agentSectionMessages } from './messages'

const model: ModelRef = { providerId: 'local', modelId: 'm' }
const IMAGE = '/home/u/.config/dez/assets/images/red.png'

// A block of the model list tool, as the stream controller writes it.
function block(id: string, filter: string, result: string, status: ToolBlockStatus = 'success'): string {
  return toolBlockText({ id, name: 'model_list', status, arguments: { filter }, result })
}

function agent(text: string, thinking?: SectionThinking): Section {
  return { id: 'a1', role: 'agent', model, content: [{ kind: 'text', text }], ...(thinking && { thinking }) }
}

const call = (id: string, filter: string) => ({ id, name: 'model_list', arguments: { filter } })
const result = (callId: string, content: string, isError = false) => ({ callId, content, isError })

const blocksReplay = (plan: string, prefixHash: string): ThinkingReplay => ({
  kind: 'anthropicBlocks',
  blocks: [{ type: 'thinking', thinking: plan, signature: `${plan} signature` }],
  prefixHash,
})

describe('agentSectionMessages', () => {
  it('gives a section with no tool blocks one agent message, with or without tools', () => {
    const section = agent('Hello.\n\nBye.\n')
    const expected = [{ role: 'agent', content: 'Hello.\n\nBye.\n' }]

    expect(agentSectionMessages(section, model, true)).toStrictEqual(expected)
    expect(agentSectionMessages(section, model, false)).toStrictEqual(expected)
  })

  it('gives each round its text and its group of calls, then the results, then the text after the last group', () => {
    const text = `Let me look.\n${block('call_1', 'gemini', '1 model')}\n${block('call_2', 'mistral', '2 models')}\nI found 3 models.`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: 'Let me look.', toolCalls: [call('call_1', 'gemini'), call('call_2', 'mistral')] },
      { role: 'tool', results: [result('call_1', '1 model'), result('call_2', '2 models')] },
      { role: 'agent', content: 'I found 3 models.' },
    ])
  })

  it('drops only the line break that joins a text to a block', () => {
    const text = `Look:\n\n${block('call_1', 'gemini', '1 model')}\n\nDone.`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: 'Look:\n', toolCalls: [call('call_1', 'gemini')] },
      { role: 'tool', results: [result('call_1', '1 model')] },
      { role: 'agent', content: '\nDone.' },
    ])
  })

  it('starts a new group after a blank line between two blocks: the round between wrote no text', () => {
    const text = `${block('call_1', 'gemini', '1 model')}\n\n${block('call_2', 'mistral', '2 models')}\nDone.`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: '', toolCalls: [call('call_1', 'gemini')] },
      { role: 'tool', results: [result('call_1', '1 model')] },
      { role: 'agent', content: '', toolCalls: [call('call_2', 'mistral')] },
      { role: 'tool', results: [result('call_2', '2 models')] },
      { role: 'agent', content: 'Done.' },
    ])
  })

  it('sends the model text without the escape of its tag text', () => {
    const text = `See <\\dez:tool> here.\n${block('call_1', 'gemini', '1 model')}\nAnd <\\/dez:tool>.`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: 'See <dez:tool> here.', toolCalls: [call('call_1', 'gemini')] },
      { role: 'tool', results: [result('call_1', '1 model')] },
      { role: 'agent', content: 'And </dez:tool>.' },
    ])
  })

  it('gives every call a result, and leaves out a blank text after the last group', () => {
    const blocks = [
      block('call_1', 'a', '1 model'),
      block('call_2', 'b', 'Bad filter.', 'error'),
      // The app stopped while the tool ran.
      block('call_3', 'c', '', 'running'),
      block('call_4', 'd', ''),
      block('call_5', 'e', '', 'error'),
    ]

    expect(agentSectionMessages(agent(`${blocks.join('\n')}\n\n`), model, true)).toStrictEqual([
      { role: 'agent', content: '', toolCalls: [call('call_1', 'a'), call('call_2', 'b'), call('call_3', 'c'), call('call_4', 'd'), call('call_5', 'e')] },
      {
        role: 'tool',
        results: [
          result('call_1', '1 model'),
          result('call_2', 'Bad filter.', true),
          result('call_3', 'Interrupted.', true),
          result('call_4', 'No result.'),
          result('call_5', 'No result.', true),
        ],
      },
    ])
  })

  it('sends no image path in the text, the arguments, or the results', () => {
    const text = `This: ![${IMAGE}](id=a)\n${block('call_1', `![${IMAGE}](id=a)`, `Found ![${IMAGE}](id=a).`)}\nSee ![${IMAGE}](id=a).`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: 'This: ![image](id=a)', toolCalls: [call('call_1', '![image](id=a)')] },
      { role: 'tool', results: [result('call_1', 'Found ![image](id=a).')] },
      { role: 'agent', content: 'See ![image](id=a).' },
    ])
    expect(JSON.stringify(agentSectionMessages(agent(text), model, false))).not.toContain('assets/images')
  })

  describe('thinking of each round', () => {
    const text = [
      'Look.',
      block('call_1', 'gemini', '1 model'),
      block('call_2', 'mistral', '2 models'),
      'More.',
      block('call_3', 'claude', '3 models'),
      'Done.',
    ].join('\n')
    const replay1 = blocksReplay('Plan 1', 'h1')
    const replay2 = blocksReplay('Plan 2', 'h2')
    // The third round's thinking was cut off: its entry has no replay.
    const thinking: SectionThinking = {
      text: 'Plan 1Plan 2Plan 3',
      replay: replay1,
      rounds: [{ afterToolCall: 'call_1', from: 6, replay: replay2 }, { afterToolCall: 'call_3', from: 12 }],
    }

    it('sends each round its own slice and replay, paired by the first call of the group before it', () => {
      expect(agentSectionMessages(agent(text, thinking), model, true)).toStrictEqual([
        { role: 'agent', content: 'Look.', thinking: { text: 'Plan 1', replay: replay1 }, toolCalls: [call('call_1', 'gemini'), call('call_2', 'mistral')] },
        { role: 'tool', results: [result('call_1', '1 model'), result('call_2', '2 models')] },
        { role: 'agent', content: 'More.', thinking: { text: 'Plan 2', replay: replay2 }, toolCalls: [call('call_3', 'claude')] },
        { role: 'tool', results: [result('call_3', '3 models')] },
        { role: 'agent', content: 'Done.' },
      ])
    })

    it('sends no thinking for a round with no entry', () => {
      const firstRoundOnly: SectionThinking = { text: 'Plan 1', replay: replay1 }
      const sent = agentSectionMessages(agent(text, firstRoundOnly), model, true)

      expect(sent.map((message) => message.role === 'agent' ? message.thinking : null)).toStrictEqual([
        { text: 'Plan 1', replay: replay1 }, null, undefined, null, undefined,
      ])
    })

    it('sends no thinking to another model', () => {
      const sent = agentSectionMessages(agent(text, thinking), { providerId: 'local', modelId: 'other' }, true)

      expect(sent.some((message) => message.role === 'agent' && message.thinking)).toBe(false)
    })

    it('sends one agent message with each block as text, and no thinking, in a request with no tools', () => {
      expect(agentSectionMessages(agent(text, thinking), model, false)).toStrictEqual([{
        role: 'agent',
        content: [
          'Look.',
          '[Tool call: model_list {"filter":"gemini"}]\n1 model\n[End of tool result]',
          '[Tool call: model_list {"filter":"mistral"}]\n2 models\n[End of tool result]',
          'More.',
          '[Tool call: model_list {"filter":"claude"}]\n3 models\n[End of tool result]',
          'Done.',
        ].join('\n'),
      }])
    })
  })
})
