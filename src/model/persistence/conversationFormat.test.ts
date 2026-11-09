import { commonmarkLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { toolBlockText } from '../chat/toolBlocks'
import type { ModelRef, SectionThinking, ThinkingReplay } from '../chat/types'
import { parseConversation, serializeConversation, serializeConversationAsMarkdown } from './conversationFormat'
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

function pillLines(serialized: string): string[] {
  return serialized.split('\n').filter((line) => line.startsWith('<dez:pill'))
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

  it('round-trips image references, also right after a pill and alone in a section', () => {
    const image = '/home/user/.config/dez/assets/images/0b5c9a2e-4a8f-4c1e-9d3b-2f6e7a1c8d40.png'
    const data: ConversationData = {
      id: 'conversation',
      title: '[image] What color is it?',
      sections: [
        section('user', [textNode(`![${image}]()\nWhat color is it? ![${image}]()`)]),
        section('agent', [textNode('Red.')]),
        section('user', [textNode(`![${image}]()`)]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(parseConversation('conversation', serializeConversation(data))).toEqual(data)
  })

  // Tool results are escaped, so no result line reads as a pill or prompt
  // line, and requests rebuild earlier calls from these exact bytes.
  it('round-trips agent text with tool blocks byte for byte', () => {
    const call = (id: string, result: string) => toolBlockText({ id, name: 'model_list', status: 'success', arguments: { filter: 'a "b"' }, result })
    const data: ConversationData = {
      id: 'conversation',
      title: 'Tools',
      sections: [
        section('user', [textNode('Like this?\n<dez:tool id="u" name="model_list">\n</dez:tool>')]),
        section('agent', [textNode([
          'Let me check.',
          call('call_1', '<dez:pill type="user"/>\n<dez:prompt name="p">\nbody\n</dez:prompt>\n</dez:pill>\n</dez:tool>'),
          call('call_2', ''),
          toolBlockText({ id: 'call_3', name: 'model_list', status: 'running', arguments: {}, result: '' }),
          'There are two.',
        ].join('\n'))]),
        section('user', [textNode('Thanks')]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    const file = serializeConversation(data)
    const parsed = parseConversation('conversation', file)

    expect(parsed).toStrictEqual(data)
    expect(serializeConversation(parsed)).toBe(file)
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

  it('strips live CodeMirror sentinels and broken pill ids from serialized content', () => {
    const pillId = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
    // Text nodes hold no pills, so every marker here is left from a broken
    // pill: a separator, a pill header with its id, a close marker, and an
    // escaped newline.
    const liveSentinelText = `a\u001Eb\uE000${pillId}\uE001c\uE002d\uE003e`
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

    expect(serialized).not.toMatch(/[\u001E\uE000-\uE003]/)
    expect(serialized).not.toContain(pillId)
    expect(serialized).toBe([
      '<!-- title: Chat | model:  | created: 1000 -->',
      '',
      '<dez:pill type="user"/>',
      'abcd',
      'e',
      '<dez:prompt name="prompt">',
      'abcd',
      'e',
      '</dez:prompt>',
      '',
    ].join('\n'))
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

describe('agent pill models', () => {
  function modeledSection(role: SectionData['role'], text: string, model: ModelRef): SectionData {
    return { role, nodes: [textNode(text)], model }
  }

  function conversation(sections: SectionData[]): ConversationData {
    return { id: 'conversation', title: 'Chat', sections, activeModel: null, created_at: 1 }
  }

  it('round-trips a model per agent section and writes none for an unknown model', () => {
    const data: ConversationData = {
      ...conversation([
        section('user', [textNode('hi')]),
        modeledSection('agent', 'one', { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }),
        section('user', [textNode('switch')]),
        modeledSection('agent', 'two', { providerId: 'zai', modelId: 'glm-4.6' }),
        section('user', [textNode('again')]),
        section('agent', [textNode('three')]),
      ]),
      activeModel: { providerId: 'zai', modelId: 'glm-4.6', modelName: 'glm-4.6' },
    }

    const serialized = serializeConversation(data)

    expect(pillLines(serialized)).toEqual([
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" model="openrouter/anthropic/claude-sonnet-4.5"/>',
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" model="zai/glm-4.6"/>',
      '<dez:pill type="user"/>',
      '<dez:pill type="agent"/>',
    ])
    // Strict: a section without a model must not come back as `model: undefined`.
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  it('escapes a model id so the pill stays on one line and reads back exactly', () => {
    const model = { providerId: 'custom-1', modelId: 'vendor/a"b & c&quot;d />\nline\re' }
    const data = conversation([section('user', [textNode('hi')]), modeledSection('agent', 'reply', model)])

    const serialized = serializeConversation(data)
    const parsed = parseConversation('conversation', serialized)

    expect(pillLines(serialized)).toEqual([
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" model="custom-1/vendor/a&quot;b &amp; c&amp;quot;d />&#10;line&#13;e"/>',
    ])
    expect(parsed.sections[1].model).toStrictEqual(model)
    expect(textContent(parsed.sections[1].nodes[0])).toBe('reply')
  })

  it('parses a file without model attributes with no model keys', () => {
    const parsed = parseConversation('conversation', '<!-- title: t | model: zai/glm-4.6 | created: 1 -->\n\n<dez:pill type="user"/>\nhi\n<dez:pill type="agent"/>\nhello\n')

    expect(parsed.sections.map((s) => s.role)).toEqual(['user', 'agent'])
    expect(parsed.sections.map((s) => Object.hasOwn(s, 'model'))).toEqual([false, false])
  })

  it('ignores a model on user pills and empty or invalid model values', () => {
    const content = [
      '<!-- title: t | model:  | created: 1 -->',
      '<dez:pill type="user" model="openrouter/x"/>',
      'hi',
      '<dez:pill type="agent" model=""/>',
      'a',
      '<dez:pill type="agent" model="no-slash"/>',
      'b',
      '<dez:pill type="agent" model="/model"/>',
      'c',
      '<dez:pill type="agent" model="provider/"/>',
      'd',
      '',
    ].join('\n')

    const parsed = parseConversation('conversation', content)

    expect(parsed.sections.map((s) => s.role)).toEqual(['user', 'agent', 'agent', 'agent', 'agent'])
    expect(parsed.sections.map((s) => Object.hasOwn(s, 'model'))).toEqual([false, false, false, false, false])
  })

  it('drops the model of a section saved as user', () => {
    const data = conversation([
      section('user', [textNode('hi')]),
      modeledSection('user', 'was an agent reply', { providerId: 'zai', modelId: 'glm-4.6' }),
    ])

    expect(pillLines(serializeConversation(data))).toEqual(['<dez:pill type="user"/>', '<dez:pill type="user"/>'])
  })

  it('reads attributes in any order and keeps a pill without a type as text', () => {
    const content = [
      '<!-- title: t | model:  | created: 1 -->',
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill   model="openrouter/x"  type="agent" />',
      'hello',
      '<dez:pill model="openrouter/y"/>',
      '',
    ].join('\n')

    const parsed = parseConversation('conversation', content)

    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[1].model).toStrictEqual({ providerId: 'openrouter', modelId: 'x' })
    expect(textContent(parsed.sections[1].nodes[0])).toBe('hello\n<dez:pill model="openrouter/y"/>')
  })
})

describe('agent thinking containers', () => {
  const model: ModelRef = { providerId: 'zai', modelId: 'glm-4.6' }

  function thinkingSection(answer: string, thinking: SectionThinking): SectionData {
    return { role: 'agent', nodes: [textNode(answer)], model, thinking }
  }

  function conversation(sections: SectionData[]): ConversationData {
    return { id: 'conversation', title: 'Chat', sections: [section('user', [textNode('hi')]), ...sections], activeModel: null, created_at: 1 }
  }

  function file(lines: string[]): string {
    return ['<!-- title: Chat | model:  | created: 1 -->', ...lines, ''].join('\n')
  }

  it('writes the thinking as the exact container body, with the markers escaped', () => {
    const data = conversation([thinkingSection('answer', { text: 'line one\n</dez:pill>\n<dez:pill type="user"/>\n' })])

    expect(serializeConversation(data)).toBe(file([
      '',
      '<dez:pill type="user"/>',
      'hi',
      '',
      '<dez:pill type="agent" model="zai/glm-4.6">',
      'line one',
      '<\\/dez:pill>',
      '<\\dez:pill type="user"/>',
      '',
      '</dez:pill>',
      'answer',
    ]))
  })

  // The `field` replay sends the text back, so every byte must survive.
  it('round-trips the thinking text byte for byte', () => {
    const texts = [
      'plain',
      '',
      '\n',
      'trailing newlines\n\n',
      '\n\nleading newlines',
      'carriage\r\nreturns\r',
      '  indented\n\ttabbed  ',
      'inline </dez:pill> closer',
      '</dez:pill>',
      '  </dez:pill>  ',
      'already escaped <\\/dez:pill> and <\\\\/dez:pill>',
      'already escaped <\\dez:pill type="user"/> and <\\\\dez:pill',
      '<dez:pill type="user"/>\n<dez:prompt name="p">\nbody\n</dez:prompt>',
      '  <dez:pill type="agent" model="zai/glm-4.6">  \n</dez:pill',
      '<!-- title: x | model: y | created: 2 -->',
    ]
    const data = conversation(texts.map((text, index) => thinkingSection(`answer ${index}`, { text })))

    expect(parseConversation('conversation', serializeConversation(data))).toStrictEqual(data)
  })

  it('round-trips each replay kind in a one-line replay attribute', () => {
    const replays: ThinkingReplay[] = [
      { kind: 'field', field: 'reasoning_content' },
      { kind: 'field', field: 'reasoning' },
      {
        kind: 'anthropicBlocks',
        blocks: [
          { type: 'thinking', thinking: 'a "quoted" & <b>\nnext line\r', signature: 'sig/+==' },
          { type: 'redacted_thinking', data: 'opaque&quot;data' },
        ],
        prefixHash: 'h1',
      },
      {
        kind: 'reasoningDetails',
        details: [
          { type: 'reasoning.text', text: 'step', index: 0, signature: null },
          { type: 'reasoning.encrypted', data: 'enc', nested: { list: [1, 2.5, true, null, 'x'] } },
        ],
        prefixHash: 'h2',
      },
      { kind: 'copilot', opaque: 'op"aque&\n', prefixHash: 'h3' },
    ]
    const data = conversation(replays.map((replay, index) => thinkingSection(`answer ${index}`, { text: `thought ${index}`, replay })))

    const serialized = serializeConversation(data)
    const openingTags = serialized.split('\n').filter((line) => line.startsWith('<dez:pill type="agent"'))

    expect(openingTags).toHaveLength(replays.length)
    expect(openingTags.every((line) => line.endsWith('">') && line.includes(' replay="{&quot;kind&quot;:'))).toBe(true)
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  it('keeps the thinking but no replay when the replay attribute is not a known shape', () => {
    const badReplays = [
      'not json',
      '{&quot;kind&quot;:&quot;unknown&quot;}',
      '{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;content&quot;}',
      '{&quot;kind&quot;:&quot;copilot&quot;,&quot;opaque&quot;:&quot;x&quot;}',
      '[]',
      '',
    ]
    const content = file(['<dez:pill type="user"/>', 'hi', ...badReplays.flatMap((replay, index) => [
      `<dez:pill type="agent" replay="${replay}">`,
      `thought ${index}`,
      '</dez:pill>',
      `answer ${index}`,
    ])])

    const parsed = parseConversation('conversation', content)

    expect(parsed.sections.slice(1).map((s) => s.thinking)).toStrictEqual(badReplays.map((_, index) => ({ text: `thought ${index}` })))
    expect(parsed.sections.slice(1).map((s) => textContent(s.nodes[0]))).toEqual(badReplays.map((_, index) => `answer ${index}`))
  })

  it('round-trips the rounds of a reply with tool calls in a one-line rounds attribute after replay', () => {
    const thinking: SectionThinking = {
      text: 'Plan.\nLook "again" & <b>.',
      replay: { kind: 'field', field: 'reasoning_content' },
      rounds: [
        { afterToolCall: 'call_1', from: 6, replay: { kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'a\n"b"', signature: 's' }], prefixHash: 'h' } },
        { afterToolCall: 'functions.x:0', from: 6 },
        { afterToolCall: 'call_3', from: 24, replay: { kind: 'field', field: 'reasoning_content' } },
      ],
    }
    const data = conversation([thinkingSection('answer', thinking)])

    const serialized = serializeConversation(data)
    const [openingTag] = serialized.split('\n').filter((line) => line.startsWith('<dez:pill type="agent"'))

    expect(openingTag).toMatch(/^<dez:pill type="agent" model="zai\/glm-4.6" replay="[^"]*" rounds="\[\{&quot;afterToolCall&quot;:&quot;call_1&quot;,&quot;from&quot;:6,[^"]*\]">$/)
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  // Without valid rounds, Dez cannot tell where the first round's text ends,
  // so no replay goes back for the section, not even the first round's.
  it('keeps the thinking text but no replay or rounds when the rounds attribute is not valid', () => {
    const replay = '{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning&quot;}'
    const round = (fields: string) => `{&quot;afterToolCall&quot;:&quot;c&quot;,${fields}}`
    const badRounds = [
      'not json',
      '{}',
      `[${round('&quot;from&quot;:1.5')}]`,
      `[${round('&quot;from&quot;:-1')}]`,
      `[${round('&quot;from&quot;:&quot;1&quot;')}]`,
      `[{&quot;from&quot;:1}]`,
      `[${round('&quot;from&quot;:3')},${round('&quot;from&quot;:2')}]`,
      `[${round('&quot;from&quot;:10')}]`,
      `[${round(`&quot;from&quot;:1,&quot;replay&quot;:{&quot;kind&quot;:&quot;unknown&quot;}`)}]`,
    ]
    const content = file(['<dez:pill type="user"/>', 'hi', ...badRounds.flatMap((rounds, index) => [
      `<dez:pill type="agent" replay="${replay}" rounds="${rounds}">`,
      `thought ${index}`,
      '</dez:pill>',
      `answer ${index}`,
    ])])

    const parsed = parseConversation('conversation', content)

    expect(parsed.sections.slice(1).map((s) => s.thinking)).toStrictEqual(badRounds.map((_, index) => ({ text: `thought ${index}` })))
  })

  it('reads empty rounds as none and keeps the replay', () => {
    const content = file([
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill type="agent" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning&quot;}" rounds="[]">',
      'thought',
      '</dez:pill>',
      'answer',
    ])

    expect(parseConversation('conversation', content).sections[1].thinking)
      .toStrictEqual({ text: 'thought', replay: { kind: 'field', field: 'reasoning' } })
  })

  it('reads a container without a model, and no thinking from a self-closing tag with a replay', () => {
    const content = file([
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill type="agent">',
      'thought',
      '</dez:pill>',
      'one',
      '<dez:pill type="agent" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning&quot;}"/>',
      'two',
    ])

    const parsed = parseConversation('conversation', content)

    expect(parsed.sections.slice(1)).toStrictEqual([
      { role: 'agent', nodes: [textNode('one')], thinking: { text: 'thought' } },
      { role: 'agent', nodes: [textNode('two')] },
    ])
  })

  it('drops the body of a user container and the thinking of a section saved as user', () => {
    const content = file([
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill type="user">',
      'hand-written body',
      '</dez:pill>',
      'question',
    ])
    const asUser: SectionData = { role: 'user', nodes: [textNode('was an agent reply')], model, thinking: { text: 'thought' } }

    expect(parseConversation('conversation', content).sections).toStrictEqual([
      section('user', [textNode('hi')]),
      section('user', [textNode('question')]),
    ])
    expect(serializeConversation(conversation([asUser]))).not.toContain('thought')
  })

  // The writer escapes every marker in a thinking body, so a marker line
  // before any closing line means a hand edit lost the closing line. The
  // lines after the opening tag must not become thinking (a `field` replay
  // would send them to the provider) even when a later container closes.
  it('reads an opening tag with no closing line before the next marker as a self-closing marker', () => {
    const content = file([
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill type="agent" model="zai/glm-4.6" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning_content&quot;}">',
      'answer 1',
      '<dez:prompt name="p">',
      'prompt body',
      '</dez:prompt>',
      '<dez:pill type="user"/>',
      'q2',
      '<dez:pill type="agent" model="zai/glm-4.6">',
      'thought 2',
      '</dez:pill>',
      'answer 2',
      '<dez:pill type="user"/>',
      'q3',
      '<dez:pill type="agent" model="zai/glm-4.6">',
      'the last closing line was deleted',
    ])

    expect(parseConversation('conversation', content).sections).toStrictEqual([
      section('user', [textNode('hi')]),
      {
        role: 'agent',
        nodes: [textNode('answer 1\n'), { kind: 'prompt', id: expect.any(String), promptId: null, name: 'p', body: 'prompt body', expanded: false }],
        model,
      },
      section('user', [textNode('q2')]),
      { role: 'agent', nodes: [textNode('answer 2')], model, thinking: { text: 'thought 2' } },
      section('user', [textNode('q3')]),
      { role: 'agent', nodes: [textNode('the last closing line was deleted')], model },
    ])
  })
})

describe('agent pill durations', () => {
  const model: ModelRef = { providerId: 'zai', modelId: 'glm-4.6' }
  const header = '<!-- title: Chat | model:  | created: 1 -->'

  it('round-trips the duration of self-closing and container agent pills, with no key when absent', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('hi')]),
        { role: 'agent', nodes: [textNode('fast')], model, durationMs: 4213 },
        section('user', [textNode('again')]),
        { role: 'agent', nodes: [textNode('thought')], durationMs: 0, thinking: { text: 'plan', replay: { kind: 'field', field: 'reasoning' } } },
        section('user', [textNode('old')]),
        { role: 'agent', nodes: [textNode('legacy')], model },
      ],
      activeModel: null,
      created_at: 1,
    }

    const serialized = serializeConversation(data)

    expect(pillLines(serialized)).toEqual([
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" model="zai/glm-4.6" duration-ms="4213"/>',
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" duration-ms="0" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning&quot;}">',
      '<dez:pill type="user"/>',
      '<dez:pill type="agent" model="zai/glm-4.6"/>',
    ])
    // Strict: a section without a duration must not come back as
    // `durationMs: undefined`.
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  it('drops the duration of a section saved as user and ignores one on a user pill', () => {
    const serialized = serializeConversation({
      id: 'conversation',
      title: 'Chat',
      sections: [section('user', [textNode('hi')]), { role: 'user', nodes: [textNode('was an agent reply')], model, durationMs: 4213 }],
      activeModel: null,
      created_at: 1,
    })
    const parsed = parseConversation('conversation', `${header}\n<dez:pill type="user" duration-ms="5"/>\nhi\n`)

    expect(pillLines(serialized)).toEqual(['<dez:pill type="user"/>', '<dez:pill type="user"/>'])
    expect(parsed.sections).toStrictEqual([section('user', [textNode('hi')])])
  })

  // Hand edits must still open, with no time for a value that is not whole
  // milliseconds.
  it('reads a duration in any attribute order, and a bad value as none', () => {
    const values = ['', '-5', '1.5', '1e3', ' 42', 'abc', '99999999999999999999']
    const content = [
      header,
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill duration-ms="1500"  type="agent"/>',
      'ordered',
      ...values.flatMap((value, index) => [`<dez:pill type="agent" duration-ms="${value}"/>`, `bad ${index}`]),
      '',
    ].join('\n')

    const parsed = parseConversation('conversation', content)

    // 'none' marks a section without a `durationMs` key.
    expect(parsed.sections.map((s) => ('durationMs' in s ? s.durationMs : 'none'))).toStrictEqual(['none', 1500, ...values.map(() => 'none')])
    expect(parsed.sections.slice(2).map((s) => textContent(s.nodes[0]))).toEqual(values.map((_, index) => `bad ${index}`))
  })
})

describe('conversation Markdown export', () => {
  function headings(markdown: string): string[] {
    const found: string[] = []
    commonmarkLanguage.parser.parse(markdown).iterate({
      enter: (node) => {
        if (node.name.startsWith('ATXHeading')) found.push(markdown.slice(node.from, node.to))
      },
    })
    return found
  }

  it('writes one heading per message with prompt bodies inline and skips empty messages', () => {
    const pillId = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
    const data: ConversationData = {
      id: 'conversation',
      title: 'Translate\nthis  text',
      sections: [
        section('user', [
          textNode(`Translate \uE000${pillId}\uE001`),
          { kind: 'prompt', id: 'p1', promptId: null, name: 'text', body: 'this text\uE003please', expanded: false },
          textNode(' now.'),
        ]),
        section('agent', [textNode('Done:\n\n```\ncode\n```\n')]),
        section('user', [textNode('  \n')]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    const markdown = serializeConversationAsMarkdown(data)

    expect(markdown).toBe([
      '# Translate this text',
      '',
      '## User',
      '',
      'Translate this text',
      'please now.',
      '',
      '## Agent',
      '',
      'Done:',
      '',
      '```',
      'code',
      '```',
      '',
    ].join('\n'))
    // Viewers must show the turns as headings, not as literal marker text.
    expect(headings(markdown)).toEqual(['# Translate this text', '## User', '## Agent'])
  })

  it('closes a code fence left open at the end of a message', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Stopped streams',
      sections: [
        section('agent', [textNode('Here:\n\n```js\nconst a = 1')]),
        section('user', [textNode('Steps?')]),
        // The opener is inside a list item. A closer at column 0 would end
        // the list item and open a new fence that runs to the end.
        section('agent', [textNode('1. Install:\n\n   ````bash\n   ```\n   npm i\n')]),
        section('user', [textNode('Thanks')]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    const markdown = serializeConversationAsMarkdown(data)

    expect(markdown).toBe([
      '# Stopped streams',
      '',
      '## Agent',
      '',
      'Here:',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '## User',
      '',
      'Steps?',
      '',
      '## Agent',
      '',
      '1. Install:',
      '',
      '   ````bash',
      '   ```',
      '   npm i',
      '   ````',
      '',
      '## User',
      '',
      'Thanks',
      '',
    ].join('\n'))
    expect(headings(markdown)).toEqual(['# Stopped streams', '## Agent', '## User', '## Agent', '## User'])
  })

  it('leaves out the agent thinking', () => {
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('Question?')]),
        { role: 'agent', nodes: [textNode('Answer.')], thinking: { text: 'hidden reasoning', replay: { kind: 'field', field: 'reasoning_content' } } },
        { role: 'agent', nodes: [textNode('  ')], thinking: { text: 'thinking only' } },
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data)).toBe('# Chat\n\n## User\n\nQuestion?\n\n## Agent\n\nAnswer.\n')
  })

  it('leaves out the tool calls of agent text, and keeps the same text in a user message', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode(`Like this?\n${block}`)]),
        section('agent', [textNode(`Let me check.\n${block}\nThere are 12.`)]),
        section('agent', [textNode(block)]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data))
      .toBe(`# Chat\n\n## User\n\nLike this?\n${block}\n\n## Agent\n\nLet me check.\n\nThere are 12.\n`)
  })
})
