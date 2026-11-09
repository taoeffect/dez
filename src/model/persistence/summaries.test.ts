import { describe, expect, it } from 'vitest'
import { toolBlockText } from '../chat/toolBlocks'
import { conversationPreview, messageCount } from './summaries'
import type { ContentNodeData, SectionData } from './types'

function textNode(text: string): ContentNodeData {
  return { kind: 'text', text }
}

function section(role: SectionData['role'], nodes: ContentNodeData[]): SectionData {
  return { role, nodes }
}

describe('conversation summaries', () => {
  it('counts visible messages and builds a normalized preview from text and prompt nodes', () => {
    const sections = [
      section('user', [textNode('   ')]),
      section('user', [textNode('Hello\nthere')]),
      section('agent', [{ kind: 'prompt', id: 'p1', promptId: null, name: 'summary', body: 'Prompt body\nwith spacing', expanded: false }]),
    ]

    expect(messageCount(sections)).toBe(2)
    expect(conversationPreview(sections)).toBe('Hello there Prompt body with spacing')
  })

  it('leaves the tool blocks of agent text out of the preview and keeps the same text in user text', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const sections = [
      section('user', [textNode(`Like:\n${block}`)]),
      section('agent', [textNode(`${block}\nThere are 12.`)]),
    ]

    expect(conversationPreview(sections))
      .toBe('Like: <dez:tool id="call_1" name="model_list"> 12 models </dez:tool> There are 12.')
  })
})
