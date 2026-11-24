import { commonmarkLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { COMPACTION_END_LINE, compactionBlockText, compactionTagText } from '../chat/compaction'
import { escapedModelText, toolBlockText } from '../chat/toolBlocks'
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

const headerLine = (text: string) => text.slice(0, text.indexOf('\n'))

// The conversation of a file whose header ends with `part`.
function parseWithHeaderPart(part: string): ConversationData {
  return parseConversation('conversation', `<!-- title: Chat | model:  | created: 1 | ${part} -->\n<dez:pill type="user"/>\nhi\n`)
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
        section('user', [textNode(`![](${image})\nWhat color is it? ![](${image})`)]),
        section('agent', [textNode('Red.')]),
        section('user', [textNode(`![](${image})`)]),
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

describe('conversation cost, marks, and counted context in the header', () => {
  const conversation = (fields: Partial<ConversationData>): ConversationData => ({
    id: 'conversation',
    title: 'Chat',
    sections: [section('user', [textNode('hi')]), section('agent', [textNode('hello')])],
    activeModel: null,
    created_at: 1,
    ...fields,
  })

  it('round-trips the cost and the edited flag, with no float noise and no unpriced part at 0', () => {
    const priced = conversation({ cost: { usd: 0.1 + 0.2, requests: 3, unpriced: 1 }, agentTextEdited: true })
    const tiny = conversation({ cost: { usd: 2.4e-7, requests: 1, unpriced: 0 } })

    expect(headerLine(serializeConversation(priced))).toBe('<!-- title: Chat | model:  | created: 1 | cost: 0.3 | requests: 3 | unpriced: 1 | edited: yes -->')
    expect(headerLine(serializeConversation(tiny))).toBe('<!-- title: Chat | model:  | created: 1 | cost: 2.4e-7 | requests: 1 -->')
    expect(parseConversation('conversation', serializeConversation(priced))).toStrictEqual({ ...priced, cost: { usd: 0.3, requests: 3, unpriced: 1 } })
    expect(parseConversation('conversation', serializeConversation(tiny))).toStrictEqual(tiny)
  })

  // Files of an older Dez must keep their bytes on a save, and must not
  // come back with `cost: undefined`.
  it('writes and reads a header with no cost and no flag as before', () => {
    const data = conversation({})
    const serialized = serializeConversation(data)

    expect(headerLine(serialized)).toBe('<!-- title: Chat | model:  | created: 1 -->')
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  it('reads the parts in any order', () => {
    const parsed = parseConversation('conversation', '<!-- edited: yes | unpriced: 2 | title: Chat | requests: 2 | created: 1 | cost: 0 | model:  -->\n<dez:pill type="user"/>\nhi\n')

    expect(parsed.cost).toStrictEqual({ usd: 0, requests: 2, unpriced: 2 })
    expect(parsed.agentTextEdited).toBe(true)
  })

  // A hand edit must still open: a cost that is not whole is no cost.
  it('ignores the whole cost when one of its values is missing or bad, and an edited value other than yes', () => {
    const parts = [
      'cost: 1',
      'requests: 2',
      'cost: abc | requests: 2',
      'cost: | requests: 2',
      'cost: -1 | requests: 2',
      'cost: Infinity | requests: 2',
      'cost: 1 | requests: 0',
      'cost: 1 | requests: 1.5',
      'cost: 1 | requests: 2 | unpriced: 3',
      'cost: 1 | requests: 2 | unpriced: -1',
      'cost: 1 | requests: 2 | unpriced: x',
      'cost: 1 | requests: 2 | edited: no',
    ]

    const parsed = parts.map(parseWithHeaderPart)

    expect(parsed.map((data) => 'cost' in data)).toEqual([...parts.slice(0, -1).map(() => false), true])
    expect(parsed.some((data) => 'agentTextEdited' in data)).toBe(false)
  })

  it('round-trips the incognito flag and the sent mark, and reads a value other than yes as no mark', () => {
    const marked = conversation({ agentTextEdited: true, incognito: true, requestSent: true, context: { tokens: 5, estimate: 7 } })
    const bad = ['incognito: no', 'incognito: true', 'incognito:', 'sent: 1', 'sent: Yes'].map(parseWithHeaderPart)

    expect(headerLine(serializeConversation(marked))).toBe('<!-- title: Chat | model:  | created: 1 | edited: yes | incognito: yes | sent: yes | context: 5 | context-estimate: 7 -->')
    expect(parseConversation('conversation', serializeConversation(marked))).toStrictEqual(marked)
    expect(bad.some((data) => 'incognito' in data || 'requestSent' in data)).toBe(false)
  })

  it('round-trips the money limit, with its unknown-prices flag, and reads a bad sum as no limit', () => {
    const strict = conversation({ requestSent: true, moneyLimit: { usd: 0.1 + 0.2, unknownPrices: false }, context: { tokens: 5, estimate: 7 } })
    const allowing = conversation({ moneyLimit: { usd: 0, unknownPrices: true } })
    const bad = ['money-limit: -1', 'money-limit: abc', 'money-limit:', 'money-limit: Infinity', 'unknown-prices: yes'].map(parseWithHeaderPart)

    expect(headerLine(serializeConversation(strict))).toBe('<!-- title: Chat | model:  | created: 1 | sent: yes | money-limit: 0.3 | context: 5 | context-estimate: 7 -->')
    expect(headerLine(serializeConversation(allowing))).toBe('<!-- title: Chat | model:  | created: 1 | money-limit: 0 | unknown-prices: yes -->')
    expect(parseConversation('conversation', serializeConversation(strict)).moneyLimit).toStrictEqual({ usd: 0.3, unknownPrices: false })
    expect(parseConversation('conversation', serializeConversation(allowing))).toStrictEqual(allowing)
    expect(parseWithHeaderPart('money-limit: 12.5 | unknown-prices: no').moneyLimit).toStrictEqual({ usd: 12.5, unknownPrices: false })
    expect(bad.some((data) => 'moneyLimit' in data)).toBe(false)
  })

  it('round-trips the counted context, after the other parts', () => {
    const counted = conversation({ context: { tokens: 81200, estimate: 90400 } })
    const all = conversation({ cost: { usd: 0.5, requests: 2, unpriced: 0 }, agentTextEdited: true, context: { tokens: 0, estimate: 0 } })

    expect(headerLine(serializeConversation(counted))).toBe('<!-- title: Chat | model:  | created: 1 | context: 81200 | context-estimate: 90400 -->')
    expect(headerLine(serializeConversation(all))).toBe('<!-- title: Chat | model:  | created: 1 | cost: 0.5 | requests: 2 | edited: yes | context: 0 | context-estimate: 0 -->')
    expect(parseConversation('conversation', serializeConversation(counted))).toStrictEqual(counted)
    expect(parseConversation('conversation', serializeConversation(all))).toStrictEqual(all)
  })

  // A context with only one of its numbers would give a wrong count: the
  // size is the count plus the difference of two estimates.
  it('ignores the whole context when one of its values is missing or bad', () => {
    const parts = [
      'context: 5',
      'context-estimate: 5',
      'context: | context-estimate: 5',
      'context: abc | context-estimate: 5',
      'context: -1 | context-estimate: 5',
      'context: 1.5 | context-estimate: 5',
      'context: Infinity | context-estimate: 5',
      'context: 5 | context-estimate: -1',
      'context: 5 | context-estimate: 1e400',
      'context-estimate: 7 | context: 5',
    ]

    const parsed = parts.map(parseWithHeaderPart)

    expect(parsed.map((data) => data.context)).toStrictEqual([...parts.slice(0, -1).map(() => undefined), { tokens: 5, estimate: 7 }])
    expect(parsed.slice(0, -1).some((data) => 'context' in data)).toBe(false)
  })
})

describe('a compacted conversation', () => {
  const tagData = { count: 2, lastId: 'k', pictures: [{ file: 'sheet.jpg', label: 'Frames of @c', width: 1568, height: 882, bytes: 120_000 }] }
  const tag = compactionTagText(tagData)
  const block = compactionBlockText(tagData, '## Summary\n\nThe duck film.')
  // The reply that ran at the compaction goes on after the block, in the
  // same section, with the model, the thinking, and the time of the reply.
  const compacted = (text: string): SectionData => ({
    role: 'agent',
    nodes: [textNode(`${block}\n${text}`)],
    model: { providerId: 'p', modelId: 'm' },
    thinking: { text: 'Plan the shot.' },
    durationMs: 4200,
  })
  const conversation = (fields: Partial<ConversationData>): ConversationData => ({
    id: 'conversation',
    title: 'Chat',
    sections: [compacted('The next shot is ready.'), section('user', [textNode('Make it longer.')])],
    activeModel: null,
    created_at: 1,
    ...fields,
  })

  it('round-trips a first agent section with the compaction block, then the reply, with its model, thinking, and time', () => {
    const data = conversation({})
    const serialized = serializeConversation(data)
    const lines = serialized.split('\n')
    const tagLine = lines.indexOf(tag)

    expect(pillLines(serialized)[0]).toContain('model="p/m"')
    expect(lines.slice(tagLine + 1, tagLine + 6)).toEqual(['## Summary', '', 'The duck film.', COMPACTION_END_LINE, 'The next shot is ready.'])
    expect(parseConversation('conversation', serialized)).toStrictEqual(data)
  })

  // A reply that streams is saved before its first token: its section is
  // the block and one line break. The file keeps no last line break of a
  // text, so the section reads back as the block alone, the form that the
  // end of a reply with no text gives too (`endStreamSection`).
  it('reads back a first section whose reply has no text yet as the block alone', () => {
    const { model, thinking, durationMs } = compacted('')
    const data = conversation({ sections: [compacted('')] })

    expect(parseConversation('conversation', serializeConversation(data)).sections)
      .toStrictEqual([{ role: 'agent', nodes: [textNode(block)], model, thinking, durationMs }])
  })

  // A file can hold no `compacted-left:` part: Dez then knows no size that
  // the newest compaction left.
  it('round-trips the compaction numbers, after the other parts', () => {
    const priced = conversation({ context: { tokens: 5, estimate: 7 }, compactions: { count: 2, tokens: 412000, cost: { usd: 0.1 + 0.2, requests: 5, unpriced: 1 }, left: 24100 } })
    const free = conversation({ compactions: { count: 1, tokens: 0, cost: { usd: 0, requests: 0, unpriced: 0 } } })

    expect(headerLine(serializeConversation(priced)))
      .toBe('<!-- title: Chat | model:  | created: 1 | context: 5 | context-estimate: 7 | compactions: 2 | compacted-tokens: 412000 | compacted-cost: 0.3 | compacted-requests: 5 | compacted-unpriced: 1 | compacted-left: 24100 -->')
    expect(headerLine(serializeConversation(free)))
      .toBe('<!-- title: Chat | model:  | created: 1 | compactions: 1 | compacted-tokens: 0 | compacted-cost: 0 | compacted-requests: 0 -->')
    expect(parseConversation('conversation', serializeConversation(priced)))
      .toStrictEqual({ ...priced, compactions: { count: 2, tokens: 412000, cost: { usd: 0.3, requests: 5, unpriced: 1 }, left: 24100 } })
    expect(parseConversation('conversation', serializeConversation(free))).toStrictEqual(free)
  })

  // Numbers with a part missing would give a wrong buffer cost or a wrong
  // token total, so a hand edit that breaks one drops them all.
  it('ignores the whole compaction numbers when one of their values is missing or bad', () => {
    const parts = [
      'compactions: 1',
      'compactions: 1 | compacted-tokens: 5',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: 1',
      'compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2',
      'compactions: 0 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2',
      'compactions: 1.5 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2',
      'compactions: 1 | compacted-tokens: -5 | compacted-cost: 1 | compacted-requests: 2',
      'compactions: 1 | compacted-tokens: x | compacted-cost: 1 | compacted-requests: 2',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: -1 | compacted-requests: 2',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2 | compacted-unpriced: 3',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2 | compacted-left: -1',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2 | compacted-left: x',
      'compactions: 1 | compacted-tokens: 5 | compacted-cost: 1 | compacted-requests: 2 | compacted-left: ',
      // The cost of the conversation is not the cost at its compaction.
      'compactions: 1 | compacted-tokens: 5 | cost: 1 | requests: 2',
      'compacted-requests: 2 | compacted-cost: 1 | compacted-tokens: 5 | compactions: 1',
    ]

    const parsed = parts.map(parseWithHeaderPart)

    expect(parsed.map((data) => data.compactions))
      .toStrictEqual([...parts.slice(0, -1).map(() => undefined), { count: 1, tokens: 5, cost: { usd: 1, requests: 2, unpriced: 0 } }])
    expect(parsed.slice(0, -1).some((data) => 'compactions' in data)).toBe(false)
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

  // The notes of Dez name stored files, and a model wrote its text with the
  // escape of model text: neither is for people.
  it('writes the notes of a compaction block for people, with no tag, no path, and no escape', () => {
    const tag = '<dez:video id="c" type="video/mp4" src="/home/u/.config/dez/assets/generated/video/v1.mp4"/>'
    const said = `The block ends at ${COMPACTION_END_LINE}.`
    const notes = `## Summary\n\n${escapedModelText(said)}\n\n## Assets of the conversation\n\n${tag}\n@c | video | MP4 | from the user | - | The duck.`
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('agent', [textNode(`${compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, notes)}\nTyped after it.`)]),
        section('user', [textNode('Next?')]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data)).toBe([
      '# Chat',
      '',
      '## Agent',
      '',
      '## Summary',
      '',
      said,
      '',
      '## Assets of the conversation',
      '',
      '[video]',
      '@c | video | MP4 | from the user | - | The duck.',
      '',
      'Typed after it.',
      '',
      '## User',
      '',
      'Next?',
      '',
    ].join('\n'))
  })

  // The passes of a reply text (tool blocks, clips) would read a tag or a
  // tool block that a model quoted in its notes as one of Dez.
  it('writes the text that a model quoted in the notes word for word, and leaves out the tool calls of the reply after the block', () => {
    const summary = [
      'The duck clip:',
      '<dez:video id="c" type="video/mp4"/>',
      'and a call:',
      '<dez:tool id="a" name="model_list" filter="gemini">',
      'ok',
      '</dez:tool>',
      'The block ends.',
    ].join('\n')
    const call = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const block = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, `## Summary\n\n${escapedModelText(summary)}`)
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [section('agent', [textNode(`${block}\n${call}\nReply text.`)])],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data)).toBe(`# Chat\n\n## Agent\n\n## Summary\n\n${summary}\n\nReply text.\n`)
  })

  it('writes each clip of agent and user text as a link', () => {
    const saved = '/home/u/.config/dez/assets/generated/video/v1.mp4'
    const pasted = '/home/u/.config/dez/assets/video/v2.mp4'
    const video = `<dez:video id="b" type="video/mp4" src="${saved}" url="https://cdn.example/v.mp4?sig=1"/>`
    const audio = '<dez:audio id="c" type="audio/mpeg" src="https://cdn.example/a.mp3" url="https://cdn.example/a.mp3"/>'
    const gone = '<dez:audio id="d" type="audio/mpeg"/>'
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode(`Like this?\n<dez:video id="e" type="video/mp4" src="${pasted}"/>\n${gone}`)]),
        section('agent', [textNode(`Here:\n${video}\n${block}\n${audio}\n${gone}\nDone.`)]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data)).toBe(
      `# Chat\n\n## User\n\nLike this?\n[video](${pasted})\n[audio]\n\n## Agent\n\nHere:\n[video](${saved})\n\n[audio](https://cdn.example/a.mp3)\n[audio]\nDone.\n`,
    )
  })

  it('writes each app that Dez shows as a label with its name, in agent and user text', () => {
    const block = toolBlockText({ id: 'call_1', name: 'apps', status: 'success', arguments: { command: 'show', parameters: '{"name":"notes"}' }, result: 'Dez shows the app notes in your reply.' })
    const data: ConversationData = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('Show me the notes app.')]),
        section('agent', [textNode(`Here:\n${block}\n\n<dez:app name="notes"/>\n\nTry it.`)]),
        section('user', [textNode('This one is empty:\n<dez:app name="notes" open="1"/>')]),
      ],
      activeModel: null,
      created_at: 1000,
    }

    expect(serializeConversationAsMarkdown(data)).toBe(
      '# Chat\n\n## User\n\nShow me the notes app.\n\n## Agent\n\nHere:\n\n[app notes]\n\nTry it.\n\n## User\n\nThis one is empty:\n[app notes]\n',
    )
  })
})
