import { describe, expect, it } from 'vitest'
import { parseConversation, serializeConversation } from './conversationFormat'
import type { ContentNodeData, ConversationData, SectionData } from './types'

function textNode(text: string): ContentNodeData {
  return { kind: 'text', text }
}

function section(role: SectionData['role'], nodes: ContentNodeData[]): SectionData {
  return { role, nodes }
}

function textContent(node: ContentNodeData): string {
  expect(node.kind).toBe('text')
  return node.kind === 'text' ? node.text : ''
}

function promptContent(node: ContentNodeData): Extract<ContentNodeData, { kind: 'prompt' }> {
  expect(node.kind).toBe('prompt')
  if (node.kind !== 'prompt') throw new Error('Expected prompt node')
  return node
}

describe('conversation persistence format', () => {
  it('collapses duplicate leading user pills while preserving the later agent section', () => {
    const content = `<!-- title: Duplicate pills | model: provider/model | created: 123 -->

<dez:pill type="user"/>


<dez:pill type="user"/>


<dez:pill type="user"/>


what's your name?
<dez:pill type="agent"/>
Hi there!
`
    const parsed = parseConversation('conversation', content)

    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[0].role).toBe('user')
    expect(parsed.sections[1].role).toBe('agent')
    expect(parsed.sections[0].nodes).toHaveLength(1)
    expect(textContent(parsed.sections[0].nodes[0])).toBe("what's your name?")
    expect(textContent(parsed.sections[1].nodes[0])).toBe('Hi there!')
  })

  it('round-trips duplicate user pills without emitting empty duplicate sections', () => {
    const content = `<!-- title: Duplicate pills | model:  | created: 456 -->

<dez:pill type="user"/>

<dez:pill type="user"/>

hello
<dez:pill type="agent"/>
world
`
    const parsed = parseConversation('conversation', content)
    const serialized = serializeConversation(parsed)
    const reparsed = parseConversation('conversation', serialized)

    expect(serialized.match(/<dez:pill type="user"\/>/g)?.length).toBe(1)
    expect(reparsed.sections).toHaveLength(2)
    expect(reparsed.sections[0].role).toBe('user')
    expect(reparsed.sections[1].role).toBe('agent')
    expect(textContent(reparsed.sections[0].nodes[0])).toBe('hello')
    expect(textContent(reparsed.sections[1].nodes[0])).toBe('world')
  })

  it('round-trips trailing empty user sections after agent responses', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('hello')]),
        section('agent', [textNode('world')]),
        section('user', []),
      ],
      activeModel: null,
      created_at: 789,
    }

    const parsed = parseConversation('conversation', serializeConversation(data))

    expect(parsed.sections).toHaveLength(3)
    expect(parsed.sections[0].role).toBe('user')
    expect(parsed.sections[1].role).toBe('agent')
    expect(parsed.sections[2].role).toBe('user')
    expect(parsed.sections[2].nodes).toEqual([])
  })

  it('preserves leading newlines in non-leading sections', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('hello')]),
        section('agent', [textNode('\nworld')]),
      ],
      activeModel: null,
      created_at: 789,
    }

    const parsed = parseConversation('conversation', serializeConversation(data))

    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[1].role).toBe('agent')
    expect(textContent(parsed.sections[1].nodes[0])).toBe('\nworld')
  })

  it('parses prompt blocks inside a conversation section', () => {
    const content = '<!-- title: t | model:  | created: 1 -->\n\n<dez:pill type="agent"/>\n\nHi there! today?\n<dez:prompt name="code-review">\nthis is a multi-line\n\nbody of many things\n</dez:prompt>\n\nrest of text\n'
    const parsed = parseConversation('c', content)

    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].role).toBe('agent')
    expect(parsed.sections[0].nodes).toHaveLength(3)
    expect(textContent(parsed.sections[0].nodes[0])).toBe('\nHi there! today?\n')
    const prompt = promptContent(parsed.sections[0].nodes[1])
    expect(prompt.name).toBe('code-review')
    expect(prompt.body).toBe('this is a multi-line\n\nbody of many things')
    expect(prompt.promptId).toBe(null)
    expect(prompt.expanded).toBe(false)
    expect(textContent(parsed.sections[0].nodes[2])).toBe('\nrest of text')
    const reparsed = parseConversation('c', serializeConversation(parsed))
    expect(textContent(reparsed.sections[0].nodes[0])).toBe('\nHi there! today?\n')
  })

  it('sanitizes header fields and escapes literal prompt closing markers', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Title | with\nspaces\r',
      sections: [
        section('user', [
          textNode('before\n'),
          { kind: 'prompt', id: 'p1', promptId: 'saved', name: 'prompt', body: 'literal </dez:prompt> marker', expanded: true },
        ]),
      ],
      activeModel: { providerId: 'openrouter', modelId: 'model/id', modelName: 'Display' },
      created_at: 1000,
    }

    const serialized = serializeConversation(data)
    const parsed = parseConversation('conversation', serialized)

    expect(serialized.startsWith('<!-- title: Title / with spaces  | model: openrouter/model/id | created: 1000 -->')).toBe(true)
    expect(serialized).toContain('literal <\\/dez:prompt> marker')
    expect(parsed.title).toBe('Title / with spaces')
    expect(parsed.activeModel).toEqual({
      providerId: 'openrouter',
      modelId: 'model/id',
      modelName: 'model/id',
    })
    expect(promptContent(parsed.sections[0].nodes[1]).body).toBe('literal </dez:prompt> marker')
  })

  it('strips live CodeMirror sentinels from serialized content', () => {
    const liveSentinelText = 'a\u001Eb\uE000c\uE001d\uE002e\uE003f'
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [
          textNode(liveSentinelText),
          { kind: 'prompt', id: 'p1', promptId: null, name: 'prompt', body: liveSentinelText, expanded: false },
        ]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    const serialized = serializeConversation(data)

    expect(serialized).not.toContain('\u001E')
    expect(serialized).not.toContain('\uE000')
    expect(serialized).not.toContain('\uE001')
    expect(serialized).not.toContain('\uE002')
    expect(serialized).not.toContain('\uE003')
    expect(serialized).toContain('abcde\nf')
  })

  it('falls back to an empty user section for empty content', () => {
    expect(parseConversation('empty', '')).toEqual({
      id: 'empty',
      title: '',
      sections: [{ role: 'user', nodes: [] }],
      activeModel: null,
      created_at: 0,
    })
  })
})
