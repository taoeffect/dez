import { describe, expect, it } from 'vitest'
import type { ModelRef, Section } from '../chat/types'
import type { InputImageRules } from '../providers/clipImages'
import { lyricsHowTo, type ClipTextRules } from '../providers/clipText'
import { modelToggles, toggleRows, toggleValue, toolsApply } from '../providers/modelToggles'
import { isToolsEnabled } from '../providers/toolsSetting'
import { MODEL_REQUESTS, type MediaKind, type ModelInfo, type ModelRequest } from '../providers/types'
import { mediaRequestInput, sectionsToStreamMessages } from '../streams/messages'
import { modelUsage, referenceNamesUsage, USAGE_TEXTS, type UsageFacts } from './modelUsage'

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
      const unstored = modelUsage({ id: 'm', name: 'M', provider: 'p', request, unstoredOutput: 'SVG' }, NO_FACTS)

      expect(usable[0], request).toBe(request === 'none' ? USAGE_TEXTS.cannotUse : USAGE_TEXTS.userSends)
      expect(usable.length > 1, request).toBe(request !== 'none')
      expect(unstored, request).toStrictEqual([USAGE_TEXTS.cannotUse])
    }
  })

  describe('of a media model', () => {
    const mediaKinds = MODEL_REQUESTS.filter((kind): kind is MediaKind => kind !== 'chat' && kind !== 'none')

    it('tells that the images of the message go exactly when a request takes them', () => {
      for (const kind of mediaKinds) {
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
      for (const kind of mediaKinds) {
        for (const model of models(kind)) {
          const usage = modelUsage(model, NO_FACTS)
          const sent = mediaInput(kind, model, [user('u1', `![${FIRST}](id=a)`), reply('a1', 'Done.'), user('u2', 'Make it blue')]).images

          expect(has(usage, USAGE_TEXTS.newestImage, USAGE_TEXTS.newestImageOnly), `${kind} ${JSON.stringify(model)}`).toBe(sent.length > 0)
        }
      }
    })

    it('tells how to write lyrics exactly when a request takes them', () => {
      for (const kind of mediaKinds) {
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
      for (const kind of mediaKinds) {
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

      expect([usage.includes(USAGE_TEXTS.videoReferences), usage.some((text) => text.includes('first frame'))]).toStrictEqual([true, false])
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
