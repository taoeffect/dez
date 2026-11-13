import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AudioPart, CutAudio } from '../model/chat/audioCut'
import { UnwritableImageTypeError, type DrawnImage, type DrawnMediaType, type ImageDrawing, type ImageSize } from '../model/chat/imageDrawing'
import { ClipReadError } from '../model/chat/mediaFiles'
import { mediaTagText, type MediaTagData } from '../model/chat/mediaTags'
import type { ModelRef, Tab } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import { TooManyImagesError } from '../model/providers/clipImages'
import { InputImageError } from '../model/providers/errors'
import type { KnownLimit } from '../model/providers/knownLimits'
import type { ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderMediaQuote, ProviderMediaQuoteInput, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers/streamTypes'
import { providerInfo } from '../model/providers/testing'
import type { ModelInfo, ProviderInfo, ProviderInputImageRules, ProviderSettingsDescriptor } from '../model/providers/types'
import { NO_JOBS_TEXT, NO_OPEN_JOBS_TEXT, startedJobId } from '../model/tools/jobs'
import { modelInfoText, type ModelInfoFacts } from '../model/tools/modelInfo'
import { IMAGE_NOT_SAVED_TEXT, INVOCATION_TEXT_CAP, invocationAnswerStateText, invocationAnswerText, modelInvocation } from '../model/tools/modelInvoke'
import { TOOL_DEFINITIONS, unexpectedToolErrorText, unknownToolText } from '../model/tools/registry'
import type { ToolArguments, ToolRunResult } from '../model/tools/types'
import { ExplainedError } from '../utils/errorText'
import { ReplyJobs, type JobOutcome } from './jobs'
import { invokeModel } from './modelInvoke'
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
// The stub media API of `model_invoke`: each request, what the provider
// answers to one, and the temp copies of clips that were deleted (files of
// the cache root). Set in beforeEach and by the tests.
let mediaRequests: ProviderGenerateMediaInput[] = []
let generateMedia: (input: ProviderGenerateMediaInput) => Promise<ProviderGenerateMediaResult>
let deletedTempCopies: string[] = []
// The stub chat API of `model_invoke`: each request, what the provider
// does with one (it calls the callbacks of the request, as the answer
// comes), and the ids of the requests that were cancelled. Set in
// beforeEach and by the tests.
let chatRequests: ProviderStreamChatInput[] = []
let streamChat: (input: ProviderStreamChatInput) => Promise<void>
let cancelledRequests: string[] = []

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
  async 'dez.provider/generateMedia' (input: ProviderGenerateMediaInput): Promise<ProviderGenerateMediaResult> {
    mediaRequests.push(input)
    return await generateMedia(input)
  },
  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    chatRequests.push(input)
    await streamChat(input)
    return { requestId: input.requestId ?? '' }
  },
  async 'dez.http/cancelStream' (requestId: string): Promise<void> {
    cancelledRequests.push(requestId)
  },
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? '/home/u/.cache/dez' : '/home/u/.config/dez'
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app'): Promise<void> {
    if (root === 'cache') deletedTempCopies.push(path)
  },
})

// The model of the reply that makes the calls: not the model that most
// calls name, so that a result tells which of the two the tool read.
const REPLY_MODEL: ModelRef = { providerId: 'venice', modelId: 'venice-glm-5' }

// Runs a call of a reply of `model` that takes no image and no clip, and
// has no job.
function run(call: ToolRunCall, { signal = new AbortController().signal, model = REPLY_MODEL } = {}): Promise<ToolRunResult> {
  const context: ToolRunContext = { tabId: '', model, jobs: new ReplyJobs(), writeImage: () => null, writeClip: () => null }
  return sbp('dez.controller/tools/run', call, signal, context) as Promise<ToolRunResult>
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
  mediaRequests = []
  generateMedia = async () => ({ media: [], clips: [] })
  deletedTempCopies = []
  chatRequests = []
  streamChat = async () => {}
  cancelledRequests = []
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
    expect(await run({ name: 'toString', arguments: {} })).toStrictEqual({ content: unknownToolText('toString'), isError: true })
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

    it('gives the model of the reply for a call with no `model`', async () => {
      expect(await run({ name: 'model_info', arguments: {} })).toStrictEqual({
        content: modelInfoText(providers[0], MODELS('venice')[1], { entry: { id: 'venice-glm-5', checked: true }, values: {}, toggles, inputImages: {} }),
        isError: false,
      })
      expect(await run({ name: 'model_info', arguments: { part: 'providerEntry' } })).toStrictEqual({
        content: JSON.stringify({ id: 'venice/venice-glm-5', providerEntry: { id: 'venice-glm-5', checked: true } }, null, 2),
        isError: false,
      })
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
      const result = run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro' } }, { signal: abort.signal })
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

      it('takes the values of a call with no `model` for the model of the reply', async () => {
        const values = { duration: '12s', resolution: '720p', aspect_ratio: '16:9' }

        expect((await run({ name: 'model_info', arguments: { parameters: '{"duration": "12s"}' } }, { model: { providerId: 'venice', modelId: 'wan' } })).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts(values, { cost: { usd: 0.07 } })))
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
        const result = run({ name: 'model_info', arguments: { model: 'venice/wan' } }, { signal: abort.signal })
        await vi.waitFor(() => expect(quotes).toHaveLength(1))

        abort.abort()

        expect((await result).isError).toBe(true)
        expect(consoleError).not.toHaveBeenCalled()
      })

      it('asks for no price after the user stopped the reply', async () => {
        // A stop while the runner looked up the model, before the price request.
        const abort = new AbortController()
        abort.abort()

        const result = await run({ name: 'model_info', arguments: { model: 'venice/wan' } }, { signal: abort.signal })

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
        model: REPLY_MODEL,
        jobs: new ReplyJobs(),
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
      }, 'Dez cannot read the file of the image @a: the file is gone or moved, or Dez may not read it. '
        + 'This is not a fault of the call. Tell the user, who can paste or drop the image again (it then gets a new id).'],
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
        model: REPLY_MODEL,
        jobs: new ReplyJobs(),
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

  describe('the job tools', () => {
    const IMAGE = '/home/u/.config/dez/assets/generated/images/job.png'
    const SONG = '/home/u/.config/dez/assets/generated/audio/job.mp3'
    const LONG = { timeoutMs: 600_000 }
    let jobs: ReplyJobs
    // The tab of the calls; none for the tools that read no conversation.
    let tabId: string
    // What the reply got, each with the tool that its text names, and the
    // ids that it gives (null: the reply takes no asset).
    let written: unknown[] = []
    let newIds: (string | null)[]

    function jobTool(name: string, args: ToolArguments = {}, signal = new AbortController().signal): Promise<ToolRunResult> {
      const context: ToolRunContext = {
        tabId,
        model: REPLY_MODEL,
        jobs,
        writeImage: (path, options) => {
          written.push({ path, ...options })
          return newIds.shift() ?? null
        },
        writeClip: (clip, options) => {
          written.push({ path: clip.src, ...options })
          return newIds.shift() ?? null
        },
      }
      return sbp('dez.controller/tools/run', { name, arguments: args }, signal, context) as Promise<ToolRunResult>
    }

    // A work that ends when its test calls `finish`.
    function heldWork(): { work: () => Promise<JobOutcome>, finish: (outcome: JobOutcome) => void } {
      let finish!: (outcome: JobOutcome) => void
      const done = new Promise<JobOutcome>((resolve) => { finish = resolve })
      return { work: () => done, finish }
    }

    beforeEach(() => {
      jobs = new ReplyJobs()
      tabId = ''
      written = []
      newIds = ['c', 'd', 'e']
    })

    // Ends the time limits of the jobs that a test left.
    afterEach(() => jobs.stopAll())

    it('jobs_wait waits for the next job end, gives each result once with its job id and status, and tells how many jobs still run', async () => {
      const slow = heldWork()
      const made = jobs.start('model_invoke', async () => ({ text: 'A red square.', isError: false, assets: [] }), LONG)
      const refused = jobs.start('video', async () => ({ text: 'The provider refused the request.', isError: true, assets: [] }), LONG)
      const last = jobs.start('model_invoke', slow.work, LONG)

      // Also a job that failed gives no error result: the result holds the
      // results of other jobs too.
      expect(await jobTool('jobs_wait')).toStrictEqual({
        content: '2 jobs ended. 1 job still runs: call jobs_wait again to get its result.\n\n'
          + `<job id="${made}" tool="model_invoke" status="finished">\nA red square.\n</job>\n\n`
          + `<job id="${refused}" tool="video" status="failed">\nThe provider refused the request.\n</job>`,
        isError: false,
      })

      const wait = jobTool('jobs_wait')
      slow.finish({ text: 'Done.', isError: false, assets: [] })
      expect(await wait).toStrictEqual({
        content: `1 job ended. No job still runs.\n\n<job id="${last}" tool="model_invoke" status="finished">\nDone.\n</job>`,
        isError: false,
      })
      expect(await jobTool('jobs_wait')).toStrictEqual({ content: NO_OPEN_JOBS_TEXT, isError: false })
    })

    it('jobs_wait puts what a job made into the reply under the name of the job\'s tool, and its result names the new ids', async () => {
      const id = jobs.start('model_invoke', async () => ({
        text: '',
        isError: false,
        assets: [{ kind: 'image', path: IMAGE }, { kind: 'clip', clip: { kind: 'audio', type: 'audio/mpeg', src: SONG, url: null, expires: null } }],
      }), LONG)

      expect((await jobTool('jobs_wait')).content).toBe(
        `1 job ended. No job still runs.\n\n<job id="${id}" tool="model_invoke" status="finished">\nMade the image @c.\nMade the audio clip @d.\n</job>`,
      )
      expect(written).toStrictEqual([{ path: IMAGE, tool: 'model_invoke' }, { path: SONG, tool: 'model_invoke' }])
      expect(deletedImages).toStrictEqual([])
      expect(deletedClips).toStrictEqual([])
    })

    it('jobs_wait deletes the file of a job when the reply takes no image any more, and says so', async () => {
      newIds = []
      jobs.start('model_invoke', async () => ({ text: '', isError: false, assets: [{ kind: 'image', path: IMAGE }] }), LONG)

      expect((await jobTool('jobs_wait')).content).toContain('The reply stopped before Dez could add the image of this job to it, so there is no new image.')
      expect(deletedImages).toStrictEqual([IMAGE])
    })

    it('jobs_wait ends at once when the user stops the reply, and keeps the result of the job for a later reader', async () => {
      const slow = heldWork()
      const id = jobs.start('model_invoke', slow.work, LONG)
      const abort = new AbortController()
      const wait = jobTool('jobs_wait', {}, abort.signal)

      abort.abort()

      expect((await wait).isError).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
      slow.finish({ text: 'Done.', isError: false, assets: [] })
      expect((await jobs.settle()).map((job) => job.id)).toStrictEqual([id])
    })

    it('jobs_list lists the jobs of the reply and does not wait', async () => {
      expect(await jobTool('jobs_list')).toStrictEqual({ content: NO_JOBS_TEXT, isError: false })

      const running = jobs.start('model_invoke', heldWork().work, LONG)
      const ended = jobs.start('video', async () => ({ text: 'Done.', isError: false, assets: [] }), LONG)
      await jobTool('jobs_wait')

      const { content, isError } = await jobTool('jobs_list')
      expect(isError).toBe(false)
      expect(content.split('\n').slice(1)).toStrictEqual([
        `${running} | model_invoke | running | - | 0`,
        `${ended} | video | finished | given | 0`,
      ])
    })

    it('job_inspect tells the status and the last state of the job that the call names', async () => {
      const id = jobs.start('model_invoke', async (_signal, report) => {
        report('Queued at the provider as job q-7.')
        return await new Promise<JobOutcome>(() => {})
      }, LONG)

      expect(await jobTool('job_inspect', { job_id: ` ${id}\n` })).toStrictEqual({
        content: `The job ${id} (model_invoke) runs, for 0 seconds so far. Call jobs_wait to wait for its result.\nState: Queued at the provider as job q-7.`,
        isError: false,
      })
    })

    it('job_inspect gives an error result that names the jobs of the reply for an id that none of them has', async () => {
      const id = jobs.start('model_invoke', heldWork().work, LONG)
      // An id that no job can have: a job id has 4 characters after `j-`.
      expect(await jobTool('job_inspect', { job_id: 'j-none-1' })).toStrictEqual({
        content: `This reply has no job with the id "j-none-1". A job of an earlier reply ended with that reply. The jobs of this reply are ${id}: call job_inspect again with one of these ids.`,
        isError: true,
      })
    })

    describe('model_invoke', () => {
      const PAINTER: ModelInfo = { id: 'painter', name: 'Painter', provider: 'venice', outputs: ['image'], request: 'image', images: { maxImages: 2 } }
      const FILMER: ModelInfo = { id: 'filmer', name: 'Filmer', provider: 'venice', outputs: ['video'], request: 'video' }
      const SCRIBE: ModelInfo = { id: 'scribe', name: 'Scribe', provider: 'venice', outputs: ['text'], request: 'transcription', clips: { audio: { use: 'source', maxClips: 1 } } }
      // A text model that makes images too.
      const SKETCHER: ModelInfo = { id: 'sketcher', name: 'Sketcher', provider: 'venice', outputs: ['text', 'image'] }
      const FOX = '/home/u/.config/dez/assets/images/fox.png'
      // A linked file: its name is private.
      const LINKED = '/home/u/Pictures/private-name.png'
      const SPEECH: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.config/dez/assets/audio/speech.mp3', url: null, expires: null, other: [] }
      const TEMP_COPY = '/home/u/.cache/dez/media/made.mp4'
      const MADE_VIDEO = { kind: 'video', mediaType: 'video/mp4', src: TEMP_COPY, url: null, expires: '2026-12-01T00:00:00.000Z', jobId: 'q-17' } as const
      const PNG = { bytes: new Uint8Array([1]), mediaType: 'image/png' } as const
      const PAINT = { model: 'venice/painter', prompt: 'The fox of @a in snow.' }
      const FILM = { model: 'venice/filmer', prompt: 'A fox runs.' }
      // Calls to text models: the first one names the model of the reply
      // itself, which a model may invoke too.
      const ASK = { model: 'venice/venice-glm-5', prompt: 'What does @a show?' }
      const SKETCH = { model: 'venice/sketcher', prompt: 'Draw a fox.' }

      // A request that the provider answers when its test calls `answer`.
      // It reports the provider's job id first.
      function heldRequest(): { answer: (result: ProviderGenerateMediaResult) => void } {
        let answer!: (result: ProviderGenerateMediaResult) => void
        const result = new Promise<ProviderGenerateMediaResult>((resolve) => { answer = resolve })
        generateMedia = (input) => {
          input.onProgress?.({ phase: 'queued', jobId: 'q-17' })
          return result
        }
        return { answer: (value) => answer(value) }
      }

      // The result of the one job of the reply, as `jobs_wait` gives it.
      async function jobResult(): Promise<string> {
        return (await jobTool('jobs_wait')).content
      }

      // The request of a call in the tab of the calls, for a test that
      // runs the work with no job.
      function invocationOf(args: ToolArguments) {
        return modelInvocation(args, {
          cache: sbp('dez.model/modelCache/snapshot') as ModelCache,
          providers,
          modelParameters: {},
          providerSettings: {},
          sections: (sbp('dez.model/tab', tabId) as Tab).sections,
        })
      }

      beforeEach(() => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [...MODELS('venice'), PAINTER, FILMER, SCRIBE, SKETCHER] })
        tabId = sbp('dez.model/tabs/activeId') as string
        sbp('dez.model/tabs/replaceSections', tabId, [
          { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${FOX}](id=a) and ![${LINKED}](id=b)\n${mediaTagText(SPEECH)}` }] },
          { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }] },
        ])
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('starts a job at once and tells the inputs that go; jobs_wait puts the image of the model into the reply', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [] })

        const started = await jobTool('model_invoke', { ...PAINT, timeout_seconds: 60 })

        const [job] = jobs.list()
        expect(started.isError).toBe(false)
        expect(startedJobId(started.content)).toBe(job.id)
        expect(started.content).toContain('the image @a')
        expect(await jobResult()).toContain(`<job id="${job.id}" tool="model_invoke" status="finished">\nMade the image @c.\n</job>`)
        expect(mediaRequests).toMatchObject([{ providerId: 'venice', modelId: 'painter', kind: 'image', images: [FOX], clips: [], reader: 'model', timeoutMs: 60_000 }])
        expect(savedImages).toStrictEqual([{ mediaType: 'image/png', options: { folder: 'generated' } }])
        expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke' }])
      })

      // The provider took the money for its job: the id must not get lost.
      it('tells the provider\'s job id while a clip is made, and keeps it on the clip', async () => {
        const request = heldRequest()
        await jobTool('model_invoke', FILM)
        const [{ id }] = jobs.list()

        expect((await jobTool('job_inspect', { job_id: id })).content).toContain('q-17')

        request.answer({ media: [], clips: [MADE_VIDEO] })
        expect(await jobResult()).toContain('Made the video clip @c.')
        expect(written).toStrictEqual([{ path: TEMP_COPY, tool: 'model_invoke', jobId: 'q-17' }])
        expect(deletedTempCopies).toStrictEqual([])
      })

      // The model reads the same texts as for any other call: only the
      // editor reads the marker.
      it('marks the clip and the image of a call with `is_intermediate` as hidden assets of its job', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [MADE_VIDEO] })

        await jobTool('model_invoke', { ...FILM, is_intermediate: true })
        const [{ id }] = jobs.list()

        expect(await jobResult()).toContain(`<job id="${id}" tool="model_invoke" status="finished">\nMade the video clip @c.\nMade the image @d.\n</job>`)
        expect(written).toStrictEqual([
          { path: TEMP_COPY, tool: 'model_invoke', hidden: id, jobId: 'q-17' },
          { path: MADE_IMAGE, tool: 'model_invoke', hidden: id },
        ])
      })

      it('hides nothing for a call whose `is_intermediate` is false', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [] })

        await jobTool('model_invoke', { ...PAINT, is_intermediate: false })
        await jobResult()

        expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke' }])
      })

      it('gives the text of a model that writes down speech as the result of the job, and writes nothing into the reply', async () => {
        generateMedia = async () => ({ media: [], clips: [], text: 'Hello there.' })

        await jobTool('model_invoke', { model: 'venice/scribe', prompt: '@c' })

        const result = await jobResult()
        expect(result).toContain('status="finished"')
        expect(result).toContain('Hello there.')
        expect(mediaRequests[0].clips?.map((clip) => clip.id)).toStrictEqual(['c'])
        expect(written).toStrictEqual([])
      })

      it.each([
        ['a model that the user cannot use', { model: 'venice/gone', prompt: 'A fox.' }],
        ['an @id that names nothing', { model: 'venice/painter', prompt: 'A fox as in @z.' }],
        ['a time limit that is too short', { ...PAINT, timeout_seconds: 5 }],
        ['a clip for a text model', { model: 'venice/venice-glm-5', prompt: 'What does @c say?' }],
        ['a text model with no prompt', { model: 'venice/venice-glm-5', prompt: ' ' }],
      ])('refuses %s at once: no job starts, and no request goes', async (_name, args) => {
        expect((await jobTool('model_invoke', args)).isError).toBe(true)
        expect(jobs.list()).toStrictEqual([])
        expect(mediaRequests).toStrictEqual([])
        expect(chatRequests).toStrictEqual([])
      })

      it('gives a refusal of the provider as the result of the job, with no local path', async () => {
        generateMedia = async () => { throw new ExplainedError('Venice refused the request: the prompt breaks its rules.', 'no file /home/alice/model.bin') }

        expect((await jobTool('model_invoke', PAINT)).isError).toBe(false)

        const result = await jobResult()
        expect(result).toContain('status="failed"')
        expect(result).toContain('Venice refused the request: the prompt breaks its rules.')
        expect(result).not.toContain('alice')
      })

      it.each(['unreadable', 'notDrawn'] as const)('names an input image that is %s by its id, never by its file', async (problem) => {
        generateMedia = async () => { throw new InputImageError(LINKED, problem, 'Dez cannot use the image private-name.png.') }

        await jobTool('model_invoke', { model: 'venice/painter', prompt: 'A fox as in @b.' })

        const result = await jobResult()
        expect(result).toContain('status="failed"')
        expect(result).toContain('the image @b')
        expect(result).not.toContain('private-name')
      })

      it('tells how many images the model takes when the provider refuses the count', async () => {
        generateMedia = async () => { throw new TooManyImagesError(1, 2) }

        await jobTool('model_invoke', { model: 'venice/painter', prompt: 'A fox as in @a and @b.' })

        const result = await jobResult()
        expect(result).toContain('status="failed"')
        expect(result).toContain('Painter takes only 1 image')
      })

      // The text of an error that Dez does not know can hold a local path.
      it('tells only that Dez did not expect an error that it does not know', async () => {
        generateMedia = async () => { throw new Error('Failed to read /home/alice/model.bin') }

        await jobTool('model_invoke', PAINT)

        const result = await jobResult()
        expect(result).toContain(unexpectedToolErrorText('model_invoke'))
        expect(result).not.toContain('alice')
      })

      it('fails the job and deletes the images that it saved when a save fails', async () => {
        generateMedia = async () => ({ media: [PNG, PNG], clips: [] })
        let saves = 0
        saveImage = async () => {
          if (++saves === 2) throw new Error('The disk is full.')
          return MADE_IMAGE
        }

        await jobTool('model_invoke', PAINT)

        expect(await jobResult()).toContain('status="failed"')
        expect(written).toStrictEqual([])
        expect(deletedImages).toStrictEqual([MADE_IMAGE])
      })

      // A cancelled request can end the body of an image early. The work
      // runs here with no job, so that the test can wait for its end.
      it('saves no image that still comes after its job ended', async () => {
        const request = heldRequest()
        const abort = new AbortController()
        const work = invokeModel(invocationOf(PAINT), abort.signal, () => {}, { toolsAllowed: false })

        abort.abort()
        request.answer({ media: [PNG], clips: [] })

        expect((await work).assets).toStrictEqual([])
        expect(savedImages).toStrictEqual([])
      })

      it('stops the request when the reply stops, and deletes the temp copy of a clip that still comes', async () => {
        const request = heldRequest()
        await jobTool('model_invoke', FILM)

        jobs.stopAll()
        request.answer({ media: [], clips: [MADE_VIDEO] })

        expect(mediaRequests[0].signal?.aborted).toBe(true)
        await vi.waitFor(() => expect(deletedTempCopies).toStrictEqual(['media/made.mp4']))
        expect(consoleError).not.toHaveBeenCalled()
      })

      it('ends the job at its time limit, stops the request, and tells the provider\'s job id', async () => {
        vi.useFakeTimers()
        heldRequest()
        await jobTool('model_invoke', { ...FILM, timeout_seconds: 10 })

        vi.advanceTimersByTime(10_000)

        const result = await jobResult()
        expect(result).toContain('status="timed out"')
        expect(result).toContain('q-17')
        expect(mediaRequests[0].signal?.aborted).toBe(true)
      })

      describe('to a text model', () => {
        // A chat request whose answer stays open after `start` until its
        // test calls `end`.
        function heldAnswer(start: (input: ProviderStreamChatInput) => void | Promise<void>): { end: () => void } {
          let end!: () => void
          const ended = new Promise<void>((resolve) => { end = resolve })
          streamChat = async (input) => {
            await start(input)
            await ended
          }
          return { end }
        }

        // The invoked model must not call a tool or invoke a model in its
        // turn, and it gets nothing of the conversation.
        it('sends one request with only the prompt and its images: no tools, no system prompt, no conversation', async () => {
          sbp('dez.model/settings/setProviderSetting', 'venice', 'webSearch', false)
          streamChat = async (input) => {
            await input.onThinking('The image shows a fox.')
            await input.onToken('A fox')
            await input.onToken(' in snow.')
          }

          const started = await jobTool('model_invoke', ASK)

          const [job] = jobs.list()
          expect(started.isError).toBe(false)
          expect(started.content).toContain('the image @a')
          expect(await jobResult()).toContain(`<job id="${job.id}" tool="model_invoke" status="finished">\n${invocationAnswerText('A fox in snow.')}\n</job>`)
          expect(chatRequests).toStrictEqual([{
            providerId: 'venice',
            modelId: 'venice-glm-5',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'What does @a' }, { type: 'image', path: FOX }, { type: 'text', text: ' show?' }] }],
            tools: [],
            imageOutput: false,
            providerSettings: { webSearch: false },
            requestId: expect.any(String),
            signal: expect.any(AbortSignal),
            onThinking: expect.any(Function),
            onToken: expect.any(Function),
            onImage: expect.any(Function),
          }])
          expect(written).toStrictEqual([])
          expect(mediaRequests).toStrictEqual([])
          expect(cancelledRequests).toStrictEqual([])
        })

        it('asks a model that makes images for them, and jobs_wait puts an image of the answer into the reply', async () => {
          streamChat = async (input) => {
            await input.onToken('Here it is.')
            await input.onImage(PNG)
          }

          await jobTool('model_invoke', SKETCH)

          expect(await jobResult()).toContain(`${invocationAnswerText('Here it is.')}\nMade the image @c.\n</job>`)
          expect(chatRequests[0].imageOutput).toBe(true)
          expect(savedImages).toStrictEqual([{ mediaType: 'image/png', options: { folder: 'generated' } }])
          expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke' }])
        })

        it('tells in the state of the job how much text came so far', async () => {
          const answer = heldAnswer((input) => input.onToken('A fox'))
          await jobTool('model_invoke', ASK)
          const [{ id }] = jobs.list()

          expect((await jobTool('job_inspect', { job_id: id })).content).toContain(invocationAnswerStateText(5))
          answer.end()
        })

        describe(`whose answer has more than ${INVOCATION_TEXT_CAP} characters`, () => {
          const tokens = ['x'.repeat(INVOCATION_TEXT_CAP), 'y', 'z']
          const cut = invocationAnswerText(tokens.join(''))

          // The user must not pay for text that the result does not hold.
          it('gives the start of the answer, and cancels the request', async () => {
            streamChat = async (input) => {
              for (const token of tokens) await input.onToken(token)
            }

            await jobTool('model_invoke', ASK)

            expect(await jobResult()).toContain(`${cut}\n</job>`)
            expect(cancelledRequests).toStrictEqual([chatRequests[0].requestId])
          })

          it('does not cancel the request of a model that makes images, whose image can still come', async () => {
            streamChat = async (input) => {
              for (const token of tokens) await input.onToken(token)
              await input.onImage(PNG)
            }

            await jobTool('model_invoke', SKETCH)

            expect(await jobResult()).toContain(`${cut}\nMade the image @c.\n</job>`)
            expect(cancelledRequests).toStrictEqual([])
          })
        })

        it('gives a refusal of the provider as the result of the job, with no local path, and deletes the images of the answer', async () => {
          streamChat = async (input) => {
            await input.onImage(PNG)
            throw new ExplainedError('Venice stopped the answer with an error.', 'no file /home/alice/model.bin')
          }

          await jobTool('model_invoke', SKETCH)

          const result = await jobResult()
          expect(result).toContain('status="failed"')
          expect(result).toContain('Venice stopped the answer with an error.')
          expect(result).not.toContain('alice')
          expect(written).toStrictEqual([])
          expect(deletedImages).toStrictEqual([MADE_IMAGE])
        })

        it('names an input image that Dez cannot read by its id, never by its file', async () => {
          streamChat = async () => { throw new InputImageError(LINKED, 'unreadable', 'Dez cannot use the image private-name.png.') }

          await jobTool('model_invoke', { model: 'venice/venice-glm-5', prompt: 'What does @b show?' })

          const result = await jobResult()
          expect(result).toContain('status="failed"')
          expect(result).toContain('the image @b')
          expect(result).not.toContain('private-name')
        })

        it('fails the job and ends the request when an image of the answer cannot be saved', async () => {
          saveImage = async () => { throw new Error('The disk is full.') }
          streamChat = async (input) => {
            await input.onToken('Here it is.')
            await input.onImage(PNG)
          }

          await jobTool('model_invoke', SKETCH)

          expect(await jobResult()).toContain(`status="failed">\n${IMAGE_NOT_SAVED_TEXT}\n</job>`)
          expect(written).toStrictEqual([])
          expect(cancelledRequests).toStrictEqual([chatRequests[0].requestId])
        })

        // A cancel after the first bytes of the answer ends it with no
        // error: what came is not the whole answer. The work runs here
        // with no job, so that the test can wait for its end.
        it('gives no text and saves no image of an answer that its job did not wait for', async () => {
          const abort = new AbortController()
          streamChat = async (input) => {
            await input.onToken('A fox')
            abort.abort()
            await input.onImage(PNG)
          }

          expect(await invokeModel(invocationOf(SKETCH), abort.signal, () => {}, { toolsAllowed: false })).toStrictEqual({ text: '', isError: false, assets: [] })
          expect(savedImages).toStrictEqual([])
        })

        it('stops the request when the reply stops, and deletes an image of the answer that it saved', async () => {
          const answer = heldAnswer((input) => input.onImage(PNG))
          await jobTool('model_invoke', SKETCH)
          await vi.waitFor(() => expect(savedImages).toHaveLength(1))

          jobs.stopAll()
          answer.end()

          expect(chatRequests[0].signal?.aborted).toBe(true)
          await vi.waitFor(() => expect(deletedImages).toStrictEqual([MADE_IMAGE]))
          expect(consoleError).not.toHaveBeenCalled()
        })

        it('ends the job at its time limit, stops the request, and tells how much text came', async () => {
          vi.useFakeTimers()
          heldAnswer((input) => input.onToken('A fox'))
          await jobTool('model_invoke', { ...ASK, timeout_seconds: 10 })

          vi.advanceTimersByTime(10_000)

          const result = await jobResult()
          expect(result).toContain('status="timed out"')
          expect(result).toContain(invocationAnswerStateText(5))
          expect(chatRequests[0].signal?.aborted).toBe(true)
        })
      })
    })
  })
})
