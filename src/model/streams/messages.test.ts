import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import { toolBlockText, type ToolBlockStatus } from '../chat/toolBlocks'
import type { ModelRef, Section, SectionThinking, ThinkingReplay } from '../chat/types'
import type { ClipInputRules, MediaKind } from '../providers/types'
import { agentSectionMessages, mediaRequestInput, sectionsToStreamMessages } from './messages'

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

  describe('clips', () => {
    const CLIP: MediaTagData = {
      kind: 'video',
      id: 'b',
      type: 'video/mp4',
      src: '/home/u/.config/dez/assets/generated/video/v1.mp4',
      url: 'https://cdn.example/v.mp4?sig=secret',
      expires: '2026-11-11T09:30:00.000Z',
      other: [{ name: 'job', value: 'j-1' }],
    }
    const SOUND: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: null, other: [] }
    const SENT_CLIP = '<dez:video id="b" type="video/mp4"/>'
    const SENT_SOUND = '<dez:audio id="c" type="audio/mpeg"/>'

    it('sends a clip as its tag with only the id and the type, with or without tools', () => {
      const section = agent(`Here it is:\n\n${mediaTagText(CLIP)}\n\nDo you like it?`)
      const expected = [{ role: 'agent', content: `Here it is:\n\n${SENT_CLIP}\n\nDo you like it?` }]

      expect(agentSectionMessages(section, model, true)).toStrictEqual(expected)
      expect(agentSectionMessages(section, model, false)).toStrictEqual(expected)
    })

    it('sends the same bytes after a save, a delete, or an expiry of the clip', () => {
      const states: MediaTagData[] = [
        CLIP,
        { ...CLIP, src: '/home/u/.cache/dez/media/v1.mp4' },
        { ...CLIP, src: CLIP.url },
        { ...CLIP, src: null, expires: null },
        { ...CLIP, src: null, url: null, expires: null, other: [] },
      ]

      for (const state of states) {
        expect(agentSectionMessages(agent(`Done.\n${mediaTagText(state)}`), model, true), mediaTagText(state))
          .toStrictEqual([{ role: 'agent', content: `Done.\n${SENT_CLIP}` }])
      }
    })

    it('sends the clips of each round with that round, and as text in a request with no tools', () => {
      const text = `${mediaTagText(CLIP)}\n${block('call_1', 'gemini', '1 model')}\n${mediaTagText(SOUND)}\nDone.`

      expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
        { role: 'agent', content: SENT_CLIP, toolCalls: [call('call_1', 'gemini')] },
        { role: 'tool', results: [result('call_1', '1 model')] },
        { role: 'agent', content: `${SENT_SOUND}\nDone.` },
      ])
      expect(agentSectionMessages(agent(text), model, false)).toStrictEqual([{
        role: 'agent',
        content: `${SENT_CLIP}\n[Tool call: model_list {"filter":"gemini"}]\n1 model\n[End of tool result]\n${SENT_SOUND}\nDone.`,
      }])
    })

    it('sends no path, no URL, and no other attribute of a clip', () => {
      const text = `${mediaTagText(CLIP)}\n${block('call_1', 'gemini', '1 model')}\n${mediaTagText(SOUND)}`

      for (const sendTools of [true, false]) {
        const sent = JSON.stringify(agentSectionMessages(agent(text), model, sendTools))
        for (const secret of ['/home/u', 'assets/generated', 'dez/media', 'cdn.example', 'sig=secret', '2026-11-11', 'j-1']) {
          expect(sent, `${secret}, sendTools ${sendTools}`).not.toContain(secret)
        }
      }
    })

    it('sends a tag that a model wrote as the model wrote it', () => {
      const text = `Like this:\n<\\dez:video id="z" type="video/mp4" url="https://x.example/z"/>\n${mediaTagText(CLIP)}`

      expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
        { role: 'agent', content: `Like this:\n<dez:video id="z" type="video/mp4" url="https://x.example/z"/>\n${SENT_CLIP}` },
      ])
    })

    it('sends a reply that holds only a clip, and no path of a tag line in a user message', () => {
      const sections: Section[] = [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: `What is this?\n${mediaTagText(CLIP)}` }] },
        agent(mediaTagText(CLIP)),
      ]
      const { messages } = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true })

      expect(messages[1]).toStrictEqual({ role: 'agent', content: SENT_CLIP })
      expect(JSON.stringify(messages)).not.toContain('/home/u')
      expect(JSON.stringify(messages)).not.toContain('assets/generated')
    })
  })

  // A loaded section has no `\n` after its last block (conversationFormat.ts
  // drops trailing newlines), so all its blocks are in one round.
  it('sends a section that ends with its only group as text, with no thinking, in a request with no tools', () => {
    const text = `Let me look.\n${block('call_1', 'gemini', '1 model')}`
    const thinking: SectionThinking = { text: 'Plan', replay: blocksReplay('Plan', 'h1') }

    expect(agentSectionMessages(agent(text, thinking), model, false)).toStrictEqual([{
      role: 'agent',
      content: 'Let me look.\n[Tool call: model_list {"filter":"gemini"}]\n1 model\n[End of tool result]',
    }])
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

    // The stream controller keeps no replay for a round that made an image;
    // a conversation from before that rule holds one.
    it('sends no thinking of a round that holds an image, and each other round keeps its own', () => {
      const withImage = text.replace('More.', `More.\n\n![${IMAGE}](id=a)`)
      const imageReply = agent(`![${IMAGE}](id=a)`, { text: '', replay: replay1 })

      expect(agentSectionMessages(agent(withImage, thinking), model, true).filter((message) => message.role === 'agent')).toStrictEqual([
        { role: 'agent', content: 'Look.', thinking: { text: 'Plan 1', replay: replay1 }, toolCalls: [call('call_1', 'gemini'), call('call_2', 'mistral')] },
        { role: 'agent', content: 'More.\n\n![image](id=a)', toolCalls: [call('call_3', 'claude')] },
        { role: 'agent', content: 'Done.' },
      ])
      expect(agentSectionMessages(imageReply, model, true)).toStrictEqual([{ role: 'agent', content: '![image](id=a)' }])
    })

    // The reference of a tool's image is at the start of the text of the
    // round after the tool's group; the replay of that round is not the
    // signature of an image.
    it('keeps the thinking of a round whose only image is one that a Dez tool made', () => {
      const toolImage = `![${IMAGE}](id=a|tool=crop_scale_image)`
      const second = (roundText: string) => agentSectionMessages(agent(text.replace('More.', roundText), thinking), model, true)[2]

      expect(second(`\n${toolImage}\n\nMore.`)).toStrictEqual({
        role: 'agent',
        content: '\n![image](id=a|tool=crop_scale_image)\n\nMore.',
        thinking: { text: 'Plan 2', replay: replay2 },
        toolCalls: [call('call_3', 'claude')],
      })
      // The model made an image in that round too.
      expect(second(`\n${toolImage}\n\n![${IMAGE}](id=b)`)).toStrictEqual({
        role: 'agent',
        content: '\n![image](id=a|tool=crop_scale_image)\n\n![image](id=b)',
        toolCalls: [call('call_3', 'claude')],
      })
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

const GENERATED = '/home/u/.config/dez/assets/generated/images/fox.webp'
const user = (id: string, text: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text }] })
const reply = (id: string, text: string): Section => ({ id, role: 'agent', model, content: [{ kind: 'text', text }] })

describe('sectionsToStreamMessages: images of user messages', () => {
  const sent = (sections: Section[], sendImages = true) => sectionsToStreamMessages(sections, model, { sendImages, sendTools: false })
  // The conversation before the message under test: a pasted image `a`,
  // and a generated image `b` in the reply. An earlier user message sends
  // its image as text only.
  const earlier = [user('u1', `![${IMAGE}](id=a) A red fox`), reply('a1', `![${GENERATED}](id=b)`)]
  const earlierMessages = [
    { role: 'user', content: '![image](id=a) A red fox' },
    { role: 'agent', content: '![image](id=b)' },
  ]

  it('gives image parts only to the newest user message: an earlier one sends its references and mentions as text', () => {
    const other = '/home/u/.config/dez/assets/images/blue.png'
    const sections = [...earlier, user('u2', `Is @a like ![${other}](id=c)?`), reply('a2', 'Yes.'), user('u3', 'And @c?')]

    expect(sent(sections)).toStrictEqual({
      messages: [
        ...earlierMessages,
        { role: 'user', content: 'Is @a like ![image](id=c)?' },
        { role: 'agent', content: 'Yes.' },
        { role: 'user', content: [{ type: 'text', text: 'And @c' }, { type: 'image', path: other }, { type: 'text', text: '?' }] },
      ],
      imagesLeftOut: 0,
    })
  })

  it('sends a mentioned image however far back it is, and no other image', () => {
    const turns = Array.from({ length: 20 }, (_, index) => [user(`q${index}`, `Question ${index}`), reply(`r${index}`, `Answer ${index}`)]).flat()
    const { messages } = sent([...earlier, ...turns, user('last', 'Make @a red')])

    expect(messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Make @a' }, { type: 'image', path: IMAGE }, { type: 'text', text: ' red' }],
    })
    expect(messages.slice(0, -1).filter((message) => message.role === 'user' && typeof message.content !== 'string')).toStrictEqual([])
  })

  // A request with no new user text (a tool round of the reply, or a submit
  // with an empty last section) must not change the message that the reply
  // answers.
  it('keeps the image parts of the newest user message when a reply comes after it', () => {
    const message = { role: 'user', content: [{ type: 'text', text: '![image](id=a)' }, { type: 'image', path: IMAGE }, { type: 'text', text: ' A red fox' }] }

    expect(sent([earlier[0]]).messages).toStrictEqual([message])
    expect(sent([earlier[0], reply('a1', 'It is a fox.'), user('u2', '')]).messages).toStrictEqual([message, { role: 'agent', content: 'It is a fox.' }])
  })

  it('sends a mentioned image of an earlier section right after its mention, which stays in the text', () => {
    expect(sent([...earlier, user('u2', 'Give @b a hat, like the one of @a.')])).toStrictEqual({
      messages: [
        ...earlierMessages,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Give @b' },
            { type: 'image', path: GENERATED },
            { type: 'text', text: ' a hat, like the one of @a' },
            { type: 'image', path: IMAGE },
            { type: 'text', text: '.' },
          ],
        },
      ],
      imagesLeftOut: 0,
    })
  })

  it('sends a mentioned image once, at its first mention', () => {
    expect(sent([...earlier, user('u2', '@b: is @b blue?')]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: '@b' }, { type: 'image', path: GENERATED }, { type: 'text', text: ': is @b blue?' }],
    })
  })

  it('adds no part for a mention of an image that the message itself holds', () => {
    const other = '/home/u/.config/dez/assets/images/blue.png'

    expect(sent([...earlier, user('u2', `Put @c on @b: ![${other}](id=c) Is @c right?`)]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Put @c on @b' },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ': ![image](id=c)' },
        { type: 'image', path: other },
        { type: 'text', text: ' Is @c right?' },
      ],
    })
  })

  it.each([
    ['an id that no image has', 'Mail @home or @c'],
    ['an address', 'Mail bob@a.com and b@b'],
    ['a longer word', 'What is @about and @b2?'],
  ])('keeps %s as plain text, in a text-only message', (_name, text) => {
    expect(sent([...earlier, user('u2', text)]).messages.at(-1)).toStrictEqual({ role: 'user', content: text })
  })

  it('reads no image of a later section, so an earlier message keeps its bytes when an image arrives', () => {
    const first = user('u1', 'Draw @a')
    const before = sent([first]).messages

    const after = sent([first, reply('a1', `![${GENERATED}](id=a)`), user('u2', 'Now make @a blue')]).messages

    expect(before).toStrictEqual([{ role: 'user', content: 'Draw @a' }])
    expect(after).toStrictEqual([
      ...before,
      { role: 'agent', content: '![image](id=a)' },
      { role: 'user', content: [{ type: 'text', text: 'Now make @a' }, { type: 'image', path: GENERATED }, { type: 'text', text: ' blue' }] },
    ])
  })

  it('takes the last image with the id when two images have it', () => {
    const sections = [user('u1', `![${IMAGE}](id=a)`), reply('a1', `![${GENERATED}](id=a)`), user('u2', 'Crop @a')]

    expect(sent(sections).messages.at(-1)).toStrictEqual({ role: 'user', content: [{ type: 'text', text: 'Crop @a' }, { type: 'image', path: GENERATED }] })
  })

  it('reads no mention in a bare image path, and sends no part of the path', () => {
    const text = 'Is /home/@b/.config/dez/assets/images/red.png the same as @b?'

    expect(sent([...earlier, user('u2', text)]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Is image the same as @b' }, { type: 'image', path: GENERATED }, { type: 'text', text: '?' }],
    })
  })

  it('scrubs a bare path before a reference and after it', () => {
    const text = `See ${IMAGE}![${IMAGE}](id=c) and ${GENERATED}.`

    expect(sent([user('u1', text)]).messages).toStrictEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'See image![image](id=c)' }, { type: 'image', path: IMAGE }, { type: 'text', text: ' and image.' }],
    }])
  })

  it('sends a model that reads no images the text only, and counts the images that the newest message would send', () => {
    const sections = [...earlier, user('u2', `Mix @b, @b, and ![${IMAGE}](id=a) with @a and @c.`)]

    expect(sent(sections, false)).toStrictEqual({
      messages: [
        ...earlierMessages,
        { role: 'user', content: 'Mix @b, @b, and ![image](id=a) with @a and @c.' },
      ],
      // `b` and `a` in the last message. The image of the first message
      // goes to no model, so it does not count.
      imagesLeftOut: 2,
    })
    expect(sent([...earlier, user('u2', 'What is it?')], false).imagesLeftOut).toBe(0)
  })
})

describe('mediaRequestInput', () => {
  // The tab's sections at the start of a media reply: the reply's own
  // section is empty, so it gives no message.
  const input = (kind: MediaKind, sections: Section[], rules?: ClipInputRules) => {
    const tab = [...sections, reply('new', '')]
    return mediaRequestInput(kind, sectionsToStreamMessages(tab, model, { sendImages: true, sendTools: false }).messages, tab, rules)
  }

  it('takes the prompt from the last user message, with each reference as its text and no path', () => {
    const sections = [
      user('u1', 'A red fox'),
      reply('a1', `![${GENERATED}](id=a)`),
      user('u2', `\nLike ![${IMAGE}](id=b), but blue \n`),
    ]

    expect(input('image', sections)).toStrictEqual({ prompt: 'Like ![image](id=b), but blue', images: [], imagesLeftOut: 0 })
    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Like ![image](id=b), but blue', images: [IMAGE], imagesLeftOut: 0 })
  })

  it('edits the images of the last user message, in order', () => {
    const other = '/home/u/.config/dez/assets/images/blue.png'
    const sections = [user('u1', `![${GENERATED}](id=a)`), user('u2', `Mix ![${other}](id=b) and ![${IMAGE}](id=c)`)]

    expect(input('imageEdit', sections).images).toStrictEqual([other, IMAGE])
  })

  it('edits the image that the last user message mentions, not the newest one', () => {
    const newest = '/home/u/.config/dez/assets/generated/images/cat.webp'
    const sections = [
      user('u1', 'A red fox'),
      reply('a1', `![${GENERATED}](id=a)`),
      user('u2', 'A cat'),
      reply('a2', `![${newest}](id=b)`),
      user('u3', 'Edit @a to add an apple'),
    ]

    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Edit @a to add an apple', images: [GENERATED], imagesLeftOut: 0 })
    expect(input('image', sections)).toStrictEqual({ prompt: 'Edit @a to add an apple', images: [], imagesLeftOut: 0 })
  })

  it('edits the pasted and the mentioned images of the last user message in text order, each one once', () => {
    const sections = [
      reply('a1', `![${GENERATED}](id=a)`),
      user('u1', `Put ![${IMAGE}](id=b) and ![${IMAGE}](id=b) on @a. Keep @a and @b sharp.`),
    ]

    expect(input('imageEdit', sections).images).toStrictEqual([IMAGE, GENERATED])
  })

  it('gives an edit model that takes fewer images the first ones, the image to edit first, and counts the rest', () => {
    const sections = [
      reply('a1', `![${GENERATED}](id=a)`),
      user('u1', `Put ![${IMAGE}](id=b) on @a`),
    ]

    expect([
      input('imageEdit', sections, { images: { maxImages: 1 } }),
      input('imageEdit', sections, { images: { maxImages: 3 } }),
    ]).toStrictEqual([
      { prompt: 'Put ![image](id=b) on @a', images: [IMAGE], imagesLeftOut: 1 },
      { prompt: 'Put ![image](id=b) on @a', images: [IMAGE, GENERATED], imagesLeftOut: 0 },
    ])
  })

  it('edits the newest image of the conversation when the last user message has none', () => {
    const sections = [
      user('u1', `![${IMAGE}](id=a) A red fox`),
      reply('a1', `![${IMAGE}](id=a)\n\n![${GENERATED}](id=b)`),
      user('u2', 'Make it blue'),
    ]

    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Make it blue', images: [GENERATED], imagesLeftOut: 0 })
  })

  it('gives an edit with no image in the conversation no images', () => {
    expect(input('imageEdit', [user('u1', 'Make it blue')])).toStrictEqual({ prompt: 'Make it blue', images: [], imagesLeftOut: 0 })
  })

  // These requests have no place for a file, and a submit says nothing of
  // the images.
  it.each(['image', 'tts', 'music'] as const)('gives a %s request the prompt, and no image of the conversation', (kind) => {
    const sections = [reply('a1', `![${GENERATED}](id=a)`), user('u1', `Say what ![${IMAGE}](id=b) and @a show`)]

    expect(input(kind, sections)).toStrictEqual({ prompt: 'Say what ![image](id=b) and @a show', images: [], imagesLeftOut: 0 })
  })

  describe('the image of an upscale', () => {
    // A model with no rules takes one image (`maxInputImages`).
    it('takes the first image of the last user message, and counts the rest', () => {
      const sections = [reply('a1', `![${GENERATED}](id=a)`), user('u1', `![${IMAGE}](id=b) and @a`)]

      expect(input('upscale', sections)).toStrictEqual({ prompt: '![image](id=b) and @a', images: [IMAGE], imagesLeftOut: 1 })
    })

    it('takes the newest image of the conversation when the last user message has none, and none when there is none', () => {
      const sections = [user('u1', `![${IMAGE}](id=a) A red fox`), reply('a1', `![${GENERATED}](id=b)`), user('u2', 'Larger')]

      expect([input('upscale', sections), input('upscale', [user('u1', 'Larger')])]).toStrictEqual([
        { prompt: 'Larger', images: [GENERATED], imagesLeftOut: 0 },
        { prompt: 'Larger', images: [], imagesLeftOut: 0 },
      ])
    })
  })

  describe('the frames of a video', () => {
    const other = '/home/u/.config/dez/assets/images/blue.png'
    // A pasted image, a mentioned image, and each of them once more.
    const twoImages = [reply('a1', `![${GENERATED}](id=a)`), user('u1', `From ![${IMAGE}](id=b) to @a. Keep @b and @a sharp.`)]
    const threeImages = [reply('a1', `![${GENERATED}](id=a)`), user('u1', `![${IMAGE}](id=b) ![${other}](id=c) @a`)]
    // The newest image of the conversation is not in the last message.
    const imageBefore = [user('u1', `![${IMAGE}](id=a) A red fox`), reply('a1', `![${GENERATED}](id=b)`), user('u2', 'Make it run')]

    it.each([
      ['a model with no rules one image', undefined, [IMAGE], 1],
      ['a model that takes one frame one image', { images: { maxImages: 1 } }, [IMAGE], 1],
      ['a model that takes two frames both images, in text order', { images: { maxImages: 2 } }, [IMAGE, GENERATED], 0],
    ])('gives %s of the last user message, and counts the rest', (_name, rules, images, imagesLeftOut) => {
      expect(input('imageToVideo', twoImages, rules)).toStrictEqual({ prompt: 'From ![image](id=b) to @a. Keep @b and @a sharp.', images, imagesLeftOut })
    })

    it('gives a model that takes two frames the first two of three images', () => {
      const { images, imagesLeftOut } = input('imageToVideo', threeImages, { images: { maxImages: 2 } })

      expect({ images, imagesLeftOut }).toStrictEqual({ images: [IMAGE, other], imagesLeftOut: 1 })
    })

    it('makes the video from the newest image of the conversation when the last user message has none', () => {
      expect(input('imageToVideo', imageBefore, { images: { maxImages: 2 } })).toStrictEqual({ prompt: 'Make it run', images: [GENERATED], imagesLeftOut: 0 })
    })

    it('gives an image-to-video request with no image in the conversation no images', () => {
      expect(input('imageToVideo', [user('u1', 'Make it run')])).toStrictEqual({ prompt: 'Make it run', images: [], imagesLeftOut: 0 })
    })

    // A text-to-video model works with no image, so it gets none that the
    // user did not put into the message.
    it('gives a text-to-video model that takes frames only the images of the last user message', () => {
      const { images: fromMessage, imagesLeftOut } = input('video', twoImages, { images: { maxImages: 1 } })

      expect({ fromMessage, imagesLeftOut, fromConversation: input('video', imageBefore, { images: { maxImages: 1 } }).images })
        .toStrictEqual({ fromMessage: [IMAGE], imagesLeftOut: 1, fromConversation: [] })
    })

    it('gives a text-to-video model that takes no frame no image, and counts the images of the last user message', () => {
      const { images, imagesLeftOut } = input('video', twoImages)

      expect({ images, imagesLeftOut }).toStrictEqual({ images: [], imagesLeftOut: 2 })
    })
  })

  it('splits the last user message of a model that takes lyrics into the style and the lyrics', () => {
    const tab = [user('u1', 'Slow piano ballad\nLyrics:\nRain on the roof'), reply('new', '')]
    const messages = sectionsToStreamMessages(tab, model, { sendImages: true, sendTools: false }).messages

    expect([
      mediaRequestInput('music', messages, tab, { text: { lyrics: { required: true } } }),
      // The rules of a model that takes none, and no rules.
      mediaRequestInput('music', messages, tab, { text: { maxPromptLength: 300 } }),
      mediaRequestInput('music', messages, tab),
    ]).toStrictEqual([
      { prompt: 'Slow piano ballad', lyrics: 'Rain on the roof', images: [], imagesLeftOut: 0 },
      { prompt: 'Slow piano ballad\nLyrics:\nRain on the roof', images: [], imagesLeftOut: 0 },
      { prompt: 'Slow piano ballad\nLyrics:\nRain on the roof', images: [], imagesLeftOut: 0 },
    ])
  })
})
