import { describe, expect, it } from 'vitest'
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
})
