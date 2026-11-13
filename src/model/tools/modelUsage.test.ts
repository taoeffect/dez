import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { ModelRef, Section } from '../chat/types'
import type { ModelCache } from '../persistence/types'
import { inputImageRulesFor, maxInputImages, type InputImageRules } from '../providers/clipImages'
import { clipTagProblem, maxInputClips, missingClipProblem, needsWavCopy, type ClipAttachment, type InputClipRules } from '../providers/clipInputs'
import { lyricsHowTo, type ClipTextRules } from '../providers/clipText'
import { MEDIA_FORMATS, type ClipFormat } from '../providers/mediaFormats'
import type { ParameterValues } from '../providers/modelParameters'
import { isToolsEnabled, modelToggles, toggleRows, toggleValue, toolsApply } from '../providers/modelToggles'
import { providerInfo } from '../providers/testing'
import { MEDIA_KINDS, MODEL_REQUESTS, type ChatImagePart, type MediaKind, type ModelInfo, type ModelRequest } from '../providers/types'
import { mediaRequestInput, sectionsToStreamMessages } from '../streams/messages'
import { modelInvocation } from './modelInvoke'
import { clipNamesUsage, modelUsage, neededClipUsage, referenceNamesUsage, takenClipsUsage, urlOnlyClipsUsage, USAGE_TEXTS, type UsageFacts } from './modelUsage'
import { ToolError } from './types'

// Each choice of a usage text is checked against the code that builds the
// request, so that a change of that code that the texts do not follow
// fails here.

const ref: ModelRef = { providerId: 'p', modelId: 'm' }
const FIRST = '/home/u/.config/dez/assets/images/first.png'
const SECOND = '/home/u/.config/dez/assets/images/second.png'
const NO_FACTS: UsageFacts = { toggles: [], inputImages: {} }

const user = (id: string, text: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text }] })
const reply = (id: string, text: string): Section => ({ id, role: 'agent', model: ref, content: [{ kind: 'text', text }] })

const IMAGE_INPUTS = [undefined, true, false]
const IMAGE_RULES: (InputImageRules | undefined)[] = [
  undefined,
  { maxImages: 1 },
  { maxImages: 2, minImages: 1 },
  { maxImages: 4, minImages: 2 },
  { maxImages: 4 },
  { maxImages: 7, references: {} },
  { maxImages: 7, references: { promptName: '@Image{n}' } },
]
const TEXT_RULES: (ClipTextRules | undefined)[] = [undefined, { maxPromptLength: 100 }, { lyrics: { required: false } }, { lyrics: { required: true, maxLength: 50 } }]

// Each model of `request` that the rules above make.
function models(request: ModelRequest): ModelInfo[] {
  return IMAGE_INPUTS.flatMap((imageInput) => IMAGE_RULES.flatMap((images) => TEXT_RULES.map((text): ModelInfo => ({
    id: 'm',
    name: 'M',
    provider: 'p',
    request,
    ...(imageInput !== undefined && { imageInput }),
    ...(images && { images }),
    ...(text && { text }),
  }))))
}

// What a media reply of `model` sends for the tab `sections`, as the stream
// controller builds it (`dez.model/streamMessagesForTab`, then
// `mediaRequestInput`).
function mediaInput(kind: MediaKind, model: ModelInfo, sections: Section[]) {
  const tab = [...sections, reply('new', '')]
  const { messages } = sectionsToStreamMessages(tab, ref, { sendImages: model.imageInput !== false, sendTools: false })
  return mediaRequestInput(kind, messages, tab, model)
}

const has = (usage: string[], ...texts: string[]) => texts.some((text) => usage.includes(text))

describe('modelUsage', () => {
  it('tells only that Dez sends no request to a model that it cannot use', () => {
    for (const request of MODEL_REQUESTS) {
      const usable = modelUsage({ id: 'm', name: 'M', provider: 'p', request }, NO_FACTS)
      const unstored = modelUsage({ id: 'm', name: 'M', provider: 'p', request, unstoredOutput: 'TIFF' }, NO_FACTS)

      expect(usable[0], request).toBe(request === 'none' ? USAGE_TEXTS.cannotUse : request === 'chat' ? USAGE_TEXTS.userSends : USAGE_TEXTS.invokeSends)
      expect(usable.length > 1, request).toBe(request !== 'none')
      expect(unstored, request).toStrictEqual([USAGE_TEXTS.cannotUse])
    }
  })

  // `model_invoke` checks the model of a call before its time limit. So a
  // call with a bad time limit tells whether the tool takes the model:
  // only then is the refusal about the time limit.
  it('tells that you can send a request with model_invoke exactly when that tool takes the model', () => {
    const invokeTakes = (model: ModelInfo) => {
      const cache: ModelCache = { version: 1, providers: { p: { models: [model], working: true, updatedAt: 0, lastCheckedAt: 0 } } }
      try {
        modelInvocation({ model: 'p/m', prompt: 'A fox.', timeout_seconds: 0 }, { cache, providers: [providerInfo('p', 'P')], modelParameters: {}, sections: [] })
      } catch (error) {
        if (error instanceof ToolError) return error.message.includes('timeout_seconds')
        throw error
      }
      throw new Error('The call was not refused.')
    }

    for (const request of MODEL_REQUESTS) {
      for (const unstoredOutput of [undefined, 'TIFF']) {
        const model: ModelInfo = { id: 'm', name: 'M', provider: 'p', request, ...(unstoredOutput && { unstoredOutput }) }

        expect(modelUsage(model, NO_FACTS)[0] === USAGE_TEXTS.invokeSends, JSON.stringify(model)).toBe(invokeTakes(model))
      }
    }
  })

  describe('of a media model', () => {
    it('tells that the images of the message go exactly when a request takes them', () => {
      for (const kind of MEDIA_KINDS) {
        for (const model of models(kind)) {
          const usage = modelUsage(model, NO_FACTS)
          const sent = mediaInput(kind, model, [user('u1', `Mix ![${FIRST}](id=a) and ![${SECOND}](id=b)`)]).images
          const label = `${kind} ${JSON.stringify(model)}`

          expect(has(usage, USAGE_TEXTS.noImages, USAGE_TEXTS.noImagesRead), label).toBe(sent.length === 0)
          // A model that does not read images gets only the newest image.
          if (has(usage, USAGE_TEXTS.newestImageOnly)) expect(sent, label).toStrictEqual([SECOND])
        }
      }
    })

    it('tells that the newest image of the conversation goes exactly when a message with no image gets it', () => {
      for (const kind of MEDIA_KINDS) {
        for (const model of models(kind)) {
          const usage = modelUsage(model, NO_FACTS)
          const sent = mediaInput(kind, model, [user('u1', `![${FIRST}](id=a)`), reply('a1', 'Done.'), user('u2', 'Make it blue')]).images

          expect(has(usage, USAGE_TEXTS.newestImage, USAGE_TEXTS.newestImageOnly), `${kind} ${JSON.stringify(model)}`).toBe(sent.length > 0)
        }
      }
    })

    it('tells how to write lyrics exactly when a request takes them', () => {
      for (const kind of MEDIA_KINDS) {
        for (const model of models(kind)) {
          const usage = modelUsage(model, NO_FACTS)
          const { lyrics } = mediaInput(kind, model, [user('u1', 'A calm song\nLyrics:\nLa la')])

          expect(model.text?.lyrics !== undefined && usage.includes(lyricsHowTo(model.text.lyrics)), `${kind} ${JSON.stringify(model)}`).toBe(lyrics !== undefined)
        }
      }
    })

    // The names text shows the names of the first two images of the request.
    // A model whose request sends no text (an upscale) names nothing.
    it('tells the names of the images in the prompt exactly when a request gives them', () => {
      for (const kind of MEDIA_KINDS) {
        for (const model of models(kind)) {
          const usage = modelUsage(model, NO_FACTS)
          const { prompt, images } = mediaInput(kind, model, [user('u1', `Mix ![${FIRST}](id=a) and ![${SECOND}](id=b)`)])
          const promptName = model.images?.references?.promptName
          const named = promptName !== undefined && usage.includes(referenceNamesUsage(promptName))
          const label = `${kind} ${JSON.stringify(model)}`

          expect(named || usage.includes(USAGE_TEXTS.promptImages) || usage.includes(USAGE_TEXTS.noText), label).toBe(true)
          expect(named, label).toBe(!usage.includes(USAGE_TEXTS.noText) && images.length > 0 && !prompt.includes('![image]'))
          if (named) expect(prompt, label).toBe('Mix @Image1 and @Image2')
        }
      }
    })

    it('tells that the images of a model with reference rules are references, not frames', () => {
      const usage = modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'video', images: { maxImages: 7, references: {} } }, NO_FACTS)

      expect([usage.includes(USAGE_TEXTS.videoReferences), usage.includes(USAGE_TEXTS.frames)]).toStrictEqual([true, false])
    })

    it('tells the rules of the input images only to a model that takes images', () => {
      const facts: UsageFacts = { toggles: [], inputImages: { size: { minShortSide: 256 }, limits: { maxBytes: 1000 } } }

      expect(modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'upscale' }, facts)).toEqual(expect.arrayContaining([USAGE_TEXTS.fitted, USAGE_TEXTS.limits]))
      expect(modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'video' }, facts)).not.toEqual(expect.arrayContaining([USAGE_TEXTS.fitted]))
      expect(modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'video' }, facts)).not.toEqual(expect.arrayContaining([USAGE_TEXTS.limits]))
    })

    it('points to the parameters of a model that has some', () => {
      const parameters = [{ name: 'duration', label: 'Length', options: ['4s', '8s'] }]

      expect(modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'video', parameters }, NO_FACTS)).toContain(USAGE_TEXTS.parameters)
      expect(modelUsage({ id: 'm', name: 'M', provider: 'p', request: 'video' }, NO_FACTS)).not.toContain(USAGE_TEXTS.parameters)
    })

    describe('the clips of the message', () => {
      const SONG: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s.mp3', url: null, expires: null, other: [] }
      const DANCE: MediaTagData = { kind: 'video', id: 'd', type: 'video/mp4', src: '/home/u/.cache/dez/media/d.mp4', url: null, expires: null, other: [] }
      const RAIN: MediaTagData = { ...SONG, id: 'e', src: '/home/u/.cache/dez/media/r.mp3' }
      const clipsReply = reply('a1', `![${FIRST}](id=a)\n${mediaTagText(SONG)}\n${mediaTagText(DANCE)}\n${mediaTagText(RAIN)}`)
      // A message with clips that it names and a clip file that the user
      // pasted into it.
      const message = user('u1', `Use @c, @d, and @e with this:\n${mediaTagText({ ...DANCE, id: 'f', src: '/home/u/.config/dez/assets/video/f.mp4' })}`)
      const CLIP_RULES: (InputClipRules | undefined)[] = [
        undefined,
        { audio: { use: 'background', maxClips: 1, types: ['audio/wav', 'audio/mpeg'] } },
        { audio: { use: 'reference', maxClips: 3, promptName: '<Audio {n}>' }, video: { use: 'reference', maxClips: 3, promptName: '<Video {n}>' }, audioNeedsVisual: true },
        { audio: { use: 'voice', types: ['audio/mpeg'] }, video: { use: 'reference', maxClips: 5 } },
        { audio: { use: 'reference', urlOnly: true }, video: { use: 'reference', urlOnly: true } },
      ]
      // The clips as a model made them, with a web address that works.
      const withUrls = (clips: ClipAttachment[]) => clips.map((clip) => ({ ...clip, url: `https://files.example.com/${clip.id}` }))
      // A video model of each clip rules, which needs an image.
      const clipModels = (kind: MediaKind) => CLIP_RULES.map((clips): ModelInfo => ({
        id: 'm',
        name: 'M',
        provider: 'p',
        request: kind,
        images: { maxImages: 4, minImages: 1, references: {} },
        ...(clips && { clips }),
      }))

      it('tells which clips of the message go exactly when a request takes them', () => {
        for (const kind of MEDIA_KINDS) {
          for (const model of clipModels(kind)) {
            const usage = modelUsage(model, NO_FACTS)
            const { clips } = mediaInput(kind, model, [clipsReply, message])
            const label = `${kind} ${JSON.stringify(model)}`

            for (const clipKind of ['audio', 'video'] as const) {
              const max = maxInputClips(model.clips, clipKind)
              const sent = clips.filter((clip) => clip.kind === clipKind).length
              expect(max > 0 && usage.includes(takenClipsUsage(clipKind, max)), `${clipKind} ${label}`).toBe(sent > 0)
            }
            if (has(usage, USAGE_TEXTS.noClips)) expect(clips, label).toStrictEqual([])
          }
        }
      })

      it('tells the names of the clips in the prompt exactly when a request gives them', () => {
        for (const model of clipModels('video')) {
          const usage = modelUsage(model, NO_FACTS)
          const { prompt } = mediaInput('video', model, [clipsReply, message])
          const label = JSON.stringify(model)

          expect(usage.includes(clipNamesUsage('audio', '<Audio {n}>')), label).toBe(prompt.includes('<Audio 1>'))
          expect(usage.includes(clipNamesUsage('video', '<Video {n}>')), label).toBe(prompt.includes('<Video 1>'))
        }
      })

      it('tells that a video clip takes the place of the newest image exactly when it does', () => {
        for (const model of clipModels('imageToVideo')) {
          const usage = modelUsage(model, NO_FACTS)
          const { images } = mediaInput('imageToVideo', model, [clipsReply, user('u1', 'Make @d slower')])

          expect(has(usage, USAGE_TEXTS.newestImageOrVideo), JSON.stringify(model)).toBe(images.length === 0)
        }
      })

      // The video models that the rules of each media format make:
      // OpenRouter frames or references (the user's choice) with the clip
      // kinds of its input modalities, Venice frames with and without a
      // background audio clip, and a Venice reference family with its
      // clips. Each request has one image, and one clip of each kind that
      // the model takes; the frame fields are those of the two formats.
      it('tells that the images are frames exactly when a video request sends them so, with and without a clip', () => {
        const FRAME_FIELDS = ['frame_images', 'image_url', 'end_image_url']
        const image: ChatImagePart = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }
        interface FormatModel { format: keyof typeof MEDIA_FORMATS, id: string, entry: unknown, mediaEntry?: unknown, values: ParameterValues }
        const venice = (id: string, constraints: Record<string, unknown>): FormatModel => ({ format: 'venice', id, entry: { id, model_spec: { constraints } }, values: {} })
        const formatModels: FormatModel[] = [
          ...['frames', 'references'].flatMap((imagesAs) => [['text', 'image'], ['text', 'image', 'audio'], ['text', 'image', 'video']].map((inputs): FormatModel => ({
            format: 'openrouter',
            id: 'm',
            entry: { id: 'm', architecture: { input_modalities: inputs } },
            mediaEntry: { id: 'm', supported_frame_images: ['first_frame', 'last_frame'] },
            values: { images_as: imagesAs },
          }))),
          venice('wan-2-6-image-to-video', {}),
          venice('wan-2-6-image-to-video', { audio_input: true }),
          venice('seedance-2-0-reference-to-video', { audio_input: true }),
        ]

        for (const kind of ['video', 'imageToVideo'] as const) {
          for (const { format, id, entry, mediaEntry, values } of formatModels) {
            const images = inputImageRulesFor(MEDIA_FORMATS[format].imageRules?.(kind, entry, mediaEntry), values)
            const clipRules = MEDIA_FORMATS[format].clipRules?.(kind, entry, mediaEntry)
            const usage = modelUsage({ id, name: 'M', provider: 'p', request: kind, ...(images && { images }), ...(clipRules && { clips: clipRules }) }, NO_FACTS)
            const clips = (['audio', 'video'] as const).flatMap((clipKind) => {
              const use = clipRules?.[clipKind]?.use
              return use ? [{ kind: clipKind, use, url: `https://files.example.com/${clipKind}.bin` }] : []
            })
            const sendsFrames = (withClips: boolean) => {
              const request = (MEDIA_FORMATS[format].clips as ClipFormat).request(kind, 'https://api.example.com/v1', id, {
                prompt: 'It runs',
                images: [image].slice(0, maxInputImages(kind, images)),
                ...(withClips && { clips }),
                values: { ...values, duration: 1 },
              })
              return FRAME_FIELDS.some((field) => Object.hasOwn(request.body ?? {}, field))
            }
            const label = `${format} ${kind} ${JSON.stringify({ entry, values })}`

            expect(usage.includes(USAGE_TEXTS.frames), label).toBe(sendsFrames(false))
            expect(usage.includes(USAGE_TEXTS.clipsMakeReferences), label).toBe(sendsFrames(false) && !sendsFrames(true))
          }
        }
      })

      // A voice is the voice of a reference, so it needs one too.
      it('tells that an audio clip needs an image or a video clip exactly when Dez refuses one alone', () => {
        for (const model of clipModels('video')) {
          const usage = modelUsage(model, NO_FACTS)
          const { clips } = mediaInput('video', model, [clipsReply, user('u1', 'Sing @c')])
          const refused = clips.length > 0 && clipTagProblem('M', model.clips, withUrls(clips), 0) !== null

          expect(has(usage, USAGE_TEXTS.audioNeedsVisual) || model.clips?.audio?.use === 'voice', JSON.stringify(model)).toBe(refused)
        }
      })

      it('tells that a clip goes only by its web address exactly when Dez refuses one that is only a file', () => {
        for (const model of clipModels('video')) {
          const usage = modelUsage(model, NO_FACTS)
          for (const clipKind of ['audio', 'video'] as const) {
            const { clips } = mediaInput('video', model, [clipsReply, user('u1', `![${FIRST}](id=a) with @${clipKind === 'audio' ? 'c' : 'd'}`)])
            const refusedAsFile = clips.length > 0 && clipTagProblem('M', model.clips, clips, 1) !== null
            const refusedWithUrl = clips.length > 0 && clipTagProblem('M', model.clips, withUrls(clips), 1) !== null

            expect(usage.includes(urlOnlyClipsUsage(clipKind)), `${clipKind} ${JSON.stringify(model)}`).toBe(refusedAsFile && !refusedWithUrl)
          }
        }
      })

      it('tells that an audio clip goes as a WAV copy exactly when one of another type does', () => {
        for (const model of clipModels('video')) {
          const audio = model.clips?.audio

          expect(has(modelUsage(model, NO_FACTS), USAGE_TEXTS.wavCopy), JSON.stringify(model)).toBe(audio !== undefined && needsWavCopy('audio', audio, 'audio/flac'))
        }
      })

      it('tells that a message needs a clip of a kind exactly when Dez refuses a message with none of that kind', () => {
        for (const kind of MEDIA_KINDS) {
          for (const model of clipModels(kind)) {
            const usage = modelUsage(model, NO_FACTS)

            for (const clipKind of ['audio', 'video'] as const) {
              const other = clipKind === 'audio' ? DANCE : SONG
              const refused = missingClipProblem('M', kind, [other]) !== null

              expect(usage.includes(neededClipUsage(clipKind)), `${clipKind} ${kind} ${JSON.stringify(model)}`).toBe(refused)
            }
          }
        }
      })
    })
  })

  describe('of a chat model', () => {
    const config = { thinking: {}, settings: [] }

    it('tells that the Dez tools go exactly when a request offers them', () => {
      for (const toolCalling of [undefined, true, false]) {
        for (const stored of [undefined, { tools: true }, { tools: false }]) {
          const model: ModelInfo = { id: 'm', name: 'M', provider: 'p', request: 'chat', ...(toolCalling !== undefined && { toolCalling }) }
          // As the model_info runner gives the toggles.
          const toggles = toggleRows(modelToggles(config, model)).map((row) => ({ key: row.key, on: toggleValue(row, stored) }))
          const usage = modelUsage(model, { toggles, inputImages: {} })

          expect(usage.includes(USAGE_TEXTS.tools), JSON.stringify({ toolCalling, stored })).toBe(toolsApply(model) && isToolsEnabled(stored))
        }
      }
    })

    it('tells that the images of the newest message go exactly when a request carries them', () => {
      for (const imageInput of IMAGE_INPUTS) {
        const model: ModelInfo = { id: 'm', name: 'M', provider: 'p', request: 'chat', ...(imageInput !== undefined && { imageInput }) }
        const { messages } = sectionsToStreamMessages([user('u1', `![${FIRST}](id=a)`)], ref, { sendImages: model.imageInput !== false, sendTools: false })
        const content = messages[0].role === 'user' ? messages[0].content : ''
        const carriesImage = typeof content !== 'string' && content.some((part) => part.type === 'image')

        expect(modelUsage(model, NO_FACTS).includes(USAGE_TEXTS.chatImages), String(imageInput)).toBe(carriesImage)
      }
    })
  })
})
