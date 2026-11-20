import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL, COMPACTION_MESSAGE_INTRO, COMPACTION_USER_MESSAGE_LABEL, compactionBlockText, compactionTagText, sectionsBeforeReply } from '../chat/compaction'
import { imageMarkdown } from '../chat/images'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagRequestText, mediaTagText, type MediaTagData } from '../chat/mediaTags'
import { SHOWN_PICTURE_OVER_LIMIT_NOTE, type ShownPicture } from '../chat/shownPictures'
import { messagePart } from '../chat/testing'
import { toolBlockText, type ToolBlockData, type ToolBlockStatus } from '../chat/toolBlocks'
import type { Section, SectionThinking, ThinkingReplay } from '../chat/types'
import type { ClipInputRules, MediaKind } from '../providers/types'
import { audioCutResultText } from '../tools/audioTool'
import { imageResultText } from '../tools/imageTool'
import { jobResultText, jobStartedText, jobsWaitText, type WrittenJobAsset } from '../tools/jobs'
import { agentSectionMessages, mediaRequestInput, messageClips, messageMentionIds, newRequestImages, sectionsToStreamMessages } from './messages'
import { model, reply, user } from './testing'

const IMAGE = '/home/u/.config/dez/assets/images/red.png'
const OTHER_IMAGE = '/home/u/.config/dez/assets/images/blue.png'
// An image file of the user that a user section links.
const LINKED_IMAGE = '/home/u/Pictures/den.png'

// The clips of a tab, as players of earlier replies show them.
const SONG: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: null, other: [] }
const DANCE: MediaTagData = { kind: 'video', id: 'd', type: 'video/mp4', src: null, url: 'https://cdn.example/d.mp4', expires: '2026-12-01T00:00:00.000Z', other: [] }
const RAIN: MediaTagData = { kind: 'audio', id: 'e', type: 'audio/wav', src: '/home/u/.config/dez/assets/generated/audio/r.wav', url: null, expires: null, other: [] }

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

// The parts of a picture that goes, and of one over an image limit
// (`pictureParts`, messages.ts).
const shown = (picture: ShownPicture) => [{ type: 'text', text: picture.label }, { type: 'picture', picture }]
const note = (picture: ShownPicture) => [{ type: 'text', text: picture.label }, { type: 'text', text: SHOWN_PICTURE_OVER_LIMIT_NOTE }]

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

  // The caller gives the count of the image parts of its request: with
  // none (a model that reads no images), no picture goes.
  it('sends no picture that a call showed with no count of the parts of the request, with or without tools', () => {
    const pictures = [{ file: 'f1.png', label: 'asset_view: the image @a.' }]
    const text = `${toolBlockText({ id: 'call_1', name: 'asset_view', status: 'success', arguments: { assets: '@a' }, result: '@a | image | PNG', pictures })}\nDone.`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: '', toolCalls: [{ id: 'call_1', name: 'asset_view', arguments: { assets: '@a' } }] },
      { role: 'tool', results: [result('call_1', '@a | image | PNG')] },
      { role: 'agent', content: 'Done.' },
    ])
    expect(JSON.stringify(agentSectionMessages(agent(text), model, false))).not.toMatch(/f1\.png|the image @a/)
    // A call that goes as text has no round to put its pictures after.
    expect(JSON.stringify(agentSectionMessages(agent(text), model, false, newRequestImages()))).not.toMatch(/f1\.png|the image @a/)
  })

  // The list of the tool calls of the code is for the panel of the chip.
  it('sends the same request for a js_eval call with and without the list of the tool calls of its code', () => {
    const block: ToolBlockData = { id: 'call_1', name: 'js_eval', status: 'success', arguments: { code: 'return 1', timeout_seconds: 30 }, result: 'The code gave: 1' }
    const bridged: ToolBlockData['bridged'] = {
      calls: [
        { name: 'model_invoke', arguments: { model: 'p/m', prompt: 'A fox' }, status: 'success', result: jobStartedText('j-k3x9', 1) },
        { name: 'image', arguments: {}, status: 'error', result: 'The required parameter "command" is missing.' },
      ],
      more: 2,
    }
    const text = (data: ToolBlockData) => `Look.\n${toolBlockText(data)}\nDone.`
    const withList = text({ ...block, bridged })

    expect(withList).toContain('bridged="')
    for (const tools of [true, false]) {
      const sent = JSON.stringify(agentSectionMessages(agent(withList), model, tools, newRequestImages()))
      expect(sent, `tools ${tools}`).toBe(JSON.stringify(agentSectionMessages(agent(text(block)), model, tools, newRequestImages())))
      expect(sent).not.toMatch(/bridged|A fox|j-k3x9/)
    }
    expect(agentSectionMessages(agent(withList), model, true)).toStrictEqual([
      { role: 'agent', content: 'Look.', toolCalls: [{ id: 'call_1', name: 'js_eval', arguments: { code: 'return 1', timeout_seconds: 30 } }] },
      { role: 'tool', results: [result('call_1', 'The code gave: 1')] },
      { role: 'agent', content: 'Done.' },
    ])
  })

  it('puts the pictures of a round in one user message right after its results, each after its label, in the order of the calls', () => {
    const sheet = { file: 's1.jpg', label: 'asset_view: the frame sheet of @f.', width: 1280, height: 320, bytes: 3000 }
    const wave = { file: 'w1.jpg', label: 'asset_view: the wave of @g.', width: 800, height: 200, bytes: 2000 }
    const image = { file: 'i1.png', label: 'asset_view: the image @a.' }
    const view = (id: string, assets: string, pictures?: typeof image[]) =>
      toolBlockText({ id, name: 'asset_view', status: 'success', arguments: { assets }, result: `${assets} | facts`, ...(pictures && { pictures }) })
    const viewCall = (id: string, assets: string) => ({ id, name: 'asset_view', arguments: { assets } })
    // The first round has no picture; the second has those of two calls.
    const text = `${block('call_1', 'gemini', '1 model')}\n\nNow the clips.\n${view('call_2', '@f @g', [sheet, wave])}\n${view('call_3', '@x')}\n${view('call_4', '@a', [image])}\nAll good.`

    expect(agentSectionMessages(agent(text), model, true, newRequestImages())).toStrictEqual([
      { role: 'agent', content: '', toolCalls: [call('call_1', 'gemini')] },
      { role: 'tool', results: [result('call_1', '1 model')] },
      { role: 'agent', content: '\nNow the clips.', toolCalls: [viewCall('call_2', '@f @g'), viewCall('call_3', '@x'), viewCall('call_4', '@a')] },
      { role: 'tool', results: [result('call_2', '@f @g | facts'), result('call_3', '@x | facts'), result('call_4', '@a | facts')] },
      {
        role: 'user',
        content: [
          { type: 'text', text: sheet.label },
          { type: 'picture', picture: sheet },
          { type: 'text', text: wave.label },
          { type: 'picture', picture: wave },
          { type: 'text', text: image.label },
          { type: 'picture', picture: image },
        ],
      },
      { role: 'agent', content: 'All good.' },
    ])
  })

  describe('with the image limits of a request', () => {
    const pictureOf = (name: string) => ({ file: `${name}.jpg`, label: `asset_view: ${name}.` })
    const [one, two, three] = ['one', 'two', 'three'].map(pictureOf)
    const view = (id: string, pictures: ReturnType<typeof pictureOf>[]) =>
      toolBlockText({ id, name: 'asset_view', status: 'success', arguments: { assets: '@a' }, result: 'ok', pictures })
    // Two rounds: the first shows two pictures, the second one.
    const section = agent(`${view('call_1', [one, two])}\n\n${view('call_2', [three])}`)
    const pictureMessages = (images: ReturnType<typeof newRequestImages>) =>
      agentSectionMessages(section, model, true, images).flatMap((message) => (message.role === 'user' ? [message.content] : []))

    // The parts of a request are counted in message order, so the
    // messages before a picture that does not go keep their bytes.
    it('sends a picture that the request has no room for as its label and a note, and counts it', () => {
      const images = newRequestImages(2)

      expect(pictureMessages(images)).toStrictEqual([[...shown(one), ...shown(two)], note(three)])
      expect([...images.overLimit]).toStrictEqual([three.file])
    })

    it('stops in the middle of the pictures of a round', () => {
      expect(pictureMessages(newRequestImages(1))).toStrictEqual([[...shown(one), ...note(two)], note(three)])
    })

    // The pictures of a round are one message.
    it('sends at most the pictures of one message for each round', () => {
      const images = newRequestImages(Infinity, 1)

      expect(pictureMessages(images)).toStrictEqual([[...shown(one), ...note(two)], shown(three)])
      expect([...images.overLimit]).toStrictEqual([two.file])
    })
  })

  // The user can edit the label in the block.
  it('sends no stored file path in the label of a picture', () => {
    const pictures = [{ file: 'f1.png', label: `asset_view: the image at ${IMAGE}.` }]
    const text = toolBlockText({ id: 'call_1', name: 'asset_view', status: 'success', arguments: { assets: '@a' }, result: 'ok', pictures })

    const [, , message] = agentSectionMessages(agent(text), model, true, newRequestImages())

    expect(message).toStrictEqual({ role: 'user', content: [{ type: 'text', text: 'asset_view: the image at image.' }, { type: 'picture', picture: pictures[0] }] })
  })

  // Anthropic refuses a text block with no visible text, and the user can
  // make a label blank in the block.
  it('sends no text part for a blank label of a picture, whether the picture goes or not', () => {
    const pictures = [{ file: 'f1.png', label: '' }, { file: 'f2.png', label: ' \n ' }]
    const text = toolBlockText({ id: 'call_1', name: 'asset_view', status: 'success', arguments: { assets: '@a' }, result: 'ok', pictures })

    const [, , message] = agentSectionMessages(agent(text), model, true, newRequestImages(1))

    expect(message).toStrictEqual({ role: 'user', content: [{ type: 'picture', picture: pictures[0] }, { type: 'text', text: SHOWN_PICTURE_OVER_LIMIT_NOTE }] })
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
    const text = `This: ![id=a](${IMAGE})\n${block('call_1', `![id=a](${IMAGE})`, `Found ![id=a](${IMAGE}).`)}\nSee ![id=a](${IMAGE}).`

    expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
      { role: 'agent', content: 'This: ![id=a](image)', toolCalls: [call('call_1', '![id=a](image)')] },
      { role: 'tool', results: [result('call_1', 'Found ![id=a](image).')] },
      { role: 'agent', content: 'See ![id=a](image).' },
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
    const SENT_CLIP = '<dez:video id="b" type="video/mp4"/>'
    const SENT_SONG = '<dez:audio id="c" type="audio/mpeg"/>'

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
      const text = `${mediaTagText(CLIP)}\n${block('call_1', 'gemini', '1 model')}\n${mediaTagText(SONG)}\nDone.`

      expect(agentSectionMessages(agent(text), model, true)).toStrictEqual([
        { role: 'agent', content: SENT_CLIP, toolCalls: [call('call_1', 'gemini')] },
        { role: 'tool', results: [result('call_1', '1 model')] },
        { role: 'agent', content: `${SENT_SONG}\nDone.` },
      ])
      expect(agentSectionMessages(agent(text), model, false)).toStrictEqual([{
        role: 'agent',
        content: `${SENT_CLIP}\n[Tool call: model_list {"filter":"gemini"}]\n1 model\n[End of tool result]\n${SENT_SONG}\nDone.`,
      }])
    })

    it('sends no path, no URL, and no other attribute of a clip', () => {
      const text = `${mediaTagText(CLIP)}\n${block('call_1', 'gemini', '1 model')}\n${mediaTagText(SONG)}`

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

    it('sends a reply that holds only a clip, and a tag line of a user message with no path', () => {
      const sections: Section[] = [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: `What is this?\n${mediaTagText(CLIP)}` }] },
        agent(mediaTagText(CLIP)),
      ]

      expect(sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true }).messages).toStrictEqual([
        { role: 'user', content: `What is this?\n${SENT_CLIP}` },
        { role: 'agent', content: SENT_CLIP },
      ])
    })
  })

  // Dez writes the asset of a tool after the group of the tool's call, so
  // its text is the start of the text of the next round.
  describe('images and clips that a Dez tool made', () => {
    const toolImage = (id: string, hidden?: string) => `![id=${id}|tool=model_invoke${hidden === undefined ? '' : `|hidden=${hidden}`}](${IMAGE})`
    const toolClip = (clip: MediaTagData, hidden?: string) => mediaTagText({
      ...clip,
      other: [{ name: MEDIA_TOOL_ATTRIBUTE, value: 'model_invoke' }, ...(hidden === undefined ? [] : [{ name: MEDIA_HIDDEN_ATTRIBUTE, value: hidden }])],
    })
    const job = (id: string, assets: WrittenJobAsset[]) => ({ id, tool: 'model_invoke', status: 'finished' as const, text: jobResultText('', assets), call: { number: 1, label: 'A fox' } })
    const WAIT_RESULT = jobsWaitText([job('j-aaaa', [{ kind: 'image', id: 'a' }, { kind: 'audio', id: 'c' }]), job('j-bbbb', [{ kind: 'video', id: 'd' }])], 0)
    const ASSETS = [toolImage('a', 'j-aaaa'), toolClip(SONG, 'j-aaaa'), toolClip(DANCE)].join('\n\n')

    // The messages after the first round, which called a tool that gave
    // `toolResult`; `roundText` is the text after that group.
    function sentAfterGroup(toolResult: string, roundText: string): unknown[] {
      const group = toolBlockText({ id: 'call_1', name: 'jobs_wait', status: 'success', arguments: {}, result: toolResult })
      return agentSectionMessages(agent(`${group}\n${roundText}`), model, true).slice(2)
    }

    it('leaves out the assets that a result of the group before names, so that a round has only the text of the model', () => {
      expect(sentAfterGroup(WAIT_RESULT, `\n${ASSETS}\n\nHere it is: @d.`)).toStrictEqual([{ role: 'agent', content: 'Here it is: @d.' }])
      expect(sentAfterGroup(WAIT_RESULT, `\n${ASSETS}\n${block('call_2', 'gemini', '1 model')}`)).toStrictEqual([
        { role: 'agent', content: '', toolCalls: [call('call_2', 'gemini')] },
        { role: 'tool', results: [result('call_2', '1 model')] },
      ])
    })

    it('leaves them out of the text of a request with no tools too, and keeps the line breaks next to the blocks', () => {
      const group = toolBlockText({ id: 'call_1', name: 'jobs_wait', status: 'success', arguments: {}, result: WAIT_RESULT })
      const text = `Look.\n${group}\n\n${ASSETS}\n${block('call_2', 'gemini', '1 model')}\n\n${toolImage('b')}\n\nDone.`

      expect(agentSectionMessages(agent(text), model, false)).toStrictEqual([{
        role: 'agent',
        content: [
          'Look.',
          `[Tool call: jobs_wait {}]\n${WAIT_RESULT}\n[End of tool result]`,
          '',
          '[Tool call: model_list {"filter":"gemini"}]\n1 model\n[End of tool result]',
          '',
          '![id=b|tool=model_invoke](image)',
          '',
          'Done.',
        ].join('\n'),
      }])
    })

    it('reads the result of each tool that makes an asset in its call', () => {
      expect(sentAfterGroup(imageResultText('a', 'b', { width: 4, height: 2 }), `\n${toolImage('b')}\n\nDone.`)).toStrictEqual([{ role: 'agent', content: 'Done.' }])
      expect(sentAfterGroup(audioCutResultText('c', 'e', { start: 0, end: 2 }, 2), `\n${toolClip(RAIN)}\n\nDone.`)).toStrictEqual([{ role: 'agent', content: 'Done.' }])
    })

    it('keeps an asset that no result of the group before says that it made', () => {
      // The asset of a job that ended after the last round: the model got
      // no result of it.
      expect(sentAfterGroup(WAIT_RESULT, `\n${toolImage('a')}\n\nDone.\n\n${toolClip(RAIN)}`))
        .toStrictEqual([{ role: 'agent', content: 'Done.\n\n<dez:audio id="e" type="audio/wav"/>' }])
      // A result that names an asset as an input of its call.
      expect(sentAfterGroup(`${jobStartedText('j-cccc', 1)}\nThe inputs of the request: the video clip @d.`, `\n${toolClip(DANCE)}\n\nDone.`))
        .toStrictEqual([{ role: 'agent', content: '\n<dez:video id="d" type="video/mp4"/>\n\nDone.' }])
      // An image of the model itself, with no mark of a tool.
      expect(sentAfterGroup(WAIT_RESULT, `\n![id=a](${IMAGE})\n\nDone.`)).toStrictEqual([{ role: 'agent', content: '\n![id=a](image)\n\nDone.' }])
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
      const withImage = text.replace('More.', `More.\n\n![id=a](${IMAGE})`)
      const imageReply = agent(`![id=a](${IMAGE})`, { text: '', replay: replay1 })

      expect(agentSectionMessages(agent(withImage, thinking), model, true).filter((message) => message.role === 'agent')).toStrictEqual([
        { role: 'agent', content: 'Look.', thinking: { text: 'Plan 1', replay: replay1 }, toolCalls: [call('call_1', 'gemini'), call('call_2', 'mistral')] },
        { role: 'agent', content: 'More.\n\n![id=a](image)', toolCalls: [call('call_3', 'claude')] },
        { role: 'agent', content: 'Done.' },
      ])
      expect(agentSectionMessages(imageReply, model, true)).toStrictEqual([{ role: 'agent', content: '![id=a](image)' }])
    })

    // The reference of a tool's image is at the start of the text of the
    // round after the tool's group; the replay of that round is not the
    // signature of an image.
    it('keeps the thinking of a round whose only image is one that a Dez tool made', () => {
      const toolImage = `![id=a|tool=image](${IMAGE})`
      const second = (roundText: string) => agentSectionMessages(agent(text.replace('More.', roundText), thinking), model, true)[2]

      expect(second(`\n${toolImage}\n\nMore.`)).toStrictEqual({
        role: 'agent',
        content: '\n![id=a|tool=image](image)\n\nMore.',
        thinking: { text: 'Plan 2', replay: replay2 },
        toolCalls: [call('call_3', 'claude')],
      })
      // The model made an image in that round too.
      expect(second(`\n${toolImage}\n\n![id=b](${IMAGE})`)).toStrictEqual({
        role: 'agent',
        content: '\n![id=a|tool=image](image)\n\n![id=b](image)',
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

// Clip files that the user pasted or dropped into a message.
const PASTED_DANCE: MediaTagData = { kind: 'video', id: 'f', type: 'video/mp4', src: '/home/u/.config/dez/assets/video/v1.mp4', url: null, expires: null, other: [] }
const PASTED_VOICE: MediaTagData = { kind: 'audio', id: 'g', type: 'audio/wav', src: '/home/u/.config/dez/assets/audio/a1.wav', url: null, expires: null, other: [] }
const SENT_DANCE = '<dez:video id="f" type="video/mp4"/>'
const SENT_VOICE = '<dez:audio id="g" type="audio/wav"/>'
// A clip as a request takes it: no unknown attribute.
const attached = ({ other: _other, ...clip }: MediaTagData) => clip
const NO_CLIPS = { clips: [], clipsLeftOut: { audio: 0, video: 0 } }

describe('messageClips', () => {
  const clipsReply = reply('a1', `Here:\n${mediaTagText(SONG)}\n${mediaTagText(DANCE)}\n${mediaTagText(RAIN)}`)

  it('gives the clips that the newest user message names, in text order and each one once', () => {
    expect(messageClips([clipsReply, user('u1', 'Put @e under @d, then @c. Keep @d.')])).toStrictEqual([attached(RAIN), attached(DANCE), attached(SONG)])
  })

  it('gives the clips that the message holds and the clips that it names, in text order, and a clip that it holds once', () => {
    const message = user('u1', `${mediaTagText(PASTED_DANCE)}\nThe dancer of @f moves to @d, and @g sings.\n${mediaTagText(PASTED_VOICE)}`)

    expect(messageClips([clipsReply, message])).toStrictEqual([attached(PASTED_DANCE), attached(DANCE), attached(PASTED_VOICE)])
  })

  it('gives a clip of an earlier user message only when the message names it', () => {
    const sections = [user('u1', `Here:\n${mediaTagText(PASTED_DANCE)}`), reply('a1', 'A dancer.')]

    expect([
      messageClips([...sections, user('u2', 'Make it longer')]),
      messageClips([...sections, user('u2', 'Make @f longer')]),
    ]).toStrictEqual([[], [attached(PASTED_DANCE)]])
  })

  it('takes the last tag of an id in the message or the sections before it, and no tag of a later section', () => {
    const later = { ...SONG, src: null, url: 'https://cdn.example/c.mp3', expires: '2026-12-01T00:00:00.000Z' }
    const sections = [
      clipsReply,
      reply('a2', mediaTagText(later)),
      user('u1', `Mix @c, @e, and @h\n${mediaTagText({ ...PASTED_VOICE, id: 'e' })}`),
      reply('a3', mediaTagText({ ...DANCE, id: 'h' })),
    ]

    expect(messageClips(sections)).toStrictEqual([attached(later), attached({ ...PASTED_VOICE, id: 'e' })])
  })

  it('reads only the newest non-empty user message', () => {
    expect(messageClips([clipsReply, user('u1', `Use @c\n${mediaTagText(PASTED_DANCE)}`), reply('a2', 'Done.'), user('u2', 'Again'), user('u3', '')])).toStrictEqual([])
  })

  it('gives no clip for a tag or a mention in code', () => {
    const message = user('u1', `Not \`@c\`:\n\`\`\`\n${mediaTagText(PASTED_DANCE)}\n@d\n\`\`\`\nbut @e`)

    expect(messageClips([clipsReply, message])).toStrictEqual([attached(RAIN)])
  })

  // The ids are unique in a tab unless the user edits the text. The clip `c`
  // has the id of an image of an earlier section, and the clip `d` that of
  // an image of the message.
  it('gives no clip for an id that an image has', () => {
    const sections = [clipsReply, reply('a2', `![id=c](${GENERATED})`), user('u1', `Use @c and @d: ![id=d](${IMAGE})\n${mediaTagText({ ...PASTED_DANCE, id: 'c' })}`)]

    expect(messageClips(sections)).toStrictEqual([])
  })

  // A model must not choose a file of this computer that Dez then reads.
  it('gives the linked path of a clip in a user message, and no source for a linked path in a reply', () => {
    const linked = '/home/u/Videos/dance (1).mp4'
    const sections = [
      reply('a1', mediaTagText({ ...SONG, src: '/home/u/Music/song.mp3' })),
      user('u1', `${mediaTagText({ ...PASTED_DANCE, src: linked })}\nMix @f with @c`),
    ]

    expect(messageClips(sections)).toStrictEqual([attached({ ...PASTED_DANCE, src: linked }), attached({ ...SONG, src: null })])
  })
})

describe('messageMentionIds', () => {
  it('gives the id of each mention of the text', () => {
    expect(messageMentionIds('Make @a run to @b, then (@c).')).toStrictEqual(new Set(['a', 'b', 'c']))
  })

  it('takes no word that only looks like a mention', () => {
    expect(messageMentionIds('Ask @a-team and bob@c.com about @d.')).toStrictEqual(new Set(['d']))
  })

  it('takes no @ in the text of an image reference or of a media tag', () => {
    const reference = imageMarkdown('/home/u/Pictures/@f/cat.png', [{ key: 'id', value: 'a' }])
    const tag = mediaTagText({ ...SONG, src: '/home/u/Music/@g/song.mp3' })

    expect(messageMentionIds(`Like ${reference} and @b\n${tag}`)).toStrictEqual(new Set(['b']))
  })

  it('takes no mention in code', () => {
    expect(messageMentionIds('Use @a, not `@b`:\n```\n@c\n```\n\n    @d')).toStrictEqual(new Set(['a']))
  })
})

describe('sectionsToStreamMessages: images of user messages', () => {
  const sent = (sections: Section[], sendImages = true, imageLimit?: number) => sectionsToStreamMessages(sections, model, { sendImages, sendTools: false, imageLimit })
  // The conversation before the message under test: a pasted image `a`,
  // and a generated image `b` in the reply. The user message carries its
  // image; the image of the reply goes as text only.
  const earlier = [user('u1', `![id=a](${IMAGE}) A red fox`), reply('a1', `![id=b](${GENERATED})`)]
  const earlierUserMessage = { role: 'user', content: [{ type: 'text', text: '![id=a](image)' }, { type: 'image', path: IMAGE }, { type: 'text', text: ' A red fox' }] }
  const earlierMessages = [earlierUserMessage, { role: 'agent', content: '![id=b](image)' }]
  // The same for a model that reads no images.
  const earlierTexts = [{ role: 'user', content: '![id=a](image) A red fox' }, { role: 'agent', content: '![id=b](image)' }]

  it('gives every user message the parts of its images, and a later message no second part of an image that an earlier one carries', () => {
    const sections = [...earlier, user('u2', `Is @a like ![id=c](${OTHER_IMAGE})?`), reply('a2', 'Yes.'), user('u3', `And @c? ![id=a](${IMAGE})`)]

    expect(sent(sections)).toStrictEqual({
      messages: [
        ...earlierMessages,
        { role: 'user', content: [{ type: 'text', text: 'Is @a like ![id=c](image)' }, { type: 'image', path: OTHER_IMAGE }, { type: 'text', text: '?' }] },
        { role: 'agent', content: 'Yes.' },
        { role: 'user', content: 'And @c? ![id=a](image)' },
      ],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      // As a message of its own, the newest user message has a part for
      // each image that it holds or names: a media request reads only it.
      newestUserMessage: [
        { type: 'text', text: 'And @c' },
        { type: 'image', path: OTHER_IMAGE },
        { type: 'text', text: '? ![id=a](image)' },
        { type: 'image', path: IMAGE },
      ],
    })
  })

  it('sends a mentioned image of a reply however far back it is, and no other image', () => {
    const turns = Array.from({ length: 20 }, (_, index) => [user(`q${index}`, `Question ${index}`), reply(`r${index}`, `Answer ${index}`)]).flat()
    const { messages } = sent([...earlier, ...turns, user('last', 'Make @b red')])

    expect(messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Make @b' }, { type: 'image', path: GENERATED }, { type: 'text', text: ' red' }],
    })
    expect(messages.slice(1, -1).filter((message) => message.role === 'user' && typeof message.content !== 'string')).toStrictEqual([])
  })

  // The prompt cache and the signed thinking replays need the same bytes
  // of a message in every later request: one with no new user text (a tool
  // round of the reply, or a submit with an empty last section), and one
  // with a newer user message, also when that message holds the image.
  it('keeps the image parts of a user message when a reply and a newer user message come after it', () => {
    const answer = { role: 'agent', content: 'It is a fox.' }

    expect(sent([earlier[0]]).messages).toStrictEqual([earlierUserMessage])
    expect(sent([earlier[0], reply('a1', 'It is a fox.'), user('u2', '')]).messages).toStrictEqual([earlierUserMessage, answer])
    expect(sent([earlier[0], reply('a1', 'It is a fox.'), user('u2', `Is ![id=a](${IMAGE}) the same as @a?`)]).messages).toStrictEqual([
      earlierUserMessage,
      answer,
      { role: 'user', content: 'Is ![id=a](image) the same as @a?' },
    ])
  })

  // `promptWithNames` (mediaRequest.ts) names a reference only when its
  // part follows it.
  it('gives each reference of an image a part in the message that sends the image first', () => {
    expect(sent([user('u1', `![id=a](${IMAGE}) and again ![id=a](${IMAGE}) and @a`)]).messages).toStrictEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
        { type: 'image', path: IMAGE },
        { type: 'text', text: ' and again ![id=a](image)' },
        { type: 'image', path: IMAGE },
        { type: 'text', text: ' and @a' },
      ],
    }])
  })

  it('sends a mentioned image of an earlier section right after its mention, which stays in the text, and no part for a mention of an image that an earlier message carries', () => {
    const sections = [...earlier, user('u2', 'Give @b a hat, like the one of @a.')]

    expect(sent(sections)).toStrictEqual({
      messages: [
        ...earlierMessages,
        { role: 'user', content: [{ type: 'text', text: 'Give @b' }, { type: 'image', path: GENERATED }, { type: 'text', text: ' a hat, like the one of @a.' }] },
      ],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      newestUserMessage: [
        { type: 'text', text: 'Give @b' },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ' a hat, like the one of @a' },
        { type: 'image', path: IMAGE },
        { type: 'text', text: '.' },
      ],
    })
  })

  it('sends a mentioned image of a reply one time in a request: a later mention of it is text', () => {
    const sections = [...earlier, user('u2', 'Crop @b'), reply('a2', 'Done.'), user('u3', 'Now turn @b')]

    expect(sent(sections).messages.filter((message) => message.role === 'user').slice(1)).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: 'Crop @b' }, { type: 'image', path: GENERATED }] },
      { role: 'user', content: 'Now turn @b' },
    ])
  })

  it('sends a mentioned image once, at its first mention', () => {
    expect(sent([...earlier, user('u2', '@b: is @b blue?')]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: '@b' }, { type: 'image', path: GENERATED }, { type: 'text', text: ': is @b blue?' }],
    })
  })

  it('adds no part for a mention of an image that the message itself holds', () => {
    expect(sent([...earlier, user('u2', `Put @c on @b: ![id=c](${OTHER_IMAGE}) Is @c right?`)]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Put @c on @b' },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ': ![id=c](image)' },
        { type: 'image', path: OTHER_IMAGE },
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

  it('reads no image of a later section, so the newest message keeps its bytes while the reply after it gets an image', () => {
    const first = user('u1', 'Draw @a')
    const before = sent([first]).messages

    // The reply that answers `first` made the image `a` and goes on with a
    // tool round: `first` is still the newest user message.
    const during = sent([first, reply('a1', `![id=a](${GENERATED})`)]).messages
    const after = sent([first, reply('a1', `![id=a](${GENERATED})`), user('u2', 'Now make @a blue')]).messages

    expect(before).toStrictEqual([{ role: 'user', content: 'Draw @a' }])
    expect(during).toStrictEqual([...before, { role: 'agent', content: '![id=a](image)' }])
    expect(after).toStrictEqual([
      ...before,
      { role: 'agent', content: '![id=a](image)' },
      { role: 'user', content: [{ type: 'text', text: 'Now make @a' }, { type: 'image', path: GENERATED }, { type: 'text', text: ' blue' }] },
    ])
  })

  it('takes the last image with the id when two images have it', () => {
    const sections = [user('u1', `![id=a](${IMAGE})`), reply('a1', `![id=a](${GENERATED})`), user('u2', 'Crop @a')]

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
    const text = `See ${IMAGE}![id=c](${IMAGE}) and ${GENERATED}.`

    expect(sent([user('u1', text)]).messages).toStrictEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'See image![id=c](image)' }, { type: 'image', path: IMAGE }, { type: 'text', text: ' and image.' }],
    }])
  })

  it('sends a model that reads no images the text only, and counts the images that the newest message would send', () => {
    const sections = [...earlier, user('u2', `Mix @b, @b, and ![id=a](${IMAGE}) with @a and @c.`)]

    expect(sent(sections, false, 1)).toStrictEqual({
      messages: [
        ...earlierTexts,
        { role: 'user', content: 'Mix @b, @b, and ![id=a](image) with @a and @c.' },
      ],
      // `b` and `a`: the images of the last message as a message of its
      // own. The image of the first message is not counted: the user got
      // the count of that message at its submit.
      imagesLeftOut: 2,
      // No image goes, so none is over the limit.
      imagesOverLimit: 0,
      // A media request reads the same text: it sends no image either.
      newestUserMessage: 'Mix @b, @b, and ![id=a](image) with @a and @c.',
    })
    expect(sent([...earlier, user('u2', 'What is it?')], false).imagesLeftOut).toBe(0)
  })

  // The report: references in a code fence to files that are gone gave
  // "is missing" errors, and many of them the toast of the image limit.
  it('sends a reference, a mention, and a tag in code as text only, with no part and no place in the image limits', () => {
    const typed = `\`\`\`\n![id=c](${OTHER_IMAGE})\n@b\n${mediaTagText(PASTED_DANCE)}\n\`\`\`\nand \`![id=d](${OTHER_IMAGE})\` and\n\n    ![id=e](${OTHER_IMAGE})`
    const text = `\`\`\`\n![id=c](image)\n@b\n${SENT_DANCE}\n\`\`\`\nand \`![id=d](image)\` and\n\n    ![id=e](image)`
    const sections = [...earlier, user('u2', typed)]

    expect(sent(sections, true, 1)).toStrictEqual({
      messages: [...earlierMessages, { role: 'user', content: text }],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      newestUserMessage: text,
    })
    expect(sent(sections, false).imagesLeftOut).toBe(0)
    expect(messageClips(sections)).toStrictEqual([])
  })

  // In a reply, a line of Dez ends the code of the model.
  it('names a tool image after a tool block that follows an open fence of the reply', () => {
    const sections = [user('u1', 'Make a fox'), reply('a1', `\`\`\`\nopen\n${block('call_1', 'gemini', '1 model')}\n![id=b|tool=image](${GENERATED})\n\nDone.`), user('u2', 'Crop @b')]

    expect(sent(sections).messages.at(-1)).toStrictEqual({ role: 'user', content: [{ type: 'text', text: 'Crop @b' }, { type: 'image', path: GENERATED }] })
  })

  it('sends a linked image of a user message as an image part, and no linked path in any text', () => {
    const linked = '/home/u/Pictures/My fox (1).JPG'
    const typed = '/home/u/Pictures/b.png'
    const sections = [
      user('u1', `![id=a](<${linked}>) A fox`),
      reply('a1', `Not mine: ![id=b|tool=image](${typed})\n${mediaTagText({ ...SONG, src: '/home/u/Music/s.mp3' })}`),
      user('u2', `Like @a or @b?\n${mediaTagText({ ...PASTED_DANCE, src: '/home/u/Videos/d.mp4' })}`),
    ]

    expect(sent(sections).messages).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: '![id=a](image)' }, { type: 'image', path: linked }, { type: 'text', text: ' A fox' }] },
      { role: 'agent', content: `Not mine: ![id=b|tool=image](image)\n${mediaTagRequestText(SONG)}` },
      { role: 'user', content: `Like @a or @b?\n${SENT_DANCE}` },
    ])
  })

  describe('with a limit of the images of a request', () => {
    // Three user messages with one image each, and a last one that names
    // the image of the reply and holds the second image again.
    const sections = [
      ...earlier,
      user('u2', `![id=c](${OTHER_IMAGE}) A blue fox`),
      reply('a2', 'Yes.'),
      user('u3', `![id=d](${LINKED_IMAGE}) and @b, with ![id=c](${OTHER_IMAGE}) and @d`),
    ]
    const secondMessage = { role: 'user', content: [{ type: 'text', text: '![id=c](image)' }, { type: 'image', path: OTHER_IMAGE }, { type: 'text', text: ' A blue fox' }] }
    const lastText = '![id=d](image) and @b, with ![id=c](image) and @d'

    it('sends the newest images as text only, counts each of them one time, and keeps the bytes of the messages before them', () => {
      expect(sent(sections, true, 2)).toStrictEqual({
        messages: [...earlierMessages, secondMessage, { role: 'agent', content: 'Yes.' }, { role: 'user', content: lastText }],
        imagesLeftOut: 0,
        // `d` (a reference and a mention) and `b`. `c` has a part in the
        // message before.
        imagesOverLimit: 2,
        // A media request has its own limits, so the message of its own
        // has every part.
        newestUserMessage: [
          { type: 'text', text: '![id=d](image)' },
          { type: 'image', path: LINKED_IMAGE },
          { type: 'text', text: ' and @b' },
          { type: 'image', path: GENERATED },
          { type: 'text', text: ', with ![id=c](image)' },
          { type: 'image', path: OTHER_IMAGE },
          { type: 'text', text: ' and @d' },
        ],
      })
    })

    it('gives the parts in message order up to the limit, in the middle of a message too', () => {
      const { messages, imagesOverLimit } = sent(sections, true, 3)

      expect(messages.at(-1)).toStrictEqual({
        role: 'user',
        content: [{ type: 'text', text: '![id=d](image)' }, { type: 'image', path: LINKED_IMAGE }, { type: 'text', text: ' and @b, with ![id=c](image) and @d' }],
      })
      expect(imagesOverLimit).toBe(1)
    })

    it('leaves out no image of a conversation that holds the limit, or fewer', () => {
      expect([sent(sections, true, 4), sent(sections, true, 20)]).toStrictEqual([sent(sections), sent(sections)])
      expect(sent(sections).imagesOverLimit).toBe(0)
    })

    it('sends every image as text only with a limit of 0', () => {
      const { messages, imagesOverLimit } = sent(sections, true, 0)

      expect(messages.filter((message) => message.role === 'user')).toStrictEqual([earlierTexts[0], { role: 'user', content: '![id=c](image) A blue fox' }, { role: 'user', content: lastText }])
      expect(imagesOverLimit).toBe(4)
    })
  })

  describe('with a limit of the images of one message', () => {
    const limited = (messageImageLimit: number, imageLimit?: number) =>
      sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: false, imageLimit, messageImageLimit })
    // A message with two images, and a later one that names the second
    // image and holds a third one.
    const sections = [
      user('u1', `![id=a](${IMAGE}) and ![id=c](${OTHER_IMAGE})`),
      reply('a1', 'Yes.'),
      user('u2', `Is @c like ![id=d](${LINKED_IMAGE})?`),
    ]
    const first = [{ type: 'text', text: '![id=a](image)' }, { type: 'image', path: IMAGE }]

    it('gives each message its parts up to the limit, and a later message the part of an image that an earlier one left out', () => {
      const { messages, imagesOverLimit } = limited(1)

      expect(messages).toStrictEqual([
        { role: 'user', content: [...first, { type: 'text', text: ' and ![id=c](image)' }] },
        { role: 'agent', content: 'Yes.' },
        { role: 'user', content: [{ type: 'text', text: 'Is @c' }, { type: 'image', path: OTHER_IMAGE }, { type: 'text', text: ' like ![id=d](image)?' }] },
      ])
      // Only `d`: `c` has its part in the last message.
      expect(imagesOverLimit).toBe(1)
    })

    it('counts the limit of the request too', () => {
      const { messages, imagesOverLimit } = limited(2, 2)

      expect(messages).toStrictEqual([
        { role: 'user', content: [...first, { type: 'text', text: ' and ![id=c](image)' }, { type: 'image', path: OTHER_IMAGE }] },
        { role: 'agent', content: 'Yes.' },
        { role: 'user', content: 'Is @c like ![id=d](image)?' },
      ])
      expect(imagesOverLimit).toBe(1)
    })

    it('leaves out no image of messages that hold the limit, or fewer', () => {
      expect(limited(2)).toStrictEqual(sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: false }))
    })
  })
})

describe('sectionsToStreamMessages: clips of user messages', () => {
  const sent = (sections: Section[], sendImages = true) => sectionsToStreamMessages(sections, model, { sendImages, sendTools: false })
  const sections = [
    user('u1', `Like this:\n${mediaTagText(PASTED_DANCE)}`),
    reply('a1', 'Yes.'),
    user('u2', `Sing @f like ![id=a](${IMAGE})\n${mediaTagText(PASTED_VOICE)}`),
  ]

  it('sends each tag of a user message in its request form, and no part for a clip or a mention of one', () => {
    const newest = [{ type: 'text', text: 'Sing @f like ![id=a](image)' }, { type: 'image', path: IMAGE }, { type: 'text', text: `\n${SENT_VOICE}` }]

    expect(sent(sections)).toStrictEqual({
      messages: [
        { role: 'user', content: `Like this:\n${SENT_DANCE}` },
        { role: 'agent', content: 'Yes.' },
        { role: 'user', content: newest },
      ],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      newestUserMessage: newest,
    })
  })

  it('sends the newest message with no image part as the text that an older message sends', () => {
    const textOnly = [...sections.slice(0, 2), user('u2', `Sing @f\n${mediaTagText(PASTED_VOICE)}`)]

    expect([sent(sections, false).messages.at(-1), sent(textOnly).messages.at(-1)]).toStrictEqual([
      { role: 'user', content: `Sing @f like ![id=a](image)\n${SENT_VOICE}` },
      { role: 'user', content: `Sing @f\n${SENT_VOICE}` },
    ])
  })

  it('reads no image mention in a tag line', () => {
    const tag = mediaTagText({ ...PASTED_DANCE, src: '/home/u/clips/@a.mp4' })

    expect(sent([user('u1', `![id=a](${IMAGE})`), user('u2', `Dance\n${tag}`)]).messages.at(-1)).toStrictEqual({ role: 'user', content: `Dance\n${SENT_DANCE}` })
  })
})

describe('sectionsToStreamMessages: pictures that a tool showed', () => {
  const pictureOf = (name: string) => ({ file: `${name}.png`, label: `asset_view: the image @a, ${name}.`, width: 64, height: 48, bytes: 300 })
  const [first, second, third] = ['first', 'second', 'third'].map(pictureOf)
  const view = (id: string, pictures: ShownPicture[]) =>
    toolBlockText({ id, name: 'asset_view', status: 'success', arguments: { assets: '@a' }, result: '@a | image | PNG', pictures })
  // An older reply that viewed the image, and the reply that runs, which
  // viewed it two times in one round.
  const sections = [
    user('u1', `![id=a](${IMAGE})`),
    reply('a1', `${view('call_1', [first])}\nIt is red.`),
    user('u2', 'Look again.'),
    reply('a2', view('call_2', [second, third])),
  ]
  // The messages of a request, and the count of its images that went as
  // text only.
  const sent = (options: Partial<Parameters<typeof sectionsToStreamMessages>[2]> = {}) => {
    const { messages, imagesOverLimit } = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true, ...options })
    return { messages, imagesOverLimit }
  }
  // The messages of the conversation, with the parts `older` and `newer`
  // of the two picture messages.
  const messages = (older: unknown[], newer: unknown[]) => [
    { role: 'user', content: [{ type: 'text', text: '![id=a](image)' }, { type: 'image', path: IMAGE }] },
    { role: 'agent', content: '', toolCalls: [{ id: 'call_1', name: 'asset_view', arguments: { assets: '@a' } }] },
    { role: 'tool', results: [result('call_1', '@a | image | PNG')] },
    { role: 'user', content: older },
    { role: 'agent', content: 'It is red.' },
    { role: 'user', content: 'Look again.' },
    { role: 'agent', content: '', toolCalls: [{ id: 'call_2', name: 'asset_view', arguments: { assets: '@a' } }] },
    { role: 'tool', results: [result('call_2', '@a | image | PNG')] },
    { role: 'user', content: newer },
  ]

  // A picture stays in view until a compaction takes its call out.
  it('sends the pictures of every reply, each after the results of its round', () => {
    expect(sent()).toStrictEqual({ messages: messages(shown(first), [...shown(second), ...shown(third)]), imagesOverLimit: 0 })
  })

  it('sends no picture to a model that reads no images, and none in a request with no tools', () => {
    for (const options of [{ sendImages: false }, { sendTools: false }]) {
      expect(JSON.stringify(sent(options).messages), JSON.stringify(options)).not.toMatch(/"picture"|first\.png|asset_view: the image/)
    }
  })

  // The image of the first message and the picture of the older reply
  // keep their parts, so the start of the request keeps its bytes.
  it('counts the pictures and the images against one limit of the request, in message order', () => {
    expect(sent({ imageLimit: 2 })).toStrictEqual({ messages: messages(shown(first), [...note(second), ...note(third)]), imagesOverLimit: 2 })
    expect(sent({ imageLimit: 3 })).toStrictEqual({ messages: messages(shown(first), [...shown(second), ...note(third)]), imagesOverLimit: 1 })
  })

  it('gives the picture message of a round at most the images of one message', () => {
    expect(sent({ messageImageLimit: 1 })).toStrictEqual({ messages: messages(shown(first), [...shown(second), ...note(third)]), imagesOverLimit: 1 })
  })
})

describe('sectionsToStreamMessages: a compacted conversation', () => {
  const sent = (sections: Section[], sendImages = true, imageLimit?: number) => sectionsToStreamMessages(sections, model, { sendImages, sendTools: false, imageLimit })
  const tag = (pictures: ShownPicture[] = []) => compactionTagText({ count: 1, lastId: 'c', pictures })
  // The start of each user section of the compaction message.
  const KEPT = `\n\n${COMPACTION_USER_MESSAGE_LABEL}\n`
  // A compaction section with the image `b`, and two kept user messages in
  // sections of their own, as an older Dez wrote them: one with the image
  // `a`, one that names both.
  const withImages = [
    reply('c', `${tag()}\nThe fox: ![id=b](${GENERATED}) It is red. See @b.\n`),
    user('u1', `Like ![id=a](${IMAGE})?`),
    user('u2', 'And @b with @a.'),
  ]
  const withImagesMessage = {
    role: 'user',
    content: [
      { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe fox: ![id=b](image)` },
      { type: 'image', path: GENERATED },
      { type: 'text', text: ` It is red. See @b.${KEPT}Like ![id=a](image)` },
      { type: 'image', path: IMAGE },
      { type: 'text', text: `?${KEPT}And @b with @a.` },
    ],
  }

  it('sends the compaction section and the user sections right after it as the first message, a user message with no tag', () => {
    const sections = [
      reply('c', `${tag()}\nThe user wants a fox film.\n`),
      user('u1', 'Make it red.'),
      user('empty', ' '),
      user('u2', 'And slow.'),
      reply('a1', 'Done.'),
      user('u3', 'Thanks.'),
    ]

    expect(sent(sections)).toStrictEqual({
      messages: [
        { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nThe user wants a fox film.${KEPT}Make it red.${KEPT}And slow.` },
        { role: 'agent', content: 'Done.' },
        { role: 'user', content: 'Thanks.' },
      ],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      newestUserMessage: 'Thanks.',
    })
  })

  it('sends a user message first for a compaction section with no notes, and for one with no user section after it', () => {
    expect([
      sent([reply('c', tag()), user('u1', 'Hi')]).messages,
      sent([reply('c', `${tag()}\nNotes.`), user('u1', ''), reply('a1', 'Done.')]),
    ]).toStrictEqual([
      [{ role: 'user', content: `${COMPACTION_MESSAGE_INTRO}${KEPT}Hi` }],
      {
        messages: [{ role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nNotes.` }, { role: 'agent', content: 'Done.' }],
        imagesLeftOut: 0,
        imagesOverLimit: 0,
        newestUserMessage: '',
      },
    ])
  })

  // Saved conversations hold the old form, and the prompt cache needs the
  // same bytes.
  it('sends the notes of a block without its tag line and its end line, as the same bytes as the old form', () => {
    const notes = 'The user wants a fox film.'
    const blockText = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, notes)
    const oldForm = `${tag().replace(/>$/, '/>')}\n${notes}`
    const kept = user('u1', 'Make it red.')

    expect(sent([reply('c', blockText), kept]).messages).toStrictEqual([{ role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\n${notes}${KEPT}Make it red.` }])
    expect(sent([reply('c', oldForm), kept])).toStrictEqual(sent([reply('c', blockText), kept]))
  })

  // The text after the block is the reply that ran at the compaction, so
  // a later user section is a message of its own.
  it('sends the text after the block as an agent message after the notes, and the user sections after it as their own messages', () => {
    const blockText = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, 'Notes.')

    expect(sent([reply('c', `${blockText}\nTyped after it.`), user('u1', 'Make it red.')]).messages).toStrictEqual([
      { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nNotes.` },
      { role: 'agent', content: 'Typed after it.' },
      { role: 'user', content: 'Make it red.' },
    ])
  })

  it('sends the notes as the model wrote them, with each clip as the request form of its tag, and no path', () => {
    const notes = `The model wrote <\\dez:audio id="x"/> once.\n${mediaTagText(RAIN)}\nThe file ${IMAGE} is the fox.`

    expect(sent([reply('c', `${tag()}\n${notes}`), user('u1', `Use ${OTHER_IMAGE}.`)]).messages).toStrictEqual([{
      role: 'user',
      content: `${COMPACTION_MESSAGE_INTRO}\n\nThe model wrote <dez:audio id="x"/> once.\n${mediaTagRequestText(RAIN)}\nThe file image is the fox.${KEPT}Use image.`,
    }])
  })

  it('sends each image of the compaction section and of its user sections right after its reference, and no second part for a mention', () => {
    expect(sent(withImages)).toStrictEqual({
      messages: [withImagesMessage],
      imagesLeftOut: 0,
      imagesOverLimit: 0,
      // The newest user message as a message of its own names its images
      // itself: a media request reads it, and never the compaction notes.
      newestUserMessage: [
        { type: 'text', text: 'And @b' },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ' with @a' },
        { type: 'image', path: IMAGE },
        { type: 'text', text: '.' },
      ],
    })
  })

  // The prompt cache and the signed thinking replays need the same bytes.
  it('keeps the image parts of the compaction message when a newer user message comes', () => {
    expect(sent([...withImages, reply('a1', 'Done.'), user('u3', `Now ![id=d](${OTHER_IMAGE})`)]).messages).toStrictEqual([
      withImagesMessage,
      { role: 'agent', content: 'Done.' },
      { role: 'user', content: [{ type: 'text', text: 'Now ![id=d](image)' }, { type: 'image', path: OTHER_IMAGE }] },
    ])
  })

  it('sends an image of the compaction message one time: a later section that holds or names it sends its text only', () => {
    const sections = [
      reply('c', `${tag()}\nThe fox: ![id=b](${GENERATED})`),
      user('u1', `Again ![id=b](${GENERATED}) and ![id=a](${IMAGE})`),
      reply('a1', 'Done.'),
      user('u3', `Turn @b like ![id=a](${IMAGE})`),
    ]

    expect(sent(sections).messages).toStrictEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe fox: ![id=b](image)` },
          { type: 'image', path: GENERATED },
          { type: 'text', text: `${KEPT}Again ![id=b](image) and ![id=a](image)` },
          { type: 'image', path: IMAGE },
        ],
      },
      { role: 'agent', content: 'Done.' },
      { role: 'user', content: 'Turn @b like ![id=a](image)' },
    ])
  })

  it('sends a reference with the kept mark as its text only, and the image of such a reference at a mention of the user', () => {
    const sections = [
      reply('c', `${tag()}\nThe fox: ![id=b|kept=compaction](${GENERATED}) The den: ![id=d|kept=compaction](${OTHER_IMAGE})`),
      user('u1', `Like ![id=a|kept=compaction](${IMAGE})?`),
      user('u2', 'And @b with @a, then @b again.'),
    ]

    expect(sent(sections).messages).toStrictEqual([{
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe fox: ![id=b|kept=compaction](image) The den: ![id=d|kept=compaction](image)${KEPT}Like ![id=a|kept=compaction](image)?${KEPT}And @b` },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ' with @a' },
        { type: 'image', path: IMAGE },
        { type: 'text', text: ', then @b again.' },
      ],
    }])
  })

  it('reads the kept mark only in the compaction message: a later user message sends the image', () => {
    const marked = `Now ![id=d|kept=compaction](${OTHER_IMAGE})`

    expect(sent([reply('c', `${tag()}\nNotes.`), user('u1', 'Hi'), reply('a1', 'Done.'), user('u3', marked)]).messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Now ![id=d|kept=compaction](image)' }, { type: 'image', path: OTHER_IMAGE }],
    })
    // A media request reads the newest user message as a message of its own.
    expect(sent([reply('c', `${tag()}\nNotes.`), user('u1', marked)]).newestUserMessage).toStrictEqual([
      { type: 'text', text: 'Now ![id=d|kept=compaction](image)' },
      { type: 'image', path: OTHER_IMAGE },
    ])
  })

  it('sends the section of the carried assets of the user with its own first line, and not as a message of the user', () => {
    const carried = `${CARRIED_USER_ASSETS_LABEL}\n![id=a](${IMAGE})\n![id=d|kept=compaction](${OTHER_IMAGE})\n${mediaTagText(RAIN)}`

    expect(sent([reply('c', `${tag()}\nNotes.`), user('u1', 'Make a fox.'), user('u+', carried), user('u2', 'Go on.')]).messages).toStrictEqual([{
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nNotes.${KEPT}Make a fox.\n\n${CARRIED_USER_ASSETS_LABEL}\n![id=a](image)` },
        { type: 'image', path: IMAGE },
        { type: 'text', text: `\n![id=d|kept=compaction](image)\n${mediaTagRequestText(RAIN)}${KEPT}Go on.` },
      ],
    }])
  })

  it('sends the pictures of the tag after the notes, each after its label', () => {
    const sheet = { file: 's1.jpg', label: 'The frame sheet of @d (/home/u/.config/dez/assets/generated/video/d.mp4).', width: 1280, height: 320, bytes: 3000 }
    const wave = { file: 'w1.jpg', label: 'The wave of @e.', width: 800, height: 200, bytes: 2000 }

    expect(sent([reply('c', `${tag([sheet, wave])}\nNotes.`), user('u1', 'Go on.')]).messages).toStrictEqual([{
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nNotes.\n\nThe frame sheet of @d (video).` },
        { type: 'picture', picture: sheet },
        { type: 'text', text: '\n\nThe wave of @e.' },
        { type: 'picture', picture: wave },
        { type: 'text', text: `${KEPT}Go on.` },
      ],
    }])
  })

  it('counts the images and the pictures of the compaction message against the limit of a request, and sends no label of a picture that does not go', () => {
    const sheet = { file: 's1.jpg', label: 'The frame sheet of @d.', width: 1280, height: 320, bytes: 3000 }
    const wave = { file: 'w1.jpg', label: 'The wave of @e.', width: 800, height: 200, bytes: 2000 }
    const sections = [
      reply('c', `${tag([sheet, wave])}\nThe fox: ![id=b](${GENERATED})`),
      user('u1', `Like ![id=a](${IMAGE})?`),
      reply('a1', 'Done.'),
      user('u2', `And ![id=d](${OTHER_IMAGE})`),
    ]

    expect(sent(sections, true, 2)).toStrictEqual({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe fox: ![id=b](image)` },
            { type: 'image', path: GENERATED },
            { type: 'text', text: '\n\nThe frame sheet of @d.' },
            { type: 'picture', picture: sheet },
            { type: 'text', text: `${KEPT}Like ![id=a](image)?` },
          ],
        },
        { role: 'agent', content: 'Done.' },
        { role: 'user', content: 'And ![id=d](image)' },
      ],
      imagesLeftOut: 0,
      // The wave, and the images `a` and `d`.
      imagesOverLimit: 3,
      newestUserMessage: [{ type: 'text', text: 'And ![id=d](image)' }, { type: 'image', path: OTHER_IMAGE }],
    })
  })

  it('sends a model that reads no images the text only, with no picture label, and counts the images of the newest user message only', () => {
    const sheet = { file: 's1.jpg', label: 'The frame sheet of @d.', width: 1280, height: 320, bytes: 3000 }
    const sections = [reply('c', `${tag([sheet])}\nThe fox: ![id=b](${GENERATED})`), ...withImages.slice(1)]

    expect(sent(sections, false)).toStrictEqual({
      messages: [{ role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nThe fox: ![id=b](image)${KEPT}Like ![id=a](image)?${KEPT}And @b with @a.` }],
      imagesLeftOut: 2,
      imagesOverLimit: 0,
      newestUserMessage: 'And @b with @a.',
    })
    // The images of the compaction message are in every request, so a
    // count of them would tell the user about them at every submit.
    expect(sent([...sections, reply('a1', 'Done.'), user('u3', 'Thanks.')], false).imagesLeftOut).toBe(0)
  })

  it('reads the tag only in a first section that is an agent section', () => {
    const text = `${tag()}\nNotes.`

    expect([
      sent([user('u1', text), reply('a1', 'Hi.')]).messages,
      sent([user('u1', 'Hi'), reply('a1', text), user('u2', 'Go on.')]).messages,
    ]).toStrictEqual([
      [{ role: 'user', content: text }, { role: 'agent', content: 'Hi.' }],
      [{ role: 'user', content: 'Hi' }, { role: 'agent', content: text }, { role: 'user', content: 'Go on.' }],
    ])
  })

  it('gives a media request the newest user message only, also when it is a part of the compaction message', () => {
    const tab = [...withImages.slice(0, 2), reply('new', '')]
    const { newestUserMessage } = sent(tab)

    expect(mediaRequestInput('imageEdit', newestUserMessage, tab)).toStrictEqual({ prompt: 'Like ![id=a](image)?', images: [IMAGE], imagesLeftOut: 0, ...NO_CLIPS })
  })

  // The form of a compaction that moves the messages of the user that the
  // work needs into its notes, as message parts (`notesMessages`). A
  // request sends each part in a code fence.
  describe('with the messages of the user in the notes', () => {
    const FENCE = '```'
    // The notes of a compaction: the requirements `requirements`, then the
    // messages of the user: `first`, each of `middle`, and `final` (null
    // when the first message is the final one).
    const notesText = (requirements: string, first: string, final: string | null, middle: string[] = []) => [
      `## Requirements and decisions\n\n${requirements}`,
      '## User messages',
      `${final === null ? '### First and final message' : '### First message'}\n\n${messagePart(first)}`,
      ...(middle.length === 0 ? [] : [`### Relevant middle messages\n\n${middle.map(messagePart).join('\n\n')}`]),
      ...(final === null ? [] : [`### Final message\n\n${messagePart(final)}`]),
    ].join('\n\n')
    const partsBlock = (notes: string, linked?: string[]) => reply('c', compactionBlockText({ count: 1, lastId: 'c', pictures: [], linked }, notes))
    const LINKED_CLIP: MediaTagData = { kind: 'video', id: 'f', type: 'video/mp4', src: '/home/u/Videos/trip.mp4', url: null, expires: null, other: [] }

    it('sends each message at its place in a code fence, with each image part in the fence right after its reference, and no start or end line', () => {
      const notes = notesText(`The fox: ![id=b](${GENERATED})`, `Make a fox like ![id=a](${IMAGE})`, 'Now make @b red.', [`End on ![id=d](${OTHER_IMAGE}).`])

      expect(sent([partsBlock(notes), reply('r', '')])).toStrictEqual({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\n## Requirements and decisions\n\nThe fox: ![id=b](image)` },
            { type: 'image', path: GENERATED },
            { type: 'text', text: `\n\n## User messages\n\n### First message\n\n${FENCE}\nMake a fox like ![id=a](image)` },
            { type: 'image', path: IMAGE },
            { type: 'text', text: `\n${FENCE}\n\n### Relevant middle messages\n\n${FENCE}\nEnd on ![id=d](image)` },
            { type: 'image', path: OTHER_IMAGE },
            { type: 'text', text: `.\n${FENCE}\n\n### Final message\n\n${FENCE}\nNow make @b red.\n${FENCE}` },
          ],
        }],
        imagesLeftOut: 0,
        imagesOverLimit: 0,
        // A media request reads the final message part, with the image of
        // its mention.
        newestUserMessage: [
          { type: 'text', text: 'Now make @b' },
          { type: 'image', path: GENERATED },
          { type: 'text', text: ' red.' },
        ],
      })
    })

    it('makes the fence one backtick longer than the longest run of backticks in the message, and at least three backticks long', () => {
      const first = `Run this:\n${FENCE}\nnpm test\n${FENCE}`
      const final = 'Name it `fox`.'
      const longFence = '````'

      expect(sent([partsBlock(notesText('Notes.', first, final)), reply('r', '')]).messages).toStrictEqual([{
        role: 'user',
        content: `${COMPACTION_MESSAGE_INTRO}\n\n## Requirements and decisions\n\nNotes.\n\n## User messages\n\n### First message\n\n${longFence}\n${first}\n${longFence}\n\n### Final message\n\n${FENCE}\n${final}\n${FENCE}`,
      }])
    })

    it('sends no path of a stored file in a text: an image goes as its own part, and a clip as its tag with no path', () => {
      const notes = notesText(
        `The file ${IMAGE} is the fox.`,
        `Make a fox like ![id=a](${IMAGE})`,
        'Go on.',
        [`Use ![id=d](${OTHER_IMAGE}), the file ${GENERATED}, and this:\n${mediaTagText(RAIN)}`],
      )
      const parts = sent([partsBlock(notes), reply('r', '')]).messages.flatMap((message) => (message.role === 'user' && Array.isArray(message.content) ? message.content : []))
      const texts = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

      expect(parts.filter((part) => part.type !== 'text')).toStrictEqual([{ type: 'image', path: IMAGE }, { type: 'image', path: OTHER_IMAGE }])
      expect(texts).toContain(mediaTagRequestText(RAIN))
      expect(texts).not.toContain('/home/u')
    })

    it('sends the reply after the notes, and a later message of the user, as messages of their own', () => {
      const sections = [partsBlock(notesText('Notes.', 'Make a fox.', null)), reply('r', 'Done.'), user('u3', `Thanks ![id=d](${OTHER_IMAGE})`)]

      expect(sent(sections).messages).toStrictEqual([
        { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\n## Requirements and decisions\n\nNotes.\n\n## User messages\n\n### First and final message\n\n${FENCE}\nMake a fox.\n${FENCE}` },
        { role: 'agent', content: 'Done.' },
        { role: 'user', content: [{ type: 'text', text: 'Thanks ![id=d](image)' }, { type: 'image', path: OTHER_IMAGE }] },
      ])
    })

    it('sends a linked image and a linked clip of the messages with no path, and only when the tag lists them', () => {
      const first = `Like ![id=a](${LINKED_IMAGE})`
      const final = `Cut this:\n${mediaTagText(LINKED_CLIP)}`
      // A model wrote a linked path into its requirements: the list does
      // not hold it, so it is no image.
      const requirements = '![id=z](/home/u/Pictures/keys.png) is the den.'
      const listed = [partsBlock(notesText(requirements, first, final), [LINKED_IMAGE, LINKED_CLIP.src!]), reply('r', '')]

      expect(sent(listed).messages).toStrictEqual([{
        role: 'user',
        content: [
          { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\n## Requirements and decisions\n\n![id=z](image) is the den.\n\n## User messages\n\n### First message\n\n${FENCE}\nLike ![id=a](image)` },
          { type: 'image', path: LINKED_IMAGE },
          { type: 'text', text: `\n${FENCE}\n\n### Final message\n\n${FENCE}\nCut this:\n${mediaTagRequestText(LINKED_CLIP)}\n${FENCE}` },
        ],
      }])
      expect(messageClips(listed).map(({ id, src }) => ({ id, src }))).toStrictEqual([{ id: 'f', src: LINKED_CLIP.src }])

      // With no list, the same paths are text of a model.
      const unlisted = [partsBlock(notesText(requirements, first, final)), reply('r', '')]
      expect(JSON.stringify(sent(unlisted).messages)).not.toContain('/home/u')
      expect(sent(unlisted).messages[0]).toStrictEqual({ role: 'user', content: expect.any(String) })
      expect(messageClips(unlisted).map(({ id, src }) => ({ id, src }))).toStrictEqual([{ id: 'f', src: null }])
    })

    // A message part of the notes is read by the rule of the block, where a
    // line of Dez ends code: a tag line in a fence of it is a clip. In a user
    // section, the fence holds the tag, which is text.
    it('names in the prompt a clip whose tag line is in a fence of the newest message part, as the request sends the clip', () => {
      const final = `Dance like this:\n${FENCE}\n${mediaTagText(DANCE)}\n${FENCE}`
      const rules: ClipInputRules = { clips: { video: { use: 'reference', maxClips: 1, promptName: '@Video{n}' } } }
      const input = (sections: Section[]) => mediaRequestInput('video', sent(sections).newestUserMessage, sections, rules)

      expect([
        input([partsBlock(notesText('Notes.', 'Make a fox.', final)), reply('r', '')]),
        input([user('u1', final), reply('r', '')]),
      ]).toStrictEqual([
        { prompt: `Dance like this:\n${FENCE}\n@Video1\n${FENCE}`, images: [], imagesLeftOut: 0, clips: [attached(DANCE)], clipsLeftOut: { audio: 0, video: 0 } },
        { prompt: `Dance like this:\n${FENCE}\n${mediaTagRequestText(DANCE)}\n${FENCE}`, images: [], imagesLeftOut: 0, ...NO_CLIPS },
      ])
    })

    // The notes of an older Dez hold the first and the newest message of
    // the user around the parts of the model.
    it('sends each message part of older notes in a code fence too, and reads the last part as the newest message', () => {
      const notes = [
        `## First message of the user\n\n${messagePart('Make a fox.')}`,
        '## Summary\n\nThe fox is done.',
        `## Newest message of the user\n\n${messagePart('Now a wolf.')}`,
      ].join('\n\n')

      expect(sent([partsBlock(notes), reply('r', '')])).toStrictEqual({
        messages: [{
          role: 'user',
          content: `${COMPACTION_MESSAGE_INTRO}\n\n## First message of the user\n\n${FENCE}\nMake a fox.\n${FENCE}\n\n## Summary\n\nThe fox is done.\n\n## Newest message of the user\n\n${FENCE}\nNow a wolf.\n${FENCE}`,
        }],
        imagesLeftOut: 0,
        imagesOverLimit: 0,
        newestUserMessage: 'Now a wolf.',
      })
    })

    // The compaction section holds the block, then the reply that ran at
    // the compaction, with its model and its thinking.
    describe('and the reply after the block in the same section', () => {
      const BLOCK = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, notesText('Notes.', 'Make a fox.', null))
      const NOTES_MESSAGE = {
        role: 'user',
        content: `${COMPACTION_MESSAGE_INTRO}\n\n## Requirements and decisions\n\nNotes.\n\n## User messages\n\n### First and final message\n\n${FENCE}\nMake a fox.\n${FENCE}`,
      }
      const replay1 = blocksReplay('Plan 1', 'h1')
      const replay2 = blocksReplay('Plan 2', 'h2')
      const rounds = `Look.\n${block('call_1', 'fox', '1 model')}\nDone.`
      const ran = (text: string, thinking?: SectionThinking): Section => ({ ...reply('r', `${BLOCK}\n${text}`), ...(thinking && { thinking }) })
      const thinking: SectionThinking = { text: 'Plan 1Plan 2', replay: replay1, rounds: [{ afterToolCall: 'call_1', from: 6, replay: replay2 }] }
      const withTools = (sections: Section[]) => sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true })

      it('sends only the notes, as a message of the user, while the reply has no text', () => {
        expect(sent([ran('')])).toStrictEqual({ messages: [NOTES_MESSAGE], imagesLeftOut: 0, imagesOverLimit: 0, newestUserMessage: 'Make a fox.' })
      })

      it('sends the rounds of the reply after the notes, each with its thinking', () => {
        expect(withTools([ran(rounds, thinking)]).messages).toStrictEqual([
          NOTES_MESSAGE,
          { role: 'agent', content: 'Look.', thinking: { text: 'Plan 1', replay: replay1 }, toolCalls: [call('call_1', 'fox')] },
          { role: 'tool', results: [result('call_1', '1 model')] },
          { role: 'agent', content: 'Done.', thinking: { text: 'Plan 2', replay: replay2 } },
        ])
      })

      it('sends a later message of the user and a later reply as messages of their own', () => {
        expect(withTools([ran(rounds, thinking), user('u1', 'Now a red one.'), reply('r2', 'Red.')]).messages.slice(-2)).toStrictEqual([
          { role: 'user', content: 'Now a red one.' },
          { role: 'agent', content: 'Red.' },
        ])
      })

      // The prompt cache: a request in the reply sends the block alone
      // (`sectionsBeforeReply`), and a later request sends it as the same
      // first message, then the reply as it was sent.
      it('sends the same first messages while the reply runs and after it', () => {
        const during = withTools(sectionsBeforeReply([ran(rounds, thinking)], 0)).messages
        const after = withTools([ran(rounds, thinking), user('u1', 'Now a red one.'), reply('r2', '')]).messages

        expect(during).toStrictEqual([NOTES_MESSAGE])
        expect(after.slice(0, 4)).toStrictEqual(withTools([ran(rounds, thinking)]).messages)
        expect(JSON.stringify(after[0])).toBe(JSON.stringify(during[0]))
      })

      // The reply after the block is newer than the messages of the notes:
      // an image that it writes gets no part in a message of the notes that
      // named its id before, but a later message of the user that names it
      // gets one.
      it('gives a message of the notes no image of the reply after the block, so the first message keeps its bytes', () => {
        const mentions = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, notesText('Notes.', 'Make a fox. Then compare it with @d.', null))
        const sections = [reply('r', `${mentions}\nHere it is.\n\n![id=d](${GENERATED})`), user('u1', 'Make @d red.')]
        const { messages } = sent(sections)

        expect(messages[0]).toStrictEqual(sent(sectionsBeforeReply(sections, 0)).messages[0])
        expect(messages.at(-1)).toStrictEqual({ role: 'user', content: [{ type: 'text', text: 'Make @d' }, { type: 'image', path: GENERATED }, { type: 'text', text: ' red.' }] })
      })
    })
  })
})

describe('mediaRequestInput', () => {
  // The tab's sections at the start of a media reply: the reply's own
  // section is empty, so it gives no message.
  const input = (kind: MediaKind, sections: Section[], rules?: ClipInputRules) => {
    const tab = [...sections, reply('new', '')]
    return mediaRequestInput(kind, sectionsToStreamMessages(tab, model, { sendImages: true, sendTools: false }).newestUserMessage, tab, rules)
  }

  it('takes the prompt from the last user message, with each reference as its text and no path', () => {
    const sections = [
      user('u1', 'A red fox'),
      reply('a1', `![id=a](${GENERATED})`),
      user('u2', `\nLike ![id=b](${IMAGE}), but blue \n`),
    ]

    expect(input('image', sections)).toStrictEqual({ prompt: 'Like ![id=b](image), but blue', images: [], imagesLeftOut: 1, ...NO_CLIPS })
    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Like ![id=b](image), but blue', images: [IMAGE], imagesLeftOut: 0, ...NO_CLIPS })
  })

  it('edits the images of the last user message, in order', () => {
    const sections = [user('u1', `![id=a](${GENERATED})`), user('u2', `Mix ![id=b](${OTHER_IMAGE}) and ![id=c](${IMAGE})`)]

    expect(input('imageEdit', sections).images).toStrictEqual([OTHER_IMAGE, IMAGE])
  })

  it('edits the image that the last user message mentions, not the newest one', () => {
    const newest = '/home/u/.config/dez/assets/generated/images/cat.webp'
    const sections = [
      user('u1', 'A red fox'),
      reply('a1', `![id=a](${GENERATED})`),
      user('u2', 'A cat'),
      reply('a2', `![id=b](${newest})`),
      user('u3', 'Edit @a to add an apple'),
    ]

    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Edit @a to add an apple', images: [GENERATED], imagesLeftOut: 0, ...NO_CLIPS })
    expect(input('image', sections)).toStrictEqual({ prompt: 'Edit @a to add an apple', images: [], imagesLeftOut: 1, ...NO_CLIPS })
  })

  it('edits the pasted and the mentioned images of the last user message in text order, each one once', () => {
    const sections = [
      reply('a1', `![id=a](${GENERATED})`),
      user('u1', `Put ![id=b](${IMAGE}) and ![id=b](${IMAGE}) on @a. Keep @a and @b sharp.`),
    ]

    expect(input('imageEdit', sections).images).toStrictEqual([IMAGE, GENERATED])
  })

  it('gives an edit model that takes fewer images the first ones, the image to edit first, and counts the rest', () => {
    const sections = [
      reply('a1', `![id=a](${GENERATED})`),
      user('u1', `Put ![id=b](${IMAGE}) on @a`),
    ]

    expect([
      input('imageEdit', sections, { images: { maxImages: 1 } }),
      input('imageEdit', sections, { images: { maxImages: 3 } }),
    ]).toStrictEqual([
      { prompt: 'Put ![id=b](image) on @a', images: [IMAGE], imagesLeftOut: 1, ...NO_CLIPS },
      { prompt: 'Put ![id=b](image) on @a', images: [IMAGE, GENERATED], imagesLeftOut: 0, ...NO_CLIPS },
    ])
  })

  it('edits the newest image of the conversation when the last user message has none', () => {
    const sections = [
      user('u1', `![id=a](${IMAGE}) A red fox`),
      reply('a1', `![id=a](${IMAGE})\n\n![id=b](${GENERATED})`),
      user('u2', 'Make it blue'),
    ]

    expect(input('imageEdit', sections)).toStrictEqual({ prompt: 'Make it blue', images: [GENERATED], imagesLeftOut: 0, ...NO_CLIPS })
  })

  it('gives an edit with no image in the conversation no images', () => {
    expect(input('imageEdit', [user('u1', 'Make it blue')])).toStrictEqual({ prompt: 'Make it blue', images: [], imagesLeftOut: 0, ...NO_CLIPS })
  })

  // These requests have no place for a file, so the submit tells the user
  // that the images of the message were left out.
  it.each(['image', 'tts', 'music'] as const)('gives a %s request the prompt, no image of the conversation, and the count of the message\'s images', (kind) => {
    const sections = [reply('a1', `![id=a](${GENERATED})`), user('u1', `Say what ![id=b](${IMAGE}) and @a show`)]

    expect(input(kind, sections)).toStrictEqual({ prompt: 'Say what ![id=b](image) and @a show', images: [], imagesLeftOut: 2, ...NO_CLIPS })
  })

  describe('the reference images of a new image', () => {
    it('takes as many images of the last user message as the model takes, and counts the rest', () => {
      const sections = [reply('a1', `![id=a](${GENERATED})`), user('u1', `Mix ![id=b](${IMAGE}) and @a`)]

      expect(input('image', sections, { images: { maxImages: 1 } })).toStrictEqual({ prompt: 'Mix ![id=b](image) and @a', images: [IMAGE], imagesLeftOut: 1, ...NO_CLIPS })
    })

    // "Make it blue" after an image: the image goes, as for an edit. One
    // image can never meet a count above 1, so a model that needs more
    // gets none, and the refusal tells the count of the message.
    it('takes the newest image of the conversation for a model that needs one, and none for a model that needs none or more', () => {
      const sections = [user('u1', 'A red fox'), reply('a1', `![id=a](${GENERATED})`), user('u2', 'Make it blue')]

      expect([
        input('image', sections, { images: { maxImages: 1, minImages: 1 } }),
        input('image', sections, { images: { maxImages: 4 } }),
        input('image', sections, { images: { maxImages: 4, minImages: 2 } }),
      ]).toStrictEqual([
        { prompt: 'Make it blue', images: [GENERATED], imagesLeftOut: 0, ...NO_CLIPS },
        { prompt: 'Make it blue', images: [], imagesLeftOut: 0, ...NO_CLIPS },
        { prompt: 'Make it blue', images: [], imagesLeftOut: 0, ...NO_CLIPS },
      ])
    })
  })

  describe('the image of an upscale', () => {
    // A model with no rules takes one image (`maxInputImages`).
    it('takes the first image of the last user message, and counts the rest', () => {
      const sections = [reply('a1', `![id=a](${GENERATED})`), user('u1', `![id=b](${IMAGE}) and @a`)]

      expect(input('upscale', sections)).toStrictEqual({ prompt: '![id=b](image) and @a', images: [IMAGE], imagesLeftOut: 1, ...NO_CLIPS })
    })

    it('takes the newest image of the conversation when the last user message has none, and none when there is none', () => {
      const sections = [user('u1', `![id=a](${IMAGE}) A red fox`), reply('a1', `![id=b](${GENERATED})`), user('u2', 'Larger')]

      expect([input('upscale', sections), input('upscale', [user('u1', 'Larger')])]).toStrictEqual([
        { prompt: 'Larger', images: [GENERATED], imagesLeftOut: 0, ...NO_CLIPS },
        { prompt: 'Larger', images: [], imagesLeftOut: 0, ...NO_CLIPS },
      ])
    })
  })

  describe('the frames of a video', () => {
    // A pasted image, a mentioned image, and each of them once more.
    const twoImages = [reply('a1', `![id=a](${GENERATED})`), user('u1', `From ![id=b](${IMAGE}) to @a. Keep @b and @a sharp.`)]
    const threeImages = [reply('a1', `![id=a](${GENERATED})`), user('u1', `![id=b](${IMAGE}) ![id=c](${OTHER_IMAGE}) @a`)]
    // The newest image of the conversation is not in the last message.
    const imageBefore = [user('u1', `![id=a](${IMAGE}) A red fox`), reply('a1', `![id=b](${GENERATED})`), user('u2', 'Make it run')]

    it.each([
      ['a model with no rules one image', undefined, [IMAGE], 1],
      ['a model that takes one frame one image', { images: { maxImages: 1 } }, [IMAGE], 1],
      ['a model that takes two frames both images, in text order', { images: { maxImages: 2 } }, [IMAGE, GENERATED], 0],
    ])('gives %s of the last user message, and counts the rest', (_name, rules, images, imagesLeftOut) => {
      expect(input('imageToVideo', twoImages, rules)).toStrictEqual({ prompt: 'From ![id=b](image) to @a. Keep @b and @a sharp.', images, imagesLeftOut, ...NO_CLIPS })
    })

    it('gives a model that takes two frames the first two of three images', () => {
      const { images, imagesLeftOut } = input('imageToVideo', threeImages, { images: { maxImages: 2 } })

      expect({ images, imagesLeftOut }).toStrictEqual({ images: [IMAGE, OTHER_IMAGE], imagesLeftOut: 1 })
    })

    it('makes the video from the newest image of the conversation when the last user message has none', () => {
      expect(input('imageToVideo', imageBefore, { images: { maxImages: 2 } })).toStrictEqual({ prompt: 'Make it run', images: [GENERATED], imagesLeftOut: 0, ...NO_CLIPS })
    })

    it('gives an image-to-video request with no image in the conversation no images', () => {
      expect(input('imageToVideo', [user('u1', 'Make it run')])).toStrictEqual({ prompt: 'Make it run', images: [], imagesLeftOut: 0, ...NO_CLIPS })
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

  describe('the references of a video', () => {
    const references = (maxImages: number, promptName?: string): ClipInputRules => ({ images: { maxImages, references: promptName === undefined ? {} : { promptName } } })
    // A pasted image, a mentioned image, each of them once more, and a
    // mention of no image.
    const twoImages = [reply('a1', `![id=a](${GENERATED})`), user('u1', `From ![id=b](${IMAGE}) to @a. Keep @b and @a sharp, not @z.`)]

    it.each([
      ['@Image{n}', 'From @Image1 to @Image2. Keep @Image1 and @Image2 sharp, not @z.'],
      ['<Image {n}>', 'From <Image 1> to <Image 2>. Keep <Image 1> and <Image 2> sharp, not @z.'],
    ])('names each image in the prompt as %s, in the order of the request, in place of its reference and its mentions', (promptName, prompt) => {
      expect(input('imageToVideo', twoImages, references(7, promptName))).toStrictEqual({ prompt, images: [IMAGE, GENERATED], imagesLeftOut: 0, ...NO_CLIPS })
    })

    it('keeps the reference and the mentions of an image that does not go', () => {
      expect(input('imageToVideo', twoImages, references(1, '@Image{n}'))).toStrictEqual({
        prompt: 'From @Image1 to @a. Keep @Image1 and @a sharp, not @z.',
        images: [IMAGE],
        imagesLeftOut: 1,
        ...NO_CLIPS,
      })
    })

    it('names an image whose reference has no id', () => {
      const sections = [user('u1', `![](${IMAGE}) meets ![id=a](${GENERATED})`)]

      expect(input('imageToVideo', sections, references(7, '@Image{n}'))).toStrictEqual({ prompt: '@Image1 meets @Image2', images: [IMAGE, GENERATED], imagesLeftOut: 0, ...NO_CLIPS })
    })

    it('keeps the ids in the prompt of a model that tells no names', () => {
      expect(input('imageToVideo', twoImages, references(7)).prompt).toBe('From ![id=b](image) to @a. Keep @b and @a sharp, not @z.')
    })

    it('names an image of an earlier message that the last user message mentions', () => {
      const imageBefore = [user('u1', `![id=a](${IMAGE}) A red fox`), reply('a1', `![id=b](${GENERATED})`), user('u2', 'Make @a run')]

      expect(input('imageToVideo', imageBefore, references(7, '@Image{n}'))).toStrictEqual({ prompt: 'Make @Image1 run', images: [IMAGE], imagesLeftOut: 0, ...NO_CLIPS })
    })
  })

  describe('the clips of a video', () => {
    const clipsReply = reply('a1', `![id=a](${GENERATED})\n${mediaTagText(SONG)}\n${mediaTagText(DANCE)}\n${mediaTagText(RAIN)}`)
    const rules = (maxAudio: number, maxVideo: number, names = false): ClipInputRules => ({
      images: { maxImages: 4, references: names ? { promptName: '@Image{n}' } : {} },
      clips: {
        audio: { use: 'reference', maxClips: maxAudio, ...(names && { promptName: '@Audio{n}' }) },
        video: { use: 'reference', maxClips: maxVideo, ...(names && { promptName: '@Video{n}' }) },
      },
    })

    it('takes as many clips of each kind as the model takes, in text order, and counts the rest', () => {
      const sections = [clipsReply, user('u1', 'Dance @d to @c, then @e')]

      expect(input('video', sections, rules(1, 3))).toStrictEqual({
        prompt: 'Dance @d to @c, then @e',
        images: [],
        imagesLeftOut: 0,
        clips: [attached(DANCE), attached(SONG)],
        clipsLeftOut: { audio: 1, video: 0 },
      })
    })

    it('gives a model with no clip rules no clip, and counts each one', () => {
      const { clips, clipsLeftOut } = input('imageToVideo', [clipsReply, user('u1', 'Dance @d to @c')], { images: { maxImages: 1 } })

      expect({ clips, clipsLeftOut }).toStrictEqual({ clips: [], clipsLeftOut: { audio: 1, video: 1 } })
    })

    it('names each clip that goes in the prompt with the numbers of its kind, and keeps the mentions of the others', () => {
      const sections = [clipsReply, user('u1', `@a dances @d to @e and @c, like ![id=g](${IMAGE})`)]

      expect(input('video', sections, rules(1, 3, true))).toStrictEqual({
        prompt: '@Image1 dances @Video1 to @Audio1 and @c, like @Image2',
        images: [GENERATED, IMAGE],
        imagesLeftOut: 0,
        clips: [attached(DANCE), attached(RAIN)],
        clipsLeftOut: { audio: 1, video: 0 },
      })
    })

    // A video clip is the reference of a request with no image; an audio
    // clip is not.
    it('takes no newest image of the conversation when a video clip goes', () => {
      const needsImage: ClipInputRules = { ...rules(3, 3), images: { maxImages: 4, minImages: 1, references: {} } }

      expect([
        input('imageToVideo', [clipsReply, user('u1', 'Make @d slower')], needsImage).images,
        input('imageToVideo', [clipsReply, user('u1', 'Make it sing @c')], needsImage).images,
      ]).toStrictEqual([[], [GENERATED]])
    })

    it('takes the clips that the message holds with no mention, in text order with the clips that it names', () => {
      const sections = [clipsReply, user('u1', `${mediaTagText(PASTED_DANCE)}\nThe dancer of @f moves to @c\n${mediaTagText(PASTED_VOICE)}`)]

      expect(input('video', sections, rules(3, 3))).toStrictEqual({
        prompt: `${SENT_DANCE}\nThe dancer of @f moves to @c\n${SENT_VOICE}`,
        images: [],
        imagesLeftOut: 0,
        clips: [attached(PASTED_DANCE), attached(SONG), attached(PASTED_VOICE)],
        clipsLeftOut: { audio: 0, video: 0 },
      })
    })

    it('names a clip that goes in place of its tag line and its mentions, and keeps the tag of a clip that does not go', () => {
      const sections = [clipsReply, user('u1', `${mediaTagText(PASTED_DANCE)}\nThe dancer of @f moves to @c\n${mediaTagText(PASTED_VOICE)}`)]

      expect(input('video', sections, rules(1, 3, true))).toStrictEqual({
        prompt: `@Video1\nThe dancer of @Video1 moves to @Audio1\n${SENT_VOICE}`,
        images: [],
        imagesLeftOut: 0,
        clips: [attached(PASTED_DANCE), attached(SONG)],
        clipsLeftOut: { audio: 1, video: 0 },
      })
    })
  })

  it('splits the last user message of a model that takes lyrics into the style and the lyrics', () => {
    const tab = [user('u1', 'Slow piano ballad\nLyrics:\nRain on the roof'), reply('new', '')]
    const { newestUserMessage } = sectionsToStreamMessages(tab, model, { sendImages: true, sendTools: false })

    expect([
      mediaRequestInput('music', newestUserMessage, tab, { text: { lyrics: { required: true } } }),
      // The rules of a model that takes none, and no rules.
      mediaRequestInput('music', newestUserMessage, tab, { text: { maxPromptLength: 300 } }),
      mediaRequestInput('music', newestUserMessage, tab),
    ]).toStrictEqual([
      { prompt: 'Slow piano ballad', lyrics: 'Rain on the roof', images: [], imagesLeftOut: 0, ...NO_CLIPS },
      { prompt: 'Slow piano ballad\nLyrics:\nRain on the roof', images: [], imagesLeftOut: 0, ...NO_CLIPS },
      { prompt: 'Slow piano ballad\nLyrics:\nRain on the roof', images: [], imagesLeftOut: 0, ...NO_CLIPS },
    ])
  })
})
