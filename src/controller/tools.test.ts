import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AudioPart, CutAudio } from '../model/chat/audioCut'
import { UnwritableImageTypeError, type DrawnImage, type DrawnMediaType, type ImageDrawing, type ImageSize } from '../model/chat/imageDrawing'
import { ClipReadError } from '../model/chat/mediaFiles'
import type { MediaTagData } from '../model/chat/mediaTags'
import type { KnownLimit } from '../model/providers/knownLimits'
import type { ProviderMediaQuote, ProviderMediaQuoteInput } from '../model/providers/streamTypes'
import { providerInfo } from '../model/providers/testing'
import type { ModelInfo, ProviderInfo, ProviderInputImageRules, ProviderSettingsDescriptor } from '../model/providers/types'
import { modelInfoText, type ModelInfoFacts } from '../model/tools/modelInfo'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToolRunResult } from '../model/tools/types'
import type { ToolRunCall, ToolRunContext } from './tools'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './tools'

const providers = [providerInfo('venice', 'Venice'), providerInfo('closed', 'Closed', false)]
const MODELS = (id: string) => [
  { id: `${id}-gemini-3-pro`, name: 'Gemini 3 Pro', provider: id },
  { id: `${id}-glm-5`, name: 'GLM 5', provider: id },
]

// The options of each model cache refresh, and what the refresh does. Set in
// beforeEach and by the tests.
let refreshes: unknown[] = []
let refreshCheck: () => Promise<void>
// The price requests, and what the provider answers to one.
let quotes: ProviderMediaQuoteInput[] = []
let quoteAnswer: () => Promise<ProviderMediaQuote | null>
// The toggles that apply to every model, the rules of an input image, and
// the known limits of each model by its full id.
let descriptor: ProviderSettingsDescriptor | null
let inputImageRules: ProviderInputImageRules
let knownLimits: Record<string, KnownLimit[]>
// The stub image store and webview of the `image` tool: the paths of the
// files that were read, what a read and a save do, the size of every stored
// image, each drawing with its file type, each save with its file type, and
// the deleted files. Set in beforeEach and by the tests.
let readImages: string[] = []
let readImage: () => Promise<Blob>
let storedImageSize: ImageSize
// Set to make the webview fail to draw.
let redrawError: Error | undefined
let drawings: { drawing: ImageDrawing, mediaType: string }[] = []
let savedImages: { mediaType: string, options: unknown }[] = []
let saveImage: () => Promise<string>
let deletedImages: string[] = []
// The stub clip store and webview of the `audio` tool: the source of each
// clip that was read, what a read and a save do, the length of every clip,
// each save, and the deleted files. Set in beforeEach and by the tests.
let readClips: (string | null)[] = []
let readClip: () => Promise<Blob>
let clipDuration: number
// Set to make the webview fail to decode.
let cutError: Error | undefined
let savedClips: { clip: unknown, options: unknown }[] = []
let saveClip: () => Promise<string>
let deletedClips: string[] = []
const CUT_BYTES = new Uint8Array([9])
// The files that the stub stores save.
const MADE_IMAGE = '/home/u/.config/dez/assets/generated/images/new.png'
const MADE_CLIP = '/home/u/.config/dez/assets/generated/audio/new.wav'

sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return providers
  },
  async 'dez.provider/mediaQuote' (input: ProviderMediaQuoteInput): Promise<ProviderMediaQuote | null> {
    quotes.push(input)
    return quoteAnswer()
  },
  'dez.provider/settingsDescriptor' (): ProviderSettingsDescriptor | null {
    return descriptor
  },
  'dez.provider/inputImageRules' (): ProviderInputImageRules {
    return inputImageRules
  },
  'dez.provider/knownLimits' (providerId: string, modelId: string): KnownLimit[] {
    return knownLimits[`${providerId}/${modelId}`] ?? []
  },
  async 'dez.controller/modelCache/refresh' (options: unknown): Promise<void> {
    refreshes.push(options)
    await refreshCheck()
  },
  async 'dez.controller/images/readFile' (path: string): Promise<Blob> {
    readImages.push(path)
    return await readImage()
  },
  // Writes the type that the drawing names, else the type that the caller
  // asked for, as redraw does.
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage | null> {
    if (redrawError) throw redrawError
    const drawing = plan(storedImageSize)
    if (!drawing) return null
    drawings.push({ drawing, mediaType })
    return { bytes: new Uint8Array([7]), mediaType: drawing.mediaType ?? mediaType, width: drawing.width, height: drawing.height }
  },
  async 'dez.controller/images/save' (_bytes: Uint8Array, mediaType: string, options: unknown): Promise<string> {
    savedImages.push({ mediaType, options })
    return await saveImage()
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
  async 'dez.controller/media/readClip' (clip: MediaTagData): Promise<Blob> {
    readClips.push(clip.src)
    return await readClip()
  },
  async 'dez.controller/media/cutAudio' (_file: Blob, plan: (duration: number) => AudioPart | null): Promise<CutAudio | null> {
    if (cutError) throw cutError
    const part = plan(clipDuration)
    return part && { part, bytes: CUT_BYTES, duration: part.end - part.start }
  },
  async 'dez.controller/media/save' (clip: unknown, options: unknown): Promise<string> {
    savedClips.push({ clip, options })
    return await saveClip()
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
  },
})

function run(call: ToolRunCall): Promise<ToolRunResult> {
  return sbp('dez.controller/tools/run', call, new AbortController().signal) as Promise<ToolRunResult>
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  // As at app start: the cached models, with no raw entries.
  for (const { id } of providers) {
    sbp('dez.model/modelCache/applyProviderResult', id, { ok: true, models: MODELS(id) })
  }
  refreshes = []
  quotes = []
  quoteAnswer = async () => ({ usd: 0.07 })
  descriptor = { name: 'Venice', thinking: true, tools: true, settings: [{ key: 'webSearch', label: 'Web search', type: 'boolean', default: true, bodyPath: 'venice_parameters.enable_web_search' }] }
  inputImageRules = {}
  knownLimits = {}
  readImages = []
  readImage = async () => new Blob([])
  storedImageSize = { width: 1000, height: 500 }
  redrawError = undefined
  drawings = []
  savedImages = []
  saveImage = async () => MADE_IMAGE
  deletedImages = []
  readClips = []
  readClip = async () => new Blob([])
  clipDuration = 10
  cutError = undefined
  savedClips = []
  saveClip = async () => MADE_CLIP
  deletedClips = []
  // A check that the provider passes, with an entry for each model.
  refreshCheck = async () => {
    sbp('dez.model/modelCache/applyProviderResult', 'venice', {
      ok: true,
      models: MODELS('venice'),
      entries: new Map(MODELS('venice').map(({ id }) => [id, { id, checked: true }])),
    })
  }
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/tools/run', () => {
  const columns = '(full id | name | provider | type | inputs | released). Letters: t text, i image, a audio, v video; ? unknown, - none.'

  it('lists the cached models of the configured providers that match the filter', async () => {
    expect(await run({ name: 'model_list', arguments: { filter: 'gemini' } })).toStrictEqual({
      content: `1 model matches "gemini" ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice | ? | t,i | ?`,
      isError: false,
    })
    expect(await run({ name: 'model_list', arguments: {} })).toStrictEqual({
      content: `2 models ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice | ? | t,i | ?\nvenice/venice-glm-5 | GLM 5 | Venice | ? | t,i | ?`,
      isError: false,
    })
  })

  it('gives an error result that names the valid values for a type that is unknown', async () => {
    expect(await run({ name: 'model_list', arguments: { type: 'q' } })).toStrictEqual({
      content: 'Unknown value "q" in `type`. Use a comma list of: text, image, audio, video.',
      isError: true,
    })
  })

  it('has a runner for every tool that requests offer', async () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect((await run({ name: definition.name, arguments: {} })).content).not.toMatch(/^Dez has no tool/)
    }
    expect(await run({ name: 'toString', arguments: {} })).toStrictEqual({
      content: 'Dez has no tool named "toString". Call only the Dez tools, by their exact names: model_list, model_info, audio, image.',
      isError: true,
    })
  })

  // The error's own text can hold a local path, and the result goes to the
  // chat provider.
  it('gives an error that Dez did not expect as such, without its text, and logs it', async () => {
    refreshCheck = async () => { throw new Error('Failed to read /home/u/.config/dez/model_cache.json') }

    expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
      content: 'Dez hit an error that it did not expect while it ran model_info. This is not a fault of the call. '
        + 'Tell the user that the tool failed (Help › Developer Console shows the error), and do not call it again with the same arguments.',
      isError: true,
    })
    expect(consoleError).toHaveBeenCalledOnce()
  })

  describe('model_info', () => {
    // The toggles of the default descriptor, with their defaults.
    const toggles = [{ key: 'thinking', label: 'Thinking', on: true }, { key: 'tools', label: 'Tools', on: true }, { key: 'webSearch', label: 'Web search', on: true }]
    const gemini = (entry: unknown) => modelInfoText(providers[0], MODELS('venice')[0], { entry, values: {}, toggles, inputImages: {} })

    it('gives the raw entry in memory, with no model check', async () => {
      sbp('dez.model/modelCache/applyProviderResult', 'venice', {
        ok: true,
        models: MODELS('venice'),
        entries: new Map([['venice-gemini-3-pro', { id: 'venice-gemini-3-pro', checked: false }]]),
      })

      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: gemini({ id: 'venice-gemini-3-pro', checked: false }),
        isError: false,
      })
      expect(refreshes).toStrictEqual([])
    })

    it('checks only the model\'s provider, at once, when no raw entry is in memory, and gives the new entry', async () => {
      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: gemini({ id: 'venice-gemini-3-pro', checked: true }),
        isError: false,
      })
      expect(refreshes).toStrictEqual([{ providerIds: ['venice'], force: true }])
    })

    it('gives an error result that points to model_list when the model is gone after the check', async () => {
      refreshCheck = async () => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [], entries: new Map() })
      }

      expect(await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).toStrictEqual({
        content: 'The user cannot use the model "venice/venice-gemini-3-pro". '
          + 'Use model_list to find the full ids of the models that the user can use.',
        isError: true,
      })
    })

    it('stops waiting for the model check when the user stops the reply', async () => {
      // A server that never answers.
      refreshCheck = () => new Promise(() => {})
      const abort = new AbortController()
      const result = sbp('dez.controller/tools/run', { name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } }, abort.signal) as Promise<ToolRunResult>
      await vi.waitFor(() => expect(refreshes).toHaveLength(1))

      abort.abort()

      expect((await result).isError).toBe(true)
      // A stop is not a failure.
      expect(consoleError).not.toHaveBeenCalled()
    })

    describe('for a model with parameters', () => {
      const VIDEO: ModelInfo = {
        id: 'wan',
        name: 'Wan',
        provider: 'venice',
        request: 'video',
        parameters: [
          { name: 'duration', label: 'Length', options: ['4s', '8s', '12s'], default: '4s' },
          { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
          { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'], default: '16:9' },
        ],
      }
      const entry = { id: 'wan' }
      const mediaEntry = { id: 'wan', pricing_skus: { per_second: '2' } }
      const info = (call: Record<string, string> = {}) => run({ name: 'model_info', arguments: { model: 'venice/wan', ...call } })
      const facts = (values: Record<string, string>, more: ModelInfoFacts = {}): ModelInfoFacts =>
        ({ entry, values, toggles: [], inputImages: inputImageRules, mediaEntry, ...more })

      beforeEach(() => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', {
          ok: true,
          models: [VIDEO],
          entries: new Map([['wan', entry]]),
          mediaEntries: new Map([['wan', mediaEntry]]),
        })
        // The user's choice in the provider settings popup.
        sbp('dez.model/settings/setModelParameter', { providerId: 'venice', modelId: 'wan' }, 'duration', '8s')
        sbp('dez.model/settings/setModelParameter', { providerId: 'venice', modelId: 'wan' }, 'resolution', '720p')
        // No toggle applies to a media model.
        descriptor = { name: 'Venice', thinking: false, tools: false, settings: [] }
        inputImageRules = { size: { minShortSide: 256 } }
      })

      it('gives the values that a request sends now, their price, and the entry of the media list', async () => {
        const values = { duration: '8s', resolution: '720p', aspect_ratio: '16:9' }

        expect(await info()).toStrictEqual({
          content: modelInfoText(providers[0], VIDEO, facts(values, { cost: { usd: 0.07 } })),
          isError: false,
        })
        expect(quotes).toStrictEqual([{ providerId: 'venice', modelId: 'wan', kind: 'video', parameters: values }])
      })

      it('lets a value of the call win over the user\'s value, for this call only', async () => {
        const values = { duration: '12s', resolution: '720p', aspect_ratio: '1:1' }

        expect((await info({ parameters: '{"duration": "12s", "aspect_ratio": "1:1"}' })).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts(values, { cost: { usd: 0.07 } })))
        expect(quotes.map(({ parameters }) => parameters)).toStrictEqual([values])
        expect(sbp('dez.model/settings/snapshot').modelParameters).toStrictEqual({ 'venice/wan': { duration: '8s', resolution: '720p' } })
      })

      it('gives an error result, and asks for no price, for a value that the model does not take', async () => {
        expect(await info({ parameters: '{"duration": "5s"}' })).toStrictEqual({
          content: 'The parameter "duration" takes one of: "4s", "8s", "12s".',
          isError: true,
        })
        expect(quotes).toStrictEqual([])
      })

      it('gives no price where the provider has no price request', async () => {
        quoteAnswer = async () => null

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts({ duration: '8s', resolution: '720p', aspect_ratio: '16:9' })))
      })

      it('gives the price records of a provider that tells no one price', async () => {
        const records = [{ billable_type: 'output_image', cost: 0.04 }, { billable_type: 'output_image', cost: 0.08, variant: '4k' }]
        quoteAnswer = async () => ({ records })

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts({ duration: '8s', resolution: '720p', aspect_ratio: '16:9' }, { priceEntry: records })))
      })

      it('gives the known limits of the model', async () => {
        const limits: KnownLimit[] = [{ text: 'Takes at most 2 images.', source: 'A test', limit: { maxImages: 2 } }]
        knownLimits = { 'venice/wan': limits }

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts({ duration: '8s', resolution: '720p', aspect_ratio: '16:9' }, { cost: { usd: 0.07 }, limits })))
      })

      it('gives the part that the call names, and asks for no price for a part that it does not know', async () => {
        expect(await info({ part: 'mediaEntry' })).toStrictEqual({
          content: JSON.stringify({ id: 'venice/wan', mediaEntry }, null, 2),
          isError: false,
        })
        expect(await info({ part: 'dez' })).toStrictEqual({
          content: '"dez" is not an entry of a model_info result. Use one of: providerEntry, mediaEntry, priceEntry.',
          isError: true,
        })
        expect(quotes).toHaveLength(1)
      })

      // The provider's text can echo details of the user's account.
      it('still gives the model when the price request fails, without the provider\'s error text', async () => {
        quoteAnswer = async () => { throw new Error('Venice returned HTTP 402: account u-123 has no funds') }

        const result = await info()

        expect(result.isError).toBe(false)
        expect(result.content).not.toContain('u-123')
        expect(JSON.parse(result.content).dez.cost).toStrictEqual({ error: expect.any(String) })
        expect(consoleError).toHaveBeenCalledOnce()
      })

      it('stops waiting for the price when the user stops the reply', async () => {
        quoteAnswer = () => new Promise(() => {})
        const abort = new AbortController()
        const result = sbp('dez.controller/tools/run', { name: 'model_info', arguments: { model: 'venice/wan' } }, abort.signal) as Promise<ToolRunResult>
        await vi.waitFor(() => expect(quotes).toHaveLength(1))

        abort.abort()

        expect((await result).isError).toBe(true)
        expect(consoleError).not.toHaveBeenCalled()
      })

      it('asks for no price after the user stopped the reply', async () => {
        // A stop while the runner looked up the model, before the price request.
        const abort = new AbortController()
        abort.abort()

        const result = await sbp('dez.controller/tools/run', { name: 'model_info', arguments: { model: 'venice/wan' } }, abort.signal) as ToolRunResult

        expect(result.isError).toBe(true)
        expect(quotes).toStrictEqual([])
      })
    })

    it('asks for no price of a chat model', async () => {
      await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })

      expect(quotes).toStrictEqual([])
    })

    it('gives each toggle that applies with the user\'s value, else its default', async () => {
      sbp('dez.model/settings/setProviderSetting', 'venice', 'tools', false)
      sbp('dez.model/settings/setProviderSetting', 'venice', 'xSearch', false)
      const result = JSON.parse((await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } })).content) as { dez: { toggles: unknown } }

      expect(result.dez.toggles).toStrictEqual([
        { key: 'thinking', label: 'Thinking', on: true },
        { key: 'tools', label: 'Tools', on: false },
        { key: 'webSearch', label: 'Web search', on: true },
      ])
    })
  })

  describe('image', () => {
    const stored = (name: string) => `/home/u/.config/dez/assets/images/${name}`
    const WHOLE = { x: 0, y: 0, width: 1000, height: 500 }
    // The paths that the reply got an image for, and the id that it gives.
    let written: string[] = []
    let newImageId: string | null
    let tabId: string

    function image(command: string, parameters: Record<string, unknown>, signal = new AbortController().signal): Promise<ToolRunResult> {
      const context: ToolRunContext = {
        tabId,
        writeImage: (path) => {
          written.push(path)
          return newImageId
        },
        writeClip: () => null,
      }
      const args = { command, parameters: JSON.stringify(parameters) }
      return sbp('dez.controller/tools/run', { name: 'image', arguments: args }, signal, context) as Promise<ToolRunResult>
    }

    beforeEach(() => {
      written = []
      newImageId = 'c'
      tabId = sbp('dez.model/tabs/activeId') as string
      sbp('dez.model/tabs/replaceSections', tabId, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${stored('fox.png')}](id=a) and a photo: ![${stored('photo.jpg')}](id=b)` }] },
        { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }] },
      ])
    })

    it('crops: draws the part at its own size, saves it as a generated image, and gives the reply its file', async () => {
      expect(await image('crop', { image: '@a', x: 100, y: 50, width: 200, height: 80 })).toStrictEqual({
        content: 'Made the image @c from @a. The image @c is 200x80 pixels.',
        isError: false,
      })

      expect(readImages).toStrictEqual([stored('fox.png')])
      expect(drawings).toStrictEqual([{ drawing: { crop: { x: 100, y: 50, width: 200, height: 80 }, width: 200, height: 80 }, mediaType: 'image/png' }])
      expect(savedImages).toStrictEqual([{ mediaType: 'image/png', options: { folder: 'generated' } }])
      expect(written).toStrictEqual([MADE_IMAGE])
      expect(deletedImages).toStrictEqual([])
    })

    it('scales: draws the whole image at the new size', async () => {
      expect(await image('scale', { image: 'a', width: 100 })).toStrictEqual({
        content: 'Made the image @c from @a. The image @c is 100x50 pixels.',
        isError: false,
      })

      expect(drawings).toStrictEqual([{ drawing: { crop: WHOLE, width: 100, height: 50 }, mediaType: 'image/png' }])
      expect(written).toStrictEqual([MADE_IMAGE])
    })

    // A photo as a PNG is some times larger.
    it('keeps a JPEG a JPEG', async () => {
      await image('scale', { image: 'b', width: 500 })

      expect(readImages).toStrictEqual([stored('photo.jpg')])
      expect(drawings.map(({ mediaType }) => mediaType)).toStrictEqual(['image/jpeg'])
      expect(savedImages.map(({ mediaType }) => mediaType)).toStrictEqual(['image/jpeg'])
    })

    // A JPEG has no transparent pixels: the blank corners would be black.
    it('saves a turned JPEG as a PNG when its blank corners are transparent, and as a JPEG when they are painted or when there are none', async () => {
      await image('rotate', { image: 'b', angle: 45 })
      await image('rotate', { image: 'b', angle: 45, fill: 'white' })
      await image('rotate', { image: 'b', angle: 90 })

      expect(drawings.map(({ drawing }) => drawing.mediaType)).toStrictEqual(['image/png', undefined, undefined])
      expect(savedImages.map(({ mediaType }) => mediaType)).toStrictEqual(['image/png', 'image/jpeg', 'image/jpeg'])
    })

    it('converts: saves the new image as the format of the call, and refuses the format of the image itself', async () => {
      expect(await image('convert', { image: 'b', format: 'svg' })).toStrictEqual({ content: 'Made the image @c from @b. The image @c is 1000x500 pixels.', isError: false })
      expect(await image('convert', { image: 'b', format: 'jpg' })).toMatchObject({ content: expect.stringMatching(/^The image @b is already in the JPEG format/), isError: true })

      expect(savedImages).toStrictEqual([{ mediaType: 'image/svg+xml', options: { folder: 'generated' } }])
    })

    it('tells that this computer cannot make the format when the webview does not write it, and that the call is not at fault', async () => {
      redrawError = new UnwritableImageTypeError('image/webp')

      expect(await image('convert', { image: 'a', format: 'webp' })).toStrictEqual({
        content: 'Dez cannot make WebP images on this computer: its web view does not write them. This is not a fault of the call, and there is no new image from @a. '
          + 'If another format will do for the user, call convert with "jpeg"; else tell the user that this computer cannot make WebP images.',
        isError: true,
      })
      expect(savedImages).toStrictEqual([])
    })

    it('makes no image for a call with only the image, and gives the size of the image', async () => {
      expect(await image('crop', { image: 'a' })).toStrictEqual({
        content: 'The image @a is 1000x500 pixels. Give x, y, width, and height to make a new image from a part of it.',
        isError: false,
      })

      expect(savedImages).toStrictEqual([])
      expect(written).toStrictEqual([])
    })

    it('gives an error result for an id that no image of the tab has, with the ids of its images, and reads no file', async () => {
      expect(await image('scale', { image: '@z', width: 10 })).toStrictEqual({
        content: 'No image of this conversation has the id @z. Its images are @a, @b: call again with one of these ids.',
        isError: true,
      })

      expect(readImages).toStrictEqual([])
    })

    it('gives the error of a part that is not inside the image, and saves nothing', async () => {
      expect(await image('crop', { image: 'a', x: 900, y: 0, width: 200, height: 100 })).toStrictEqual({
        content: 'The crop (x 900, y 0, 200x100 pixels) is not inside the image @a, which is 1000x500 pixels. '
          + 'A crop inside it has x and y of 0 or more, x + width of 1000 or less, and y + height of 500 or less. '
          + 'The nearest such crop is x 800, y 0, width 200, height 100.',
        isError: true,
      })

      expect(savedImages).toStrictEqual([])
    })

    // An error result goes to the chat provider.
    it.each([
      ['the file cannot be read', () => {
        readImage = async () => { throw new Error(`Failed to read ${stored('fox.png')}: HTTP 404`) }
      }, 'Dez cannot read the file of the image @a: the file is gone, or Dez may not read it. '
        + 'This is not a fault of the call. Tell the user, who can paste the image again (it then gets a new id).'],
      ['the save fails', () => {
        saveImage = async () => { throw new Error('The Dez folder /home/u/.config/dez cannot hold images') }
      }, 'Dez could not save the new image, so there is no new image. This is not a fault of the call, and Dez showed the user the cause. '
        + 'Tell the user that the image was not made, and call the image tool again only when the user asks for it.'],
    ])('gives an error result with no path when %s', async (_case, fail, content) => {
      fail()

      expect(await image('scale', { image: 'a', width: 10 })).toStrictEqual({ content, isError: true })
      expect(written).toStrictEqual([])
    })

    it('tells that a failed drawing is not the fault of the call, with the reason of the webview', async () => {
      redrawError = new Error('The image cannot be decoded.')

      expect(await image('scale', { image: 'a', width: 10 })).toStrictEqual({
        content: 'Dez could not draw a new image from @a. This is not a fault of the call. Tell the user, and do not call the image tool again for @a.'
          + '\n\nDetails: The image cannot be decoded.',
        isError: true,
      })
      expect(savedImages).toStrictEqual([])
    })

    it('deletes the new file when the reply takes no image any more', async () => {
      newImageId = null

      expect(await image('scale', { image: 'a', width: 10 })).toStrictEqual({
        content: 'The reply stopped before Dez could add the new image to it, so there is no new image. This is not a fault of the call. '
          + 'Call the image tool again only when the user asks for the image again.',
        isError: true,
      })
      expect(deletedImages).toStrictEqual([MADE_IMAGE])
    })

    it('saves no image after the user stopped the reply', async () => {
      const abort = new AbortController()
      readImage = async () => {
        abort.abort()
        return new Blob([])
      }

      expect((await image('scale', { image: 'a', width: 10 }, abort.signal)).isError).toBe(true)
      expect(savedImages).toStrictEqual([])
    })
  })

  describe('audio clip', () => {
    const song = '/home/u/.config/dez/assets/generated/audio/song.mp3'
    // The clips that the reply got a tag for, and the id that it gives.
    let written: unknown[] = []
    let newClipId: string | null
    let tabId: string

    function clip(parameters: Record<string, unknown>, signal = new AbortController().signal): Promise<ToolRunResult> {
      const context: ToolRunContext = {
        tabId,
        writeImage: () => null,
        writeClip: (data) => {
          written.push(data)
          return newClipId
        },
      }
      const args = { command: 'clip', parameters: JSON.stringify(parameters) }
      return sbp('dez.controller/tools/run', { name: 'audio', arguments: args }, signal, context) as Promise<ToolRunResult>
    }

    beforeEach(() => {
      written = []
      newClipId = 'c'
      tabId = sbp('dez.model/tabs/activeId') as string
      sbp('dez.model/tabs/replaceSections', tabId, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'A song.' }] },
        { id: 'a1', role: 'agent', content: [{ kind: 'text', text: `<dez:audio id="b" type="audio/mpeg" src="${song}"/>` }] },
        { id: 'u2', role: 'user', content: [{ kind: 'text', text: 'Cut it.' }] },
        { id: 'a2', role: 'agent', content: [{ kind: 'text', text: '' }] },
      ])
    })

    it('cuts the part into a WAV clip, saves it at once, and gives the reply its tag', async () => {
      expect(await clip({ clip: '@b', start: 1, end: 3.5 })).toStrictEqual({
        content: 'Made the audio clip @c from @b, from second 1 to second 3.5. The audio clip @c is 2.5 seconds long.',
        isError: false,
      })

      expect(readClips).toStrictEqual([song])
      const wav = { kind: 'audio', type: 'audio/wav', src: null, url: null, expires: null }
      expect(savedClips).toStrictEqual([{ clip: wav, options: { bytes: CUT_BYTES } }])
      expect(written).toStrictEqual([{ ...wav, src: MADE_CLIP }])
      expect(deletedClips).toStrictEqual([])
    })

    it('ends the part at the end of the clip for an end past it', async () => {
      expect((await clip({ clip: 'b', start: 8, end: 60 })).content).toBe('Made the audio clip @c from @b, from second 8 to second 10. The audio clip @c is 2 seconds long.')
    })

    it('makes no clip for a call with only the clip, and gives the length of the clip', async () => {
      clipDuration = 12.3456

      expect(await clip({ clip: 'b' })).toStrictEqual({
        content: 'The audio clip @b is 12.35 seconds long. Give a start, an end, or both to make a new clip from a part of it.',
        isError: false,
      })
      expect(savedClips).toStrictEqual([])
      expect(written).toStrictEqual([])
    })

    it('gives the error of a part that is not in the clip, and saves nothing', async () => {
      expect(await clip({ clip: 'b', start: 12 })).toStrictEqual({
        content: 'The audio clip @b is 10 seconds long, so "start" must be less than 10.',
        isError: true,
      })
      expect(savedClips).toStrictEqual([])
    })

    // An error result goes to the chat provider: no path, no URL.
    it.each([
      [new ClipReadError('deleted'), 'The audio clip @b is gone: the user deleted its file, and it has no web address to download it from. '
        + 'This is not a fault of the call. Tell the user, and do not call the audio tool again for @b.'],
      [new ClipReadError('expired', 'The server of the clip answered HTTP 403.'), 'The audio clip @b has expired: the provider that made it does not keep it any more, and the user did not save it. '
        + 'This is not a fault of the call. Tell the user, and do not call the audio tool again for @b.\n\nDetails: The server of the clip answered HTTP 403.'],
      [new ClipReadError('unreadable', 'The file cannot be read (HTTP 404).'), 'Dez could not read the audio clip @b: its file is gone, Dez may not read it, or its server did not send it (the details tell which). '
        + 'This is not a fault of the call. Tell the user, and call the audio tool again for @b only when the user asks for it.\n\nDetails: The file cannot be read (HTTP 404).'],
    ])('gives an error result for a clip that cannot be read (%s)', async (error, content) => {
      readClip = async () => {
        throw error
      }

      expect(await clip({ clip: 'b', end: 5 })).toStrictEqual({ content, isError: true })
      expect(savedClips).toStrictEqual([])
      expect(consoleError).toHaveBeenCalledWith('The tool audio failed:', expect.objectContaining({ cause: error }))
    })

    it('tells that a failed decode is not the fault of the call, with the reason of the webview', async () => {
      cutError = new Error('The audio cannot be decoded.')

      expect(await clip({ clip: 'b', end: 5 })).toStrictEqual({
        content: 'Dez could not decode the audio clip @b (audio/mpeg): this computer has no decoder for its file type, or the file is broken. '
          + 'This is not a fault of the call. Tell the user, and do not call the audio tool again for @b.\n\nDetails: The audio cannot be decoded.',
        isError: true,
      })
      expect(savedClips).toStrictEqual([])
    })

    it('gives an error result with no path when the save fails', async () => {
      saveClip = async () => {
        throw new Error(`Failed to write ${MADE_CLIP}`)
      }

      expect(await clip({ clip: 'b', end: 5 })).toStrictEqual({
        content: 'Dez could not save the new audio clip, so there is no new clip. This is not a fault of the call, and Dez showed the user the cause. '
          + 'Tell the user that the clip was not made, and call the audio tool again only when the user asks for it.',
        isError: true,
      })
      expect(written).toStrictEqual([])
    })

    it('deletes the new file when the reply takes no clip any more', async () => {
      newClipId = null

      expect(await clip({ clip: 'b', end: 5 })).toStrictEqual({
        content: 'The reply stopped before Dez could add the new audio clip to it, so there is no new clip. This is not a fault of the call. '
          + 'Call the audio tool again only when the user asks for the clip again.',
        isError: true,
      })
      expect(deletedClips).toStrictEqual([MADE_CLIP])
    })

    it('ends at once and saves no clip when the user stops the reply during the read', async () => {
      const abort = new AbortController()
      readClip = () => {
        abort.abort()
        return new Promise<Blob>(() => {})
      }

      expect((await clip({ clip: 'b', end: 5 }, abort.signal)).isError).toBe(true)
      expect(savedClips).toStrictEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    })
  })
})
