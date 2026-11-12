import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest, NativeHttpResponse } from '../../utils/protocol/nativeHttp'
import { bytesToBase64 } from '../../utils/base64'
import { ExplainedError } from '../../utils/errorText'
import { TooManyImagesError } from './clipImages'
import { NO_VIDEO_LENGTH_MESSAGE } from './mediaFormats'
import type { ModelParameter } from './modelParameters'
import { wavFile } from './pcmAudio'
import type { ProviderGenerateMediaResult } from './streamTypes'
import type { ModelInfo } from './types'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../state/index'
import './selectors'

// The clip part of dez.provider/generateMedia: the job loop (selectors.ts)
// and its steps (clipRequests.ts). The native layer is a stand-in, so no
// request leaves the test: the URLs below name servers that do not exist.

interface FileRef {
  root: string
  path: string
}

interface Download {
  request: NativeHttpRequest
  requestId: string
  file: FileRef
  rule: NativeDownloadRule
  // The time of the request.
  at: number
}

const CACHE_DIR = '/home/u/.cache/dez'
const VENICE_URL = 'http://localhost:5050/api/v1'
const OPENROUTER_URL = 'http://localhost:6060/api/v1'
const STARTED_AT = Date.parse('2026-11-10T09:30:00.000Z')
const SECOND_MS = 1000
const DAY_MS = 24 * 60 * 60 * SECOND_MS
const JOB_TIMEOUT_MS = 30 * 60 * SECOND_MS
// The start of the text of an answer of the venice-like provider that Dez
// cannot use, and the advice of a failed job.
const UNUSABLE_ANSWER = 'Media server sent an answer that Dez cannot use. Send the request again. If the error stays, report it at Help › Dez on GitHub.'
const JOB_ADVICE = 'To ask Media server about this clip, give its job id: q-1.'
const POST_HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' }

// What the stand-ins received, in order.
let downloads: Download[] = []
let moves: Array<{ from: FileRef, to: FileRef }> = []
let deleted: FileRef[] = []
let loaded: FileRef[] = []
let saved: Array<FileRef & { content: Uint8Array }> = []
// The bytes of every file that a test reads: raw PCM samples.
const SAMPLES = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0])
// The error of the next delete of a file, if any.
let deleteError: Error | null = null
let cancelled: string[] = []
let httpRequests: NativeHttpRequest[] = []
// The answers of the media server to the clip requests, in order. A
// function answers when its promise settles.
let answers: Array<NativeHttpDownload | (() => Promise<NativeHttpDownload>)> = []

const bytesOf = (text: string) => Array.from(new TextEncoder().encode(text))
// A response that Rust saved in the file: the clip.
const clip = (contentType: string): NativeHttpDownload => ({ status: 200, headers: { 'content-type': contentType }, saved: true, body: [] })
const json = (value: unknown, status = 200): NativeHttpDownload =>
  ({ status, headers: { 'content-type': 'application/json' }, saved: false, body: bytesOf(JSON.stringify(value)) })

sbp('sbp/selectors/register', {
  async 'dez.native/getProviderSecret' (): Promise<string | null> {
    return 'sk-test'
  },
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? CACHE_DIR : '/home/u/.config/dez'
  },
  // No clip request reads a list: a request here is a failure of the test.
  async 'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    httpRequests.push(request)
    return { status: 404, headers: {}, body: bytesOf('Not found') }
  },
  async 'dez.native/downloadAppFile' (request: NativeHttpRequest, requestId: string, file: FileRef, rule: NativeDownloadRule): Promise<NativeHttpDownload> {
    downloads.push({ request, requestId, file, rule, at: Date.now() })
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`The test has no answer for ${request.url}`)
    return typeof answer === 'function' ? answer() : answer
  },
  async 'dez.native/moveAppFile' (from: FileRef, to: FileRef): Promise<void> {
    moves.push({ from, to })
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app'): Promise<void> {
    deleted.push({ root, path })
    if (deleteError) throw deleteError
  },
  async 'dez.native/loadAppFileBytes' (path: string, root = 'app'): Promise<Uint8Array> {
    loaded.push({ root, path })
    return SAMPLES
  },
  async 'dez.native/saveAppFile' (path: string, content: Uint8Array, root = 'app'): Promise<void> {
    saved.push({ root, path, content })
  },
  async 'dez.http/cancelStream' (requestId: string): Promise<void> {
    cancelled.push(requestId)
  },
})

let consoleError: MockInstance<typeof console.error>

// The id that the nth clip request of a test gets for its file, in the
// shape that the type of `crypto.randomUUID` asks for.
const fileId = (n: number) => `00000000-0000-4000-8000-${n}` as const

beforeEach(() => {
  setActivePinia(createPinia())
  downloads = []
  moves = []
  deleted = []
  loaded = []
  saved = []
  deleteError = null
  cancelled = []
  httpRequests = []
  answers = []
  vi.useFakeTimers({ now: STARTED_AT })
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Each request of a clip takes one id, for the name of its file.
  let uuids = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => fileId(++uuids))
  for (const [id, name, baseUrl, format] of [['venice-like', 'Media server', VENICE_URL, 'venice'], ['router-like', 'Router', OPENROUTER_URL, 'openrouter']]) {
    sbp('dez.model/customProviders/save', { id, name, baseUrl, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey', mediaApi: { format } })
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const generate = (input: Record<string, unknown>) =>
  sbp('dez.provider/generateMedia', { providerId: 'venice-like', modelId: 'm', prompt: 'Rain', requestId: 'reply-1', ...input }) as Promise<ProviderGenerateMediaResult>

// The file of the nth clip request: `part` while Rust writes it.
const tempFile = (n: number, extension: string): FileRef => ({ root: 'cache', path: `media/${fileId(n)}.${extension}` })
const tempPath = (n: number, extension: string) => `${CACHE_DIR}/media/${fileId(n)}.${extension}`
const isoAfter = (ms: number) => new Date(STARTED_AT + ms).toISOString()
const requestUrls = () => downloads.map(({ request }) => `${request.method} ${request.url}`)

// Puts the model `m` of a provider in the model cache with these
// parameters, as a model check does.
function cacheModel(providerId: string, parameters: ModelParameter[]): void {
  sbp('dez.model/modelCache/applyProviderResult', providerId, { ok: true, models: [{ id: 'm', name: 'M', provider: providerId, parameters }] })
}

const VENICE_VIDEO_PARAMETERS: ModelParameter[] = [
  { name: 'duration', label: 'Length', options: ['4s', '8s'], default: '4s' },
  { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
  { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'], default: '16:9' },
]
const OPENROUTER_VIDEO_PARAMETERS: ModelParameter[] = [
  { name: 'duration', label: 'Length (seconds)', options: [1, 4, 8], default: 1 },
  { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
  { name: 'aspect_ratio', label: 'Aspect ratio', options: ['16:9', '1:1'] },
]
// The answer of a Venice-like provider to a video request with a last
// frame, for a model that takes none, and the two frames of that request.
const LAST_FRAME_REFUSAL = json({
  details: { _errors: [], end_image_url: { _errors: ['This model does not support end_image_url'] } },
  error: 'Invalid request parameters',
}, 400)
const TWO_FRAMES = ['/home/u/.config/dez/assets/images/fox.png', '/home/u/.config/dez/assets/images/end.png']

describe('a clip that the first answer holds', () => {
  it('lets Rust write the speech to a temp copy, named by the type of the answer', async () => {
    answers = [clip('audio/mpeg')]

    const result = await generate({ kind: 'tts', prompt: 'Hi' })

    expect(result).toStrictEqual({
      media: [],
      clips: [{ kind: 'audio', mediaType: 'audio/mpeg', src: tempPath(1, 'mp3'), url: null, expires: isoAfter(DAY_MS), jobId: null }],
    })
    // Only audio is saved, so that a JSON answer never becomes a clip.
    expect(downloads).toStrictEqual([{
      request: {
        method: 'POST',
        url: `${VENICE_URL}/audio/speech`,
        headers: POST_HEADERS,
        body: JSON.stringify({ model: 'm', input: 'Hi' }),
        timeoutMs: JOB_TIMEOUT_MS,
      },
      requestId: 'reply-1',
      file: tempFile(1, 'part'),
      rule: { maxBytes: 1024 ** 3, contentTypes: ['audio/'] },
      at: STARTED_AT,
    }])
    expect(moves).toStrictEqual([{ from: tempFile(1, 'part'), to: tempFile(1, 'mp3') }])
    expect(httpRequests).toEqual([])
  })

  it('reads the type of the clip from a header of any case, without its parameters', async () => {
    answers = [{ status: 200, headers: { 'Content-Type': 'Audio/WAV; rate=24000' }, saved: true, body: [] }]

    const { clips } = await generate({ kind: 'tts' })

    expect(clips.map(({ mediaType, src }) => [mediaType, src])).toStrictEqual([['audio/wav', tempPath(1, 'wav')]])
  })

  // The media server of this provider does not tell the size of a sample.
  it('deletes the file of a clip whose type Dez cannot name, and fails with the whole content type', async () => {
    answers = [clip('audio/pcm;rate=24000')]

    await expect(generate({ kind: 'tts' })).rejects.toThrow('Media server sent the clip in a file type that Dez does not know. Choose another model, and report the file type at Help › Dez on GitHub.\n\nDetails: Content type: audio/pcm;rate=24000')

    expect(deleted).toStrictEqual([tempFile(1, 'part')])
    expect([moves, loaded, saved]).toStrictEqual([[], [], []])
  })

  it('keeps the file type error when the delete of the file fails', async () => {
    answers = [clip('audio/x-unknown')]
    deleteError = new Error('Permission denied')

    await expect(generate({ kind: 'tts' })).rejects.toThrow('Media server sent the clip in a file type that Dez does not know. Choose another model, and report the file type at Help › Dez on GitHub.\n\nDetails: Content type: audio/x-unknown')

    expect(consoleError).toHaveBeenCalledWith('Failed to delete a clip of an unknown file type:', deleteError)
  })

  it('makes a WAV temp copy of raw PCM speech from the layout of the answer, and deletes the raw samples', async () => {
    answers = [clip('audio/pcm;rate=44100;channels=1')]

    const result = await generate({ providerId: 'router-like', kind: 'tts', prompt: 'Hi' })

    expect(result).toStrictEqual({
      media: [],
      clips: [{ kind: 'audio', mediaType: 'audio/wav', src: tempPath(1, 'wav'), url: null, expires: isoAfter(DAY_MS), jobId: null }],
    })
    expect(loaded).toStrictEqual([tempFile(1, 'part')])
    expect(saved).toStrictEqual([{ ...tempFile(1, 'wav'), content: wavFile(SAMPLES, { rate: 44100, channels: 1, sampleBits: 16 }) }])
    expect(deleted).toStrictEqual([tempFile(1, 'part')])
    expect(moves).toEqual([])
  })

  // The clip is paid for, and the cleanup of the temp copies deletes the
  // file later.
  it('keeps a WAV clip when the delete of its raw samples fails', async () => {
    answers = [clip('audio/pcm;rate=44100')]
    deleteError = new Error('Permission denied')

    const { clips } = await generate({ providerId: 'router-like', kind: 'tts' })

    expect(clips.map(({ mediaType, src }) => [mediaType, src])).toStrictEqual([['audio/wav', tempPath(1, 'wav')]])
    expect(consoleError).toHaveBeenCalledWith('Failed to delete the raw samples of a clip:', deleteError)
  })

  // A guessed rate would play the speech at a wrong speed.
  it('makes no file of raw PCM whose answer does not tell its rate', async () => {
    answers = [clip('audio/pcm')]

    await expect(generate({ providerId: 'router-like', kind: 'tts' })).rejects.toThrow('Details: Content type: audio/pcm')

    expect(deleted).toStrictEqual([tempFile(1, 'part')])
    expect([moves, loaded, saved]).toStrictEqual([[], [], []])
  })

  describe('a speech model that makes only raw PCM', () => {
    const pcmOnly = json({ error: { message: 'HeyGen Voice only supports response_format "pcm".', code: 400 } }, 400)

    it('sends the request once more with pcm, which the refusal names', async () => {
      answers = [pcmOnly, clip('audio/pcm;rate=24000;channels=1')]

      const { clips } = await generate({ providerId: 'router-like', kind: 'tts', prompt: 'Hi' })

      expect(downloads.map(({ request }) => JSON.parse(request.body as string).response_format)).toStrictEqual(['mp3', 'pcm'])
      expect(clips.map(({ mediaType }) => mediaType)).toStrictEqual(['audio/wav'])
      expect(consoleError).toHaveBeenCalledTimes(1)
    })

    // No loop of refusals.
    it('fails with the second refusal, and sends no third request', async () => {
      answers = [pcmOnly, pcmOnly]

      await expect(generate({ providerId: 'router-like', kind: 'tts' })).rejects.toThrow('Details: HTTP 400: HeyGen Voice only supports response_format "pcm".')

      expect(downloads).toHaveLength(2)
    })

    it('sends nothing more after a refusal of another field', async () => {
      answers = [json({ error: { message: 'Unknown voice "x"', code: 400 } }, 400)]

      await expect(generate({ providerId: 'router-like', kind: 'tts' })).rejects.toThrow('Details: HTTP 400: Unknown voice "x"')

      expect(downloads).toHaveLength(1)
    })
  })

  it.each([
    ['a refused request', { status: 402, headers: {}, saved: false, body: bytesOf('Insufficient balance') }, 'Your Media server account does not have enough credit. Add credit at Media server, then try again.\n\nDetails: HTTP 402: Insufficient balance'],
    ['an answer that is neither a clip nor JSON', { status: 200, headers: { 'content-type': 'text/html' }, saved: false, body: bytesOf('<html>') }, `${UNUSABLE_ANSWER}\n\nDetails: The answer is neither a clip nor JSON (content type: text/html).`],
    ['a JSON answer to a speech request', json({ queue_id: 'q-1' }), `${UNUSABLE_ANSWER}\n\nDetails: The answer to the clip request is neither a clip nor a job.`],
  ])('fails for %s, and names no job', async (_name, answer, message) => {
    answers = [answer]

    // The message, not the error: a refused request has its own error class.
    const error: unknown = await generate({ kind: 'tts' }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(message)

    expect(downloads).toHaveLength(1)
    expect(moves).toEqual([])
  })

  // The code cannot tell the connection, the size limit, and the disk apart,
  // so the text names all three.
  it('names the causes of a download that the native layer refuses, with the native text last', async () => {
    answers = [() => Promise.reject('error decoding response body')]

    await expect(generate({ kind: 'tts' })).rejects.toThrow('Dez could not get the answer of Media server: the connection broke, the clip is larger than 1.0 GB (the most that Dez takes), or Dez could not write the file. The details tell which. Check the internet connection and the free disk space, then send the request again.\n\nDetails: error decoding response body')
  })
})

describe('a clip job', () => {
  it('asks for the state of a music job every 5 seconds, and takes the clip from the answer that holds it', async () => {
    answers = [json({ model: 'm', queue_id: 'q-1', status: 'QUEUED' }), json({ status: 'PROCESSING' }), clip('audio/wav')]

    const result = generate({ kind: 'music' })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS - 1)
    expect(downloads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(downloads).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    // The copy is there for a day from the request that gave it.
    expect(await result).toStrictEqual({
      media: [],
      clips: [{ kind: 'audio', mediaType: 'audio/wav', src: tempPath(3, 'wav'), url: null, expires: isoAfter(10 * SECOND_MS + DAY_MS), jobId: 'q-1' }],
    })
    const retrieve = { method: 'POST', url: `${VENICE_URL}/audio/retrieve`, headers: POST_HEADERS, body: JSON.stringify({ model: 'm', queue_id: 'q-1' }) }
    // One request id serves the whole job, and each request must end
    // before the job's 30 minutes do.
    expect(downloads.map(({ request, requestId, file, at }) => ({ request, requestId, file, at }))).toStrictEqual([
      {
        request: { method: 'POST', url: `${VENICE_URL}/audio/queue`, headers: POST_HEADERS, body: JSON.stringify({ model: 'm', prompt: 'Rain' }), timeoutMs: JOB_TIMEOUT_MS },
        requestId: 'reply-1',
        file: tempFile(1, 'part'),
        at: STARTED_AT,
      },
      { request: { ...retrieve, timeoutMs: JOB_TIMEOUT_MS - 5 * SECOND_MS }, requestId: 'reply-1', file: tempFile(2, 'part'), at: STARTED_AT + 5 * SECOND_MS },
      { request: { ...retrieve, timeoutMs: JOB_TIMEOUT_MS - 10 * SECOND_MS }, requestId: 'reply-1', file: tempFile(3, 'part'), at: STARTED_AT + 10 * SECOND_MS },
    ])
    expect(moves).toStrictEqual([{ from: tempFile(3, 'part'), to: tempFile(3, 'wav') }])
  })

  it('queues a song with its lyrics, the switches that the user set, and the defaults of the other parameters', async () => {
    cacheModel('venice-like', [
      { name: 'duration_seconds', label: 'Length (seconds)', options: [60, 90], default: 60 },
      { name: 'force_instrumental', label: 'Instrumental' },
      { name: 'loop', label: 'Loop' },
    ])
    answers = [json({ model: 'm', queue_id: 'q-1', status: 'QUEUED' }), clip('audio/mpeg')]

    const result = generate({ kind: 'music', prompt: 'Slow piano ballad', lyrics: 'Rain on the roof', parameters: { loop: true } })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await result

    // A switch that no one set sends no value: the provider's own default
    // applies.
    expect(JSON.parse(downloads[0].request.body as string)).toStrictEqual({
      duration_seconds: 60,
      loop: true,
      model: 'm',
      prompt: 'Slow piano ballad',
      lyrics_prompt: 'Rain on the roof',
    })
  })

  // The URL comes from an answer of the provider: the request to it must
  // not carry the API key.
  it('copies a video from the file URL of a job, with a request that has no header', async () => {
    const url = 'https://share.example.com/v1/share/token-1'
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [json({ model: 'm', queue_id: 'q-1', download_url: url }), json({ status: 'PROCESSING' }), json({ status: 'COMPLETED' }), clip('video/mp4')]

    const result = generate({ kind: 'video', prompt: 'A red fox' })
    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)

    // The tag gets no `url`: the clip does not play from that URL.
    expect(await result).toStrictEqual({
      media: [],
      clips: [{ kind: 'video', mediaType: 'video/mp4', src: tempPath(4, 'mp4'), url: null, expires: isoAfter(10 * SECOND_MS + DAY_MS), jobId: 'q-1' }],
    })
    expect(requestUrls()).toStrictEqual([`POST ${VENICE_URL}/video/queue`, `POST ${VENICE_URL}/video/retrieve`, `POST ${VENICE_URL}/video/retrieve`, `GET ${url}`])
    expect(downloads[3].request).toStrictEqual({ method: 'GET', url, timeoutMs: JOB_TIMEOUT_MS - 10 * SECOND_MS })
    // With no chosen value, each parameter of the cached model has its
    // default.
    expect(JSON.parse(downloads[0].request.body as string)).toStrictEqual({ model: 'm', prompt: 'A red fox', duration: '4s', aspect_ratio: '16:9', resolution: '480p' })
    expect(downloads.map(({ rule }) => rule.contentTypes)).toStrictEqual([['video/'], ['video/'], ['video/'], ['video/']])
    expect(httpRequests).toEqual([])
    expect(moves).toStrictEqual([{ from: tempFile(4, 'part'), to: tempFile(4, 'mp4') }])
  })

  it('gives the URL of a video that the provider stores at a URL that plays, with no temp copy', async () => {
    const url = 'https://storage.example.com/v/clip.mp4?sig=1'
    const expiresAt = (STARTED_AT + DAY_MS) / SECOND_MS
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    answers = [json({ id: 'gen-1', status: 'pending' }, 202), json({ id: 'gen-1', status: 'completed', urls: [url], expires_at: expiresAt })]

    const result = generate({ providerId: 'router-like', kind: 'video', prompt: 'A red fox' })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    expect(await result).toStrictEqual({
      media: [],
      clips: [{ kind: 'video', mediaType: 'video/mp4', src: url, url, expires: isoAfter(DAY_MS), jobId: 'gen-1' }],
    })
    expect(requestUrls()).toStrictEqual([`POST ${OPENROUTER_URL}/videos`, `GET ${OPENROUTER_URL}/videos/gen-1`])
    expect(moves).toEqual([])
  })

  it('sends a chosen value that the model takes, and the default in place of one that it does not take', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [json({ queue_id: 'q-1' }), clip('video/mp4')]

    const result = generate({ kind: 'video', prompt: 'A red fox', parameters: { duration: '8s', resolution: '4k', fps: 60 } })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    expect((await result).clips.map(({ src, jobId }) => [src, jobId])).toStrictEqual([[tempPath(2, 'mp4'), 'q-1']])
    expect(JSON.parse(downloads[0].request.body as string)).toStrictEqual({ model: 'm', prompt: 'A red fox', duration: '8s', aspect_ratio: '16:9', resolution: '480p' })
  })

  // The bytes of the files go, never their paths.
  it('sends the stored images of a video request as its first and last frame, as data URLs', async () => {
    const appDir = '/home/u/.config/dez'
    const data = bytesToBase64(SAMPLES)
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [json({ queue_id: 'q-1' }), clip('video/mp4')]

    const result = generate({
      kind: 'imageToVideo',
      prompt: 'It runs',
      images: [`${appDir}/assets/images/fox.png`, `${appDir}/assets/generated/images/end.webp`],
    })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await result

    expect(loaded).toStrictEqual([{ root: 'app', path: 'assets/images/fox.png' }, { root: 'app', path: 'assets/generated/images/end.webp' }])
    expect(JSON.parse(downloads[0].request.body as string)).toStrictEqual({
      model: 'm',
      prompt: 'It runs',
      duration: '4s',
      aspect_ratio: '16:9',
      resolution: '480p',
      image_url: `data:image/png;base64,${data}`,
      end_image_url: `data:image/webp;base64,${data}`,
    })
    expect(downloads[0].request.body).not.toContain(appDir)
  })

  // Dez does not send the request again with one image: the user chooses
  // the image. With no raw entry of the model in memory, the model cache
  // learns no count (learnedImageLimit.ts).
  it('fails with the count of the images after a refusal of the last frame, and sends no other request', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [LAST_FRAME_REFUSAL]

    const error = await generate({ kind: 'imageToVideo', images: TWO_FRAMES }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(TooManyImagesError)
    expect(error).toMatchObject({ maxImages: 1, sentImages: 2 })
    expect(downloads).toHaveLength(1)
    expect(consoleError.mock.calls.map(([text, logged]) => [text, (logged as ExplainedError).details])).toStrictEqual([[
      'Media server refused the images of a request to m:',
      'HTTP 400: Invalid request parameters (end_image_url: This model does not support end_image_url)',
    ]])
    expect((sbp('dez.model/modelCache/model', 'venice-like', 'm') as ModelInfo).learnedImageLimit).toBeUndefined()
  })

  // The refusal cost nothing, and so would the next one; but the user
  // would send the same message again and again.
  it('keeps the count of a refusal of the last frame, and refuses a later request with more images before any request', async () => {
    sbp('dez.model/modelCache/applyProviderResult', 'venice-like', {
      ok: true,
      models: [{ id: 'm', name: 'M', provider: 'venice-like', parameters: VENICE_VIDEO_PARAMETERS }],
      entries: new Map([['m', { id: 'm', model_spec: { name: 'M' } }]]),
    })
    answers = [LAST_FRAME_REFUSAL]
    await expect(generate({ kind: 'imageToVideo', images: TWO_FRAMES })).rejects.toBeInstanceOf(TooManyImagesError)

    await expect(generate({ kind: 'imageToVideo', images: TWO_FRAMES })).rejects.toStrictEqual(new ExplainedError(
      'M takes only 1 image, and this message has 2. Keep only 1 image in the message (pasted, or named with @id), and send it again.',
    ))
    expect(downloads).toHaveLength(1)
    expect((sbp('dez.model/modelCache/model', 'venice-like', 'm') as ModelInfo).learnedImageLimit?.maxImages).toBe(1)
  })

  it('makes a video through a job that answers 202, a GET poll, and a download of the content', async () => {
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    answers = [
      json({ id: 'gen-1', polling_url: 'https://evil.example/poll', status: 'pending' }, 202),
      json({ id: 'gen-1', status: 'in_progress' }),
      json({ id: 'gen-1', status: 'completed', unsigned_urls: ['https://evil.example/content'] }),
      clip('video/mp4'),
    ]

    const result = generate({ providerId: 'router-like', kind: 'video', prompt: 'A red fox' })
    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)

    expect(await result).toStrictEqual({
      media: [],
      clips: [{ kind: 'video', mediaType: 'video/mp4', src: tempPath(4, 'mp4'), url: null, expires: isoAfter(10 * SECOND_MS + DAY_MS), jobId: 'gen-1' }],
    })
    // The aspect ratio has no default, so the request names none. The key
    // goes only to URLs that Dez builds from the job id.
    expect(downloads.map(({ request }) => request)).toStrictEqual([
      {
        method: 'POST',
        url: `${OPENROUTER_URL}/videos`,
        headers: POST_HEADERS,
        body: JSON.stringify({ duration: 1, resolution: '480p', model: 'm', prompt: 'A red fox' }),
        timeoutMs: JOB_TIMEOUT_MS,
      },
      { method: 'GET', url: `${OPENROUTER_URL}/videos/gen-1`, headers: { Authorization: 'Bearer sk-test' }, timeoutMs: JOB_TIMEOUT_MS - 5 * SECOND_MS },
      { method: 'GET', url: `${OPENROUTER_URL}/videos/gen-1`, headers: { Authorization: 'Bearer sk-test' }, timeoutMs: JOB_TIMEOUT_MS - 10 * SECOND_MS },
      { method: 'GET', url: `${OPENROUTER_URL}/videos/gen-1/content?index=0`, headers: { Authorization: 'Bearer sk-test' }, timeoutMs: JOB_TIMEOUT_MS - 10 * SECOND_MS },
    ])
    expect(moves).toStrictEqual([{ from: tempFile(4, 'part'), to: tempFile(4, 'mp4') }])
  })

  // A request with no length would get the provider's default length, at
  // a price that no one saw.
  it.each(['venice-like', 'router-like'])('sends no video request to a %s model whose lengths the model cache does not have', async (providerId) => {
    await expect(generate({ providerId, kind: 'video', parameters: { duration: 1 } }))
      .rejects.toStrictEqual(new ExplainedError(NO_VIDEO_LENGTH_MESSAGE))

    expect(downloads).toEqual([])
    expect(httpRequests).toEqual([])
  })

  // The provider took the money when the job started.
  it.each([
    ['a refused state request', [json({ queue_id: 'q-1' }), { status: 500, headers: {}, saved: false, body: bytesOf('Busy') }], `This is a problem at Media server, not in your message or in Dez. Try again later. ${JOB_ADVICE}\n\nDetails: HTTP 500: Busy`],
    [
      'a state that tells of no clip',
      [json({ queue_id: 'q-1' }), json({ status: 'FAILED' })],
      `Media server did not make the clip. The cause can be the prompt (Media server can refuse a prompt) or a problem at Media server: the details below tell what Media server said. Change the prompt, or send the request again later. ${JOB_ADVICE}\n\nDetails: State: FAILED`,
    ],
  ])('names the job before the details of the error, and in the log, after %s', async (_name, jobAnswers, message) => {
    answers = jobAnswers

    const failure = expect(generate({ kind: 'music' })).rejects.toThrow(message)
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure

    expect(consoleError.mock.calls.map(([text]) => text)).toStrictEqual(['The clip job q-1 of Media server (model m) failed:'])
  })

  it('fails when the content request of a finished job gives no clip', async () => {
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    answers = [json({ id: 'gen-1' }, 202), json({ status: 'completed' }), json({ error: 'Not ready' })]

    const failure = expect(generate({ providerId: 'router-like', kind: 'video' })).rejects.toThrow('Router sent an answer that Dez cannot use. Send the request again. If the error stays, report it at Help › Dez on GitHub. To ask Router about this clip, give its job id: gen-1.\n\nDetails: The answer to the clip download holds no clip.')
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure
  })

  it('gives up on a job that does not end in 30 minutes', async () => {
    answers = [json({ queue_id: 'q-1' }), ...Array.from({ length: 400 }, () => json({ status: 'PROCESSING' }))]

    const failure = expect(generate({ kind: 'music' })).rejects.toThrow(`Media server did not make the clip in 30 minutes, the longest time that Dez waits. Send the request again later. ${JOB_ADVICE}`)
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS)
    await failure

    // The last request had 5 seconds left.
    expect(downloads.at(-1)).toMatchObject({ at: STARTED_AT + JOB_TIMEOUT_MS - 5 * SECOND_MS, request: { timeoutMs: 5 * SECOND_MS } })
  })

  // Rust ends a request at the clip's deadline, with a native text that does
  // not tell the time limit. Here the provider made the clip, and its
  // download takes the rest of the time.
  it('tells of the time limit when it ends the download of a made clip', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    const cutDownload = () => {
      vi.setSystemTime(STARTED_AT + JOB_TIMEOUT_MS)
      return Promise.reject('error decoding response body')
    }
    answers = [json({ model: 'm', queue_id: 'q-1', download_url: 'https://share.example.com/v1/share/token-1' }), json({ status: 'COMPLETED' }), cutDownload]

    const failure = expect(generate({ kind: 'video' })).rejects.toThrow('Dez did not get the clip from Media server in 30 minutes, the longest time that Dez waits: Media server did not make it in that time, or the download of the clip was too slow. '
      + `Send the request again later. ${JOB_ADVICE}\n\nDetails: error decoding response body`)
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure

    expect(downloads).toHaveLength(3)
  })
})

describe('a stop of a clip', () => {
  it('ends the wait of a job at once, and logs the job', async () => {
    const abort = new AbortController()
    answers = [json({ queue_id: 'q-1' }), json({ status: 'PROCESSING' })]

    const failure = expect(generate({ kind: 'music', signal: abort.signal })).rejects.toThrow('This operation was aborted')
    await vi.advanceTimersByTimeAsync(2 * SECOND_MS)
    abort.abort()
    await failure

    // No time went by, and no request came after the stop.
    expect(Date.now()).toBe(STARTED_AT + 2 * SECOND_MS)
    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)
    expect(downloads).toHaveLength(1)
    expect(cancelled).toStrictEqual(['reply-1'])
    expect(consoleError.mock.calls.map(([text]) => text)).toStrictEqual(['The clip job q-1 of Media server (model m) was stopped:'])
  })

  it('cancels the request that runs, and sends no other', async () => {
    const abort = new AbortController()
    // As Rust does: the download rejects when its request id is cancelled.
    const running = () => new Promise<NativeHttpDownload>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject('Download cancelled'))
    })
    answers = [json({ queue_id: 'q-1' }), running, json({ status: 'PROCESSING' })]

    const failure = expect(generate({ kind: 'music', signal: abort.signal })).rejects.toBe('Download cancelled')
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    abort.abort()
    await failure

    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)
    expect(downloads).toHaveLength(2)
    expect(cancelled).toStrictEqual(['reply-1'])
  })

  it('sends nothing for a clip that was stopped before its first request', async () => {
    answers = [clip('audio/mpeg')]

    await expect(generate({ kind: 'tts', signal: AbortSignal.abort() })).rejects.toThrow('This operation was aborted')

    expect(downloads).toEqual([])
  })

  it('stops no request after the clip is there', async () => {
    const abort = new AbortController()
    answers = [clip('audio/mpeg')]

    await generate({ kind: 'tts', signal: abort.signal })
    abort.abort()

    expect(cancelled).toEqual([])
  })
})
