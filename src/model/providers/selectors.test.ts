import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AudioPart, CutAudio } from '../chat/audioCut'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../chat/imageDrawing'
import { ClipReadError } from '../chat/mediaFiles'
import type { ModelRef, Section } from '../chat/types'
import { toolBlockText } from '../chat/toolBlocks'
import type { ModelCache } from '../persistence/types'
import { sectionsToStreamMessages } from '../streams/messages'
import { base64ToBytes, bytesToBase64 } from '../../utils/base64'
import { ExplainedError } from '../../utils/errorText'
import type { NativeHttpDownload, NativeHttpRequest, NativeHttpResponse, NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { NativeHttpError } from '../../utils/protocol/errors'
import type { ClipAttachment, InputClipRules } from './clipInputs'
import type { KnownLimit } from './knownLimits'
import type { ProviderGenerateMediaResult, ProviderMediaQuote } from './streamTypes'
import type { GeneratedMedia, ModelDisplayNames, ProviderModelsResult, ProviderSettingsDescriptor } from './types'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../state/index'
import './selectors'

// The text Rust sends when provider_keys.json does not parse.
const KEY_STORE_ERROR = 'API error: Failed to parse provider_keys.json (line 1, column 2)'

// The text of an image reference whose file Dez cannot read.
const MISSING_IMAGE = (name: string) => `The image file ${name} is missing, or Dez cannot read it. Paste the image again, or remove its reference from the message.`
// The text of a stored SVG that the webview cannot draw as a PNG copy.
const SVG_NOT_DRAWN = (name: string) => `Dez cannot send the SVG image ${name}. Providers take no SVG images, so Dez sends a PNG copy, and it could not draw one: the file can be damaged, or it holds HTML, which a copy may not show. Remove its reference or mention from the message, or paste a PNG copy of the image in its place.`

// Requests the stubs below received, in order.
let httpRequests: NativeHttpRequest[] = []
let streamRequests: NativeHttpRequest[] = []
let streamRequestIds: string[] = []
let imageReads: string[] = []
let downloadRequests: NativeHttpRequest[] = []
// The JSON body of a request that a stand-in got.
const jsonBody = (request: NativeHttpRequest) => JSON.parse(request.body as string) as Record<string, unknown>

// The app folder and its stored images.
const APP_DIR = '/home/u/.config/dez'
const STORED_IMAGE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
const STORED_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30"/>')
// The linked files that dez.controller/images/readFile reads, by path, with
// the type that the asset protocol gives; any other path fails to read.
let linkedImages: Record<string, File> = {}

const dataUrl = (mediaType: string, bytes: Uint8Array) => `data:${mediaType};base64,${bytesToBase64(bytes)}`

// The stand-in of the webview's canvas (dez.controller/images/redraw):
// every stored image has the size `storedImageSize` (null: a file that the
// webview cannot decode), and every drawing is the file `DRAWN_IMAGE`.
// `drawings` holds what each call drew, and the file type that it asked.
let storedImageSize: ImageSize | null
let drawings: Array<[ImageDrawing | null, string]> = []
const DRAWN_IMAGE = Uint8Array.from([1, 2, 3, 4])

// The stand-ins of the webview's clip reads (dez.controller/media/readClip,
// dez.controller/media/cutAudio): each clip is the file of its id in
// `clipFiles`, unless no clip can be read (`clipReadError`). Every audio
// clip is `audioSeconds` long (an error: the webview cannot decode it), and
// its WAV copy is the file `WAV_COPY`. `clipReads` holds the id of each
// clip read, `audioDecodes` counts the decodes, and `audioCuts` holds the
// part of each WAV copy.
let clipFiles: Record<string, Uint8Array> = {}
let clipReadError: ClipReadError | null
let clipReads: string[] = []
let audioSeconds: number | Error
let audioDecodes = 0
let audioCuts: AudioPart[] = []
const WAV_COPY = new TextEncoder().encode('RIFF\x08\x00\x00\x00WAVEfmt ')

// Requests to this base URL get HTTP 404; every other server answers.
const FAILING_BASE_URL = 'http://localhost:9090/v1'
// No server listens at this base URL, so the native layer gets no answer.
const CLOSED_BASE_URL = 'http://localhost:9/v1'
// This server answers every request with a web page.
const HTML_BASE_URL = 'http://localhost:8181/v1'
// This server thinks before it answers, then calls a tool.
const REASONING_BASE_URL = 'http://localhost:7070/v1'

const REASONING_STREAM = [
  'data: {"choices":[{"delta":{"reasoning_content":"Plan"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":" it."}}]}',
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"model_list","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n'
const STREAMED_TOOL_CALLS = [{ id: 'call_1', name: 'model_list', argumentsText: '{}' }]

// This server answers, then stops the stream with an OpenRouter error
// event, after a tool call that it never finishes.
const BROKEN_STREAM_BASE_URL = 'http://localhost:7171/v1'
const BROKEN_STREAM = [
  'data: {"choices":[{"delta":{"content":"Partial"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"model_list","arguments":"{\\"fil"}}]}}]}',
  'data: {"error":{"code":502,"message":"Provider returned error","metadata":{"error_type":"provider_unavailable"}},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n'

// This media server answers a generate request with JSON, an edit and an
// upscale with the image's bytes, and a transcription with JSON, each in
// two chunks. The file host answers the same way.
const MEDIA_BASE_URL = 'http://localhost:5050/api/v1'
const WEBP_IMAGE = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WEBPVP8 ')
const JPEG_IMAGE = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
const HOSTED_IMAGE_URL = 'https://files.example.com/cat.jpg'
const HOSTED_PAGE_URL = 'https://files.example.com/cat.html'
const MEDIA_ANSWERS = new Map([
  [`${MEDIA_BASE_URL}/image/generate`, { contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ images: [bytesToBase64(WEBP_IMAGE)] })) }],
  [`${MEDIA_BASE_URL}/image/multi-edit`, { contentType: 'image/png', body: STORED_IMAGE }],
  [`${MEDIA_BASE_URL}/image/upscale`, { contentType: 'image/png', body: STORED_IMAGE }],
  [`${MEDIA_BASE_URL}/audio/transcriptions`, { contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ text: ' Hello there. ', duration: 3 })) }],
  [HOSTED_IMAGE_URL, { contentType: 'image/jpeg', body: JPEG_IMAGE }],
  [HOSTED_PAGE_URL, { contentType: 'image/jpeg', body: new TextEncoder().encode('<html>Not here</html>') }],
])

// The reply of this chat server is text, then one image for each of
// `painterImageUrls` (each in a chunk of its own, as OpenRouter sends
// them), then more text.
const PAINTER_BASE_URL = 'http://localhost:6060/v1'
let painterImageUrls: string[] = []
function painterStream(): string {
  const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}`
  return [
    chunk({ content: 'Two cats.' }),
    ...painterImageUrls.map((url) => chunk({ content: '', images: [{ type: 'image_url', image_url: { url } }] })),
    chunk({ content: 'Done.' }),
    'data: [DONE]',
  ].join('\n\n') + '\n\n'
}

// The answer of a server to a non-stream request, by URL: a status and the
// JSON of the body. A URL with no entry here gets the default answers of
// the stand-in below.
let httpAnswers = new Map<string, { status: number, json: unknown }>()
let consoleError: MockInstance<typeof console.error>

// Stand-ins for the native layer: the key store cannot be read.
sbp('sbp/selectors/register', {
  async 'dez.native/getProviderSecret' (): Promise<string | null> {
    throw KEY_STORE_ERROR
  },
  async 'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    httpRequests.push(request)
    const answer = httpAnswers.get(request.url)
    if (answer) return { status: answer.status, headers: {}, body: Array.from(new TextEncoder().encode(JSON.stringify(answer.json))) }
    // As Rust does: a request that gets no answer rejects with the text of
    // the error, which names the URL.
    if (request.url.startsWith(CLOSED_BASE_URL)) throw `error sending request for url (${request.url})`
    if (request.url.startsWith(HTML_BASE_URL)) return { status: 200, headers: {}, body: Array.from(new TextEncoder().encode('<html>Hi</html>')) }
    if (request.url.startsWith(FAILING_BASE_URL)) {
      return { status: 404, headers: {}, body: Array.from(new TextEncoder().encode('Not found')) }
    }
    const body = new TextEncoder().encode(JSON.stringify({ data: [{ id: 'served-model' }] }))
    return { status: 200, headers: {}, body: Array.from(body) }
  },
  async 'dez.native/getAppDir' (): Promise<string> {
    return APP_DIR
  },
  async 'dez.native/loadAppFileBytes' (path: string): Promise<Uint8Array> {
    imageReads.push(path)
    if (path === 'assets/images/red.png' || path === 'assets/generated/images/red.png') return STORED_IMAGE
    if (path === 'assets/generated/images/logo.svg') return STORED_SVG
    throw `Failed to read ${path}: No such file or directory (os error 2)`
  },
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    imageReads.push(path)
    const file = linkedImages[path]
    if (!file) throw new Error('The file cannot be read (HTTP 404).')
    return file
  },
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage | null> {
    if (!storedImageSize) throw new Error('unknown image format')
    const drawing = plan(storedImageSize)
    drawings.push([drawing, mediaType])
    return drawing && { bytes: DRAWN_IMAGE, mediaType: drawing.mediaType ?? mediaType, width: drawing.width, height: drawing.height }
  },
  async 'dez.controller/media/readClip' (clip: ClipAttachment): Promise<Blob> {
    clipReads.push(clip.id)
    if (clipReadError) throw clipReadError
    return new Blob([clipFiles[clip.id]])
  },
  async 'dez.controller/media/cutAudio' (_file: Blob, plan: (duration: number) => AudioPart | null): Promise<CutAudio | null> {
    audioDecodes += 1
    if (audioSeconds instanceof Error) throw audioSeconds
    const part = plan(audioSeconds)
    if (part) audioCuts.push(part)
    return part && { part, bytes: WAV_COPY, duration: part.end - part.start }
  },
  // Every clip request gets the clip as its answer.
  async 'dez.native/downloadAppFile' (request: NativeHttpRequest): Promise<NativeHttpDownload> {
    downloadRequests.push(request)
    return { status: 200, headers: { 'content-type': 'video/mp4' }, saved: true, body: [] }
  },
  async 'dez.native/moveAppFile' (): Promise<void> {},
  async 'dez.http/stream' (request: NativeHttpRequest, requestId: string): Promise<NativeHttpStreamResult> {
    streamRequests.push(request)
    streamRequestIds.push(requestId)
    if (request.url.startsWith(CLOSED_BASE_URL)) throw new NativeHttpError(`error sending request for url (${request.url})`)
    const media = MEDIA_ANSWERS.get(request.url)
    if (media) {
      const half = media.body.length >> 1
      return {
        requestId,
        response: { status: 200, headers: { 'content-type': media.contentType } },
        chunks: (async function * () {
          yield media.body.slice(0, half)
          yield media.body.slice(half)
        })(),
      }
    }
    const failing = request.url.startsWith(FAILING_BASE_URL)
    return {
      requestId,
      response: { status: failing ? 404 : 200, headers: {} },
      chunks: (async function * () {
        yield new TextEncoder().encode(failing
          ? 'Not found'
          : request.url.startsWith(REASONING_BASE_URL)
            ? REASONING_STREAM
            : request.url.startsWith(BROKEN_STREAM_BASE_URL)
              ? BROKEN_STREAM
              : request.url.startsWith(PAINTER_BASE_URL)
                ? painterStream()
                : 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n')
      })(),
    }
  },
})

beforeEach(() => {
  setActivePinia(createPinia())
  httpRequests = []
  httpAnswers = new Map()
  streamRequests = []
  streamRequestIds = []
  imageReads = []
  linkedImages = {}
  downloadRequests = []
  storedImageSize = { width: 1024, height: 768 }
  drawings = []
  clipFiles = {}
  clipReadError = null
  clipReads = []
  audioSeconds = 10
  audioDecodes = 0
  audioCuts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  sbp('dez.model/customProviders/save', {
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:8080/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
  })
})

// A new spy for each test: the log of one test is not in the next.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('provider requests when provider_keys.json cannot be read', () => {
  it('still checks the models of a provider that needs no key, without a key', async () => {
    const result = await sbp('dez.provider/listModelsResult', 'local') as ProviderModelsResult

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'served-model', name: 'served-model', provider: 'local' }],
      entries: new Map([['served-model', { id: 'served-model' }]]),
    })
    expect(httpRequests).toHaveLength(1)
    expect(httpRequests[0].url).toBe('http://localhost:8080/v1/models')
    expect(httpRequests[0].headers).not.toHaveProperty('Authorization')
  })

  it('still streams a chat with a provider that needs no key, without a key', async () => {
    const tokens: string[] = []
    await sbp('dez.provider/streamChat', {
      providerId: 'local',
      modelId: 'served-model',
      messages: [{ role: 'user', content: 'Hi' }],
      onToken: (token: string) => { tokens.push(token) },
    })

    expect(tokens).toEqual(['Hello'])
    expect(streamRequests).toHaveLength(1)
    expect(streamRequests[0].url).toBe('http://localhost:8080/v1/chat/completions')
    expect(streamRequests[0].headers).not.toHaveProperty('Authorization')
  })

  it('fails the model check of a provider that needs a key, with the fix first and the key store error last', async () => {
    const result = await sbp('dez.provider/listModelsResult', 'openrouter') as ProviderModelsResult

    expect(result).toEqual({
      ok: false,
      models: [],
      error: `Dez could not read the API key of OpenRouter. Enter the API key of OpenRouter again in Settings › Providers. If Dez cannot save it either, its key file is damaged or locked: the details below tell what failed.\n\nDetails: ${KEY_STORE_ERROR}`,
    })
    expect(httpRequests).toEqual([])
  })
})

describe('provider requests that get no answer that Dez can read', () => {
  const saveProvider = (id: string, baseUrl: string) => {
    sbp('dez.model/customProviders/save', { id, name: 'My server', baseUrl, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey' })
  }
  // A custom provider: the user wrote its base URL, so the text names it.
  const UNREACHED = 'Dez could not reach My server, or the connection broke before the answer was complete. Check the internet connection, then try again. If the error stays, check the base URL of My server in Settings › Providers (for a server on this computer: check that it runs).'

  it('tells that Dez could not reach the server of a chat, with the native text last', async () => {
    saveProvider('closed', CLOSED_BASE_URL)

    const failure = sbp('dez.provider/streamChat', {
      providerId: 'closed',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      onToken: () => {},
    }) as Promise<void>

    await expect(failure).rejects.toStrictEqual(new ExplainedError(UNREACHED, `error sending request for url (${CLOSED_BASE_URL}/chat/completions)`))
  })

  it('tells that Dez could not reach the server of a model check', async () => {
    saveProvider('closed', CLOSED_BASE_URL)

    const result = await sbp('dez.provider/listModelsResult', 'closed') as ProviderModelsResult

    expect(result).toStrictEqual({ ok: false, models: [], error: `${UNREACHED}\n\nDetails: error sending request for url (${CLOSED_BASE_URL}/models)` })
  })

  it('throws the provider\'s error event inside a stream, after the text before it', async () => {
    saveProvider('broken', BROKEN_STREAM_BASE_URL)
    const tokens: string[] = []

    const failure = sbp('dez.provider/streamChat', {
      providerId: 'broken',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      onToken: (token: string) => { tokens.push(token) },
    }) as Promise<void>

    await expect(failure).rejects.toStrictEqual(new ExplainedError(
      'My server stopped the answer with an error. This is a problem at My server, not in your message or in Dez. Try again later.',
      'provider_unavailable: Provider returned error',
    ))
    expect(tokens).toStrictEqual(['Partial'])
  })

  it('tells the user to check the base URL of a custom provider whose server answers with no JSON', async () => {
    saveProvider('html', HTML_BASE_URL)

    const { ok, error } = await sbp('dez.provider/listModelsResult', 'html') as ProviderModelsResult

    expect([ok, error?.split('\n\n')[0]]).toStrictEqual([false, 'My server sent an answer that is not JSON, so Dez cannot read it. Check the base URL of My server in Settings › Providers.'])
  })
})

describe('model checks of a provider with media model lists', () => {
  const ROUTER_URL = 'http://localhost:6161/api/v1'
  const speechEntry = { id: 'speech', supported_voices: ['af_alloy', 'af_bella'] }
  const videoEntry = { id: 'video' }
  const imageEntry = { id: 'image' }
  const videoMediaEntry = { id: 'video', supported_durations: [4, 1], pricing_skus: { cents_per_video_output_second: '2' } }
  const imageMediaEntry = { id: 'image', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] } } }
  const speech = {
    id: 'speech',
    name: 'speech',
    provider: 'router',
    request: 'tts',
    parameters: [{ name: 'voice', label: 'Voice', options: ['af_alloy', 'af_bella'], default: 'af_alloy' }],
  }
  const video = { id: 'video', name: 'video', provider: 'router', request: 'video' }
  // The video list entry tells no frame: the model takes only references.
  const imagesAsReferences = { name: 'images_as', label: 'Images as', options: ['references'], default: 'references' }
  const videoData = {
    parameters: [{ name: 'duration', label: 'Length (seconds)', options: [1, 4], default: 1 }, imagesAsReferences],
    images: { maxImages: 16, references: {} },
  }
  const image = { id: 'image', name: 'image', provider: 'router', request: 'image' }
  const imageParameters = [{ name: 'aspect_ratio', label: 'Aspect ratio', options: ['1:1', '16:9'] }]
  const listUrls = () => httpRequests.map(({ method, url }) => `${method} ${url}`).sort()

  function saveRouter(fetchModels = true) {
    sbp('dez.model/customProviders/save', {
      id: 'router',
      name: 'Router',
      baseUrl: ROUTER_URL,
      apiFormat: 'openai',
      models: [{ id: 'speech', request: 'tts' }, { id: 'video', request: 'video' }, { id: 'image', request: 'image' }],
      fetchModels,
      auth: 'apiKey',
      mediaApi: { format: 'openrouter' },
    })
  }

  beforeEach(() => {
    saveRouter()
    httpAnswers.set(`${ROUTER_URL}/models`, { status: 200, json: { data: [speechEntry, videoEntry, imageEntry] } })
    httpAnswers.set(`${ROUTER_URL}/images/models`, { status: 200, json: { data: [imageMediaEntry] } })
    httpAnswers.set(`${ROUTER_URL}/videos/models`, { status: 200, json: { data: [videoMediaEntry, { id: 'not-in-the-model-list' }] } })
  })

  it('reads every list, and gives each media model its parameters', async () => {
    const result = await sbp('dez.provider/listModelsResult', 'router') as ProviderModelsResult

    expect(result).toStrictEqual({
      ok: true,
      models: [speech, { ...video, ...videoData }, { ...image, parameters: imageParameters }],
      entries: new Map([['speech', speechEntry], ['video', videoEntry], ['image', imageEntry]]),
      mediaEntries: new Map<string, unknown>([['image', imageMediaEntry], ['video', videoMediaEntry], ['not-in-the-model-list', { id: 'not-in-the-model-list' }]]),
    })
    expect(listUrls()).toStrictEqual([`GET ${ROUTER_URL}/images/models`, `GET ${ROUTER_URL}/models`, `GET ${ROUTER_URL}/videos/models`])
  })

  // The chat models of the provider work without the media lists.
  it('still passes the check when a media list fails, and tells so: the models of that list then have no parameters', async () => {
    httpAnswers.set(`${ROUTER_URL}/videos/models`, { status: 503, json: { error: 'Busy' } })

    const result = await sbp('dez.provider/listModelsResult', 'router') as ProviderModelsResult

    expect(result).toStrictEqual({
      ok: true,
      models: [speech, video, { ...image, parameters: imageParameters }],
      entries: new Map([['speech', speechEntry], ['video', videoEntry], ['image', imageEntry]]),
      mediaEntries: new Map<string, unknown>([['image', imageMediaEntry]]),
      mediaListFailed: true,
    })
    // The log also has the key store failure of this file's stand-in.
    expect(consoleError.mock.calls.map(([text]) => text)).toContain('Failed to list the media models of provider router:')
  })

  it('gives no media entries when every media list fails', async () => {
    httpAnswers.set(`${ROUTER_URL}/images/models`, { status: 503, json: { error: 'Busy' } })
    httpAnswers.set(`${ROUTER_URL}/videos/models`, { status: 503, json: { error: 'Busy' } })

    const result = await sbp('dez.provider/listModelsResult', 'router') as ProviderModelsResult

    expect([result.models, result.mediaEntries, result.mediaListFailed]).toStrictEqual([[speech, video, image], undefined, true])
  })

  // A video model with no lengths gets no request, so a media list that
  // fails once must not take away the lengths of an earlier check.
  it('leaves in the model cache what an earlier check read from a media list, when that list then fails', async () => {
    const check = async () => sbp('dez.model/modelCache/applyProviderResult', 'router', await sbp('dez.provider/listModelsResult', 'router'))
    const cachedModels = () => (sbp('dez.model/modelCache/snapshot') as ModelCache).providers.router?.models

    await check()
    httpAnswers.set(`${ROUTER_URL}/videos/models`, { status: 503, json: { error: 'Busy' } })
    await check()
    expect(cachedModels()).toStrictEqual([speech, { ...video, ...videoData }, { ...image, parameters: imageParameters }])

    // The next good list wins over what the cache kept.
    const longer = { id: 'video', supported_durations: [8] }
    httpAnswers.set(`${ROUTER_URL}/videos/models`, { status: 200, json: { data: [longer] } })
    await check()
    expect(cachedModels()?.[1].parameters).toStrictEqual([{ name: 'duration', label: 'Length (seconds)', options: [8], default: 8 }, imagesAsReferences])
  })

  it('fails the check when the model list fails, whatever the media lists say', async () => {
    httpAnswers.set(`${ROUTER_URL}/models`, { status: 401, json: { error: 'No key' } })

    const result = await sbp('dez.provider/listModelsResult', 'router') as ProviderModelsResult

    expect({ ok: result.ok, models: result.models }).toStrictEqual({ ok: false, models: [] })
  })

  it('reads the media lists for a provider that does not fetch its models', async () => {
    saveRouter(false)

    const result = await sbp('dez.provider/listModelsResult', 'router') as ProviderModelsResult

    // With no model list, the speech model has no entry with voices.
    expect(result.models).toStrictEqual([
      { id: 'speech', name: 'speech', provider: 'router', request: 'tts' },
      { ...video, ...videoData },
      { ...image, parameters: imageParameters },
    ])
    expect(listUrls()).toStrictEqual([`GET ${ROUTER_URL}/images/models`, `GET ${ROUTER_URL}/videos/models`])
  })
})

describe('thinking in chat streams', () => {
  async function streamThinker(providerSettings?: Record<string, boolean>) {
    sbp('dez.model/customProviders/save', {
      id: 'thinker',
      name: 'Thinker',
      baseUrl: REASONING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      thinking: {},
    })
    const calls: string[] = []
    const result = await sbp('dez.provider/streamChat', {
      providerId: 'thinker',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      requestId: 'request-1',
      ...(providerSettings && { providerSettings }),
      onToken: (token: string) => { calls.push(`token:${token}`) },
      onThinking: (token: string) => { calls.push(`thinking:${token}`) },
    })
    return { calls, result }
  }

  it('sends the thinking and the answer to their callbacks and returns the replay and the tool calls', async () => {
    const { calls, result } = await streamThinker()

    expect(calls).toEqual(['thinking:Plan', 'thinking: it.', 'token:Hello'])
    expect(result).toStrictEqual({
      requestId: 'request-1',
      thinkingReplay: { kind: 'field', field: 'reasoning_content' },
      toolCalls: STREAMED_TOOL_CALLS,
    })
  })

  it('drops the thinking and returns no replay, but the tool calls, when the toggle is off', async () => {
    const { calls, result } = await streamThinker({ thinking: false })

    expect(calls).toEqual(['token:Hello'])
    expect(result).toStrictEqual({ requestId: 'request-1', toolCalls: STREAMED_TOOL_CALLS })
  })

  it('shows no thinking for a provider without thinking support', async () => {
    const calls: string[] = []
    sbp('dez.model/customProviders/save', {
      id: 'plain',
      name: 'Plain',
      baseUrl: REASONING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
    })
    const result = await sbp('dez.provider/streamChat', {
      providerId: 'plain',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      requestId: 'request-2',
      onToken: (token: string) => { calls.push(`token:${token}`) },
      onThinking: (token: string) => { calls.push(`thinking:${token}`) },
    })

    expect(calls).toEqual(['token:Hello'])
    expect(result).toStrictEqual({ requestId: 'request-2', toolCalls: STREAMED_TOOL_CALLS })
  })
})

// The popup's rows and the chat request read one rule (modelToggles.ts) with
// the model of the model cache, so they agree for every model.
describe('the toggles of the request model', () => {
  const GATED_URL = 'http://localhost:4040/v1'
  const search = { key: 'search', label: 'Search', type: 'boolean', default: true, bodyPath: 'extra.search', modelSupport: { path: 'caps.search' } }
  const every = { name: 'Gated', thinking: true, tools: true, settings: [search] }
  const none = { name: 'Gated', thinking: false, tools: false, settings: [] }
  const descriptor = (modelId: string) => sbp('dez.provider/settingsDescriptor', 'gated', modelId) as ProviderSettingsDescriptor | null

  async function sentBody(modelId: string, providerSettings: Record<string, boolean> = {}): Promise<Record<string, unknown>> {
    streamRequests = []
    await sbp('dez.provider/streamChat', { providerId: 'gated', modelId, messages: [{ role: 'user', content: 'Hi' }], providerSettings, onToken: () => {} })
    return jsonBody(streamRequests[0])
  }

  // The model check puts the facts of the server's list into the cache.
  async function checkModels() {
    sbp('dez.model/modelCache/applyProviderResult', 'gated', await sbp('dez.provider/listModelsResult', 'gated'))
  }

  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'gated',
      name: 'Gated',
      baseUrl: GATED_URL,
      apiFormat: 'openai',
      models: [{ id: 'speech', request: 'tts' }],
      fetchModels: true,
      modelToolCalling: { path: 'caps.tools' },
      modelThinking: { path: 'caps.thinks' },
      auth: 'apiKey',
      settings: [search],
      thinking: { enabledBody: { reasoning: { enabled: true } }, disabledBody: { reasoning: { enabled: false } } },
    })
    httpAnswers.set(`${GATED_URL}/models`, {
      status: 200,
      json: {
        data: [
          { id: 'full', caps: { tools: true, thinks: true, search: true } },
          { id: 'bare', caps: { tools: false, thinks: false, search: false } },
          { id: 'untold' },
        ],
      },
    })
  })

  it('shows every toggle for a model that the cache does not have, and sends their fields', async () => {
    expect(descriptor('bare')).toStrictEqual(every)
    expect(await sentBody('bare')).toMatchObject({ model: 'bare', extra: { search: true }, reasoning: { enabled: true } })
    expect(await sentBody('bare', { search: false, thinking: false })).toMatchObject({ extra: { search: false }, reasoning: { enabled: false } })
  })

  it('shows and sends only what the cached model can use', async () => {
    await checkModels()

    // `bare` takes chat requests but none of the toggles; `speech` takes no
    // chat request.
    expect(['full', 'untold', 'bare', 'speech', 'not-listed'].map(descriptor)).toStrictEqual([every, every, none, none, every])
    expect(await sentBody('full')).toMatchObject({ extra: { search: true }, reasoning: { enabled: true } })
    // Neither the on nor the off value goes, whatever the stored toggles say.
    const storedValues: Array<Record<string, boolean>> = [{}, { search: true, thinking: true }, { search: false, thinking: false }]
    for (const stored of storedValues) {
      expect(await sentBody('bare', stored)).toStrictEqual({ model: 'bare', messages: [{ role: 'user', content: 'Hi' }], stream: true })
    }
  })

  it('gives null for a provider that does not exist', () => {
    expect(sbp('dez.provider/settingsDescriptor', 'no-such-provider', 'm')).toBeNull()
  })
})

describe('images in chat streams', () => {
  function streamImage(path: string) {
    return sbp('dez.provider/streamChat', {
      providerId: 'local',
      modelId: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Which color?' }, { type: 'image', path }] }],
      onToken: () => {},
    })
  }

  it.each(['assets/images', 'assets/generated/images'])('sends the bytes of a stored image in %s as base64, read through the app folder', async (folder) => {
    await streamImage(`${APP_DIR}/${folder}/red.png`)

    expect(imageReads).toEqual([`${folder}/red.png`])
    expect(streamRequests).toHaveLength(1)
    expect(JSON.parse(streamRequests[0].body as string).messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: dataUrl('image/png', STORED_IMAGE) },
    })
  })

  it('fails before the request when the image file is missing, and tells how to fix the message', async () => {
    await expect(streamImage(`${APP_DIR}/assets/images/gone.png`)).rejects.toThrow(MISSING_IMAGE('gone.png'))

    expect(imageReads).toEqual(['assets/images/gone.png'])
    expect(streamRequests).toEqual([])
  })

  it('reads no file for an image of another Dez folder', async () => {
    await expect(streamImage('/home/other/.config/dez/assets/images/red.png')).rejects.toThrow(MISSING_IMAGE('red.png'))

    expect(imageReads).toEqual([])
    expect(streamRequests).toEqual([])
  })

  it('sends the bytes of a linked image, read where it is, with the type of its bytes, else of its extension', async () => {
    linkedImages = {
      '/home/u/Pictures/Fox (1).JPG': new File([STORED_IMAGE], 'Fox (1).JPG', { type: 'image/png' }),
      '/home/u/Pictures/b.WEBP': new File([STORED_IMAGE], 'b.WEBP', { type: '' }),
    }

    await streamImage('/home/u/Pictures/Fox (1).JPG')
    await streamImage('/home/u/Pictures/b.WEBP')

    expect(imageReads).toStrictEqual(['/home/u/Pictures/Fox (1).JPG', '/home/u/Pictures/b.WEBP'])
    expect(streamRequests.map((request) => JSON.parse(request.body as string).messages[0].content[1].image_url.url)).toStrictEqual([
      dataUrl('image/png', STORED_IMAGE),
      dataUrl('image/webp', STORED_IMAGE),
    ])
  })

  it('fails before the request when a linked image is gone, and tells how to fix the message', async () => {
    await expect(streamImage('/home/u/Pictures/gone.png')).rejects.toThrow(
      'The image file gone.png is gone or moved, or Dez cannot read it. Drop the image again, or remove its reference from the message.',
    )

    expect(imageReads).toStrictEqual(['/home/u/Pictures/gone.png'])
    expect(streamRequests).toEqual([])
  })

  // No provider is known to take SVG image parts.
  it('sends a stored SVG as a PNG drawing of the whole image, at its own size', async () => {
    storedImageSize = { width: 300, height: 150 }

    await streamImage(`${APP_DIR}/assets/generated/images/logo.svg`)

    expect(drawings).toStrictEqual([[{ crop: { x: 0, y: 0, width: 300, height: 150 }, width: 300, height: 150 }, 'image/png']])
    expect(JSON.parse(streamRequests[0].body as string).messages[0].content[1]).toStrictEqual({
      type: 'image_url',
      image_url: { url: dataUrl('image/png', DRAWN_IMAGE) },
    })
  })

  // WebKit draws no copy of an SVG with HTML in it, and the SVG itself
  // cannot go.
  it('fails before the request for an SVG that the webview cannot draw, and tells how to fix the message', async () => {
    storedImageSize = null

    await expect(streamImage(`${APP_DIR}/assets/generated/images/logo.svg`)).rejects.toThrow(`${SVG_NOT_DRAWN('logo.svg')}\n\nDetails: unknown image format`)

    expect(streamRequests).toEqual([])
    expect(consoleError).toHaveBeenCalledWith(`Failed to draw a PNG copy of the SVG image ${APP_DIR}/assets/generated/images/logo.svg:`, new Error('unknown image format'))
  })

  it('sends the image of the newest user message only, and an earlier turn as the same bytes in every request after that', async () => {
    const model = { providerId: 'local', modelId: 'm' }
    const path = `${APP_DIR}/assets/images/red.png`
    const turn1: Section[] = [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: `Which color? ![${path}](id=a)` }] }]
    const turn2: Section[] = [
      ...turn1,
      { id: 'a1', role: 'agent', model, content: [{ kind: 'text', text: `Red, as here: ![${path}](id=b)` }] },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: `![${path}](id=c) And this one?` }] },
    ]
    const turn3: Section[] = [
      ...turn2,
      { id: 'a2', role: 'agent', model, content: [{ kind: 'text', text: 'Red too.' }] },
      { id: 'u3', role: 'user', content: [{ kind: 'text', text: 'Sure?' }] },
    ]
    for (const sections of [turn1, turn2, turn3]) {
      const { messages } = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true })
      await sbp('dez.provider/streamChat', { providerId: 'local', modelId: 'm', messages, onToken: () => {} })
    }
    const [first, second, third] = streamRequests.map((request) => jsonBody(request).messages as unknown[])
    const imagePart = { type: 'image_url', image_url: { url: dataUrl('image/png', STORED_IMAGE) } }

    expect(first).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Which color? ![image](id=a)' }, imagePart] }])
    expect(second).toEqual([
      { role: 'user', content: 'Which color? ![image](id=a)' },
      { role: 'assistant', content: 'Red, as here: ![image](id=b)' },
      { role: 'user', content: [{ type: 'text', text: '![image](id=c)' }, imagePart, { type: 'text', text: ' And this one?' }] },
    ])
    expect(third.slice(2)).toEqual([
      { role: 'user', content: '![image](id=c) And this one?' },
      { role: 'assistant', content: 'Red too.' },
      { role: 'user', content: 'Sure?' },
    ])
    // OpenAI-format providers reuse their prompt cache only for a prefix of
    // the same text: a turn changes once, when it loses its image parts.
    expect(JSON.stringify(third.slice(0, 2))).toBe(JSON.stringify(second.slice(0, 2)))
    // The third request reads no image file.
    expect(imageReads).toEqual(['assets/images/red.png', 'assets/images/red.png'])
  })
})

describe('chat streams with image paths', () => {
  const path = `${APP_DIR}/assets/images/red.png`
  // Every form of an image path in a conversation: valid references, broken
  // ones, a bare path, a path in metadata, in a prompt body, in agent text,
  // in a tool call's arguments and result, and in thinking that would go
  // back.
  const toolCall = toolBlockText({
    id: 'call_1',
    name: 'model_list',
    status: 'success',
    arguments: { filter: `![${path}](id=a)` },
    result: `Found ${path}.`,
  })
  const sections = (model: ModelRef): Section[] => [
    { id: 'u1', role: 'user', content: [{ kind: 'text', text: `Look: ![${path}](id=a) Why?` }] },
    {
      id: 'a1',
      role: 'agent',
      model,
      content: [{ kind: 'text', text: `This: ![${path}](id=a)\n${toolCall}\nDone.` }],
      thinking: { text: `The user sent ${path}.`, replay: { kind: 'field', field: 'reasoning_content' } },
    },
    {
      id: 'u2',
      role: 'user',
      content: [
        { kind: 'text', text: [`![${path}](id=b)`, `![${path}](id=a`, `[${path}](id=b)`, `see ${path} now`, `![${path}](id=b|desc=a /home/bob/.config/dez/assets/images/b.png)`, ''].join('\n') },
        { kind: 'prompt', id: 'p1', promptId: null, name: 'Ask', body: `Prompt: ![${path}](id=a)`, expanded: false },
        { kind: 'text', text: '' },
      ],
    },
  ]

  it.each([
    ['openai', true, true],
    ['openai', false, false],
    ['anthropic', true, false],
    ['anthropic', false, true],
  ] as const)('sends no path in the %s format (images sent: %s, tools sent: %s), and sends the ids', async (apiFormat, sendImages, sendTools) => {
    sbp('dez.model/customProviders/save', {
      id: apiFormat,
      name: apiFormat,
      baseUrl: `http://localhost:6060/${apiFormat}`,
      apiFormat,
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      thinking: {},
    })
    const model = { providerId: apiFormat, modelId: 'm' }
    const { messages } = sectionsToStreamMessages(sections(model), model, { sendImages, sendTools })

    await sbp('dez.provider/streamChat', { providerId: apiFormat, modelId: 'm', messages, onToken: () => {} })

    const body = streamRequests[0].body as string
    expect(body).not.toContain('assets/images')
    expect(body).not.toContain('/home/u')
    expect(body).toContain('id=a')
    expect(body).toContain('id=b')
    expect(body).toContain('model_list')
    expect(body.includes(Buffer.from(STORED_IMAGE).toString('base64'))).toBe(sendImages)
  })
})

describe('images of a chat reply', () => {
  // A RIFF file that is not an image.
  const WAV = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WAVEfmt ')

  // A provider whose chat models can make images, with a header that only
  // its own server may get.
  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'painter',
      name: 'Painter',
      baseUrl: PAINTER_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      headers: { 'X-Team': 'blue' },
      imageOutputBody: { modalities: ['image', 'text'] },
    })
  })

  // The answer text and the images, in the order that the callbacks got
  // them. `onImage` ends a macrotask later, as the save of a file does: a
  // stream that did not wait for it would give all its later text first.
  // The timer has no duration, so the test does not depend on speed.
  async function streamPainter(imageUrls: string[]): Promise<unknown[]> {
    painterImageUrls = imageUrls
    const calls: unknown[] = []
    await sbp('dez.provider/streamChat', {
      providerId: 'painter',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Two cats' }],
      imageOutput: true,
      onToken: (token: string) => { calls.push(token) },
      onImage: async (image: GeneratedMedia) => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        calls.push(image)
      },
    })
    return calls
  }

  it('gives each image as bytes with the type of its bytes, in stream order with the text', async () => {
    const calls = await streamPainter([dataUrl('image/webp', STORED_IMAGE), HOSTED_IMAGE_URL])

    expect(calls).toStrictEqual([
      'Two cats.',
      { bytes: STORED_IMAGE, mediaType: 'image/png' },
      { bytes: JPEG_IMAGE, mediaType: 'image/jpeg' },
      'Done.',
    ])
  })

  it('fetches an image URL once, with no header of the provider', async () => {
    await streamPainter([HOSTED_IMAGE_URL])

    expect(streamRequests).toHaveLength(2)
    expect(streamRequests[0].headers).toMatchObject({ 'X-Team': 'blue' })
    expect(streamRequests[1]).toStrictEqual({ method: 'GET', url: HOSTED_IMAGE_URL })
  })

  it.each([
    ['bytes that are not an image', dataUrl('image/png', WAV), 'not a PNG, JPEG, GIF, WebP, or SVG image'],
    ['a data URL whose data is not base64', 'data:image/png;base64,***', 'not base64 text'],
    ['a data URL with no base64 mark', 'data:image/svg+xml,<svg/>', 'neither a base64 data URL nor an http(s) URL'],
    ['a URL of another scheme', 'file:///etc/passwd', 'neither a base64 data URL nor an http(s) URL'],
    ['a URL whose file is not an image', HOSTED_PAGE_URL, 'not a PNG, JPEG, GIF, WebP, or SVG image'],
    ['a URL that its server refuses', `${FAILING_BASE_URL}/cat.png`, 'The file that Painter made is not at its link any more: the link can have expired. Send the request again to make a new one.\n\nDetails: HTTP 404: Not found'],
  ])('fails the chat for %s', async (_name, url, message) => {
    await expect(streamPainter([url])).rejects.toThrow(message)
  })
})

describe('media requests', () => {
  // A media API in the Venice format, and chat fields (`requestBody`,
  // `settings`) that media requests must not take.
  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'media',
      name: 'Media server',
      baseUrl: MEDIA_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      headers: { 'X-Team': 'blue' },
      requestBody: { venice_parameters: { include_venice_system_prompt: false } },
      settings: [{ key: 'webSearch', label: 'Web search', type: 'boolean', default: true, bodyPath: 'venice_parameters.enable_web_search' }],
      mediaApi: { format: 'venice' },
    })
  })

  const generate = (input: Record<string, unknown>) =>
    sbp('dez.provider/generateMedia', { providerId: 'media', modelId: 'm', prompt: 'A red fox', ...input }) as Promise<ProviderGenerateMediaResult>

  it('makes an image through dez.http/stream with the request id and the config headers, and no chat fields', async () => {
    const result = await generate({ kind: 'image', requestId: 'reply-1' })

    expect(result).toStrictEqual({ media: [{ bytes: WEBP_IMAGE, mediaType: 'image/webp' }], clips: [] })
    expect(streamRequestIds).toEqual(['reply-1'])
    expect(streamRequests).toStrictEqual([{
      method: 'POST',
      url: `${MEDIA_BASE_URL}/image/generate`,
      headers: { 'Content-Type': 'application/json', 'X-Team': 'blue' },
      body: JSON.stringify({ model: 'm', prompt: 'A red fox', format: 'webp', hide_watermark: true, safe_mode: false }),
    }])
    expect(imageReads).toEqual([])
  })

  it('edits stored images of both folders, sent as data URLs, and returns the whole image of a binary answer', async () => {
    const result = await generate({ kind: 'imageEdit', images: [`${APP_DIR}/assets/generated/images/red.png`, `${APP_DIR}/assets/images/red.png`] })

    expect(result).toStrictEqual({ media: [{ bytes: STORED_IMAGE, mediaType: 'image/png' }], clips: [] })
    expect(imageReads).toEqual(['assets/generated/images/red.png', 'assets/images/red.png'])
    expect(streamRequests.map((request) => [request.url, jsonBody(request)])).toStrictEqual([
      [`${MEDIA_BASE_URL}/image/multi-edit`, { modelId: 'm', prompt: 'A red fox', images: [dataUrl('image/png', STORED_IMAGE), dataUrl('image/png', STORED_IMAGE)], safe_mode: false }],
    ])
  })

  it('sends nothing for a request that was stopped before it started', async () => {
    await expect(generate({ kind: 'image', signal: AbortSignal.abort() })).rejects.toThrow('This operation was aborted')

    expect(streamRequests).toEqual([])
  })

  // The submit refuses it first (thread.ts); the model is not in the model
  // cache, so the text names it by its id.
  it.each([
    ['imageEdit', 'm edits an image. Paste an image, or name one with @id.'],
    ['upscale', 'm makes an image larger. Paste an image, or name one with @id.'],
    ['imageToVideo', 'm makes a video from an image. Paste an image, or name one with @id.'],
  ] as const)('refuses a %s request with no image, before any request', async (kind, message) => {
    await expect(generate({ kind })).rejects.toStrictEqual(new ExplainedError(message))
    await expect(generate({ kind, images: [] })).rejects.toStrictEqual(new ExplainedError(message))

    expect(streamRequests).toEqual([])
    expect(downloadRequests).toEqual([])
  })

  // The image rules come from the model cache (an OpenRouter model whose
  // `input_references` start at 1, mediaFormats.ts).
  it.each([
    [1, [], 'Styles needs an input image. Paste an image, or name one with @id.'],
    [2, [`${APP_DIR}/assets/images/red.png`], 'Styles needs at least 2 images, and this message has 1. Paste more images, or name them with @id.'],
  ])('refuses an image request with fewer images than the %i that the model needs, before any request', async (minImages, images, message) => {
    sbp('dez.model/modelCache/applyProviderResult', 'media', {
      ok: true,
      models: [{ id: 'm', name: 'Styles', provider: 'media', request: 'image', images: { maxImages: 4, minImages } }],
    })

    await expect(generate({ kind: 'image', images })).rejects.toStrictEqual(new ExplainedError(message))
    expect([imageReads, streamRequests]).toStrictEqual([[], []])
  })

  // The answer would be billed, and Dez could not store it.
  it('refuses a request to a model that makes only a type that Dez does not store, before any request', async () => {
    sbp('dez.model/modelCache/applyProviderResult', 'media', {
      ok: true,
      models: [{ id: 'm', name: 'Scanner', provider: 'media', request: 'image', unstoredOutput: 'TIFF' }],
    })

    await expect(generate({ kind: 'image' })).rejects.toThrow('Scanner makes only TIFF images, and Dez cannot store TIFF images. Choose another image model.')
    expect(streamRequests).toEqual([])
  })

  it('reads no file of another Dez folder, and sends nothing', async () => {
    await expect(generate({ kind: 'imageEdit', images: ['/home/other/.config/dez/assets/images/red.png'] })).rejects.toThrow(MISSING_IMAGE('red.png'))

    expect(imageReads).toEqual([])
    expect(streamRequests).toEqual([])
  })

  it('names the provider of a refused request first, with the start of its answer in the details', async () => {
    sbp('dez.model/customProviders/save', {
      id: 'broken',
      name: 'Broken server',
      baseUrl: FAILING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      mediaApi: { format: 'venice' },
    })

    await expect(generate({ providerId: 'broken', kind: 'image' })).rejects.toThrow(
      'Broken server has nothing for this request: the model can be gone, or it does not take this kind of request. Broken server tells its reason in the details below. Choose another model, or check the base URL of Broken server in Settings › Providers.\n\nDetails: HTTP 404: Not found',
    )
  })

  it('fails before any request for a provider with no media API', async () => {
    await expect(generate({ providerId: 'local', kind: 'image' })).rejects.toThrow('Local has no media API that Dez can use.')
    await expect(generate({ providerId: 'local', kind: 'tts' })).rejects.toThrow('Local has no media API that Dez can use.')

    expect([streamRequests, downloadRequests, httpRequests]).toStrictEqual([[], [], []])
  })

  describe('input images and the size rules of the request', () => {
    const path = `${APP_DIR}/assets/images/red.png`
    // The fields `fields` of the JSON body of each request.
    const bodyFields = (requests: NativeHttpRequest[], fields: string[]) => requests.map((request) => {
      const body = jsonBody(request)
      return fields.map((field) => body[field])
    })
    const editImages = () => bodyFields(streamRequests, ['images']).flat()
    const frames = () => bodyFields(downloadRequests, ['image_url', 'end_image_url'])

    // Puts the model `m` in the model cache as an image-to-video model
    // whose images have these size rules. The video request needs a
    // length.
    function useVideoModel(size?: Record<string, number>): void {
      sbp('dez.model/modelCache/applyProviderResult', 'media', {
        ok: true,
        models: [{
          id: 'm',
          name: 'M',
          provider: 'media',
          outputs: ['video'],
          request: 'imageToVideo',
          parameters: [{ name: 'duration', label: 'Length', options: ['5s'], default: '5s' }],
          images: { maxImages: 2, ...(size && { size }) },
        }],
      })
    }

    it('sends an edit image that is too small as a drawing with the least size of the edit request', async () => {
      storedImageSize = { width: 100, height: 50 }

      await generate({ kind: 'imageEdit', images: [path] })

      expect(drawings).toStrictEqual([[{ crop: { x: 0, y: 0, width: 100, height: 50 }, width: 512, height: 256 }, 'image/png']])
      expect(editImages()).toStrictEqual([[dataUrl('image/png', DRAWN_IMAGE)]])
    })

    it('sends an edit image that passes the rules as it is', async () => {
      await generate({ kind: 'imageEdit', images: [path] })

      expect(drawings).toStrictEqual([[null, 'image/png']])
      expect(editImages()).toStrictEqual([[dataUrl('image/png', STORED_IMAGE)]])
    })

    it('sends an image that the webview cannot decode as it is, and logs the cause', async () => {
      storedImageSize = null

      await generate({ kind: 'imageEdit', images: [path] })

      expect(editImages()).toStrictEqual([[dataUrl('image/png', STORED_IMAGE)]])
      expect(consoleError).toHaveBeenCalledWith('Failed to fit an image to the size rules of the request:', new Error('unknown image format'))
    })

    it('sends each frame of a video as a drawing that passes the size rules of the model', async () => {
      useVideoModel({ minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 })
      storedImageSize = { width: 100, height: 1000 }

      await generate({ kind: 'imageToVideo', images: [path, path] })

      const drawing = { crop: { x: 0, y: 375, width: 100, height: 249 }, width: 300, height: 747 }
      expect(drawings).toStrictEqual([[drawing, 'image/png'], [drawing, 'image/png']])
      expect(frames()).toStrictEqual([[dataUrl('image/png', DRAWN_IMAGE), dataUrl('image/png', DRAWN_IMAGE)]])
    })

    it('sends the frame of a video model whose provider tells no size rule as it is, and does not decode it', async () => {
      useVideoModel()
      storedImageSize = { width: 100, height: 1000 }

      await generate({ kind: 'imageToVideo', images: [path] })

      expect(drawings).toStrictEqual([])
      expect(frames()).toStrictEqual([[dataUrl('image/png', STORED_IMAGE), undefined]])
    })

    describe('of an SVG', () => {
      const svgPath = `${APP_DIR}/assets/generated/images/logo.svg`
      const whole = (width: number, height: number) => ({ crop: { x: 0, y: 0, width, height }, width, height })

      it('sends an edit image that passes the rules as a PNG drawing of the whole image', async () => {
        await generate({ kind: 'imageEdit', images: [svgPath] })

        expect(drawings).toStrictEqual([[whole(1024, 768), 'image/png']])
        expect(editImages()).toStrictEqual([[dataUrl('image/png', DRAWN_IMAGE)]])
      })

      it('sends the frame of a video model whose provider tells no size rule as a PNG drawing', async () => {
        useVideoModel()
        storedImageSize = { width: 300, height: 150 }

        await generate({ kind: 'imageToVideo', images: [svgPath] })

        expect(drawings).toStrictEqual([[whole(300, 150), 'image/png']])
        expect(frames()).toStrictEqual([[dataUrl('image/png', DRAWN_IMAGE), undefined]])
      })

      it('sends an edit image that is too small as a drawing with the least size of the edit request', async () => {
        storedImageSize = { width: 100, height: 50 }

        await generate({ kind: 'imageEdit', images: [svgPath] })

        expect(drawings).toStrictEqual([[{ crop: { x: 0, y: 0, width: 100, height: 50 }, width: 512, height: 256 }, 'image/png']])
      })

      it('refuses an image that the webview cannot draw before any request', async () => {
        storedImageSize = null

        await expect(generate({ kind: 'imageEdit', images: [svgPath] })).rejects.toThrow(SVG_NOT_DRAWN('logo.svg'))

        expect(streamRequests).toEqual([])
      })
    })

    // Puts the model `m` in the model cache as an upscale model with the
    // parameters of the Venice format.
    function useUpscaleModel(): void {
      sbp('dez.model/modelCache/applyProviderResult', 'media', {
        ok: true,
        models: [{
          id: 'm',
          name: 'M',
          provider: 'media',
          outputs: ['image'],
          request: 'upscale',
          parameters: [
            { name: 'scale', label: 'Scale', options: [2, 4], default: 2 },
            { name: 'creativity', label: 'Creativity', min: 0, max: 0.02, step: 0.001, default: 0.01 },
          ],
        }],
      })
    }

    // A value that the model does not take gets the default.
    it('upscales a stored image with the chosen values that the model takes, else the defaults, and no prompt', async () => {
      useUpscaleModel()

      const result = await generate({ kind: 'upscale', images: [path], parameters: { scale: 4, creativity: 0.5 } })

      expect(result).toStrictEqual({ media: [{ bytes: STORED_IMAGE, mediaType: 'image/png' }], clips: [] })
      expect(streamRequests.map((request) => [request.url, jsonBody(request)])).toStrictEqual([
        [`${MEDIA_BASE_URL}/image/upscale`, { scale: 4, creativity: 0.01, image: bytesToBase64(STORED_IMAGE) }],
      ])
    })

    it('sends an upscale image that is too small as a drawing with the least size of the upscale request', async () => {
      useUpscaleModel()
      storedImageSize = { width: 200, height: 100 }

      await generate({ kind: 'upscale', images: [path] })

      expect(drawings).toStrictEqual([[{ crop: { x: 0, y: 0, width: 200, height: 100 }, width: 512, height: 256 }, 'image/png']])
      expect(bodyFields(streamRequests, ['image'])).toStrictEqual([[bytesToBase64(DRAWN_IMAGE)]])
    })

    // The size is the decoded one: no drawing makes an image smaller for an
    // upscale.
    it('refuses an upscale of an image at the pixel cap before any request, and tells what to do', async () => {
      useUpscaleModel()
      storedImageSize = { width: 4096, height: 4096 }

      await expect(generate({ kind: 'upscale', images: [path] })).rejects.toThrow('The image has 4096 × 4096 pixels, and an upscale makes images of at most 16,777,216 pixels (4096 × 4096), so this image cannot get larger. Use an image with fewer pixels.')

      expect(drawings).toStrictEqual([[null, 'image/png']])
      expect(streamRequests).toEqual([])
    })
  })

  describe('input clips of a clip or text request', () => {
    const VIDEO_LENGTH = [{ name: 'duration', label: 'Length', options: ['5s'], default: '5s' }]
    // A Venice reference-to-video model, whose family takes its reference
    // clips in fields of their own (veniceReferences.ts).
    const REFERENCE_MODEL = 'seedance-2-0-reference-to-video'
    const OGG_AUDIO = new TextEncoder().encode('OggS')
    const MP3_AUDIO = new TextEncoder().encode('ID3\x04')
    const BACKGROUND_AUDIO: InputClipRules = { audio: { use: 'background', maxClips: 1, types: ['audio/wav', 'audio/mpeg'] } }

    const clip = (kind: 'audio' | 'video', id: string, type: string): ClipAttachment =>
      ({ kind, id, type, src: `${APP_DIR}/assets/generated/${kind}/${id}.bin`, url: `https://files.example.com/${id}.bin`, expires: null })

    // Puts the video model `modelId` in the model cache with the clip
    // rules `clips`, as a model of the request kind `request`. The video
    // request needs a length.
    function useClipModel(modelId: string, clips: InputClipRules, request: 'video' | 'imageToVideo' = 'video'): void {
      sbp('dez.model/modelCache/applyProviderResult', 'media', {
        ok: true,
        models: [{ id: modelId, name: 'M', provider: 'media', outputs: ['video'], request, parameters: VIDEO_LENGTH, clips }],
      })
    }

    // An MP4 file of `seconds`: an `ftyp` box, then a `moov` box that holds
    // only its movie header (`mvhd` version 0, with 1000 units in one
    // second), which is all that mp4Duration.ts reads.
    function mp4Video(seconds: number): Uint8Array {
      const bytes = new Uint8Array(52)
      const view = new DataView(bytes.buffer)
      const box = (offset: number, size: number, type: string) => {
        view.setUint32(offset, size)
        bytes.set(new TextEncoder().encode(type), offset + 4)
      }
      box(0, 16, 'ftyp')
      bytes.set(new TextEncoder().encode('isom'), 8)
      box(16, 36, 'moov')
      box(24, 28, 'mvhd')
      view.setUint32(44, 1000)
      view.setUint32(48, seconds * 1000)
      return bytes
    }

    // The model needs an image, and the video clip is its reference. The
    // model takes WAV and MP3 audio, so the OGG clip goes as a WAV copy.
    it('sends a reference video in place of the image that the model needs, and an audio clip of a type that it does not take as a WAV copy of the whole clip', async () => {
      useClipModel(REFERENCE_MODEL, {
        video: { use: 'reference', maxClips: 3, types: ['video/mp4', 'video/quicktime'] },
        audio: { use: 'reference', maxClips: 3, types: ['audio/wav', 'audio/mpeg'] },
        audioNeedsVisual: true,
      }, 'imageToVideo')
      const video = mp4Video(12)
      clipFiles = { v1: video, a1: OGG_AUDIO }
      audioSeconds = 12

      await generate({ modelId: REFERENCE_MODEL, kind: 'imageToVideo', clips: [clip('video', 'v1', 'video/mp4'), clip('audio', 'a1', 'audio/ogg')] })

      expect(audioCuts).toStrictEqual([{ start: 0, end: 12 }])
      expect(downloadRequests.map(jsonBody)).toStrictEqual([{
        duration: '5s',
        model: REFERENCE_MODEL,
        prompt: 'A red fox',
        reference_video_urls: [dataUrl('video/mp4', video)],
        reference_audio_urls: [dataUrl('audio/wav', WAV_COPY)],
      }])
    })

    // Its length is then unknown, and the provider checks it.
    it('sends a background audio clip that the webview cannot decode as it is, with no length check, when the model takes its type', async () => {
      useClipModel('m', { audio: { use: 'background', maxClips: 1, maxSeconds: 1, types: ['audio/wav', 'audio/mpeg'] } })
      clipFiles = { a1: MP3_AUDIO }
      audioSeconds = new Error('EncodingError: Unable to decode audio data')

      await generate({ kind: 'video', clips: [clip('audio', 'a1', 'audio/mp3')] })

      expect(downloadRequests.map(jsonBody)).toStrictEqual([{ duration: '5s', model: 'm', prompt: 'A red fox', audio_url: dataUrl('audio/mpeg', MP3_AUDIO) }])
    })

    // A decode holds all samples of the clip in memory, and a long
    // recording has many.
    it('sends an audio clip of a type that the model takes as it is, with no decode, when the model has no length rule', async () => {
      useClipModel('m', BACKGROUND_AUDIO)
      clipFiles = { a1: MP3_AUDIO }

      await generate({ kind: 'video', clips: [clip('audio', 'a1', 'audio/mpeg')] })

      expect(audioDecodes).toBe(0)
      expect(downloadRequests.map(jsonBody)).toStrictEqual([{ duration: '5s', model: 'm', prompt: 'A red fox', audio_url: dataUrl('audio/mpeg', MP3_AUDIO) }])
    })

    it('refuses an audio clip that needs a WAV copy and that the webview cannot decode, before any request', async () => {
      useClipModel('m', BACKGROUND_AUDIO)
      clipFiles = { a1: OGG_AUDIO }
      audioSeconds = new Error('EncodingError: Unable to decode audio data')

      await expect(generate({ kind: 'video', clips: [clip('audio', 'a1', 'audio/ogg')] })).rejects.toThrow(
        'M takes no audio clip of the type audio/ogg, and Dez could not make a WAV copy of the audio clip @a1: this app cannot decode its audio. Use another audio clip.\n\nDetails: EncodingError: Unable to decode audio data',
      )
      expect(downloadRequests).toEqual([])
    })

    // readClip's details hold no path and no URL either (media.ts).
    it.each([
      ['deleted', '', 'The audio clip @a1 is gone'],
      ['expired', 'HTTP 404: Not Found', 'The audio clip @a1 has expired'],
      ['unreadable', 'No such file or directory (os error 2) HTTP 403: Forbidden', 'Dez could not read the audio clip @a1'],
    ] as const)('refuses a clip that is %s with a text that names its id and no path or URL, before any request', async (problem, details, start) => {
      useClipModel('m', BACKGROUND_AUDIO)
      clipReadError = new ClipReadError(problem, details)
      const audio = clip('audio', 'a1', 'audio/mpeg')

      const error = await generate({ kind: 'video', clips: [audio] }).then(() => null, (error: unknown) => error)

      expect(error).toBeInstanceOf(ExplainedError)
      const { explanation, details: shownDetails, message } = error as ExplainedError
      expect(explanation.startsWith(start)).toBe(true)
      expect(shownDetails).toBe(details)
      expect(message).not.toContain(audio.src)
      expect(message).not.toContain(audio.url)
      expect([downloadRequests, streamRequests, httpRequests]).toStrictEqual([[], [], []])
    })

    // The size is that of the file that goes: the WAV copy.
    it.each([
      ['an audio clip too long, by its decode', { audio: { use: 'background', maxSeconds: 30 } }, { a1: MP3_AUDIO }, [clip('audio', 'a1', 'audio/mpeg')], 'The audio clip @a1 is 31 seconds long, and M takes audio clips of at most 30 seconds.'],
      ['a video clip too long, by its MP4 header', { video: { use: 'reference', maxSeconds: 15 } }, { v1: mp4Video(15.5) }, [clip('video', 'v1', 'video/mp4')], 'The video clip @v1 is 15.5 seconds long, and M takes video clips of at most 15 seconds.'],
      ['a video clip too short', { video: { use: 'reference', minSeconds: 2 } }, { v1: mp4Video(1.5) }, [clip('video', 'v1', 'video/mp4')], 'The video clip @v1 is 1.5 seconds long, and M takes video clips of at least 2 seconds.'],
      ['video clips too long together', { video: { use: 'reference', maxTotalSeconds: 15 } }, { v1: mp4Video(8), v2: mp4Video(8) }, [clip('video', 'v1', 'video/mp4'), clip('video', 'v2', 'video/mp4')], 'The video clips of this message are 16 seconds long together, and M takes at most 15 seconds of video clips in one request.'],
      ['a WAV copy too large', { audio: { use: 'background', maxBytes: 10, types: ['audio/wav'] } }, { a1: OGG_AUDIO }, [clip('audio', 'a1', 'audio/ogg')], 'The copy is 16 B, and M takes audio clips of at most 10 B.'],
    ] as Array<[string, InputClipRules, Record<string, Uint8Array>, ClipAttachment[], string]>)('refuses %s, before any request', async (_case, rules, files, clips, message) => {
      useClipModel('m', rules)
      clipFiles = files
      audioSeconds = 31

      await expect(generate({ kind: 'video', clips })).rejects.toThrow(message)
      expect(downloadRequests).toEqual([])
    })

    it('refuses a clip of a kind that the model does not take before it reads any clip', async () => {
      useClipModel('m', { video: { use: 'reference' } })

      await expect(generate({ kind: 'video', clips: [clip('video', 'v1', 'video/mp4'), clip('audio', 'a1', 'audio/mpeg')] })).rejects.toThrow('M takes no audio clip, and this message has 1 audio clip.')
      expect([clipReads, downloadRequests]).toStrictEqual([[], []])
    })

    it('sends a clip of a kind that the model takes only by web address by its URL, unread, and reads the clips of the other kind', async () => {
      useClipModel(REFERENCE_MODEL, { video: { use: 'reference', urlOnly: true }, audio: { use: 'reference', types: ['audio/mpeg'] } }, 'imageToVideo')
      clipFiles = { a1: MP3_AUDIO }
      audioSeconds = 3

      await generate({ modelId: REFERENCE_MODEL, kind: 'imageToVideo', clips: [clip('video', 'v1', 'video/mp4'), clip('audio', 'a1', 'audio/mpeg')] })

      expect(clipReads).toStrictEqual(['a1'])
      expect(downloadRequests.map(jsonBody)).toStrictEqual([{
        duration: '5s',
        model: REFERENCE_MODEL,
        prompt: 'A red fox',
        reference_video_urls: ['https://files.example.com/v1.bin'],
        reference_audio_urls: [dataUrl('audio/mpeg', MP3_AUDIO)],
      }])
    })

    it('refuses a clip with no web address to a model that takes its kind only by one, before it reads any clip', async () => {
      useClipModel('m', { video: { use: 'reference', urlOnly: true } })

      await expect(generate({ kind: 'video', clips: [{ ...clip('video', 'v1', 'video/mp4'), url: null }] })).rejects.toThrow('M takes video clips only by a web address that its provider downloads, and @v1 has none')
      expect([clipReads, downloadRequests]).toStrictEqual([[], []])
    })

    // Puts the transcription model `whisper` in the model cache, with the
    // clip rules of the Venice format.
    function useTranscriptionModel(): void {
      sbp('dez.model/modelCache/applyProviderResult', 'media', {
        ok: true,
        models: [{ id: 'whisper', name: 'Whisper', provider: 'media', outputs: ['text'], request: 'transcription', clips: { audio: { use: 'source', maxClips: 1, types: ['audio/wav', 'audio/mpeg'] } } }],
      })
    }

    it('sends the audio clip of a transcription as the file of a form through dez.http/stream, and gives the text of the answer as it is', async () => {
      useTranscriptionModel()
      clipFiles = { a1: MP3_AUDIO }
      audioSeconds = 3

      const result = await generate({ modelId: 'whisper', kind: 'transcription', clips: [clip('audio', 'a1', 'audio/mpeg')], requestId: 'reply-1' })
      const [{ url, headers, body }] = streamRequests
      const form = await new Response(typeof body === 'object' ? base64ToBytes(body.base64) : body, { headers }).formData()
      const file = form.get('file')

      expect(result).toStrictEqual({ media: [], clips: [], text: ' Hello there. ' })
      expect([streamRequestIds, url, downloadRequests]).toStrictEqual([['reply-1'], `${MEDIA_BASE_URL}/audio/transcriptions`, []])
      expect(file instanceof Blob && new Uint8Array(await file.arrayBuffer())).toStrictEqual(MP3_AUDIO)
    })

    it('refuses a transcription with no audio clip before any request', async () => {
      useTranscriptionModel()

      await expect(generate({ modelId: 'whisper', kind: 'transcription', clips: [clip('video', 'v1', 'video/mp4')] })).rejects.toThrow(
        'Whisper writes down the speech of an audio clip, and this message has no audio clip.',
      )
      expect([clipReads, streamRequests, downloadRequests]).toStrictEqual([[], [], []])
    })
  })
})

describe('the price of a clip', () => {
  const QUOTE_URL = `${MEDIA_BASE_URL}/video/quote`
  const quote = (input: Record<string, unknown>) =>
    sbp('dez.provider/mediaQuote', { providerId: 'media', modelId: 'm', kind: 'video', ...input }) as Promise<ProviderMediaQuote | null>

  // The model `m` in the model cache, as a model check leaves it.
  function cacheModel(entry: unknown = { id: 'm' }) {
    sbp('dez.model/modelCache/applyProviderResult', 'media', {
      ok: true,
      models: [{
        id: 'm',
        name: 'M',
        provider: 'media',
        parameters: [
          { name: 'duration', label: 'Length', options: ['4s', '8s'], default: '4s' },
          { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'], default: '16:9' },
          { name: 'duration_seconds', label: 'Length (seconds)', min: 1, max: 30, default: 5 },
        ],
      }],
      entries: new Map([['m', entry]]),
    })
  }

  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'media',
      name: 'Media server',
      baseUrl: MEDIA_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      mediaApi: { format: 'venice' },
    })
    httpAnswers.set(QUOTE_URL, { status: 200, json: { quote: 0.07 } })
  })

  it('asks the provider for the price of a request with the chosen values, and the defaults of the others', async () => {
    cacheModel()

    expect(await quote({ parameters: { duration: '8s' } })).toStrictEqual({ usd: 0.07 })
    expect(httpRequests).toStrictEqual([{
      method: 'POST',
      url: QUOTE_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: '8s', aspect_ratio: '16:9', duration_seconds: 5, model: 'm' }),
      timeoutMs: 20_000,
    }])
  })

  it('gives no price, and sends no request, where the provider has no price request', async () => {
    cacheModel({ id: 'm', model_spec: { pricing: { per_thousand_characters: { usd: 0.1 } } } })

    expect([
      await quote({ kind: 'tts' }),
      // The model's entry tells that its price is by the length of the text.
      await quote({ kind: 'music' }),
      await quote({ kind: 'image' }),
      await quote({ providerId: 'local' }),
    ]).toStrictEqual([null, null, null, null])
    expect(httpRequests).toEqual([])
  })

  it('rejects when the provider refuses the price request', async () => {
    cacheModel()
    httpAnswers.set(QUOTE_URL, { status: 400, json: { error: 'Bad model' } })

    await expect(quote({})).rejects.toThrow('Details: HTTP 400: Bad model')
  })
})

describe('the price of an image', () => {
  const quote = (providerId: string, modelId: string, kind: string, parameters: Record<string, unknown> = {}) =>
    sbp('dez.provider/mediaQuote', { providerId, modelId, kind, parameters }) as Promise<ProviderMediaQuote | null>

  // A model in the model cache, as a model check leaves it.
  function cacheModel(providerId: string, model: Record<string, unknown>, entry: unknown, mediaEntry?: unknown) {
    sbp('dez.model/modelCache/applyProviderResult', providerId, {
      ok: true,
      models: [{ name: 'M', provider: providerId, ...model }],
      entries: new Map([[model.id, entry]]),
      ...(mediaEntry !== undefined && { mediaEntries: new Map([[model.id, mediaEntry]]) }),
    })
  }

  beforeEach(() => {
    for (const [id, format] of [['media', 'venice'], ['routed', 'openrouter']]) {
      sbp('dez.model/customProviders/save', {
        id,
        name: 'Media server',
        baseUrl: MEDIA_BASE_URL,
        apiFormat: 'openai',
        models: [],
        fetchModels: true,
        auth: 'apiKey',
        mediaApi: { format },
      })
    }
  })

  describe('from the prices of the model entry', () => {
    // Every Venice image model repeats the upscale prices.
    const upscale = { '2x': { usd: 0.02, diem: 0.02 }, '4x': { usd: 0.08, diem: 0.08 } }
    const pricing = (prices: Record<string, unknown>) => ({ id: 'm', model_spec: { pricing: { ...prices, upscale } } })

    it('gives the price of the scale of an upscale, and sends no request', async () => {
      cacheModel('media', { id: 'm', request: 'upscale', parameters: [{ name: 'scale', label: 'Scale', options: [2, 4], default: 2 }] }, pricing({ generation: { usd: 0.01 } }))

      expect([await quote('media', 'm', 'upscale'), await quote('media', 'm', 'upscale', { scale: 4 })]).toStrictEqual([{ usd: 0.02 }, { usd: 0.08 }])
      expect(httpRequests).toStrictEqual([])
    })

    it('gives the one price of a new image or an edit', async () => {
      cacheModel('media', { id: 'm', request: 'image' }, pricing({ generation: { usd: 0.01 }, inpaint: { usd: 0.04 } }))
      expect(await quote('media', 'm', 'image')).toStrictEqual({ usd: 0.01 })

      cacheModel('media', { id: 'm', request: 'imageEdit' }, pricing({ inpaint: { usd: 0.04 } }))
      expect(await quote('media', 'm', 'imageEdit')).toStrictEqual({ usd: 0.04 })
    })

    // The values of the request choose the price, as the model check left
    // the parameter of the resolution with no default.
    it('gives the price of the resolution of the request, and none with no resolution', async () => {
      cacheModel('media', { id: 'm', request: 'image', parameters: [{ name: 'resolution', label: 'Resolution', options: ['1K', '4K'] }] }, pricing({ resolutions: { '1K': { usd: 0.01 }, '4K': { usd: 0.05 } } }))

      expect([await quote('media', 'm', 'image', { resolution: '4K' }), await quote('media', 'm', 'image')]).toStrictEqual([{ usd: 0.05 }, null])
      expect(httpRequests).toStrictEqual([])
    })
  })

  describe('from the price records of the model', () => {
    const RECORDS_URL = `${MEDIA_BASE_URL}/images/models/acme/pic/endpoints`
    const mediaEntry = { id: 'acme/pic', supported_parameters: { resolution: { type: 'enum', values: ['1K', '2K', '4K'] } } }
    const record = (cost: number, variant?: string) => ({ billable: 'output_image', unit: 'image', cost_usd: cost, ...(variant && { variant }) })
    const endpoints = (pricing: unknown[]) => ({ id: 'acme/pic', endpoints: [{ pricing }, { pricing }] })

    beforeEach(() => {
      cacheModel('routed', { id: 'acme/pic', request: 'image', parameters: [{ name: 'resolution', label: 'Resolution', options: ['1K', '2K', '4K'] }] }, { id: 'acme/pic' }, mediaEntry)
    })

    it('asks for the records, and gives them with the price of the request\'s resolution, else of the resolutions with no record', async () => {
      const records = endpoints([record(0.13), record(0.17, '4k'), { billable: 'input_image', unit: 'image', cost_usd: 0 }])
      httpAnswers.set(RECORDS_URL, { status: 200, json: records })

      expect([
        await quote('routed', 'acme/pic', 'image', { resolution: '4K' }),
        await quote('routed', 'acme/pic', 'image', { resolution: '2K' }),
        await quote('routed', 'acme/pic', 'image'),
      ]).toStrictEqual([{ usd: 0.17, records }, { usd: 0.13, records }, { usd: 0.13, records }])
      expect(httpRequests.map(({ method, url, timeoutMs }) => [method, url, timeoutMs])).toStrictEqual(Array(3).fill(['GET', RECORDS_URL, 20_000]))
    })

    it.each([
      ['a record that costs by another unit', [record(0.04), { billable: 'input_image', unit: 'image', cost_usd: 0.01 }]],
      ['a variant that is no resolution of the model', [record(0.04), record(0.08, 'high_resolution')]],
      ['two records of one variant', [record(0.04, '1k'), record(0.08, '1k')]],
    ])('gives only the records for %s', async (_name, pricing) => {
      const records = endpoints(pricing)
      httpAnswers.set(RECORDS_URL, { status: 200, json: records })

      expect(await quote('routed', 'acme/pic', 'image', { resolution: '1K' })).toStrictEqual({ records })
    })

    it('gives only the records when the providers of the model have different prices', async () => {
      const records = { id: 'acme/pic', endpoints: [{ pricing: [record(0.04)] }, { pricing: [record(0.05)] }] }
      httpAnswers.set(RECORDS_URL, { status: 200, json: records })

      expect(await quote('routed', 'acme/pic', 'image')).toStrictEqual({ records })
    })

    it('rejects when the provider refuses the records request', async () => {
      httpAnswers.set(RECORDS_URL, { status: 404, json: { error: 'No model' } })

      await expect(quote('routed', 'acme/pic', 'image')).rejects.toThrow('Details: HTTP 404: No model')
    })
  })
})

describe('known model limits', () => {
  const WAN = { id: 'wan-2-7-text-to-video', name: 'Wan 2.7', request: 'video' }
  const limits = (providerId: string) => (sbp('dez.provider/knownLimits', providerId, WAN.id) as KnownLimit[]).map(({ limit }) => limit)

  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'proxy',
      name: 'Proxy',
      baseUrl: MEDIA_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      mediaApi: { format: 'venice' },
    })
  })

  // The limit of the Venice video queue is for the video request kinds.
  it('gives the limits of the provider\'s media format for the request kind of the cached model', () => {
    expect(limits('proxy')).toStrictEqual([])

    for (const providerId of ['proxy', 'local']) {
      sbp('dez.model/modelCache/applyProviderResult', providerId, { ok: true, models: [{ ...WAN, provider: providerId }] })
    }

    expect([limits('proxy'), limits('local')]).toStrictEqual([[{ maxBodyMB: 35 }], []])
  })

  // The row tells the model why Dez refuses a message with more images.
  it('gives last the image count that a refusal of the provider told, with the name of the provider', () => {
    sbp('dez.model/modelCache/applyProviderResult', 'proxy', {
      ok: true,
      models: [{ ...WAN, provider: 'proxy' }],
      entries: new Map([[WAN.id, { id: WAN.id }]]),
    })
    sbp('dez.model/modelCache/learnImageLimit', 'proxy', WAN.id, 1)
    const rows = sbp('dez.provider/knownLimits', 'proxy', WAN.id) as KnownLimit[]

    expect(rows.map(({ limit }) => limit)).toStrictEqual([{ maxBodyMB: 35 }, { maxImages: 1 }])
    expect(rows[1].source).toContain('Proxy')
  })
})

describe('provider error messages', () => {
  // Settings gives custom providers UUID ids, which the user never sees.
  const uuid = 'b7e3a1c2-5d4f-4e6a-9c8b-1a2b3c4d5e6f'

  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: uuid,
      name: 'Broken server',
      baseUrl: FAILING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
    })
  })

  const chatInput = {
    providerId: uuid,
    modelId: 'served-model',
    messages: [{ role: 'user', content: 'Hi' }],
    onToken: () => {},
  }

  it('name a custom provider whose server fails by its name, not its id', async () => {
    const result = await sbp('dez.provider/listModelsResult', uuid) as ProviderModelsResult
    const chatError = await sbp('dez.provider/streamChat', chatInput).catch((error: Error) => error)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Broken server')
    expect(result.error).not.toContain(uuid)
    expect(chatError).toBeInstanceOf(Error)
    expect((chatError as Error).message).toContain('Broken server')
    expect((chatError as Error).message).not.toContain(uuid)
  })

  it('do not show the id of a deleted provider that a tab still uses', async () => {
    sbp('dez.model/customProviders/remove', uuid)
    const chatError = await sbp('dez.provider/streamChat', chatInput).catch((error: Error) => error)

    expect(chatError).toBeInstanceOf(Error)
    expect((chatError as Error).message).not.toContain(uuid)
    expect(streamRequests).toEqual([])
  })
})

describe('model display names', () => {
  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'named',
      name: 'Named server',
      baseUrl: 'http://localhost:8081/v1',
      apiFormat: 'openai',
      models: [{ id: 'alpha', name: 'Alpha One' }, { id: 'beta' }],
      fetchModels: true,
      auth: 'apiKey',
    })
    // As if the last fetch ran before the config named `alpha`.
    sbp('dez.model/modelCache/applyProviderResult', 'named', {
      ok: true,
      models: [
        { id: 'alpha', name: 'alpha (served)', provider: 'named', readableName: 'Alpha Readable' },
        { id: 'beta', name: 'Beta Two', provider: 'named' },
        { id: 'vendor/gamma', name: 'Gamma', provider: 'named' },
      ],
    })
    sbp('dez.model/modelCache/applyProviderResult', 'gone', {
      ok: true,
      models: [{ id: 'delta', name: 'Delta', provider: 'gone' }],
    })
  })

  const names = () => sbp('dez.provider/modelDisplayNames') as ModelDisplayNames

  it('prefer a name set in the provider config over the cached name', () => {
    expect(names().models.get('named/alpha')).toBe('Alpha One')
  })

  it('use the cached name when the config sets none', () => {
    expect(names().models.get('named/beta')).toBe('Beta Two')
    expect(names().models.get('named/vendor/gamma')).toBe('Gamma')
  })

  it('have no entry for a model that is neither configured nor cached', () => {
    expect(names().models.has('named/epsilon')).toBe(false)
  })

  it('take the readable names from the cache, also for a model that the config names', () => {
    expect([...names().readableNames]).toStrictEqual([['named/alpha', 'Alpha Readable']])
  })

  it('name known providers and have no entry for an unknown provider', () => {
    expect(names().providers.get('named')).toBe('Named server')
    expect(names().providers.get('openrouter')).toBe('OpenRouter')
    expect(names().providers.has('gone')).toBe(false)
  })
})
