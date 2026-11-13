import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { ClipInputRules, MediaKind, ModelInfo } from '../providers/types'
import { conversationAssets, mediaRequestProblem, preparedMediaRequest, promptRequestProblem, promptRequestSource } from './mediaRequest'
import { mediaRequestInput, sectionsToStreamMessages } from './messages'
import { model, reply, user } from './testing'

const PASTED = '/home/u/.config/dez/assets/images/red.png'
const GENERATED = '/home/u/.config/dez/assets/generated/images/fox.webp'
const LINKED = '/home/u/Pictures/cat.png'

const SONG: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: null, other: [] }
const DANCE: MediaTagData = { kind: 'video', id: 'd', type: 'video/mp4', src: null, url: 'https://cdn.example/d.mp4', expires: '2026-12-01T00:00:00.000Z', other: [] }
const RAIN: MediaTagData = { kind: 'audio', id: 'e', type: 'audio/wav', src: '/home/u/.config/dez/assets/generated/audio/r.wav', url: null, expires: null, other: [] }
// A clip as a request takes it: no unknown attribute.
const attached = ({ other: _other, ...clip }: MediaTagData) => clip

// A conversation with the images `a` (generated) and `b` (pasted), and the
// clips `c`, `d`, and `e`.
const CONVERSATION = [
  user('u1', `Like ![${PASTED}](id=b)`),
  reply('a1', `![${GENERATED}](id=a)\n${mediaTagText(SONG)}\n${mediaTagText(DANCE)}\n${mediaTagText(RAIN)}`),
]

// Rules of a video model that takes images and clips as references.
const references = (maxImages: number, maxAudio: number, maxVideo: number, names = false): ClipInputRules => ({
  images: { maxImages, references: names ? { promptName: '@Image{n}' } : {} },
  clips: {
    audio: { use: 'reference', maxClips: maxAudio, ...(names && { promptName: '@Audio{n}' }) },
    video: { use: 'reference', maxClips: maxVideo, ...(names && { promptName: '@Video{n}' }) },
  },
})

// The request of a `model_invoke` call with `prompt` in the conversation,
// and why it does not go.
function invoked(kind: MediaKind, prompt: string, rules: ClipInputRules = {}, facts: Pick<ModelInfo, 'imageInput' | 'learnedImageLimit'> = {}) {
  const source = promptRequestSource(prompt, conversationAssets(CONVERSATION))
  const input = preparedMediaRequest(kind, source, rules)
  return { input, problem: promptRequestProblem('Model', kind, { ...rules, ...facts }, rules.images, source, input) }
}

// The request of a user message with `text` after the conversation.
function submitted(kind: MediaKind, text: string, rules: ClipInputRules = {}) {
  const tab = [...CONVERSATION, user('u2', text), reply('new', '')]
  return mediaRequestInput(kind, sectionsToStreamMessages(tab, model, { sendImages: true, sendTools: false }).messages, tab, rules)
}

describe('conversationAssets', () => {
  it('gives each id its newest image or clip, and an id of both to the image', () => {
    const newerSong: MediaTagData = { ...SONG, type: 'audio/wav', src: '/home/u/.config/dez/assets/generated/audio/s2.wav' }
    const sections = [
      ...CONVERSATION,
      user('u2', `![${GENERATED}](id=b)\n${mediaTagText(newerSong)}\n${mediaTagText({ ...DANCE, id: 'a' })}`),
    ]

    const { images, clips } = conversationAssets(sections)

    expect([...images]).toStrictEqual([['b', GENERATED], ['a', GENERATED]])
    expect([...clips]).toStrictEqual([['c', attached(newerSong)], ['d', attached(DANCE)], ['e', attached(RAIN)]])
  })

  // A model's text must never make Dez read a file of the computer.
  it('takes a linked file only from a user section', () => {
    const linkedClip: MediaTagData = { ...SONG, id: 'h', src: '/home/u/Music/song.mp3' }
    const text = `![${LINKED}](id=g)\n${mediaTagText(linkedClip)}`

    const fromUser = conversationAssets([user('u1', text)])
    const fromAgent = conversationAssets([reply('a1', text)])

    expect([fromUser.images.get('g'), fromUser.clips.get('h')?.src]).toStrictEqual([LINKED, '/home/u/Music/song.mp3'])
    expect([fromAgent.images.get('g'), fromAgent.clips.get('h')?.src]).toStrictEqual([undefined, null])
  })
})

describe('promptRequestSource', () => {
  it('takes each image and clip that the prompt names with @id, in text order and each one once', () => {
    const source = promptRequestSource('Make @a dance like @d to @c. Keep @a sharp, @everyone and @z.', conversationAssets(CONVERSATION))

    expect(source).toStrictEqual({
      parts: [
        { type: 'text', text: 'Make @a' },
        { type: 'image', path: GENERATED },
        { type: 'text', text: ' dance like @d to @c. Keep @a sharp, @everyone and @z.' },
      ],
      clips: [attached(DANCE), attached(SONG)],
      pathsById: conversationAssets(CONVERSATION).images,
      inputs: [{ id: 'a', kind: 'image' }, { id: 'd', kind: 'video' }, { id: 'c', kind: 'audio' }],
      unknownIds: ['everyone', 'z'],
    })
  })

  // A model could write the path of any file into a reference or a tag.
  it('reads no image reference and no media tag of the prompt as an input, and keeps no path of them', () => {
    const prompt = `Edit ![${LINKED}](id=b) and ![${PASTED}](id=b)\n<dez:audio id="c" type="audio/mpeg" src="/home/u/.cache/dez/media/s1.mp3"/>`

    const { parts, clips, inputs } = promptRequestSource(prompt, conversationAssets(CONVERSATION))

    expect({ parts, clips, inputs }).toStrictEqual({
      parts: [{ type: 'text', text: 'Edit ![image](id=b) and ![image](id=b)\n<dez:audio id="c" type="audio/mpeg" src="audio"/>' }],
      clips: [],
      inputs: [],
    })
  })
})

describe('preparedMediaRequest', () => {
  it.each<[string, MediaKind, string, ClipInputRules]>([
    ['images and clips with their ids', 'video', '@a dances @d to @e and @c', references(4, 1, 3)],
    ['images and clips with the names of the model', 'video', '@a dances @d to @e and @c, like @b', references(4, 1, 3, true)],
    ['more images than the model takes', 'video', 'From @a to @b', references(1, 1, 1)],
    ['lyrics', 'music', 'Slow piano ballad\nLyrics:\nRain on the roof', { text: { lyrics: { required: true } } }],
    ['no input', 'image', 'A red fox', {}],
  ])('makes the same request of a tool prompt and of a user message with %s', (_name, kind, text, rules) => {
    expect(invoked(kind, text, rules).input).toStrictEqual(submitted(kind, text, rules))
  })

  it('names each image and clip that goes by its order, and keeps the id of one that does not go', () => {
    expect(invoked('video', '@a dances @d to @e and @c, like @b', references(4, 1, 3, true)).input).toStrictEqual({
      prompt: '@Image1 dances @Video1 to @Audio1 and @c, like @Image2',
      images: [GENERATED, PASTED],
      imagesLeftOut: 0,
      clips: [attached(DANCE), attached(RAIN)],
      clipsLeftOut: { audio: 1, video: 0 },
    })
  })

  // "Make it blue" from the user edits the image of the reply before. A
  // model names each input, so that it never edits an image by chance.
  it('gives a tool prompt that names no image no image of the conversation, where a user message gets the newest one', () => {
    expect([invoked('imageEdit', 'Make it blue').input.images, submitted('imageEdit', 'Make it blue').images]).toStrictEqual([[], [GENERATED]])
  })
})

describe('promptRequestProblem', () => {
  it('lets a prompt go whose inputs the model takes', () => {
    expect([
      invoked('image', 'A red fox').problem,
      invoked('imageEdit', 'Make @a blue').problem,
      invoked('video', '@a dances @d to @c', references(2, 1, 1)).problem,
      invoked('transcription', '@c', { clips: { audio: { use: 'source', maxClips: 1 } } }).problem,
    ]).toStrictEqual([null, null, null, null])
  })

  // The user sees a toast about an input that did not go. A model would
  // get a result that leaves out an input that it meant.
  it.each<[string, MediaKind, string, ClipInputRules, string]>([
    ['more images than the model takes', 'video', 'From @a to @b', references(1, 1, 1), 'takes only 1 image, and the prompt names 2'],
    ['an image for a model that takes none', 'image', 'A fox like @a', {}, 'takes no input image, and the prompt names 1 image'],
    ['more clips of a kind than the model takes', 'video', '@d to @c and @e', references(1, 1, 1), 'takes only 1 audio clip, and the prompt names 2'],
    ['a clip for a model that takes none', 'imageToVideo', '@a moves like @d', { images: { maxImages: 1 } }, 'takes no video clip, and the prompt names 1 video clip'],
  ])('refuses a prompt that names %s, where a user message is cut', (_name, kind, prompt, rules, text) => {
    expect(invoked(kind, prompt, rules).problem).toContain(text)
    expect(mediaRequestProblem('Model', kind, rules, rules.images, submitted(kind, prompt, rules))).toBeNull()
  })

  // A message to such a model carries no image (`modelInputs`).
  it('takes an image for a model that is known not to read images only when its kind needs exactly one', () => {
    expect([
      invoked('upscale', '@a', {}, { imageInput: false }).problem,
      invoked('video', 'From @a', references(2, 1, 1), { imageInput: false }).problem,
    ]).toStrictEqual([null, expect.stringContaining('takes no input image')])
  })

  it('refuses more images than a refusal of the provider told, before the cut', () => {
    const learned = { learnedImageLimit: { maxImages: 1, entry: '0badc0de' } }

    expect([
      invoked('video', 'From @a to @b', references(2, 1, 1), learned).problem,
      invoked('video', 'From @a', references(2, 1, 1), learned).problem,
    ]).toStrictEqual([expect.stringContaining('takes only 1 image, and the prompt names 2'), null])
  })

  // A model cannot paste a file or change a message: its fix is a new call.
  it.each<[string, MediaKind, string, ClipInputRules]>([
    ['no image for an edit', 'imageEdit', 'Make it blue', {}],
    ['too few images', 'image', 'Mix @a', { images: { maxImages: 4, minImages: 2 } }],
    ['too many images', 'video', 'From @a to @b', references(1, 1, 1)],
    ['an image that the model does not take', 'image', 'A fox like @a', {}],
    ['no clip to write down', 'transcription', 'Write it down', { clips: { audio: { use: 'source', maxClips: 1 } } }],
    ['too many clips', 'video', '@d to @c and @e', references(1, 1, 1)],
    ['a clip that the model does not take', 'imageToVideo', '@a moves like @d', { images: { maxImages: 1 } }],
    ['an audio clip with no image or video', 'video', 'Sing @c', { ...references(1, 1, 1), clips: { ...references(1, 1, 1).clips, audioNeedsVisual: true } }],
    ['more voices than references', 'video', '@c and @e talk', { clips: { audio: { use: 'voice' } } }],
  ])('tells the model that wrote the prompt how to call again after %s', (_name, kind, prompt, rules) => {
    const { problem } = invoked(kind, prompt, rules)

    expect(problem).toMatch(/prompt/)
    expect(problem).not.toMatch(/\b(paste|drop|message)\b/i)
  })
})
