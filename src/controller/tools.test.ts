import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ContextSize } from '../model/chat/contextSize'
import { UnwritableImageTypeError, type ComposedImage, type DrawnImage, type DrawnMediaType, type ImageComposition, type ImageDrawing, type ImageSize } from '../model/chat/imageDrawing'
import { imageMediaType } from '../model/chat/images'
import { jpegSize } from '../model/chat/jpegSize'
import { mediaTagText, type MediaTagData } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER, shownPictureSize, type ShownPicture } from '../model/chat/shownPictures'
import { jpegHeader } from '../model/chat/testing'
import { toolBlockText } from '../model/chat/toolBlocks'
import type { ModelRef, Tab } from '../model/chat/types'
import type { ModelCache } from '../model/persistence/types'
import { TooManyImagesError } from '../model/providers/clipImages'
import { InputImageError, ProviderHttpError } from '../model/providers/errors'
import type { KnownLimit } from '../model/providers/knownLimits'
import { contextWindowOf } from '../model/providers/modelFamilies'
import { PRICE_LIFETIME_MS } from '../model/providers/modelPrices'
import type { ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderMediaQuote, ProviderMediaQuoteInput, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers/streamTypes'
import { providerInfo } from '../model/providers/testing'
import type { ModelInfo, ProviderInfo, ProviderInputImageRules, ProviderSettingsDescriptor } from '../model/providers/types'
import { NO_PICTURE_BUDGET, type PictureBudget } from '../model/streams/pictureBudget'
import { assetProbeArgs, clipNotReadFacts } from '../model/tools/assetFacts'
import { ASSET_INFO_COLUMNS } from '../model/tools/assetInfo'
import { clipChecksArgs, SCENE_CUT_FILTER } from '../model/tools/clipAnalysis'
import {
  ASSET_VIEW_TIMEOUT_MS,
  audioViewArgs,
  clipNotReadNote,
  cropOfClipText,
  cropTexts,
  cropUnderPixelText,
  gridCostNote,
  gridNotDrawnNote,
  gridNotSavedNote,
  gridTooLargeNote,
  jpegCopyNote,
  NO_VIDEO_STREAM_NOTE,
  noSoundNote,
  PICTURE_LIMIT_NOTE,
  PICTURE_NOT_DRAWN_NOTE,
  PICTURE_NOT_SAVED_NOTE,
  PICTURE_NOT_READ_NOTE,
  PICTURE_TOO_LARGE_NOTE,
  pictureCostNote,
  sheetTooLargeNote,
  soundlessPartNote,
  soundStripFailedNote,
  soundStripLayout,
  soundStripTooLargeNote,
  VIEW_FAILED_NOTE,
} from '../model/tools/assetView'
import { conversationInfoText } from '../model/tools/conversationInfo'
import { jobsListText, jobStartedText, jobsWaitResults, jobsWaitText, NO_JOBS_TEXT, NO_OPEN_JOBS_TEXT } from '../model/tools/jobs'
import { modelCost, modelInfoText, type ModelInfoFacts } from '../model/tools/modelInfo'
import { IMAGE_NOT_SAVED_TEXT, INVOCATION_TEXT_CAP, invocationAnswerStateText, invocationAnswerText, modelInvocation } from '../model/tools/modelInvoke'
import { modelListArguments, modelListText } from '../model/tools/modelList'
import { TOOL_DEFINITIONS, unexpectedToolErrorText, unknownToolText } from '../model/tools/registry'
import type { ToolArguments, ToolRunResult } from '../model/tools/types'
import { FFPROBE_TIMEOUT_MS } from '../model/tools/videoTool'
import { ExplainedError } from '../utils/errorText'
import type { RequestLogRow } from './diagnostics/requestLog'
import { ReplyJobs, type JobOutcome } from './jobs'
import { invokeModel } from './modelInvoke'
import type { BundledToolEnd } from './nativeTypes'
import { APP_DIR, audioProgress, deletedWorkFolder, ENDED, FILE_ID, heldWork, LONG, native, resetNative, running, writes } from './testing'
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
// Set to make the webview fail to decode an image, or only to draw one
// that it decoded.
let redrawError: Error | undefined
let drawError: Error | undefined
let drawings: { drawing: ImageDrawing, mediaType: string }[] = []
// The byte count of the file of each drawing, of the type that it writes.
let drawingBytes: (drawing: ImageDrawing, mediaType: DrawnMediaType) => number
// The pictures that the webview composed (the grids, and the frame sheets
// with their sound strips), with the type and the bytes of each file, and
// the byte count of the file of each composition (at least its JPEG header).
let compositions: { files: { type: string, bytes: Uint8Array }[], composition: ImageComposition }[] = []
let composedBytes: (composition: ImageComposition) => number
let savedImages: { mediaType: string, options: unknown }[] = []
let saveImage: () => Promise<string>
let deletedImages: string[] = []
// The clip files that were deleted. The native side of the `audio` tool
// (the runs of ffmpeg and their files) is the stub of testing.ts.
let deletedClips: string[] = []
// The file that the stub image store saves.
const MADE_IMAGE = '/home/u/.config/dez/assets/generated/images/new.png'
// The stub media API of `model_invoke`: each request, and what the
// provider answers to one. Set in beforeEach and by the tests.
let mediaRequests: ProviderGenerateMediaInput[] = []
let generateMedia: (input: ProviderGenerateMediaInput) => Promise<ProviderGenerateMediaResult>
// The stub chat API of `model_invoke`: each request, what the provider
// does with one (it calls the callbacks of the request, as the answer
// comes), and the ids of the requests that were cancelled. Set in
// beforeEach and by the tests.
let chatRequests: ProviderStreamChatInput[] = []
let streamChat: (input: ProviderStreamChatInput) => Promise<Pick<ProviderStreamChatResult, 'cost' | 'usage'> | void>
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
    if (drawError) throw drawError
    drawings.push({ drawing, mediaType })
    const type = drawing.mediaType ?? mediaType
    return { bytes: new Uint8Array(drawingBytes(drawing, type)).fill(7), mediaType: type, width: drawing.width, height: drawing.height }
  },
  // Plans from the sizes of the files: a JPEG (a frame sheet, a sound strip,
  // or a composed sheet with its strip) has its own size, and each other
  // file is a stored image. Every composition is a JPEG: its file is the
  // start of a JPEG of its size, filled up to `composedBytes`.
  async 'dez.controller/images/compose'<C extends ImageComposition> (files: readonly Blob[], plan: (sizes: readonly ImageSize[]) => C): Promise<ComposedImage<C>> {
    const read = await Promise.all(files.map(async (file) => ({ type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })))
    const composition = plan(read.map(({ bytes }) => jpegSize(bytes) ?? storedImageSize))
    if (drawError) throw drawError
    compositions.push({ files: read, composition })
    const header = jpegHeader(composition.width, composition.height)
    const bytes = new Uint8Array(Math.max(header.length, composedBytes(composition))).fill(7)
    bytes.set(header)
    return { drawn: { bytes, mediaType: composition.mediaType, width: composition.width, height: composition.height }, composition }
  },
  async 'dez.controller/images/save' (_bytes: Uint8Array, mediaType: string, options: unknown): Promise<string> {
    savedImages.push({ mediaType, options })
    return await saveImage()
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
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
    return { requestId: input.requestId ?? '', ...await streamChat(input) ?? {} }
  },
  async 'dez.http/cancelStream' (requestId: string): Promise<void> {
    cancelledRequests.push(requestId)
  },
})

// The model of the reply that makes the calls: not the model that most
// calls name, so that a result tells which of the two the tool read.
const REPLY_MODEL: ModelRef = { providerId: 'venice', modelId: 'venice-glm-5' }

// The picture budget of a context of a reply that shows no picture.
const NO_PICTURES: Pick<ToolRunContext, 'pictureBudget'> = { pictureBudget: async () => NO_PICTURE_BUDGET }

// Runs a call of a reply of `model` that takes no image and no clip, and
// has no job.
function run(call: ToolRunCall, { signal = new AbortController().signal, model = REPLY_MODEL } = {}): Promise<ToolRunResult> {
  const context: ToolRunContext = { tabId: '', model, jobs: new ReplyJobs(), writeImage: () => null, writeClip: () => null, ...NO_PICTURES }
  return sbp('dez.controller/tools/run', call, signal, context) as Promise<ToolRunResult>
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  resetNative()
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
  drawError = undefined
  drawings = []
  compositions = []
  composedBytes = () => 1
  drawingBytes = () => 1
  savedImages = []
  saveImage = async () => MADE_IMAGE
  deletedImages = []
  deletedClips = []
  mediaRequests = []
  generateMedia = async () => ({ media: [], clips: [] })
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
  const columns = '(full id | name | provider | type | inputs | released | price). Letters: t text, i image, a audio, v video; ? unknown, - none.'

  it('lists the cached models of the configured providers that match the filter', async () => {
    expect(await run({ name: 'model_list', arguments: { filter: 'gemini' } })).toStrictEqual({
      content: `1 model matches "gemini" ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice | ? | t,i | ? | ?`,
      isError: false,
    })
    expect(await run({ name: 'model_list', arguments: {} })).toStrictEqual({
      content: `2 models ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice | ? | t,i | ? | ?\nvenice/venice-glm-5 | GLM 5 | Venice | ? | t,i | ? | ?`,
      isError: false,
    })
    // The model checks of beforeEach are fresh.
    expect(refreshes).toStrictEqual([])
  })

  // A model check is free, and the list prices come with it.
  describe('model_list price checks', () => {
    const start = 1_800_000_000_000
    const priced: ModelInfo = { ...MODELS('venice')[0], price: { unit: 'token', input: 2, output: 12 } }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(start)
      for (const { id } of providers) {
        sbp('dez.model/modelCache/applyProviderResult', id, { ok: true, models: id === 'venice' ? [priced] : MODELS(id) })
      }
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('checks first each configured provider whose last check is older than the price lifetime', async () => {
      vi.setSystemTime(start + PRICE_LIFETIME_MS - 1)
      await run({ name: 'model_list', arguments: {} })
      expect(refreshes).toStrictEqual([])

      vi.setSystemTime(start + PRICE_LIFETIME_MS)
      const result = await run({ name: 'model_list', arguments: {} })
      // The closed provider is not configured.
      expect(refreshes).toStrictEqual([{ providerIds: ['venice'] }])
      // The check (`refreshCheck` of the outer beforeEach) gives a list with
      // no prices.
      expect(result.content).toBe(`2 models ${columns}\nvenice/venice-gemini-3-pro | Gemini 3 Pro | Venice | ? | t,i | ? | ?\nvenice/venice-glm-5 | GLM 5 | Venice | ? | t,i | ? | ?`)

      await run({ name: 'model_list', arguments: {} })
      expect(refreshes).toHaveLength(1)
    })

    // As when the check of the provider runs already.
    it('tells that the prices of a provider can be old when its check gives no new list', async () => {
      refreshCheck = async () => {}
      const now = start + PRICE_LIFETIME_MS
      vi.setSystemTime(now)

      const content = (await run({ name: 'model_list', arguments: {} })).content
      const cache = sbp('dez.model/modelCache/snapshot') as ModelCache

      expect(content).toBe(modelListText(cache, providers, modelListArguments({}), now))
      // The same list from a fresh check has no note.
      expect(content).not.toBe(modelListText(cache, providers, modelListArguments({}), start))
    })

    it('runs no check for a call with an argument value that the tool does not take', async () => {
      vi.setSystemTime(start + PRICE_LIFETIME_MS)

      expect((await run({ name: 'model_list', arguments: { sort: 'cost' } })).isError).toBe(true)
      expect(refreshes).toStrictEqual([])
    })

    it('stops waiting for the checks when the user stops the reply', async () => {
      refreshCheck = () => new Promise(() => {})
      vi.setSystemTime(start + PRICE_LIFETIME_MS)
      const abort = new AbortController()
      const result = run({ name: 'model_list', arguments: {} }, { signal: abort.signal })
      await vi.waitFor(() => expect(refreshes).toHaveLength(1))

      abort.abort()

      expect((await result).isError).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
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
    const noPrice = modelCost(providers[0], MODELS('venice')[0], null)
    const gemini = (entry: unknown) => modelInfoText(providers[0], MODELS('venice')[0], { entry, values: {}, toggles, inputImages: {}, cost: noPrice })

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
        content: modelInfoText(providers[0], MODELS('venice')[1], { entry: { id: 'venice-glm-5', checked: true }, values: {}, toggles, inputImages: {}, cost: noPrice }),
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

    // The result with `only` holds no entry of the provider, and with no
    // `cost` no price.
    it('runs no model check for a call whose `only` does not name `cost`', async () => {
      expect(JSON.parse((await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro', only: 'usage' } })).content))
        .toStrictEqual({ id: 'venice/venice-gemini-3-pro', usage: expect.any(Array) })
      expect(refreshes).toStrictEqual([])
    })

    // The list prices come with the model list.
    it('checks the provider for a call whose `only` names `cost`, when no raw entry is in memory or the last check is old', async () => {
      const start = 1_800_000_000_000
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(start)
        const call = { name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro', only: 'cost' } }

        expect(JSON.parse((await run(call)).content)).toStrictEqual({ id: 'venice/venice-gemini-3-pro', dez: { cost: noPrice } })
        expect(refreshes).toStrictEqual([{ providerIds: ['venice'], force: true }])

        vi.setSystemTime(start + PRICE_LIFETIME_MS - 1)
        await run(call)
        expect(refreshes).toHaveLength(1)

        vi.setSystemTime(start + PRICE_LIFETIME_MS)
        await run(call)
        expect(refreshes).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
    })

    // A chat model has no price request: the price is the list price.
    it('gives the list price of a chat model, with no price request', async () => {
      refreshCheck = async () => {
        sbp('dez.model/modelCache/applyProviderResult', 'venice', {
          ok: true,
          models: [{ ...MODELS('venice')[0], price: { unit: 'token', input: 2, output: 12, cachedInput: 0.2 } }],
          entries: new Map([['venice-gemini-3-pro', { id: 'venice-gemini-3-pro' }]]),
        })
      }

      expect(JSON.parse((await run({ name: 'model_info', arguments: { model: 'venice/venice-gemini-3-pro', only: 'cost' } })).content)).toStrictEqual({
        id: 'venice/venice-gemini-3-pro',
        dez: { cost: { usdPer1MInputTokens: 2, usdPer1MOutputTokens: 12, usdPer1MCachedInputTokens: 0.2 } },
      })
      expect(quotes).toStrictEqual([])
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

      it('gives no price where the provider has no price request and the model no list price', async () => {
        quoteAnswer = async () => null

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts({ duration: '8s', resolution: '720p', aspect_ratio: '16:9' }, { cost: modelCost(providers[0], VIDEO, null) })))
      })

      it('gives the price records of a provider that tells no one price', async () => {
        const records = [{ billable_type: 'output_image', cost: 0.04 }, { billable_type: 'output_image', cost: 0.08, variant: '4k' }]
        quoteAnswer = async () => ({ records })
        const cost = modelCost(providers[0], VIDEO, { records })

        expect((await info()).content)
          .toBe(modelInfoText(providers[0], VIDEO, facts({ duration: '8s', resolution: '720p', aspect_ratio: '16:9' }, { cost, priceEntry: records })))
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

      it('asks for a price only for a call whose `only` names `cost`', async () => {
        expect(JSON.parse((await info({ only: 'parameters' })).content)).toStrictEqual({
          id: 'venice/wan',
          dez: {
            parameters: [
              { name: 'duration', label: 'Length', options: ['4s', '8s', '12s'], default: '4s', value: '8s' },
              { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p', value: '720p' },
              { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'], default: '16:9', value: '16:9' },
            ],
          },
        })
        expect(quotes).toStrictEqual([])

        expect(JSON.parse((await info({ only: 'cost', parameters: '{"duration": "12s"}' })).content)).toStrictEqual({ id: 'venice/wan', dez: { cost: { usd: 0.07 } } })
        expect(quotes.map(({ parameters }) => parameters)).toStrictEqual([{ duration: '12s', resolution: '720p', aspect_ratio: '16:9' }])
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
        ...NO_PICTURES,
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
        ...NO_PICTURES,
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
      // An ffmpeg that wrote 2.5 seconds of audio into the new file.
      native.program = writes('stdout', audioProgress(2.5))
      native.folderFiles = ['b.mp3', 'new_clip.wav']
    })

    it('cuts the part into a new stored WAV clip, and gives the reply its tag', async () => {
      expect(await clip({ clip: '@b', start: 1, end: 3.5 })).toStrictEqual({
        content: 'Made the audio clip @c from @b, from second 1 to second 3.5. The audio clip @c is 2.5 seconds long.',
        isError: false,
      })

      expect(native.runs.map(({ run }) => run.inputs)).toStrictEqual([[{ name: 'b.mp3', source: song }]])
      expect(native.moves.map(({ to }) => to.path)).toStrictEqual([expect.stringMatching(/^assets\/generated\/audio\/[0-9a-f-]{36}\.wav$/)])
      expect(written).toStrictEqual([{ kind: 'audio', type: 'audio/wav', src: `${APP_DIR}/${native.moves[0].to.path}`, url: null, expires: null }])
      expect(deletedClips).toStrictEqual([])
    })

    it('ends the part at the end of the clip for an end past it', async () => {
      native.program = writes('stdout', audioProgress(2))

      expect((await clip({ clip: 'b', start: 8, end: 60 })).content).toBe('Made the audio clip @c from @b, from second 8 to second 10. The audio clip @c is 2 seconds long.')
    })

    it('makes no clip for a call with only the clip, and gives the length of the clip', async () => {
      native.program = writes('stdout', audioProgress(12.3456))

      expect(await clip({ clip: 'b' })).toStrictEqual({
        content: 'The audio clip @b is 12.35 seconds long. Give a start, an end, or both to make a new clip from a part of it.',
        isError: false,
      })
      expect(native.moves).toStrictEqual([])
      expect(written).toStrictEqual([])
    })

    it('refuses a part that no clip has before it reads the clip', async () => {
      expect(await clip({ clip: 'b', start: 5, end: 5 })).toStrictEqual({ content: '"end" (5) must be after "start" (5).', isError: true })
      expect(native.runs).toStrictEqual([])
    })

    it('gives the error of a part that is not in the clip, with the length of the clip, and makes no clip', async () => {
      // The cut wrote no audio; the clip is 10 seconds long.
      native.program = async (run, onOutput) => {
        onOutput({ stream: 'stdout', text: audioProgress(run.args.includes('-ss') ? null : 10) })
        return ENDED
      }

      expect(await clip({ clip: 'b', start: 12 })).toStrictEqual({
        content: 'The audio clip @b is 10 seconds long, so "start" must be less than 10.',
        isError: true,
      })
      expect(native.moves).toStrictEqual([])
      expect(written).toStrictEqual([])
    })

    it('deletes the new file when the reply takes no clip any more', async () => {
      newClipId = null

      expect(await clip({ clip: 'b', end: 5 })).toStrictEqual({
        content: 'The reply stopped before Dez could add the new audio clip to it, so there is no new clip. This is not a fault of the call. '
          + 'Call the audio tool again only when the user asks for the clip again.',
        isError: true,
      })
      expect(deletedClips).toStrictEqual([`${APP_DIR}/${native.moves[0].to.path}`])
    })

    it('stops ffmpeg and makes no clip when the user stops the reply during the cut', async () => {
      const abort = new AbortController()
      let end: (end: BundledToolEnd) => void = () => {}
      native.program = () => new Promise((resolve) => { end = resolve })

      const result = clip({ clip: 'b', end: 5 }, abort.signal)
      await vi.waitFor(() => expect(native.runs).toHaveLength(1))
      abort.abort()
      end({ kind: 'cancelled' })

      expect((await result).isError).toBe(true)
      expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
      expect(native.moves).toStrictEqual([])
      expect(written).toStrictEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    })
  })

  describe('the job tools', () => {
    const IMAGE = '/home/u/.config/dez/assets/generated/images/job.png'
    const SONG = '/home/u/.config/dez/assets/generated/audio/job.mp3'
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
        ...NO_PICTURES,
      }
      return sbp('dez.controller/tools/run', { name, arguments: args }, signal, context) as Promise<ToolRunResult>
    }

    beforeEach(() => {
      jobs = new ReplyJobs()
      tabId = ''
      written = []
      newIds = ['c', 'd', 'e']
    })

    // Ends the time limits of the jobs that a test left.
    afterEach(() => jobs.stopAll())

    it('jobs_wait waits for the next job end, gives each result once with its job id, its call, and its status, and tells how many jobs still run', async () => {
      const slow = heldWork()
      const made = jobs.start('model_invoke', async () => ({ text: 'A red square.', isError: false, assets: [] }), { ...LONG, label: 'A red square' }).id
      const refused = jobs.start('video', async () => ({ text: 'The provider refused the request.', isError: true, assets: [] }), LONG).id
      const last = jobs.start('model_invoke', slow.work, LONG).id

      // Also a job that failed gives no error result: the result holds the
      // results of other jobs too.
      expect(await jobTool('jobs_wait')).toStrictEqual({
        content: '2 jobs ended. 1 job still runs: call jobs_wait again to get its result.\n\n'
          + `<job id="${made}" number="1" tool="model_invoke" status="finished" call="A red square">\nA red square.\n</job>\n\n`
          + `<job id="${refused}" number="2" tool="video" status="failed">\nThe provider refused the request.\n</job>`,
        isError: false,
      })

      const wait = jobTool('jobs_wait')
      slow.finish({ text: 'Done.', isError: false, assets: [] })
      expect(await wait).toStrictEqual({
        content: `1 job ended. No job still runs.\n\n<job id="${last}" number="3" tool="model_invoke" status="finished">\nDone.\n</job>`,
        isError: false,
      })
      expect(await jobTool('jobs_wait')).toStrictEqual({ content: NO_OPEN_JOBS_TEXT, isError: false })
    })

    it('jobs_wait with `all` waits until no job runs, and gives every result in one call', async () => {
      const slow = heldWork()
      const fast = heldWork()
      const slowId = jobs.start('model_invoke', slow.work, LONG).id
      const fastId = jobs.start('model_invoke', fast.work, LONG).id

      let result: ToolRunResult | undefined
      const wait = jobTool('jobs_wait', { all: true }).then((value) => { result = value })
      fast.finish({ text: 'Fast.', isError: false, assets: [] })
      await vi.waitFor(() => expect(jobs.running).toBe(1))
      // A result is ready, but one job still runs.
      expect(result).toBeUndefined()

      slow.finish({ text: 'Slow.', isError: false, assets: [] })
      await wait
      expect(result).toStrictEqual({
        content: '2 jobs ended. No job still runs.\n\n'
          + `<job id="${fastId}" number="2" tool="model_invoke" status="finished">\nFast.\n</job>\n\n`
          + `<job id="${slowId}" number="1" tool="model_invoke" status="finished">\nSlow.\n</job>`,
        isError: false,
      })
    })

    it('jobs_wait with `jobs` waits only for the named jobs, and tells of the results that stay for a later call', async () => {
      const music = heldWork()
      const image = heldWork()
      const musicId = jobs.start('model_invoke', music.work, LONG).id
      const imageId = jobs.start('model_invoke', image.work, LONG).id
      const fastId = jobs.start('model_invoke', async () => ({ text: 'Fast.', isError: false, assets: [] }), LONG).id

      let result: ToolRunResult | undefined
      const wait = jobTool('jobs_wait', { jobs: imageId }).then((value) => { result = value })
      await vi.waitFor(() => expect(jobs.ready).toBe(1))
      // A result of another job is ready, but the named job still runs.
      expect(result).toBeUndefined()

      image.finish({ text: 'Image.', isError: false, assets: [] })
      await wait
      expect(result?.content).toBe(jobsWaitText([{ id: imageId, tool: 'model_invoke', status: 'finished', text: 'Image.', call: { number: 2, label: '' } }], 1, 1))

      expect(jobsWaitResults((await jobTool('jobs_wait')).content).map((job) => job.id)).toStrictEqual([fastId])
      music.finish({ text: 'Music.', isError: false, assets: [] })
      expect(jobsWaitResults((await jobTool('jobs_wait', { jobs: `${musicId}, ${imageId}` })).content).map((job) => job.id)).toStrictEqual([musicId])
    })

    it('jobs_wait refuses `jobs` with `all`, and an id of no job of the reply, and waits for nothing', async () => {
      const held = heldWork()
      const id = jobs.start('model_invoke', held.work, LONG).id

      expect(await jobTool('jobs_wait', { jobs: id, all: true })).toMatchObject({ isError: true })
      const unknown = await jobTool('jobs_wait', { jobs: `${id} j-zzzz` })
      expect(unknown.isError).toBe(true)
      expect(unknown.content).toContain(`"j-zzzz"`)
      expect(unknown.content).toContain(id)
      expect(jobs.running).toBe(1)
    })

    it('jobs_wait puts what a job made into the reply under the name of the job\'s tool, and its result names the new ids', async () => {
      const { id } = jobs.start('model_invoke', async () => ({
        text: '',
        isError: false,
        assets: [{ kind: 'image', path: IMAGE }, { kind: 'clip', clip: { kind: 'audio', type: 'audio/mpeg', src: SONG, url: null, expires: null } }],
      }), LONG)

      expect((await jobTool('jobs_wait')).content).toBe(
        `1 job ended. No job still runs.\n\n<job id="${id}" number="1" tool="model_invoke" status="finished">\nMade the image @c.\nMade the audio clip @d.\n</job>`,
      )
      expect(written).toStrictEqual([{ path: IMAGE, tool: 'model_invoke', madeBy: id }, { path: SONG, tool: 'model_invoke', madeBy: id }])
      expect(deletedImages).toStrictEqual([])
      expect(deletedClips).toStrictEqual([])
    })

    it('jobs_wait deletes the file of a job when the reply takes no image any more, and says so', async () => {
      newIds = []
      jobs.start('model_invoke', async () => ({ text: '', isError: false, assets: [{ kind: 'image', path: IMAGE }] }), LONG)

      expect((await jobTool('jobs_wait')).content).toContain('The reply stopped before Dez could add the image of this job to it, so there is no new image.')
      expect(deletedImages).toStrictEqual([IMAGE])
    })

    it('jobs_wait ends at once when the user stops the reply, and the stopped job leaves no result', async () => {
      jobs.start('model_invoke', heldWork().work, LONG)
      const abort = new AbortController()
      const wait = jobTool('jobs_wait', {}, abort.signal)

      // What `dez.stream/stop` does.
      abort.abort()
      jobs.stopAll()

      expect((await wait).isError).toBe(true)
      expect(consoleError).not.toHaveBeenCalled()
      expect(await jobs.settle()).toStrictEqual([])
    })

    it('jobs_list lists the jobs of the reply and does not wait', async () => {
      expect(await jobTool('jobs_list')).toStrictEqual({ content: NO_JOBS_TEXT, isError: false })

      const running = jobs.start('model_invoke', heldWork().work, { ...LONG, label: 'A red fox' }).id
      const ended = jobs.start('video', async () => ({ text: 'Done.', isError: false, assets: [] }), LONG).id
      await jobTool('jobs_wait')

      expect(await jobTool('jobs_list')).toStrictEqual({
        content: jobsListText([
          { id: running, tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 0, state: '', call: { number: 1, label: 'A red fox' } },
          { id: ended, tool: 'video', status: 'finished', delivered: true, elapsedMs: 0, state: '', call: { number: 2, label: '' } },
        ]),
        isError: false,
      })
    })

    it('job_inspect tells the status and the last state of the job that the call names', async () => {
      const { id } = jobs.start('model_invoke', async (_signal, report) => {
        report('Queued at the provider as job q-7.')
        return await new Promise<JobOutcome>(() => {})
      }, LONG)

      expect(await jobTool('job_inspect', { job_id: ` ${id}\n` })).toStrictEqual({
        content: `The job ${id} (job 1 of this reply, model_invoke) runs, for 0 seconds so far. Call jobs_wait to wait for its result.\nState: Queued at the provider as job q-7.`,
        isError: false,
      })
    })

    it('job_inspect gives an error result that names the jobs of the reply for an id that none of them has', async () => {
      const { id } = jobs.start('model_invoke', heldWork().work, LONG)
      // An id that no job can have: a job id has 4 characters after `j-`.
      const result = await jobTool('job_inspect', { job_id: 'j-none-1' })
      expect(result.isError).toBe(true)
      expect(result.content).toContain('"j-none-1"')
      expect(result.content).toContain(`The jobs of this reply are ${id}:`)
    })

    describe('model_invoke', () => {
      const PAINTER: ModelInfo = { id: 'painter', name: 'Painter', provider: 'venice', outputs: ['image'], request: 'image', images: { maxImages: 2 } }
      const FILMER: ModelInfo = { id: 'filmer', name: 'Filmer', provider: 'venice', outputs: ['video'], request: 'video' }
      const SCRIBE: ModelInfo = { id: 'scribe', name: 'Scribe', provider: 'venice', outputs: ['text'], request: 'transcription', clips: { audio: { use: 'source', maxClips: 1 } } }
      // A text model that makes images too.
      const SKETCHER: ModelInfo = { id: 'sketcher', name: 'Sketcher', provider: 'venice', outputs: ['text', 'image'] }
      // A text model that makes audio too.
      const SINGER: ModelInfo = { id: 'singer', name: 'Singer', provider: 'venice', outputs: ['text', 'audio'] }
      const MADE_SONG = { kind: 'audio', mediaType: 'audio/mpeg', src: '/home/u/.cache/dez/media/song.mp3', url: null, expires: '2026-12-01T00:00:00.000Z', jobId: null } as const
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
      // It goes with the price `quote`, and reports the provider's job id.
      function heldRequest({ quote }: { quote?: number } = {}): { answer: (result: ProviderGenerateMediaResult) => void } {
        let answer!: (result: ProviderGenerateMediaResult) => void
        const result = new Promise<ProviderGenerateMediaResult>((resolve) => { answer = resolve })
        generateMedia = (input) => {
          input.onProgress?.({ phase: 'sent', jobId: null, ...(quote !== undefined && { quote }) })
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
        sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [...MODELS('venice'), PAINTER, FILMER, SCRIBE, SKETCHER, SINGER] })
        tabId = sbp('dez.model/tabs/activeId') as string
        sbp('dez.model/tabs/replaceSections', tabId, [
          { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${FOX}](id=a) and ![${LINKED}](id=b)\n${mediaTagText(SPEECH)}` }] },
          { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }] },
        ])
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('starts a job at once and tells its number and the inputs that go; jobs_wait puts the image of the model into the reply, with the start of the prompt', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [] })

        const started = await jobTool('model_invoke', { ...PAINT, timeout_seconds: 60 })

        const [job] = jobs.list()
        expect(started.isError).toBe(false)
        expect(started.content.split('\n')[0]).toBe(jobStartedText(job.id, 1))
        expect(started.content).toContain('the image @a')
        expect(await jobResult()).toContain(`<job id="${job.id}" number="1" tool="model_invoke" status="finished" call="The fox of @a in snow.">\nMade the image @c.\n</job>`)
        expect(mediaRequests).toMatchObject([{ providerId: 'venice', modelId: 'painter', kind: 'image', images: [FOX], clips: [], reader: 'model', timeoutMs: 60_000 }])
        expect(savedImages).toStrictEqual([{ mediaType: 'image/png', options: { folder: 'generated' } }])
        expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke', madeBy: job.id }])
      })

      // Calls that begin with the same words: only the number tells which
      // result is whose.
      it('numbers the jobs in the order of their calls', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [] })

        const first = await jobTool('model_invoke', PAINT)
        const second = await jobTool('model_invoke', PAINT)

        const [one, two] = jobs.list()
        expect([first.content.split('\n')[0], second.content.split('\n')[0]]).toStrictEqual([jobStartedText(one.id, 1), jobStartedText(two.id, 2)])
        expect(jobsWaitResults((await jobTool('jobs_wait', { all: true })).content).map((result) => [result.id, result.call]).sort()).toStrictEqual([
          [one.id, { number: 1, label: 'The fox of @a in snow.' }],
          [two.id, { number: 2, label: 'The fox of @a in snow.' }],
        ].sort())
      })

      // The provider took the money for its job: the id must not get lost.
      it('tells the provider\'s job id while a clip is made, and keeps it on the clip', async () => {
        const request = heldRequest()
        await jobTool('model_invoke', FILM)
        const [{ id }] = jobs.list()

        expect((await jobTool('job_inspect', { job_id: id })).content).toContain('q-17')

        request.answer({ media: [], clips: [MADE_VIDEO] })
        expect(await jobResult()).toContain('Made the video clip @c.')
        expect(written).toStrictEqual([{ path: TEMP_COPY, tool: 'model_invoke', madeBy: id, jobId: 'q-17' }])
        expect(native.deletedFiles).toStrictEqual([])
      })

      // The model reads the same texts as for any other call: only the
      // editor reads the marker.
      it('marks the clip and the image of a call with `is_intermediate` as hidden assets of its job', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [MADE_VIDEO] })

        await jobTool('model_invoke', { ...FILM, is_intermediate: true })
        const [{ id }] = jobs.list()

        expect(await jobResult()).toContain(`<job id="${id}" number="1" tool="model_invoke" status="finished" call="A fox runs.">\nMade the video clip @c.\nMade the image @d.\n</job>`)
        expect(written).toStrictEqual([
          { path: TEMP_COPY, tool: 'model_invoke', madeBy: id, hidden: id, jobId: 'q-17' },
          { path: MADE_IMAGE, tool: 'model_invoke', madeBy: id, hidden: id },
        ])
      })

      it('hides nothing for a call whose `is_intermediate` is false', async () => {
        generateMedia = async () => ({ media: [PNG], clips: [] })

        await jobTool('model_invoke', { ...PAINT, is_intermediate: false })
        await jobResult()

        expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke', madeBy: jobs.list()[0].id }])
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
        const work = invokeModel(invocationOf(PAINT), tabId, abort.signal, () => {}, () => {}, () => {}, { toolsAllowed: false })

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
        await vi.waitFor(() => expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/made.mp4', folder: false }]))
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

      // The spend line of jobs_list adds these prices.
      it('gives a job the quote of its request while it runs, then the price of the result', async () => {
        const request = heldRequest({ quote: 0.3 })
        await jobTool('model_invoke', FILM)
        expect(jobs.list()[0].cost).toBe(0.3)

        request.answer({ media: [], clips: [MADE_VIDEO], cost: 0.25 })
        await jobResult()
        expect(jobs.list()[0].cost).toBe(0.25)
      })

      it('keeps the quote of a job that the reply stopped, and has no known price for a request with no quote', async () => {
        const request = heldRequest({ quote: 0.3 })
        await jobTool('model_invoke', FILM)
        heldRequest()
        await jobTool('model_invoke', FILM)

        jobs.stopAll()
        request.answer({ media: [], clips: [MADE_VIDEO], cost: 0.25 })
        await vi.waitFor(() => expect(native.deletedFiles).toHaveLength(1))

        expect(jobs.list().map((job) => job.cost)).toStrictEqual([0.3, null])
      })

      // A provider gives back the money of a request that it refused, and
      // bills one that it took: its job, or an answer that Dez cannot use.
      it('counts a refused request as free, keeps the quote of a request that failed after the provider took it, and counts a job whose request did not go as one with no paid request', async () => {
        const refusal = new ProviderHttpError('venice', 400, true, '', undefined, 'Venice refused the request.', 'Venice refused the request.')
        let failure: { sends: boolean, queued?: boolean, error: Error } = { sends: true, error: new ExplainedError('Venice refused the request: the prompt breaks its rules.', '', { cause: refusal }) }
        generateMedia = async (input) => {
          if (failure.sends) input.onProgress?.({ phase: 'sent', jobId: null, quote: 0.3 })
          if (failure.queued) input.onProgress?.({ phase: 'queued', jobId: 'q-17' })
          throw failure.error
        }
        await jobTool('model_invoke', PAINT)
        // A poll of the provider's job that it refused.
        failure = { sends: true, queued: true, error: new ExplainedError('Venice refused the request. Venice ran this request as its job q-17.', '', { cause: refusal }) }
        await jobTool('model_invoke', PAINT)
        failure = { sends: true, error: new ExplainedError('Venice sent an answer that Dez cannot use.') }
        await jobTool('model_invoke', PAINT)
        failure = { sends: false, error: refusal }
        await jobTool('model_invoke', PAINT)
        await jobTool('jobs_wait', { all: true })

        expect(jobs.list().map((job) => [job.status, Object.hasOwn(job, 'cost') ? job.cost : 'none']))
          .toStrictEqual([['failed', 0], ['failed', 0.3], ['failed', 0.3], ['failed', 'none']])
      })

      describe('to a text model', () => {
        // A chat request whose answer stays open after `start` until its
        // test calls `end`, which gives the result of the request.
        function heldAnswer(start: (input: ProviderStreamChatInput) => void | Promise<void>): { end: (result?: Pick<ProviderStreamChatResult, 'cost'>) => void } {
          let end!: (result?: Pick<ProviderStreamChatResult, 'cost'>) => void
          const ended = new Promise<Pick<ProviderStreamChatResult, 'cost'> | undefined>((resolve) => { end = resolve })
          streamChat = async (input) => {
            await start(input)
            return await ended
          }
          return { end }
        }

        // The invoked model must not call a tool or invoke a model in its
        // turn, and it gets nothing of the conversation. A failure of the
        // request is told to the calling model (`reader`).
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
          expect(await jobResult()).toContain(`<job id="${job.id}" number="1" tool="model_invoke" status="finished" call="What does @a show?">\n${invocationAnswerText('A fox in snow.')}\n</job>`)
          expect(chatRequests).toStrictEqual([{
            providerId: 'venice',
            modelId: 'venice-glm-5',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'What does @a' }, { type: 'image', path: FOX }, { type: 'text', text: ' show?' }] }],
            tools: [],
            imageOutput: false,
            audioOutput: false,
            providerSettings: { webSearch: false },
            reader: 'model',
            onSent: expect.any(Function),
            requestId: expect.any(String),
            signal: expect.any(AbortSignal),
            onThinking: expect.any(Function),
            onToken: expect.any(Function),
            onImage: expect.any(Function),
            onClip: expect.any(Function),
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
          expect(written).toStrictEqual([{ path: MADE_IMAGE, tool: 'model_invoke', madeBy: jobs.list()[0].id }])
        })

        it('asks a model that makes audio for it, and jobs_wait puts the clip of the answer into the reply', async () => {
          streamChat = async (input) => {
            await input.onToken('<instrumental>')
            await input.onClip(MADE_SONG)
          }

          await jobTool('model_invoke', { model: 'venice/singer', prompt: 'A short song.' })

          expect(await jobResult()).toContain(`${invocationAnswerText('<instrumental>')}\nMade the audio clip @c.\n</job>`)
          expect(chatRequests[0]).toMatchObject({ imageOutput: false, audioOutput: true })
          expect(written).toStrictEqual([{ path: MADE_SONG.src, tool: 'model_invoke', madeBy: jobs.list()[0].id }])
        })

        it('tells in the state of the job how much text came so far', async () => {
          const answer = heldAnswer((input) => input.onToken('A fox'))
          await jobTool('model_invoke', ASK)
          const [{ id }] = jobs.list()

          expect((await jobTool('job_inspect', { job_id: id })).content).toContain(invocationAnswerStateText(5))
          answer.end()
        })

        // A provider takes no money for a request that it refused; an answer
        // that broke off can have cost money. A request that failed before
        // it went is no paid request.
        it('has no known price while the answer comes, then the price of the request; a refused request costs 0, another failure has no known price, and a request that did not go is no paid request', async () => {
          const answer = heldAnswer(async (input) => {
            input.onSent?.()
            await input.onToken('A fox.')
          })
          await jobTool('model_invoke', ASK)
          expect(jobs.list()[0].cost).toBeNull()

          answer.end({ cost: 0.002 })
          await jobResult()
          for (const [sent, failure] of [
            [true, new ProviderHttpError('venice', 400, true, '', undefined, 'Venice refused the request.', 'Venice refused the request.')],
            [true, new ExplainedError('The connection broke.')],
            [false, new InputImageError(FOX, 'unreadable', 'Dez cannot use the image fox.png.')],
          ] as const) {
            streamChat = async (input) => {
              if (sent) input.onSent?.()
              throw failure
            }
            await jobTool('model_invoke', ASK)
            await jobResult()
          }

          expect(jobs.list().map((job) => [job.status, Object.hasOwn(job, 'cost') ? job.cost : 'none']))
            .toStrictEqual([['finished', 0.002], ['failed', 0], ['failed', null], ['failed', 'none']])
        })

        // The request holds no conversation, so it tells nothing about the
        // context of its tab or about the prompt cache of the reply.
        it('adds a row for its request to the request log, under the tab of its call and with no context size', async () => {
          streamChat = async (input) => {
            input.onSent?.()
            await input.onToken('A fox.')
            return { cost: 0.002, usage: { inputTokens: 400, cachedInputTokens: 300, outputTokens: 30 } }
          }

          await jobTool('model_invoke', ASK)
          await jobResult()

          expect((sbp('dez.diagnostics/requestLog') as RequestLogRow[]).filter((row) => row.tabId === tabId)).toStrictEqual([{
            startedAt: expect.any(Number),
            tabId,
            providerId: 'venice',
            modelId: 'venice-glm-5',
            kind: 'model_invoke',
            uncachedInputTokens: 100,
            cacheReadTokens: 300,
            cacheWriteTokens: 0,
            outputTokens: 30,
            cost: 0.002,
            contextTokens: null,
            contextEstimated: null,
            imageCount: 1,
            sincePreviousMs: null,
          }])
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

          expect(await jobResult()).toContain(`status="failed" call="Draw a fox.">\n${IMAGE_NOT_SAVED_TEXT}\n</job>`)
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

          expect(await invokeModel(invocationOf(SKETCH), tabId, abort.signal, () => {}, () => {}, () => {}, { toolsAllowed: false })).toStrictEqual({ text: '', isError: false, assets: [] })
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

        // No text names them before the job ends, which can be long after
        // them: Delete Unused Files keeps them by this list.
        it('tells the job the image and the clip of an answer that goes on', async () => {
          const answer = heldAnswer(async (input) => {
            await input.onImage(PNG)
            await input.onClip(MADE_SONG)
          })
          await jobTool('model_invoke', SKETCH)

          await vi.waitFor(() => expect(jobs.madeAssetSources()).toStrictEqual([MADE_IMAGE, MADE_SONG.src]))
          expect(jobs.list()[0].status).toBe('running')
          answer.end()
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

  describe('asset_info', () => {
    const FOX = `${APP_DIR}/assets/images/fox.png`
    const SCENE = `${APP_DIR}/assets/generated/video/scene.mp4`
    const VOICE = `${APP_DIR}/assets/audio/voice.wav`
    // What ffprobe writes for each clip: a video clip with sound.
    const PROBED = JSON.stringify({
      streams: [
        { codec_name: 'h264', codec_type: 'video', width: 854, height: 480, avg_frame_rate: '24/1', r_frame_rate: '24/1' },
        { codec_name: 'aac', codec_type: 'audio', sample_rate: '48000', channels: 2 },
      ],
      format: { duration: '5.040000', size: '1250000' },
    })
    const COLUMNS = ASSET_INFO_COLUMNS
    let tabId: string

    function assetInfo(assets: string, checks?: string): Promise<ToolRunResult> {
      const context: ToolRunContext = { tabId, model: REPLY_MODEL, jobs: new ReplyJobs(), writeImage: () => null, writeClip: () => null, ...NO_PICTURES }
      const args = checks === undefined ? { assets } : { assets, checks }
      return sbp('dez.controller/tools/run', { name: 'asset_info', arguments: args }, running(), context) as Promise<ToolRunResult>
    }

    beforeEach(() => {
      tabId = sbp('dez.model/tabs/activeId') as string
      const start = toolBlockText({
        id: 'call_1',
        name: 'model_invoke',
        status: 'success',
        arguments: { model: 'venice/film', prompt: 'Scene 1: a fox', is_intermediate: true },
        result: jobStartedText('j-aaaa', 1),
      })
      const scene = mediaTagText({
        kind: 'video',
        id: 'b',
        type: 'video/mp4',
        src: SCENE,
        url: null,
        expires: null,
        other: [{ name: 'tool', value: 'model_invoke' }, { name: 'made-by', value: 'j-aaaa' }, { name: 'hidden', value: 'j-aaaa' }],
      })
      sbp('dez.model/tabs/replaceSections', tabId, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${FOX}](id=a)` }] },
        // The clip @c has no file and no web address any more.
        { id: 'a1', role: 'agent', model: REPLY_MODEL, content: [{ kind: 'text', text: `${start}\n\n${scene}\n<dez:audio id="c" type="audio/wav"/>` }] },
        { id: 'u2', role: 'user', content: [{ kind: 'text', text: `<dez:audio id="d" type="audio/wav" src="${VOICE}"/>\nWhich is which?` }] },
        { id: 'a2', role: 'agent', content: [{ kind: 'text', text: '' }] },
      ])
      readImage = async () => new Blob([new Uint8Array(2048)])
      native.program = writes('stdout', PROBED)
    })

    it('gives the facts, the place, and the origin of each asset, with one ffprobe run for each clip in one work folder', async () => {
      expect(await assetInfo('@a, @b @c d')).toStrictEqual({
        content: [
          COLUMNS,
          '@a | image | PNG | 1000x500 | 2 KB | shown | from the user',
          '@b | video | MP4 | 5.04 s | 854x480 | 24 fps | h264 | sound (aac) | 1.2 MB | hidden | made by the model_invoke job 1 of its reply: "Scene 1: a fox"',
          '@c | audio | gone: the user deleted its file, and it has no web address | shown | made by the model venice/venice-glm-5',
          '@d | audio | WAV | 5.04 s | aac | 48000 Hz | 2 channels | 1.2 MB | shown | from the user',
        ].join('\n'),
        isError: false,
      })

      expect(readImages).toStrictEqual([FOX])
      expect(drawings).toStrictEqual([])
      const folder = deletedWorkFolder()
      expect(native.runs.map(({ run }) => ({ tool: run.tool, args: run.args, folder: run.folder, inputs: run.inputs }))).toStrictEqual([
        { tool: 'dez-ffprobe', args: assetProbeArgs('b.mp4'), folder, inputs: [{ name: 'b.mp4', source: SCENE }] },
        { tool: 'dez-ffprobe', args: assetProbeArgs('d.wav'), folder, inputs: [{ name: 'd.wav', source: VOICE }] },
      ])
    })

    it('refuses an id that names no asset, with the ids that the call can name, and reads nothing', async () => {
      expect(await assetInfo('@a @z')).toStrictEqual({
        content: '@z names no image and no clip of this conversation. Dez read no facts. '
          + 'The conversation has the image @a, the video clip @b, the audio clip @c, the audio clip @d: call again with these ids.',
        isError: true,
      })
      expect(readImages).toStrictEqual([])
      expect(native.runs).toStrictEqual([])
    })

    it('tells in its line that Dez could not read an image or a clip, and gives the other lines', async () => {
      native.program = writes('stderr', 'Invalid data found when processing input', { kind: 'exited', code: 1 })
      readImage = async () => {
        throw new Error('No such file')
      }

      expect((await assetInfo('a b')).content).toBe([
        COLUMNS,
        '@a | image | Dez could not read its file | shown | from the user',
        '@b | video | ffprobe could not read its file | hidden | made by the model_invoke job 1 of its reply: "Scene 1: a fox"',
      ].join('\n'))

      readImage = async () => new Blob([new Uint8Array(2048)])
      redrawError = new Error('The image cannot be decoded.')
      expect((await assetInfo('a')).content).toBe(`${COLUMNS}\n@a | image | PNG | 2 KB | Dez could not read its picture | shown | from the user`)
    })

    it('gives the format of the bytes, as asset_view does, for a file whose extension does not match them', async () => {
      readImage = async () => new Blob([new Uint8Array(2048)], { type: 'image/jpeg' })

      expect((await assetInfo('a')).content).toBe(`${COLUMNS}\n@a | image | JPEG | 1000x500 | 2 KB | shown | from the user`)
    })

    describe('with checks', () => {
      const CHECKED_COLUMNS = `${COLUMNS} Under the line of a clip: a line for each check, with times in seconds of the clip.`
      const SCENE_LINE = '@b | video | MP4 | 5.04 s | 854x480 | 24 fps | h264 | sound (aac) | 1.2 MB | hidden | made by the model_invoke job 1 of its reply: "Scene 1: a fox"'
      const VOICE_LINE = '@d | audio | WAV | 5.04 s | aac | 48000 Hz | 2 channels | 1.2 MB | shown | from the user'
      // What the check runs log for each clip copy, and how they end.
      let checkLogs: Record<string, string>
      let checkEnds: Record<string, BundledToolEnd>

      beforeEach(() => {
        checkLogs = {
          'b.mp4': [
            '[Parsed_blackdetect_0 @ 0xffffa1667d90] black_start:2 black_end:3 black_duration:1',
            '[Parsed_scdet_1 @ 0xffffa1667e50] lavfi.scd.score: 41.855, lavfi.scd.time: 2',
            '[Parsed_scdet_1 @ 0xffffa1667e50] lavfi.scd.score: 38.512, lavfi.scd.time: 3',
          ].join('\n'),
          'd.wav': '[Parsed_silencedetect_0 @ 0xffffa1668090] silence_start: 1.014813',
        }
        checkEnds = {}
        native.program = async (run, onOutput) => {
          const input = run.args[run.args.indexOf('-i') + 1]
          if (run.tool === 'dez-ffprobe') onOutput({ stream: 'stdout', text: PROBED })
          else onOutput({ stream: 'stderr', text: checkLogs[input] })
          return run.tool === 'dez-ffmpeg' ? checkEnds[input] ?? ENDED : ENDED
        }
      })

      // The tool, the arguments, and the time limit of each run.
      const runs = () => native.runs.map(({ run }) => ({ tool: run.tool, args: run.args, timeoutMs: run.timeoutMs }))

      it('runs the checks that fit each clip over the whole clip, after its probe, and gives their lines under its line', async () => {
        expect(await assetInfo('@a @b @d', 'cuts, silence black')).toStrictEqual({
          content: [
            CHECKED_COLUMNS,
            '@a | image | PNG | 1000x500 | 2 KB | shown | from the user',
            SCENE_LINE,
            '  black: 2 s to 3 s',
            '  silence: none',
            '  cuts: 2, 3 s',
            VOICE_LINE,
            '  black: no check, the clip has no picture',
            '  silence: 1.015 s to the end',
            '  cuts: no check, the clip has no picture',
          ].join('\n'),
          isError: false,
        })

        deletedWorkFolder()
        expect(runs()).toStrictEqual([
          { tool: 'dez-ffprobe', args: assetProbeArgs('b.mp4'), timeoutMs: FFPROBE_TIMEOUT_MS },
          { tool: 'dez-ffmpeg', args: clipChecksArgs('b.mp4', ['black', 'silence', 'cuts']), timeoutMs: ASSET_VIEW_TIMEOUT_MS },
          { tool: 'dez-ffprobe', args: assetProbeArgs('d.wav'), timeoutMs: FFPROBE_TIMEOUT_MS },
          { tool: 'dez-ffmpeg', args: clipChecksArgs('d.wav', ['silence']), timeoutMs: ASSET_VIEW_TIMEOUT_MS },
        ])
        expect(consoleError).not.toHaveBeenCalled()
      })

      it('runs no ffmpeg for a clip that no check fits', async () => {
        expect((await assetInfo('d', 'frozen')).content).toBe([CHECKED_COLUMNS, VOICE_LINE, '  frozen: no check, the clip has no picture'].join('\n'))
        expect(runs().map(({ tool }) => tool)).toStrictEqual(['dez-ffprobe'])
      })

      it('gives one line of no checks for a clip whose run failed or that Dez could not read, and the lines of the others', async () => {
        checkEnds['b.mp4'] = { kind: 'timedOut' }

        expect((await assetInfo('b c d', 'silence frozen')).content).toBe([
          CHECKED_COLUMNS,
          SCENE_LINE,
          '  No checks: ffmpeg took longer than 60 s to read this whole clip, so Dez stopped it. A check of the picture reads every frame: '
            + 'for a long video clip, check only its sound (`silence`, `loudness_curve`), or view parts of it with asset_view (`start` and `end`).',
          '@c | audio | gone: the user deleted its file, and it has no web address | shown | made by the model venice/venice-glm-5',
          '  No checks: Dez could not read this clip.',
          VOICE_LINE,
          '  frozen: no check, the clip has no picture',
          '  silence: 1.015 s to the end',
        ].join('\n'))
        expect(consoleError).toHaveBeenCalledWith('ffmpeg could not run the checks of the video clip @b:', { kind: 'timedOut' }, checkLogs['b.mp4'])
      })

      it('refuses a check that Dez does not have, and reads nothing', async () => {
        expect(await assetInfo('@a @b', 'black, freeze')).toStrictEqual({
          content: 'Unknown value "freeze" in `checks`. Use any of: black, frozen, silence, loudness_curve, cuts. Dez read no facts.',
          isError: true,
        })
        expect(readImages).toStrictEqual([])
        expect(native.runs).toStrictEqual([])
      })
    })
  })

  describe('asset_view', () => {
    const FOX = `${APP_DIR}/assets/images/fox.png`
    const SCENE = `${APP_DIR}/assets/generated/video/scene.mp4`
    const VOICE = `${APP_DIR}/assets/audio/voice.wav`
    const FOX_BYTES = new Uint8Array([1, 2, 3])
    const probed = (streams: object[]) => JSON.stringify({ streams, format: { duration: '5.040000', size: '1250000' } })
    const VIDEO_STREAM = { codec_name: 'h264', codec_type: 'video', width: 854, height: 480, avg_frame_rate: '24/1', r_frame_rate: '24/1' }
    const AUDIO_STREAM = { codec_name: 'pcm_s16le', codec_type: 'audio', sample_rate: '48000', channels: 2 }
    // The log lines of ffmpeg that Dez reads: the frames of a sheet, the
    // cuts of a clip, and the loudness summary.
    const showinfoLog = (times: number[]) => times
      .map((time, n) => `[Parsed_showinfo_1 @ 0x1] n:   ${n} pts:  ${n} pts_time:${time} duration: 512 fmt:yuv420p\n`).join('')
    const SHOWINFO = showinfoLog([0.4167, 1.25, 2.0833])
    // The label of the frame sheet of @b with the frames of SHOWINFO.
    const SHEET_SHOWS = 'the frame sheet of the video clip @b: 3 frames in one row, at 0.417, 1.25, 2.083 s'
    const scdetLog = (times: number[]) => times.map((time) => `[Parsed_scdet_0 @ 0x3] lavfi.scd.score: 21.747, lavfi.scd.time: ${time}\n`).join('')
    const EBUR128 = '[Parsed_ebur128_3 @ 0x2] Summary:\n  Integrated loudness:\n    I:         -23.1 LUFS\n'
      + '  Loudness range:\n    LRA:         9.4 LU\n  True peak:\n    Peak:      -18.8 dBFS\n'
    // The pictures that ffmpeg makes: a frame sheet of 968 by 364 pixels
    // (455 tokens), a wave of 800 by 200 (232 tokens), a spectrogram with
    // its axes of a sound of 48 kHz, and a sound strip under the sheet. The
    // image @a, of 1000 by 500 pixels, costs 648 tokens.
    const SHEET_JPEG = jpegHeader(968, 364)
    const WAVE_JPEG = jpegHeader(800, 200)
    const SPECTROGRAM_JPEG = jpegHeader(1084, 328)
    const STRIP_JPEG = jpegHeader(968, 160)
    // The last line of a view that showed no picture.
    const FULL_BUDGET_LINE = 'Picture budget left in this reply: 20 pictures, 57,408 tokens and 20.0 MB of base64.'
    let tabId: string
    let budget: PictureBudget
    // The pictures that the calls of a test gave their reply.
    let shown: ReturnType<typeof savedPicture>[]
    // The ffprobe output of each clip, by the name of its copy.
    let probes: Record<string, string>
    let frameSheetLog: string
    let frameSheetEnd: BundledToolEnd
    let cutsLog: string
    // The log and the end of each run on the sound of a clip.
    let soundLog: string
    let soundEnd: BundledToolEnd

    // A picture that a call gave its reply: the copy that its result
    // names, with the bytes of its saved file. A request reads that file,
    // so these bytes are what the model gets.
    function savedPicture(copy: ShownPicture) {
      const saved = native.savedFiles.find(({ file }) => file.root === 'app' && file.path === `${SHOWN_PICTURE_FOLDER}/${copy.file}`)
      return { label: copy.label, picture: { mediaType: imageMediaType(copy.file), bytes: saved?.content }, size: shownPictureSize(copy) }
    }

    // Runs a call of a reply with the budget `budget`, and adds the
    // pictures of its result to `shown`.
    async function assetView(args: ToolArguments, { signal = running() } = {}): Promise<ToolRunResult> {
      const context: ToolRunContext = {
        tabId,
        model: REPLY_MODEL,
        jobs: new ReplyJobs(),
        writeImage: () => null,
        writeClip: () => null,
        pictureBudget: async () => budget,
      }
      const result = await sbp('dez.controller/tools/run', { name: 'asset_view', arguments: args }, signal, context) as ToolRunResult
      shown.push(...(result.pictures ?? []).map(savedPicture))
      return result
    }

    const ffmpegRuns = () => native.runs.filter(({ run }) => run.tool === 'dez-ffmpeg').map(({ run }) => run)
    // The first id that the label of a picture names.
    const labelId = ({ label }: { label: string }) => label.match(/@[a-z]+/)?.[0]

    beforeEach(() => {
      tabId = sbp('dez.model/tabs/activeId') as string
      sbp('dez.model/tabs/replaceSections', tabId, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${FOX}](id=a)\n<dez:video id="b" type="video/mp4" src="${SCENE}"/>` }] },
        // The clip @c has no file and no web address any more.
        { id: 'a1', role: 'agent', model: REPLY_MODEL, content: [{ kind: 'text', text: `<dez:audio id="c" type="audio/wav"/>` }] },
        { id: 'u2', role: 'user', content: [{ kind: 'text', text: `<dez:audio id="d" type="audio/wav" src="${VOICE}"/>\nCheck them.` }] },
        { id: 'a2', role: 'agent', content: [{ kind: 'text', text: '' }] },
      ])
      readImage = async () => new Blob([FOX_BYTES], { type: 'image/png' })
      // The budget of a reply with no image in its context, by the numbers
      // of an older Dez: the token numbers of the tests are easy to check
      // against it.
      budget = { tokens: 57_408, bytes: 20 * 1024 ** 2, pictures: 20 }
      shown = []
      probes = { 'b.mp4': probed([VIDEO_STREAM, AUDIO_STREAM]), 'd.wav': probed([AUDIO_STREAM]) }
      frameSheetLog = SHOWINFO
      frameSheetEnd = ENDED
      cutsLog = ''
      soundLog = EBUR128
      soundEnd = ENDED
      native.program = async (run, onOutput) => {
        if (run.tool === 'dez-ffprobe') {
          onOutput({ stream: 'stdout', text: probes[run.args.at(-1) as string] ?? '' })
          return ENDED
        }
        if (run.args.includes(SCENE_CUT_FILTER)) {
          onOutput({ stream: 'stderr', text: cutsLog })
          return ENDED
        }
        if (run.args.includes('-vf')) {
          onOutput({ stream: 'stderr', text: frameSheetLog })
          return frameSheetEnd
        }
        onOutput({ stream: 'stderr', text: soundLog })
        return soundEnd
      }
      native.fileBytes = ({ path }) => {
        if (path.endsWith('-frames.jpg')) return SHEET_JPEG
        if (path.endsWith('-strip.jpg')) return STRIP_JPEG
        if (path.endsWith('-spectrogram.jpg')) return SPECTROGRAM_JPEG
        if (path.endsWith('-wave.jpg')) return WAVE_JPEG
        // A new kind of file needs its bytes here: a read of any other file
        // fails, so the view gets no picture of it.
        throw new Error(`The test has no picture for ${path}.`)
      }
    })

    it('shows an image as it is, the frame sheet of a video clip, and the wave of an audio clip, with their facts, times, and the loudness of each clip', async () => {
      const result = await assetView({ assets: '@a @b @d', frames: 3, end: 2.5 })

      expect(result.isError).toBe(false)
      const lines = result.content.split('\n')
      expect(lines[0]).toBe('@a | image | PNG | 1000x500 | 3 B')
      // The loudness of the video clip, which has sound, is of the part of
      // its frame sheet.
      const loudness = 'Loudness of 0 s to 2.5 s: -23.1 LUFS integrated, 9.4 LU range, -18.8 dBFS true peak.'
      expect(lines.slice(1, 7)).toStrictEqual([
        '@b | video | MP4 | 5.04 s | 854x480 | 24 fps | h264 | sound (pcm_s16le) | 1.2 MB',
        'Frame sheet of 0 s to 2.5 s: 3 frames in one row, at 0.417, 1.25, 2.083 s.',
        loudness,
        expect.stringMatching(/^@d \| audio \| WAV \| /),
        expect.stringMatching(/^Wave picture of 0 s to 2\.5 s: /),
        loudness,
      ])
      expect(drawings).toStrictEqual([])
      expect(shown.map((shownPicture) => ({ ...shownPicture, label: labelId(shownPicture) }))).toStrictEqual([
        { label: '@a', picture: { mediaType: 'image/png', bytes: FOX_BYTES }, size: { width: 1000, height: 500 } },
        { label: '@b', picture: { mediaType: 'image/jpeg', bytes: SHEET_JPEG }, size: { width: 968, height: 364 } },
        { label: '@d', picture: { mediaType: 'image/jpeg', bytes: WAVE_JPEG }, size: { width: 800, height: 200 } },
      ])
      // 648 + 455 + 232 tokens, and 4 + 80 + 80 bytes of base64.
      expect(lines.at(-1)).toBe('Picture budget left in this reply: 17 pictures, 56,073 tokens and 20.0 MB of base64.')
      // The result names a copy of each picture, with its label and what
      // the picture costs in a request: the requests of the reply read the
      // copies, and the panel of the call's chip shows them.
      expect(result.pictures).toStrictEqual([
        { file: expect.stringMatching(new RegExp(`^${FILE_ID.source}\\.png$`)), label: 'asset_view: the image @a.', width: 1000, height: 500, bytes: FOX_BYTES.length },
        { file: expect.stringMatching(new RegExp(`^${FILE_ID.source}\\.jpg$`)), label: `asset_view: ${SHEET_SHOWS}.`, width: 968, height: 364, bytes: SHEET_JPEG.length },
        { file: expect.stringMatching(new RegExp(`^${FILE_ID.source}\\.jpg$`)), label: expect.stringMatching(/^asset_view: the wave of the audio clip @d, /), width: 800, height: 200, bytes: WAVE_JPEG.length },
      ])
      expect(native.savedFiles).toHaveLength(3)

      // One copy of each clip, for its probe; the later runs find it in
      // the folder, which goes at the end with the pictures.
      const folder = deletedWorkFolder()
      expect(native.runs.map(({ run }) => ({ tool: run.tool, folder: run.folder, inputs: run.inputs, output: run.args.at(-1) }))).toStrictEqual([
        { tool: 'dez-ffprobe', folder, inputs: [{ name: 'b.mp4', source: SCENE }], output: 'b.mp4' },
        { tool: 'dez-ffmpeg', folder, inputs: [], output: 'b-frames.jpg' },
        { tool: 'dez-ffmpeg', folder, inputs: [], output: '-' },
        { tool: 'dez-ffprobe', folder, inputs: [{ name: 'd.wav', source: VOICE }], output: 'd.wav' },
        { tool: 'dez-ffmpeg', folder, inputs: [], output: '-' },
      ])
      expect(ffmpegRuns()[0].args).toStrictEqual(expect.arrayContaining(['-to', '2.500', '-i', 'b.mp4']))
      // A run on the sound of the video clip only, with no wave.
      expect(ffmpegRuns()[1].args).toStrictEqual(audioViewArgs('b.mp4', { start: 0, end: 2.5 }, null))
      expect(native.readFiles).toStrictEqual([{ root: 'cache', path: `${folder}/b-frames.jpg` }, { root: 'cache', path: `${folder}/d-wave.jpg` }])
    })

    it('gives the model no picture whose save failed: tells so at its asset, gives its cost back, and gives the other pictures', async () => {
      let saves = 0
      native.saveAppFile = async () => {
        if (++saves === 2) throw new Error('No space left on device')
      }

      const result = await assetView({ assets: '@a @b @d', frames: 3, end: 2.5 })

      expect(result.isError).toBe(false)
      expect(shown.map(labelId)).toStrictEqual(['@a', '@d'])
      const lines = result.content.split('\n')
      // The clip @b keeps its facts and its loudness, and has the note,
      // with no line about its frame sheet.
      expect(lines.slice(1, 4)).toStrictEqual([
        expect.stringMatching(/^@b \| video \| /),
        expect.stringMatching(/^Loudness of 0 s to 2\.5 s: /),
        PICTURE_NOT_SAVED_NOTE,
      ])
      expect(result.content).not.toContain('Frame sheet of')
      // 648 + 232 tokens: the sheet costs nothing.
      expect(lines.at(-1)).toBe('Picture budget left in this reply: 18 pictures, 56,528 tokens and 20.0 MB of base64.')
      expect(consoleError).toHaveBeenCalledWith('Failed to save the copy of a picture that a tool showed:', new Error('No space left on device'))
    })

    it('gives no picture and the whole budget when no save works', async () => {
      native.saveAppFile = async () => {
        throw new Error('No space left on device')
      }

      const result = await assetView({ assets: '@a' })

      expect(result).toStrictEqual({ content: `@a | image | PNG | 1000x500 | 3 B\n${PICTURE_NOT_SAVED_NOTE}\n${FULL_BUDGET_LINE}`, isError: false })
    })

    it('saves no copy, and gives no result, for a call that the user stopped', async () => {
      const stop = new AbortController()
      // The read of the image is the last work of this call before the
      // save.
      readImage = async () => {
        stop.abort()
        return new Blob([FOX_BYTES], { type: 'image/png' })
      }

      const result = await assetView({ assets: '@a' }, { signal: stop.signal })

      expect(result.isError).toBe(true)
      expect(result.pictures).toBeUndefined()
      expect(native.savedFiles).toStrictEqual([])
    })

    it('shows the first frame at or after each time of the call, read from the start of the clip, and tells the times with no frame', async () => {
      const result = await assetView({ assets: '@b', times: '2.08 0.4 1.25 6' })

      // 6 s is after the end of the clip (5.04 s): it gets no place in the
      // sheet.
      const [run] = ffmpegRuns()
      expect(run.args).not.toContain('-ss')
      expect(run.args[run.args.indexOf('-vf') + 1]).toMatch(/^select='if\(eq\(selected_n\\,0\)\\,gte\(t\\,0\.399\).*,tile=3x1:nb_frames=3:/)
      expect(result.content).toContain('Frame sheet of the first frame at or after each of `times` 0.4, 1.25, 2.08, 6 s: 3 frames in one row, at 0.417, 1.25, 2.083 s.')
      expect(result.content).toContain('No frame at or after 6 s:')
      expect(shown.map(({ label }) => label)).toStrictEqual(['asset_view: the frame sheet of the video clip @b: 3 frames in one row, at 0.417, 1.25, 2.083 s.'])
      // The loudness of a call with `times` is of the whole clip.
      expect(ffmpegRuns()[1].args).toStrictEqual(audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null))
      expect(result.content).toContain('Loudness of 0 s to 5.04 s: ')

      // The picture of a clip can end before the end of its sound.
      frameSheetLog = showinfoLog([0.4167])
      expect((await assetView({ assets: '@b', times: '0.4 4.9 5' })).content).toContain('No frame at or after 4.9, 5 s:')
    })

    it('runs no frame sheet for times that are all after the end of the clip, and still gives the loudness of its sound', async () => {
      const result = await assetView({ assets: '@b', times: '6 7' })

      expect(result.content).toContain('No frame at or after 6, 7 s:')
      expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null)])
      expect(shown).toStrictEqual([])
    })

    it('shows the first frame of the part and of each shot after it, at most `frames`, and tells where the left-out shots start', async () => {
      // The times of a run are from its `-ss` on.
      cutsLog = scdetLog([0.25, 1.0833, 2])
      frameSheetLog = showinfoLog([0, 0.25, 1.0833])

      const result = await assetView({ assets: '@b', scenes: true, start: 1, frames: 3 })

      const [cuts, sheet] = ffmpegRuns()
      expect(cuts.args).toStrictEqual(expect.arrayContaining(['-ss', '1.000', '-to', '5.040', '-i', 'b.mp4', '-vf', SCENE_CUT_FILTER]))
      expect(sheet.args).toStrictEqual(expect.arrayContaining(['-ss', '1.000', '-i', 'b.mp4']))
      expect(sheet.args[sheet.args.indexOf('-vf') + 1]).toMatch(/gte\(t\\,0\.000\).*gte\(t\\,0\.249\).*gte\(t\\,1\.082\).*,tile=3x1:nb_frames=3:/)
      expect(sheet.args.at(-1)).toBe('b-frames.jpg')
      expect(result.content).toContain('Frame sheet of the shots of 1 s to 5.04 s: 3 frames in one row, at 1, 1.25, 2.083 s.')
      expect(result.content).toMatch(/3 cuts in the part, and the sheet leaves out .*, from 3 s on: .*`start` 3\./)
      expect(shown).toHaveLength(1)
      // The loudness is of the part of the sheet.
      expect(ffmpegRuns()[2].args).toStrictEqual(audioViewArgs('b.mp4', { start: 1, end: 5.04 }, null))
      expect(result.content).toContain('Loudness of 1 s to 5.04 s: ')
    })

    it('shows the first frame alone for a clip of one shot', async () => {
      frameSheetLog = showinfoLog([0])

      const result = await assetView({ assets: '@b', scenes: true })

      expect(ffmpegRuns()[1].args[ffmpegRuns()[1].args.indexOf('-vf') + 1]).toMatch(/^select='if\(eq\(selected_n\\,0\)\\,gte\(t\\,0\.000\)\\,0\)',showinfo,.*tile=1x1:nb_frames=1:/)
      expect(result.content).toContain('Frame sheet of the shots of 0 s to 5.04 s: 1 frame in one row, at 0 s.')
      expect(result.content).toContain('Dez found no cut in the part.')
    })

    it('gives the loudness of the sound of a video clip with no picture', async () => {
      probes['b.mp4'] = probed([AUDIO_STREAM])

      const result = await assetView({ assets: '@b' })

      expect(result.content.split('\n').slice(1, 3)).toStrictEqual([NO_VIDEO_STREAM_NOTE, expect.stringMatching(/^Loudness of 0 s to 5\.04 s: /)])
      expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null)])
    })

    it('gives no loudness, and no note about it, for a video clip with no sound', async () => {
      probes['b.mp4'] = probed([VIDEO_STREAM])

      const result = await assetView({ assets: '@b' })

      expect(result.content.split('\n').slice(0, 3)).toStrictEqual([
        '@b | video | MP4 | 5.04 s | 854x480 | 24 fps | h264 | no sound | 1.2 MB',
        expect.stringMatching(/^Frame sheet of 0 s to 5\.04 s: /),
        expect.stringMatching(/^You see each picture /),
      ])
      expect(ffmpegRuns()).toHaveLength(1)
    })

    // ffmpeg reads no sample of the sound in the part (it ends before the
    // part), and its ebur128 still logs a summary, of nothing.
    it('tells of a part in which the sound of a clip has no sample, with no loudness and no failure', async () => {
      soundLog = '[fc#0 @ 0x4] [ao0->#0:0 @ 0x5] No filtered frames for output stream, trying to initialize anyway.\n'
        + EBUR128.replace('-23.1', '-70.0').replace('-18.8', '0.0')

      const video = await assetView({ assets: '@b', start: 3 })

      expect(video.content).toContain(soundlessPartNote({ start: 3, end: 5.04 }, 'none'))
      expect(video.content).not.toContain('LUFS')
      expect(shown.map(labelId)).toStrictEqual(['@b'])

      // With the wave, the run fails, as it has no picture to write.
      soundEnd = { kind: 'exited', code: 234 }
      const audio = await assetView({ assets: '@d', start: 3 })

      expect(audio.content).toContain(soundlessPartNote({ start: 3, end: 5.04 }, 'wave'))
      expect(audio.content).not.toContain(VIEW_FAILED_NOTE)
      expect(shown).toHaveLength(1)
      expect(consoleError).not.toHaveBeenCalled()
    })

    it('gives the facts and the loudness only, and no picture, to a model that reads no images', async () => {
      sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: MODELS('venice').map((model) => ({ ...model, imageInput: false })) })

      const result = await assetView({ assets: 'a b d' })

      expect(shown).toStrictEqual([])
      expect(drawings).toStrictEqual([])
      // The loudness of each clip, from a run on its sound only.
      expect(result.content.match(/-23\.1 LUFS integrated/g)).toHaveLength(2)
      expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([
        audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null),
        audioViewArgs('d.wav', { start: 0, end: 5.04 }, null),
      ])
      expect(native.readFiles).toStrictEqual([])
      expect(result.content).not.toContain('Picture budget')
    })

    it('makes no picture when the budget of the reply has no picture left, and tells which assets got none', async () => {
      budget = { ...budget, pictures: 1 }

      const result = await assetView({ assets: 'a b d' })

      expect(shown.map(({ picture }) => picture.mediaType)).toStrictEqual(['image/png'])
      // The clips still get their loudness, from runs on their sound only.
      expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([
        audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null),
        audioViewArgs('d.wav', { start: 0, end: 5.04 }, null),
      ])
      expect(result.content.match(/-23\.1 LUFS integrated/g)).toHaveLength(2)
      expect(result.content.split(PICTURE_LIMIT_NOTE)).toHaveLength(3)
      expect(result.content.split('\n').at(-1)).toBe('Picture budget left in this reply: 0 pictures, 56,760 tokens and 20.0 MB of base64.')
    })

    it('shows each picture that fits in the tokens that are left, and tells the cost of each one that does not, with no line about its picture', async () => {
      budget = { ...budget, tokens: 500 }

      const result = await assetView({ assets: 'a b d' })

      expect(shown.map(labelId)).toStrictEqual(['@b'])
      expect(result.content).toContain(pictureCostNote({ tokens: 648, bytes: 4, pictures: 1 }, budget))
      expect(result.content).toContain(pictureCostNote({ tokens: 232, bytes: 80, pictures: 1 }, { tokens: 45, bytes: budget.bytes - 80, pictures: 19 }))
      expect(result.content).toMatch(/^Frame sheet of /m)
      expect(result.content).not.toContain('Wave picture of')
      expect(result.content).toMatch(/-23\.1 LUFS integrated/)
      expect(result.content.split('\n').at(-1)).toBe('Picture budget left in this reply: 19 pictures, 45 tokens and 20.0 MB of base64.')
    })

    it.each([
      ['a file that is too large as a copy of the same size', 'review', 4_000_000, { width: 1000, height: 500 }, { width: 1000, height: 500 }],
      ['a picture with a long side over 1568 pixels at that side, for review', 'review', 3, { width: 3001, height: 1500 }, { width: 1568, height: 784 }],
      ['a picture with a long side over 3000 pixels at that side, for full', 'full', 3, { width: 1500, height: 3001 }, { width: 1500, height: 3000 }],
    ] as const)('sends %s, as a JPEG copy on white', async (_case, detail, bytes, size, drawn) => {
      readImage = async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      storedImageSize = size

      const result = await assetView({ assets: 'a', detail })

      expect(drawings).toStrictEqual([{
        drawing: { crop: { x: 0, y: 0, ...size }, ...drawn, background: '#ffffff', mediaType: 'image/jpeg' },
        mediaType: 'image/png',
      }])
      expect(shown.map(({ picture, size }) => ({ mediaType: picture.mediaType, size }))).toStrictEqual([{ mediaType: 'image/jpeg', size: drawn }])
      expect(result.content).toContain(jpegCopyNote(drawn, size, detail))
    })

    it('sends an image of more than 1568 pixels as it is for full detail', async () => {
      storedImageSize = { width: 2000, height: 1000 }

      await assetView({ assets: 'a', detail: 'full' })

      expect(drawings).toStrictEqual([])
      expect(shown.map(({ picture, size }) => ({ picture, size }))).toStrictEqual([
        { picture: { mediaType: 'image/png', bytes: FOX_BYTES }, size: { width: 2000, height: 1000 } },
      ])
    })

    it('sends an SVG image as a PNG drawing at its own size, when the drawing is not too large', async () => {
      readImage = async () => new Blob(['<svg/>'], { type: 'image/svg+xml' })
      drawingBytes = () => 3_750_000

      await assetView({ assets: 'a' })

      expect(drawings).toStrictEqual([{ drawing: { crop: { x: 0, y: 0, width: 1000, height: 500 }, width: 1000, height: 500, mediaType: 'image/png' }, mediaType: 'image/png' }])
      expect(shown.map(({ picture }) => picture.mediaType)).toStrictEqual(['image/png'])
    })

    it('sends an SVG image whose PNG drawing is too large as a JPEG copy on white', async () => {
      readImage = async () => new Blob(['<svg/>'], { type: 'image/svg+xml' })
      drawingBytes = (_drawing, mediaType) => mediaType === 'image/png' ? 3_750_001 : 1

      const result = await assetView({ assets: 'a' })

      const crop = { x: 0, y: 0, width: 1000, height: 500 }
      expect(drawings).toStrictEqual([
        { drawing: { crop, width: 1000, height: 500, mediaType: 'image/png' }, mediaType: 'image/png' },
        { drawing: { crop, width: 1000, height: 500, background: '#ffffff', mediaType: 'image/jpeg' }, mediaType: 'image/jpeg' },
      ])
      expect(shown.map(({ picture }) => picture.mediaType)).toStrictEqual(['image/jpeg'])
      expect(result.content).toContain(jpegCopyNote(crop, crop, 'review'))
    })

    it('draws a JPEG copy that is still too large again at 2048, 1568, then 1024 pixels, until it fits', async () => {
      readImage = async () => new Blob([new Uint8Array(4_000_000)], { type: 'image/png' })
      storedImageSize = { width: 3000, height: 1500 }
      drawingBytes = (drawing) => drawing.width > 1024 ? 3_750_001 : 1

      const result = await assetView({ assets: 'a', detail: 'full' })

      expect(drawings.map(({ drawing, mediaType }) => [drawing.width, drawing.height, drawing.mediaType, mediaType])).toStrictEqual([
        [3000, 1500, 'image/jpeg', 'image/png'],
        [2048, 1024, 'image/jpeg', 'image/jpeg'],
        [1568, 784, 'image/jpeg', 'image/jpeg'],
        [1024, 512, 'image/jpeg', 'image/jpeg'],
      ])
      expect(shown.map(({ size }) => size)).toStrictEqual([{ width: 1024, height: 512 }])
      expect(result.content).toContain(jpegCopyNote({ width: 1024, height: 512 }, storedImageSize, 'full'))
    })

    it('sends no picture of an image whose smallest JPEG copy is still too large, and logs it', async () => {
      storedImageSize = { width: 3000, height: 1500 }
      drawingBytes = () => 3_750_001

      const result = await assetView({ assets: 'a' })

      expect(drawings.map(({ drawing }) => drawing.width)).toStrictEqual([1568, 1024])
      expect(result).toStrictEqual({ content: `@a | image | PNG | 3000x1500 | 3 B\n${PICTURE_TOO_LARGE_NOTE}\n${FULL_BUDGET_LINE}`, isError: false })
      expect(shown).toStrictEqual([])
      expect(consoleError).toHaveBeenCalledWith('The smallest picture of the image @a has 3750001 bytes, more than Dez sends.')
    })

    it.each([
      ['at its own pixels', 'review', { width: 1000, height: 500 }, '0.5 0 0.5 0.5', { x: 500, y: 0, width: 500, height: 250 }, { width: 500, height: 250 }],
      ['as a smaller copy at the side of review', 'review', { width: 4000, height: 2000 }, '0 0 1 0.5', { x: 0, y: 0, width: 4000, height: 1000 }, { width: 1568, height: 392 }],
      ['as a smaller copy at the side of full', 'full', { width: 4000, height: 2000 }, '0 0 1 0.5', { x: 0, y: 0, width: 4000, height: 1000 }, { width: 3000, height: 750 }],
    ] as const)('shows a crop of an image %s, as a PNG for a PNG, and tells which part it is', async (_case, detail, size, crop, region, picture) => {
      storedImageSize = size

      const result = await assetView({ assets: '@a', crop, detail })

      expect(drawings).toStrictEqual([{ drawing: { crop: region, ...picture, mediaType: 'image/png' }, mediaType: 'image/png' }])
      const texts = cropTexts('a', region, picture, detail)
      expect(shown.map(({ label, picture, size }) => ({ label, mediaType: picture.mediaType, size }))).toStrictEqual([
        { label: `asset_view: ${texts.shows}.`, mediaType: 'image/png', size: picture },
      ])
      expect(result.content).toContain(texts.note)
    })

    it('sends a crop whose PNG drawing is too large as a JPEG copy of the same part', async () => {
      drawingBytes = (_drawing, mediaType) => mediaType === 'image/png' ? 3_750_001 : 1

      const result = await assetView({ assets: '@a', crop: '0.5 0 0.5 0.5' })

      const region = { x: 500, y: 0, width: 500, height: 250 }
      expect(drawings.map(({ drawing }) => drawing)).toStrictEqual([
        { crop: region, width: 500, height: 250, mediaType: 'image/png' },
        { crop: region, width: 500, height: 250, background: '#ffffff', mediaType: 'image/jpeg' },
      ])
      expect(shown.map(({ picture }) => picture.mediaType)).toStrictEqual(['image/jpeg'])
      expect(result.content).toContain(cropTexts('a', region, { width: 500, height: 250 }, 'review').note)
    })

    it('refuses a crop of a clip, and a crop of less than one pixel of the image', async () => {
      expect(await assetView({ assets: '@b', crop: '0 0 0.5 0.5' })).toStrictEqual({ content: cropOfClipText('b', 'video'), isError: true })
      expect(native.runs).toStrictEqual([])

      expect(await assetView({ assets: '@a', crop: '0.5 0 0.0004 1' })).toStrictEqual({ content: cropUnderPixelText('a', storedImageSize), isError: true })
      expect(drawings).toStrictEqual([])
      expect(shown).toStrictEqual([])
    })

    it.each([['review', 320], ['full', 640]] as const)('fits each frame of a sheet in the box of %s detail', async (detail, box) => {
      await assetView({ assets: '@b', detail })

      expect(ffmpegRuns()[0].args.join(' ')).toContain(`scale=w=${box}:h=${box}:`)
    })

    it('sends no frame sheet whose file is too large, and tells the argument that makes a smaller one', async () => {
      const sheet = new Uint8Array(3_750_001)
      sheet.set(SHEET_JPEG)
      native.fileBytes = ({ path }) => path.endsWith('-frames.jpg') ? sheet : new Uint8Array()

      expect((await assetView({ assets: '@b', detail: 'full' })).content).toContain(sheetTooLargeNote('full', 'frames'))
      expect((await assetView({ assets: '@b', times: '1 2' })).content).toContain(sheetTooLargeNote('review', 'times'))
      expect(shown).toStrictEqual([])
    })

    it('sends no picture of an image that the webview cannot decode, or of a clip that ffmpeg cannot read, and shows the others', async () => {
      redrawError = new Error('The image cannot be decoded.')
      frameSheetEnd = { kind: 'exited', code: 1 }

      const result = await assetView({ assets: 'a b d' })

      expect(result.content).toContain('@a | image | PNG | 3 B | Dez could not read its picture')
      expect(shown.map(labelId)).toStrictEqual(['@d'])
    })

    it('keeps the size of an image that the webview decoded but could not draw, and tells why it sends no picture', async () => {
      storedImageSize = { width: 8192, height: 4096 }
      drawError = new Error('No canvas to draw the image on.')

      expect(await assetView({ assets: 'a' })).toStrictEqual({ content: `@a | image | PNG | 8192x4096 | 3 B\n${PICTURE_NOT_DRAWN_NOTE}\n${FULL_BUDGET_LINE}`, isError: false })
      expect(shown).toStrictEqual([])
    })

    it('tells of a part with no frame, and shows no picture for it', async () => {
      frameSheetLog = 'No filtered frames for output stream, trying to initialize anyway.\nNothing was written into output file'
      frameSheetEnd = { kind: 'exited', code: 234 }

      const result = await assetView({ assets: 'b' })

      expect(result.isError).toBe(false)
      expect(result.content).toContain('No frame sheet: ffmpeg found no frame in 0 s to 5.04 s of the clip.')
      expect(shown).toStrictEqual([])
    })

    // The facts of such a clip tell what happened, and the result has no
    // details of the read.
    it('tells only what to do about a clip that Dez cannot read, and runs no program for it', async () => {
      native.fileSize = () => null

      expect(await assetView({ assets: 'c d' })).toStrictEqual({
        content: [
          `@c | audio | ${clipNotReadFacts('deleted')}`,
          clipNotReadNote('c', 'deleted'),
          `@d | audio | ${clipNotReadFacts('unreadable')}`,
          clipNotReadNote('d', 'unreadable'),
          FULL_BUDGET_LINE,
        ].join('\n'),
        isError: false,
      })
      expect(native.runs).toStrictEqual([])
      expect(shown).toStrictEqual([])
    })

    it('tells that Dez could not read a picture that ffmpeg made, not that ffmpeg could not read the clip, and keeps the loudness', async () => {
      native.fileBytes = () => {
        throw new Error('No such file')
      }

      const result = await assetView({ assets: 'b d' })

      expect(result.content.split('\n').filter((line) => line === PICTURE_NOT_READ_NOTE)).toHaveLength(2)
      expect(result.content).not.toContain(VIEW_FAILED_NOTE)
      expect(result.content).toMatch(/-23\.1 LUFS integrated/)
      expect(shown).toStrictEqual([])
    })

    it('tells a damaged clip that gives no frame as a view that failed, not as a part with no frame, logs the cause, and runs nothing more on it', async () => {
      frameSheetLog = 'Cannot determine format of input 0:0 after EOF\nNothing was written into output file'
      frameSheetEnd = { kind: 'exited', code: 183 }

      const result = await assetView({ assets: 'b' })

      expect(result.content).toContain(VIEW_FAILED_NOTE)
      expect(result.content).not.toContain('No frame sheet')
      expect(consoleError).toHaveBeenCalledWith('ffmpeg could not make the view of the video clip @b:', frameSheetEnd, frameSheetLog)
      expect(shown).toStrictEqual([])
      expect(ffmpegRuns()).toHaveLength(1)
    })

    it('refuses an id that names no asset, and a start after the end of a clip shows none of it', async () => {
      expect(await assetView({ assets: '@a @z' })).toStrictEqual({
        content: expect.stringMatching(/^@z names no image and no clip of this conversation\. Dez showed nothing\./),
        isError: true,
      })
      expect(readImages).toStrictEqual([])
      expect(native.runs).toStrictEqual([])

      const result = await assetView({ assets: 'b', start: 6 })
      expect(result.content).toMatch(/`start` \(6 s\) is not before the end of the clip \(5\.04 s\)/)
      expect(ffmpegRuns()).toStrictEqual([])
      expect(shown).toStrictEqual([])
    })

    describe('with `sound_picture`', () => {
      const SHEET_NOTE = 'Frame sheet of 0 s to 2.5 s: 3 frames in one row, at 0.417, 1.25, 2.083 s.'
      // The file that the webview composes of the frame sheet and its strip
      // (`soundStripLayout`).
      const SHEET_WITH_STRIP_JPEG = jpegHeader(968, 528)

      it('shows the spectrogram of an audio clip with its axes, and tells the time of a later part', async () => {
        const result = await assetView({ assets: '@d', sound_picture: 'Spectrogram', start: 1 })

        expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([
          audioViewArgs('d.wav', { start: 1, end: 5.04 }, { kind: 'spectrogram', output: 'd-spectrogram.jpg', strip: null }),
        ])
        expect(shown).toStrictEqual([{
          label: 'asset_view: the spectrogram of the audio clip @d, 1 s to 5.04 s, time runs left to right and the frequency bottom to top.',
          picture: { mediaType: 'image/jpeg', bytes: SPECTROGRAM_JPEG },
          size: { width: 1084, height: 328 },
        }])
        expect(result.content).toMatch(/^Spectrogram of 1 s to 5\.04 s: 1084x328 pixels, .*\(add 1 s for the time in the clip\)/m)
        expect(result.content).toMatch(/-23\.1 LUFS integrated/)
      })

      it('gives an audio clip with "none" its loudness only, and no note of a picture over the budget', async () => {
        const result = await assetView({ assets: '@d', sound_picture: 'none' })

        expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([audioViewArgs('d.wav', { start: 0, end: 5.04 }, null)])
        expect(shown).toStrictEqual([])
        expect(native.readFiles).toStrictEqual([])
        expect(result.content.split('\n').slice(1)).toStrictEqual([expect.stringMatching(/^Loudness of 0 s to 5\.04 s: /), FULL_BUDGET_LINE])

        budget = { ...budget, pictures: 0 }
        expect((await assetView({ assets: '@d', sound_picture: 'none' })).content).not.toContain(PICTURE_LIMIT_NOTE)
        expect((await assetView({ assets: '@d' })).content).toContain(PICTURE_LIMIT_NOTE)
      })

      it('tells which picture of the sound a clip with no sound does not get', async () => {
        probes['d.wav'] = probed([VIDEO_STREAM])
        probes['b.mp4'] = probed([VIDEO_STREAM])

        expect((await assetView({ assets: '@d', sound_picture: 'spectrogram' })).content).toContain(noSoundNote('spectrogram', true))
        expect((await assetView({ assets: '@d', sound_picture: 'none' })).content).toContain(noSoundNote('none', true))
        const video = await assetView({ assets: '@b', sound_picture: 'wave' })

        expect(video.content).toContain(noSoundNote('wave', false))
        // The frame sheet only.
        expect(ffmpegRuns()).toHaveLength(1)
        expect(shown.map(({ picture }) => picture.bytes)).toStrictEqual([SHEET_JPEG])
      })

      it('draws the wave of a video clip as a strip under its frame sheet, at the width of the sheet, in one picture', async () => {
        const result = await assetView({ assets: '@b', frames: 3, end: 2.5, sound_picture: 'wave' })

        const strip = { width: 968, height: 160 }
        expect(ffmpegRuns()[1].args).toStrictEqual(audioViewArgs('b.mp4', { start: 0, end: 2.5 }, { kind: 'wave', output: 'b-wave-strip.jpg', strip }))
        expect(compositions).toStrictEqual([{
          files: [{ type: 'image/jpeg', bytes: SHEET_JPEG }, { type: 'image/jpeg', bytes: STRIP_JPEG }],
          composition: soundStripLayout([{ width: 968, height: 364 }, strip]),
        }])
        expect(shown).toStrictEqual([{
          label: `asset_view: ${SHEET_SHOWS}; under the frames, the wave of its sound, 0 s to 2.5 s, time runs left to right.`,
          picture: { mediaType: 'image/jpeg', bytes: SHEET_WITH_STRIP_JPEG },
          size: { width: 968, height: 528 },
        }])
        const lines = result.content.split('\n')
        expect(lines.slice(1, 3)).toStrictEqual([
          `${SHEET_NOTE} `
            + 'Under the frames: the wave of the sound of 0 s to 2.5 s, a strip of 968x160 pixels; '
            + 'time runs left to right over the whole width of the sheet, and the height is the peak level on a square-root scale.',
          expect.stringMatching(/^Loudness of 0 s to 2\.5 s: /),
        ])
        // The cost of the whole picture: 665 tokens, and 80 bytes of base64.
        expect(lines.at(-1)).toBe('Picture budget left in this reply: 19 pictures, 56,743 tokens and 20.0 MB of base64.')
      })

      it('draws a spectrogram strip at the height of `detail`, and tells its frequency range from the sample rate', async () => {
        const result = await assetView({ assets: '@b', detail: 'full', sound_picture: 'spectrogram' })

        expect(ffmpegRuns()[1].args).toStrictEqual(audioViewArgs('b.mp4', { start: 0, end: 5.04 }, {
          kind: 'spectrogram', output: 'b-spectrogram-strip.jpg', strip: { width: 968, height: 320 },
        }))
        expect(result.content).toMatch(/Under the frames: the spectrogram of the sound of 0 s to 5\.04 s, .* from 0 to 24,000 Hz on a linear scale/)
      })

      it('sends the frame sheet alone, with a note in the line of the sheet, when the strip cannot be read, drawn, or sent', async () => {
        const view = async () => {
          shown = []
          return (await assetView({ assets: '@b', frames: 3, end: 2.5, sound_picture: 'wave' })).content.split('\n')[1]
        }
        const sheetOnly = [{ label: `asset_view: ${SHEET_SHOWS}.`, picture: { mediaType: 'image/jpeg', bytes: SHEET_JPEG }, size: { width: 968, height: 364 } }]

        native.fileBytes = ({ path }) => {
          if (path.endsWith('-strip.jpg')) throw new Error('No such file')
          return SHEET_JPEG
        }
        expect(await view()).toBe(`${SHEET_NOTE} ${soundStripFailedNote('wave')}`)
        expect(shown).toStrictEqual(sheetOnly)
        expect(compositions).toStrictEqual([])

        native.fileBytes = ({ path }) => path.endsWith('-strip.jpg') ? STRIP_JPEG : SHEET_JPEG
        drawError = new Error('No canvas to draw the image on.')
        expect(await view()).toBe(`${SHEET_NOTE} ${soundStripFailedNote('wave')}`)
        expect(shown).toStrictEqual(sheetOnly)
        expect(consoleError).toHaveBeenCalledWith('Failed to draw the wave strip of the video clip @b under its frame sheet:', drawError)

        drawError = undefined
        composedBytes = () => 3_750_001
        expect(await view()).toBe(`${SHEET_NOTE} ${soundStripTooLargeNote('wave', 'review')}`)
        expect(shown).toStrictEqual(sheetOnly)
      })

      it('tells of no strip of a frame sheet that does not go: over the budget, or in a grid that does not go', async () => {
        native.fileBytes = ({ path }) => {
          if (path.endsWith('-strip.jpg')) throw new Error('No such file')
          return SHEET_JPEG
        }
        // The sheet costs 455 tokens, and the grid 700.
        budget = { ...budget, tokens: 400 }

        const alone = await assetView({ assets: '@b', frames: 3, end: 2.5, sound_picture: 'wave' })
        const grid = await assetView({ assets: '@a @b', layout: 'grid', frames: 3, end: 2.5, sound_picture: 'wave' })

        expect(shown).toStrictEqual([])
        expect(alone.content).toContain(pictureCostNote({ tokens: 455, bytes: 80, pictures: 1 }, budget))
        expect(grid.content).toContain(gridCostNote(['a', 'b'], { tokens: 700, bytes: 80, pictures: 1 }, budget))
        for (const { content } of [alone, grid]) {
          expect(content).not.toContain(soundStripFailedNote('wave'))
          expect(content).not.toContain(SHEET_NOTE)
          expect(content).toMatch(/^Loudness of 0 s to 2\.5 s: /m)
        }
      })

      it('shows the sound picture of a video clip with no frame sheet as a picture of its own', async () => {
        probes['b.mp4'] = probed([AUDIO_STREAM])

        const result = await assetView({ assets: '@b', sound_picture: 'spectrogram' })

        expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([
          audioViewArgs('b.mp4', { start: 0, end: 5.04 }, { kind: 'spectrogram', output: 'b-spectrogram.jpg', strip: null }),
        ])
        expect(compositions).toStrictEqual([])
        expect(shown).toStrictEqual([{
          label: 'asset_view: the spectrogram of the video clip @b, 0 s to 5.04 s, time runs left to right and the frequency bottom to top.',
          picture: { mediaType: 'image/jpeg', bytes: SPECTROGRAM_JPEG },
          size: { width: 1084, height: 328 },
        }])
        expect(result.content).toContain(NO_VIDEO_STREAM_NOTE)

        budget = { ...budget, pictures: 0 }
        expect((await assetView({ assets: '@b', sound_picture: 'spectrogram' })).content).toContain(PICTURE_LIMIT_NOTE)
        expect((await assetView({ assets: '@b' })).content).not.toContain(PICTURE_LIMIT_NOTE)
      })

      it('puts the frame sheet with its strip into a grid as one piece', async () => {
        const result = await assetView({ assets: '@a @b', layout: 'grid', frames: 3, end: 2.5, sound_picture: 'wave' })

        // The sheet with its strip, then the grid of the image and that
        // picture, at its own size on a line of its own, 16 pixels under the
        // image.
        expect(compositions.map(({ files }) => files.map(({ bytes }) => bytes))).toStrictEqual([[SHEET_JPEG, STRIP_JPEG], [FOX_BYTES, SHEET_WITH_STRIP_JPEG]])
        expect(compositions[1].composition.places).toStrictEqual([{ x: 0, y: 0, width: 320, height: 160 }, { x: 0, y: 176, width: 968, height: 528 }])
        expect(shown.map(({ label, size }) => ({ label, size }))).toStrictEqual([{
          label: `asset_view: a grid, top to bottom: the image @a; ${SHEET_SHOWS}; under the frames, the wave of its sound, 0 s to 2.5 s, time runs left to right.`,
          size: { width: 968, height: 704 },
        }])
        expect(result.content).toMatch(/^Frame sheet of 0 s to 2\.5 s: .* Under the frames: the wave of the sound of 0 s to 2\.5 s, a strip of 968x160 pixels; /m)
      })
    })

    describe('with `layout` "grid"', () => {
      const GRID_PICTURE = { mediaType: 'image/jpeg', bytes: jpegHeader(968, 540) }

      it('draws the images and the frame sheets in one picture after the others, and gives the note of each sheet with its clip', async () => {
        const result = await assetView({ assets: '@a @d @b', layout: 'grid', frames: 3, end: 2.5 })

        expect(result.isError).toBe(false)
        // The image in the frame box (320 pixels), then the sheet, 16
        // pixels under it.
        expect(compositions).toStrictEqual([{
          files: [{ type: 'image/png', bytes: FOX_BYTES }, { type: 'image/jpeg', bytes: SHEET_JPEG }],
          composition: {
            width: 968,
            height: 540,
            places: [{ x: 0, y: 0, width: 320, height: 160 }, { x: 0, y: 176, width: 968, height: 364 }],
            background: '#ffffff',
            mediaType: 'image/jpeg',
            scale: 1,
            imagesSmaller: true,
          },
        }])
        expect(drawings).toStrictEqual([])
        expect(shown).toStrictEqual([
          { label: 'asset_view: the wave of the audio clip @d, 0 s to 2.5 s, time runs left to right.', picture: { mediaType: 'image/jpeg', bytes: WAVE_JPEG }, size: { width: 800, height: 200 } },
          { label: `asset_view: a grid, top to bottom: the image @a; ${SHEET_SHOWS}.`, picture: GRID_PICTURE, size: { width: 968, height: 540 } },
        ])
        const lines = result.content.split('\n')
        expect(lines[0]).toBe('@a | image | PNG | 1000x500 | 3 B')
        expect(lines[1]).toMatch(/^@d \| audio \| /)
        expect(lines[2]).toMatch(/^Wave picture of /)
        expect(lines.slice(4, 8)).toStrictEqual([
          expect.stringMatching(/^@b \| video \| /),
          'Frame sheet of 0 s to 2.5 s: 3 frames in one row, at 0.417, 1.25, 2.083 s.',
          expect.stringMatching(/^Loudness of 0 s to 2\.5 s: /),
          expect.stringMatching(new RegExp(`^Grid picture of 968x540 pixels, top to bottom: the image @a; ${SHEET_SHOWS.replaceAll('.', '\\.')}\\. Each image fits in 320 by 320 pixels`)),
        ])
        expect(lines[8]).toMatch(/^You see each picture /)
        // 232 + 700 tokens, and 80 + 4 bytes of base64.
        expect(lines[9]).toBe('Picture budget left in this reply: 18 pictures, 56,476 tokens and 20.0 MB of base64.')
        expect(result.pictures).toStrictEqual([
          { file: expect.stringMatching(/\.jpg$/), label: shown[0].label, width: 800, height: 200, bytes: WAVE_JPEG.length },
          { file: expect.stringMatching(/\.jpg$/), label: shown[1].label, width: 968, height: 540, bytes: GRID_PICTURE.bytes.length },
        ])
      })

      it('shows separate pictures for fewer than 2 images and video clips', async () => {
        const result = await assetView({ assets: '@a @d', layout: 'grid' })

        expect(compositions).toStrictEqual([])
        expect(shown.map(labelId)).toStrictEqual(['@a', '@d'])
        expect(result.content).not.toContain('Grid picture')
      })

      it('shows the image that is left of a grid whose clip gave no sheet as `separate` does, at its own size', async () => {
        frameSheetEnd = { kind: 'exited', code: 1 }

        const result = await assetView({ assets: '@a @b', layout: 'grid' })

        expect(compositions).toStrictEqual([])
        expect(shown).toStrictEqual([
          { label: 'asset_view: the image @a.', picture: { mediaType: 'image/png', bytes: FOX_BYTES }, size: { width: 1000, height: 500 } },
        ])
        expect(result.content).not.toContain('Grid picture')
        // 648 tokens and 4 bytes of base64.
        expect(result.content.split('\n').at(-1)).toBe('Picture budget left in this reply: 19 pictures, 56,760 tokens and 20.0 MB of base64.')
      })

      it('shows the frame sheet that is left of a grid whose image the webview cannot decode as `separate` does, with its note', async () => {
        redrawError = new Error('The image cannot be decoded.')

        const result = await assetView({ assets: '@a @b', layout: 'grid', frames: 3, end: 2.5 })

        expect(compositions).toStrictEqual([])
        expect(shown).toStrictEqual([
          { label: `asset_view: ${SHEET_SHOWS}.`, picture: { mediaType: 'image/jpeg', bytes: SHEET_JPEG }, size: { width: 968, height: 364 } },
        ])
        expect(result.content.split('\n').slice(1)).toStrictEqual([
          expect.stringMatching(/^@b \| video \| /),
          'Frame sheet of 0 s to 2.5 s: 3 frames in one row, at 0.417, 1.25, 2.083 s.',
          expect.stringMatching(/^Loudness of 0 s to 2\.5 s: /),
          expect.stringMatching(/^You see each picture /),
          // 455 tokens and 80 bytes of base64.
          'Picture budget left in this reply: 19 pictures, 56,953 tokens and 20.0 MB of base64.',
        ])
      })

      it('makes no grid when the budget has no picture left, and tells each asset that got none', async () => {
        budget = { ...budget, pictures: 0 }

        const result = await assetView({ assets: '@a @b', layout: 'grid' })

        expect(compositions).toStrictEqual([])
        expect(shown).toStrictEqual([])
        expect(result.content.split(PICTURE_LIMIT_NOTE)).toHaveLength(3)
        expect(ffmpegRuns().map(({ args }) => args)).toStrictEqual([audioViewArgs('b.mp4', { start: 0, end: 5.04 }, null)])
      })

      it('draws no grid when the other pictures of the call spent the last picture of the budget, and tells each asset of the grid', async () => {
        budget = { ...budget, pictures: 1 }

        const result = await assetView({ assets: '@a @d @b', layout: 'grid', frames: 3, end: 2.5 })

        expect(compositions).toStrictEqual([])
        expect(shown.map(labelId)).toStrictEqual(['@d'])
        const lines = result.content.split('\n')
        expect(lines[1]).toBe(PICTURE_LIMIT_NOTE)
        expect(lines.slice(5)).toStrictEqual([
          expect.stringMatching(/^@b \| video \| /),
          expect.stringMatching(/^Loudness of 0 s to 2\.5 s: /),
          PICTURE_LIMIT_NOTE,
          expect.stringMatching(/^You see each picture /),
          // 232 tokens and 80 bytes of base64 for the wave.
          'Picture budget left in this reply: 0 pictures, 57,176 tokens and 20.0 MB of base64.',
        ])
      })

      it('draws no grid for a call that the user stopped during its last asset', async () => {
        const stop = new AbortController()
        readImage = async () => {
          stop.abort()
          return new Blob([FOX_BYTES], { type: 'image/png' })
        }

        const result = await assetView({ assets: '@b @a', layout: 'grid' }, { signal: stop.signal })

        expect(result.isError).toBe(true)
        expect(compositions).toStrictEqual([])
        expect(shown).toStrictEqual([])
      })

      it('tells the cost of a grid that does not fit in the tokens that are left, after the pictures that fit, with no sheet note', async () => {
        budget = { ...budget, tokens: 800 }

        const result = await assetView({ assets: '@a @d @b', layout: 'grid', frames: 3, end: 2.5 })

        expect(shown.map(labelId)).toStrictEqual(['@d'])
        expect(result.content).toContain(gridCostNote(['a', 'b'], { tokens: 700, bytes: 80, pictures: 1 }, { tokens: 568, bytes: budget.bytes - 80, pictures: 19 }))
        expect(result.content).not.toContain('Frame sheet of')
        expect(result.content.split('\n').at(-1)).toBe('Picture budget left in this reply: 19 pictures, 568 tokens and 20.0 MB of base64.')
      })

      it('tells of a grid that the webview could not draw, and logs the cause', async () => {
        drawError = new Error('No canvas to draw the image on.')

        const result = await assetView({ assets: '@a @b', layout: 'grid' })

        expect(shown).toStrictEqual([])
        expect(result.content).toContain(gridNotDrawnNote(['a', 'b']))
        expect(result.content.split('\n').at(-1)).toBe(FULL_BUDGET_LINE)
        expect(consoleError).toHaveBeenCalledWith('Failed to draw the grid picture of @a @b:', drawError)
      })

      it('tells of a grid whose copy Dez could not save, with no sheet note and no grid line, and gives its cost back', async () => {
        native.saveAppFile = async () => {
          throw new Error('No space left on device')
        }

        const result = await assetView({ assets: '@a @b', layout: 'grid', frames: 3, end: 2.5 })

        expect(result.pictures).toBeUndefined()
        const lines = result.content.split('\n')
        expect(lines).toContain(gridNotSavedNote(['a', 'b']))
        expect(result.content).not.toMatch(/^(Frame sheet of|Grid picture of) /m)
        expect(lines.at(-1)).toBe(FULL_BUDGET_LINE)
      })

      it('draws a grid whose file is too large again at a smaller side until it fits, else sends none', async () => {
        // A sheet of 4 columns of frames of 640 pixels.
        const sheet = jpegHeader(2572, 1000)
        native.fileBytes = ({ path }) => path.endsWith('-frames.jpg') ? sheet : new Uint8Array()
        composedBytes = (composition) => composition.width > 1024 ? 3_750_001 : 1

        const result = await assetView({ assets: '@a @b', layout: 'grid' })

        // 2572 by 1176 pixels of parts, at 1568, then 1024, on the longer
        // side.
        expect(compositions.map(({ composition: { width, height } }) => `${width}x${height}`)).toStrictEqual(['1568x717', '1024x468'])
        expect(shown.map(({ size }) => size)).toStrictEqual([{ width: 1024, height: 468 }])
        expect(result.content).toMatch(/^Grid picture of 1024x468 pixels, .* The whole grid is a smaller copy, at 39% of the size of its parts\./m)

        compositions = []
        shown = []
        composedBytes = () => 3_750_001
        const tooLarge = await assetView({ assets: '@a @b', layout: 'grid' })

        expect(compositions.map(({ composition: { width } }) => width)).toStrictEqual([1568, 1024])
        expect(shown).toStrictEqual([])
        expect(tooLarge.content).toContain(gridTooLargeNote(['a', 'b']))
        expect(consoleError).toHaveBeenCalledWith('The smallest grid picture of @a @b has 3750001 bytes, more than Dez sends.')
      })
    })
  })

  describe('conversation_info', () => {
    const BUDGET: PictureBudget = { pictures: 12, tokens: 57_408, bytes: 3 * 1024 ** 2 }
    const WINDOW = contextWindowOf({ id: REPLY_MODEL.modelId })
    let tabId: string
    let jobs: ReplyJobs
    // How many times the call asked for the picture budget.
    let budgetReads: number

    async function conversationInfo(): Promise<ToolRunResult> {
      const context: ToolRunContext = {
        tabId,
        model: REPLY_MODEL,
        jobs,
        writeImage: () => null,
        writeClip: () => null,
        pictureBudget: async () => {
          budgetReads += 1
          return BUDGET
        },
      }
      return await sbp('dez.controller/tools/run', { name: 'conversation_info', arguments: {} }, new AbortController().signal, context) as ToolRunResult
    }
    const sizeNow = () => sbp('dez.model/tabs/contextSize', tabId, REPLY_MODEL) as ContextSize

    beforeEach(() => {
      jobs = new ReplyJobs()
      budgetReads = 0
      tabId = sbp('dez.model/tabs/activeId') as string
      sbp('dez.model/tabs/replaceSections', tabId, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Make a film for at most 5 dollars.' }] },
        { id: 'a1', role: 'agent', model: REPLY_MODEL, content: [{ kind: 'text', text: '' }] },
      ])
    })

    // Ends the time limits of the jobs that a test left.
    afterEach(() => jobs.stopAll())

    it('tells the numbers of the tab of the call: the size that the provider counted, the window of the model, the cost, and the picture budget', async () => {
      sbp('dez.model/tabs/countRequestCost', tabId, 0.25)
      sbp('dez.model/tabs/countRequestCost', tabId, null)
      sbp('dez.model/tabs/countRequestContext', tabId, REPLY_MODEL, 81_234)

      expect(await conversationInfo()).toStrictEqual({
        content: conversationInfoText({
          contextSize: { tokens: 81_234, estimated: false },
          contextWindow: WINDOW,
          compactions: undefined,
          cost: { usd: 0.25, requests: 2, unpriced: 1 },
          jobs: [],
          pictureBudget: BUDGET,
        }),
        isError: false,
      })
    })

    it('tells the cost since the newest compaction and the size of the whole conversation after a compaction of the tab', async () => {
      sbp('dez.model/tabs/countRequestCost', tabId, 2)
      sbp('dez.model/tabs/compact', tabId, {
        sections: [
          { id: 'notes', role: 'agent', model: REPLY_MODEL, content: [{ kind: 'text', text: '<dez:compaction count="1"/>\nThe notes.' }] },
          { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Make a film for at most 5 dollars.' }] },
          { id: 'a1', role: 'agent', model: REPLY_MODEL, content: [{ kind: 'text', text: '' }] },
        ],
        replySectionId: 'a1',
        tokens: 150_000,
      })
      sbp('dez.model/tabs/countRequestCost', tabId, 0.5)

      const lines = (await conversationInfo()).content.split('\n')

      expect(lines).toContain('Cost of the conversation since its newest compaction (an estimate): $0.50 for 1 request.')
      expect(lines).toContain('Cost of the conversation so far (an estimate): $2.50 for 2 requests.')
      expect(lines.find((line) => line.startsWith('Compactions so far: 1.'))).toContain(`${(150_000 + sizeNow().tokens).toLocaleString('en-US')} tokens`)
    })

    // The window of the model list wins over the one of the family, as in
    // the compaction check of a reply.
    it('counts by the model of the reply as the model list has it, and reads no picture budget for a model that reads no images', async () => {
      sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [{ ...MODELS('venice')[1], contextWindow: 64_000, imageInput: false }] })

      const { content } = await conversationInfo()

      expect(content).toContain('Context window of your model: 64,000 tokens.')
      expect(content).toContain('gets to 41,600 tokens')
      expect(content.split('\n').at(-1)).toBe('Picture budget: none. Your model gets no pictures.')
      expect(budgetReads).toBe(0)
    })

    it('tells the quote of a job that still runs, which the cost of the tab does not hold yet', async () => {
      const film = heldWork()
      jobs.start('model_invoke', film.work, LONG)
      film.reportCost(1.75)

      const { content } = await conversationInfo()

      expect(content).toContain('Cost of the conversation so far: none.')
      expect(content).toContain('$1.75 for 1 job.')
    })

    it('gives an error result for a tab that is gone', async () => {
      tabId = 'gone'

      const result = await conversationInfo()

      expect(result.isError).toBe(true)
      expect(result.content).toContain('The tab of this conversation is closed')
    })
  })
})
