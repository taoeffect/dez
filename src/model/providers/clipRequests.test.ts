import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest, NativeHttpResponse, NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { bytesToBase64 } from '../../utils/base64'
import { ExplainedError } from '../../utils/errorText'
import { TooManyImagesError } from './clipImages'
import { notMadeJobCost } from './errors'
import { NO_VIDEO_LENGTH_MESSAGE } from './mediaFormats'
import type { ModelParameter } from './modelParameters'
import { wavFile } from './pcmAudio'
import type { MediaProgress, ProviderGenerateMediaResult } from './streamTypes'
import type { ModelInfo } from './types'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../state/index'
import './selectors'

// The clip part of dez.provider/generateMedia: the job loop (selectors.ts)
// and its steps (clipRequests.ts), and the job loop of images. The native
// layer is a stand-in, so no request leaves the test: the URLs below name
// servers that do not exist.

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
// The price that the venice-like provider tells for a music or video
// request (POST /audio/quote, /video/quote); null: the price request fails.
const QUOTE_USD = 0.35
let quoteUsd: number | null = QUOTE_USD
// While set, the price request waits for this promise.
let quoteHeld: Promise<void> | null = null
// The answers of the media server to the clip requests, in order. A
// function answers when its promise settles.
let answers: Array<NativeHttpDownload | (() => Promise<NativeHttpDownload>)> = []
// The requests of the images of a job (dez.http/stream), in order, and the
// answers of the server to them: a status, and bytes or the JSON of the
// body.
let streams: Array<{ request: NativeHttpRequest, requestId: string, at: number }> = []
let streamAnswers: Array<{ status: number, body: unknown }> = []
// The price that the APIMart-like provider tells for an image request.
const IMAGE_QUOTE_USD = 0.0085

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
  // A clip request reads no list; it asks only for its price.
  async 'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    httpRequests.push(request)
    if (request.url.endsWith('/quote')) {
      if (quoteHeld) await quoteHeld
      return quoteUsd === null
        ? { status: 500, headers: {}, body: bytesOf('Internal error') }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: bytesOf(JSON.stringify({ quote: quoteUsd })) }
    }
    if (request.url.includes('/pricing/model?')) return { status: 200, headers: { 'content-type': 'application/json' }, body: bytesOf(JSON.stringify({ total_usd: IMAGE_QUOTE_USD })) }
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
  async 'dez.http/stream' (request: NativeHttpRequest, requestId: string): Promise<NativeHttpStreamResult> {
    streams.push({ request, requestId, at: Date.now() })
    const answer = streamAnswers.shift()
    if (answer === undefined) throw new Error(`The test has no answer for ${request.url}`)
    const body = answer.body instanceof Uint8Array ? answer.body : new TextEncoder().encode(JSON.stringify(answer.body))
    return { requestId, response: { status: answer.status, headers: {} }, chunks: (async function * () { yield body })() }
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
  quoteUsd = QUOTE_USD
  quoteHeld = null
  answers = []
  streams = []
  streamAnswers = []
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
      cost: QUOTE_USD,
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
      cost: QUOTE_USD,
    })
    expect(requestUrls()).toStrictEqual([`POST ${VENICE_URL}/video/queue`, `POST ${VENICE_URL}/video/retrieve`, `POST ${VENICE_URL}/video/retrieve`, `GET ${url}`])
    expect(downloads[3].request).toStrictEqual({ method: 'GET', url, timeoutMs: JOB_TIMEOUT_MS - 10 * SECOND_MS })
    // With no chosen value, each parameter of the cached model has its
    // default.
    expect(JSON.parse(downloads[0].request.body as string)).toStrictEqual({ model: 'm', prompt: 'A red fox', duration: '4s', aspect_ratio: '16:9', resolution: '480p' })
    expect(downloads.map(({ rule }) => rule.contentTypes)).toStrictEqual([['video/'], ['video/'], ['video/'], ['video/']])
    expect(httpRequests.map(({ method, url }) => `${method} ${url}`)).toStrictEqual([`POST ${VENICE_URL}/video/quote`])
    expect(moves).toStrictEqual([{ from: tempFile(4, 'part'), to: tempFile(4, 'mp4') }])
  })

  // A Suno task of APIMart makes two songs, and tells one cost for both.
  it('copies each file of a job that made more than one clip, and counts the cost of the job once', async () => {
    const martUrl = 'http://localhost:7070/v1'
    const songUrls = ['https://cdn.example.com/audio/song-1.mp3', 'https://cdn.example.com/audio/song-2.m4a']
    sbp('dez.model/customProviders/save', { id: 'mart-like', name: 'Mart', baseUrl: martUrl, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey', mediaApi: { format: 'apimart' } })
    answers = [
      json({ code: 200, data: [{ status: 'submitted', task_id: 'task-1' }] }),
      json({ code: 200, data: { id: 'task-1', status: 'completed', cost: 0.05, result: { music: songUrls.map((audio_url) => ({ audio_url })) } } }),
      clip('audio/mpeg'),
      clip('audio/mp4'),
    ]

    const result = generate({ providerId: 'mart-like', modelId: 'suno', kind: 'music', prompt: 'A ukulele jingle' })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    const expires = isoAfter(5 * SECOND_MS + DAY_MS)
    expect(await result).toStrictEqual({
      media: [],
      clips: [
        { kind: 'audio', mediaType: 'audio/mpeg', src: tempPath(3, 'mp3'), url: null, expires, jobId: 'task-1' },
        { kind: 'audio', mediaType: 'audio/mp4', src: tempPath(4, 'm4a'), url: null, expires, jobId: 'task-1' },
      ],
      cost: 0.05,
    })
    expect(requestUrls()).toStrictEqual([`POST ${martUrl}/music/generations`, `GET ${martUrl}/music/tasks/task-1?language=en`, `GET ${songUrls[0]}`, `GET ${songUrls[1]}`])
    // The URLs come from an answer: their requests carry no API key.
    expect(downloads.slice(2).map(({ request }) => request.headers)).toStrictEqual([undefined, undefined])
  })

  // The clips are paid for; the cleanup of the temp copies deletes the
  // copy of the first clip later.
  it('fails a job whose second file does not come, and leaves the copy of the first file', async () => {
    const martUrl = 'http://localhost:7070/v1'
    sbp('dez.model/customProviders/save', { id: 'mart-like', name: 'Mart', baseUrl: martUrl, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey', mediaApi: { format: 'apimart' } })
    answers = [
      json({ code: 200, data: [{ status: 'submitted', task_id: 'task-1' }] }),
      json({ code: 200, data: { id: 'task-1', status: 'completed', cost: 0.05, result: { music: [{ audio_url: 'https://cdn.example.com/1.mp3' }, { audio_url: 'https://cdn.example.com/2.mp3' }] } } }),
      clip('audio/mpeg'),
      { status: 404, headers: { 'content-type': 'text/plain' }, saved: false, body: bytesOf('Not found') },
    ]

    const failure = expect(generate({ providerId: 'mart-like', modelId: 'suno', kind: 'music', prompt: 'A ukulele jingle' })).rejects.toThrow('task-1')
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure

    expect(moves).toStrictEqual([{ from: tempFile(3, 'part'), to: tempFile(3, 'mp3') }])
    expect(deleted).toStrictEqual([])
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

  // Only the user can ask the provider about a job, so the model of a
  // `model_invoke` call gets the id to pass on.
  it('tells a model that called what a new call can change, and to give the user the job id', async () => {
    answers = [json({ queue_id: 'q-1' }), json({ status: 'FAILED' })]

    const failure = expect(generate({ kind: 'music', reader: 'model' })).rejects.toThrow(
      'Media server did not make the clip. The cause can be the prompt (Media server can refuse a prompt) or a problem at Media server: the details below tell what Media server said. '
      + 'Change the prompt, or call again once. Media server ran this request as its job q-1: give the user this id, with which the user can ask Media server about the clip.\n\nDetails: State: FAILED',
    )
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure
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

  // A `model_invoke` call names its own time limit.
  it.each([
    ['90 seconds', 90 * SECOND_MS],
    ['1 minute', 60 * SECOND_MS],
  ])('gives up on a job at the time limit of the caller, and names it as %s', async (limit, timeoutMs) => {
    answers = [json({ queue_id: 'q-1' }), ...Array.from({ length: 20 }, () => json({ status: 'PROCESSING' }))]

    const failure = expect(generate({ kind: 'music', timeoutMs })).rejects.toThrow(`Media server did not make the clip in ${limit},`)
    await vi.advanceTimersByTimeAsync(timeoutMs)
    await failure

    expect(downloads[0].request.timeoutMs).toBe(timeoutMs)
    expect(downloads.at(-1)).toMatchObject({ at: STARTED_AT + timeoutMs - 5 * SECOND_MS, request: { timeoutMs: 5 * SECOND_MS } })
  })

  // The provider took the money for the job, so its id is in each step
  // from the answer that gave it.
  it('tells the caller each step of a job, with the job id of the provider from its start', async () => {
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    answers = [json({ id: 'gen-1' }, 202), json({ status: 'in_progress' }), json({ status: 'completed' }), clip('video/mp4')]
    const steps: Array<[MediaProgress, number]> = []

    const result = generate({ providerId: 'router-like', kind: 'video', onProgress: (progress: MediaProgress) => steps.push([progress, downloads.length]) })
    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)
    await result

    // Each step, and how many requests went before it.
    expect(steps).toStrictEqual([
      [{ phase: 'sent', jobId: null }, 0],
      [{ phase: 'queued', jobId: 'gen-1', resume: { id: 'gen-1' } }, 1],
      [{ phase: 'downloading', jobId: 'gen-1' }, 3],
    ])
  })

  it('tells the caller only the first request of a clip that the first answer holds', async () => {
    answers = [clip('audio/mpeg')]
    const steps: MediaProgress[] = []

    await generate({ kind: 'tts', onProgress: (progress: MediaProgress) => steps.push(progress) })

    expect(steps).toStrictEqual([{ phase: 'sent', jobId: null }])
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

describe('the price of a clip', () => {
  it('asks for the price of the values before the request, and tells it at the first step and in the result', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [json({ queue_id: 'q-1' }), clip('video/mp4')]
    const steps: Array<[MediaProgress, number]> = []

    const result = generate({ kind: 'video', onProgress: (progress: MediaProgress) => steps.push([progress, downloads.length]) })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    expect((await result).cost).toBe(QUOTE_USD)
    expect(steps).toStrictEqual([[{ phase: 'sent', jobId: null, quote: QUOTE_USD }, 0], [{ phase: 'queued', jobId: 'q-1', resume: { queue_id: 'q-1' } }, 1]])
    expect(JSON.parse(httpRequests[0].body as string)).toStrictEqual({ model: 'm', duration: '4s', resolution: '480p', aspect_ratio: '16:9' })
  })

  it('takes the price of a request with the same values from the quote cache, with no new price request', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    answers = [json({ queue_id: 'q-1' }), clip('video/mp4'), json({ queue_id: 'q-2' }), clip('video/mp4'), json({ queue_id: 'q-3' }), clip('video/mp4')]
    const costs: Array<number | undefined> = []

    for (const [parameters, usd] of [[{}, 0.35], [{}, 0.7], [{ duration: '8s' }, 0.7]] as const) {
      quoteUsd = usd
      const result = generate({ kind: 'video', parameters })
      await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
      costs.push((await result).cost)
    }

    expect(costs).toStrictEqual([0.35, 0.35, 0.7])
    expect(httpRequests).toHaveLength(2)
  })

  it('makes the clip with no known price when the price request fails, and logs the failure', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    quoteUsd = null
    answers = [json({ queue_id: 'q-1' }), clip('video/mp4')]
    const steps: MediaProgress[] = []

    const result = generate({ kind: 'video', onProgress: (progress: MediaProgress) => steps.push(progress) })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    const { clips, ...rest } = await result
    expect([clips.length, rest]).toStrictEqual([1, { media: [] }])
    expect(steps[0]).toStrictEqual({ phase: 'sent', jobId: null })
    expect(consoleError.mock.calls.map(([text]) => text)).toStrictEqual(['Failed to get the price of a request to m of Media server; the request goes with no known price:'])
  })

  it('stops at once while the price request runs, and sends no clip request', async () => {
    cacheModel('venice-like', VENICE_VIDEO_PARAMETERS)
    quoteHeld = new Promise(() => {})
    const abort = new AbortController()

    const failure = expect(generate({ kind: 'video', signal: abort.signal })).rejects.toThrow('This operation was aborted')
    await vi.advanceTimersByTimeAsync(0)
    expect(httpRequests).toHaveLength(1)
    abort.abort()
    await failure

    expect(downloads).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('gives the price that the answer of a finished job tells over the quote', async () => {
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    sbp('dez.model/modelCache/keepQuote', { providerId: 'router-like', modelId: 'm', kind: 'video', values: { duration: 1, resolution: '480p' }, usd: 2, at: STARTED_AT })
    answers = [json({ id: 'gen-1' }, 202), json({ status: 'completed', usage: { cost: 1.25 } }), clip('video/mp4')]
    const steps: MediaProgress[] = []

    const result = generate({ providerId: 'router-like', kind: 'video', onProgress: (progress: MediaProgress) => steps.push(progress) })
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    expect([steps[0].quote, (await result).cost]).toStrictEqual([2, 1.25])
  })

  // No provider tells the price of speech before the request: the list
  // price is per character of its text.
  it('reckons the price of speech from the list price per character, for the characters of its text', async () => {
    sbp('dez.model/modelCache/applyProviderResult', 'venice-like', { ok: true, models: [{ id: 'm', name: 'M', provider: 'venice-like', price: { unit: 'character', usd: 15 } }] })
    answers = [clip('audio/mpeg')]

    const { cost } = await generate({ kind: 'tts', prompt: 'Héllo 🦊' })

    expect(cost).toBe(0.000105)
    expect(httpRequests).toEqual([])
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

    // The wait left no timer, and no request came after the stop.
    expect(vi.getTimerCount()).toBe(0)
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

describe('an image job', () => {
  const MART_URL = 'http://localhost:7070/v1'
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
  const IMAGE_URLS = ['https://cdn.example.com/image/1.png', 'https://cdn.example.com/image/2.jpg']
  const SUBMITTED = { status: 200, body: { code: 200, data: [{ status: 'submitted', task_id: 'task-1' }] } }
  const task = (data: Record<string, unknown>) => ({ status: 200, body: { code: 200, data: { id: 'task-1', ...data } } })
  const generateImage = (input: Record<string, unknown> = {}) =>
    generate({ providerId: 'mart-like', modelId: 'gpt-image-2', kind: 'image', prompt: 'A red dot', ...input })
  const streamUrls = () => streams.map(({ request }) => `${request.method ?? 'POST'} ${request.url}`)

  beforeEach(() => {
    sbp('dez.model/customProviders/save', { id: 'mart-like', name: 'Mart', baseUrl: MART_URL, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey', mediaApi: { format: 'apimart' } })
  })

  // The provider took the money for the task, so its id is in each step
  // from the answer that gave it. The cost of the task takes the place of
  // the quote.
  it('asks for the state of the task until it is done, then copies each image with a request that has no header', async () => {
    streamAnswers = [
      SUBMITTED,
      task({ status: 'processing', progress: 40 }),
      task({ status: 'completed', cost: 0.009, result: { images: [{ url: [IMAGE_URLS[0]] }, { url: [IMAGE_URLS[1]] }] } }),
      { status: 200, body: PNG },
      { status: 200, body: JPEG },
    ]
    const steps: Array<[MediaProgress, number]> = []

    const result = generateImage({ onProgress: (progress: MediaProgress) => steps.push([progress, streams.length]) })
    await vi.advanceTimersByTimeAsync(10 * SECOND_MS)

    expect(await result).toStrictEqual({ media: [{ bytes: PNG, mediaType: 'image/png' }, { bytes: JPEG, mediaType: 'image/jpeg' }], clips: [], cost: 0.009 })
    expect(steps).toStrictEqual([
      [{ phase: 'sent', jobId: null, quote: IMAGE_QUOTE_USD }, 0],
      [{ phase: 'queued', jobId: 'task-1', resume: { data: [{ task_id: 'task-1' }] } }, 1],
      [{ phase: 'downloading', jobId: 'task-1' }, 3],
    ])
    expect(streamUrls()).toStrictEqual([
      `POST ${MART_URL}/images/generations`,
      `GET ${MART_URL}/tasks/task-1?language=en`,
      `GET ${MART_URL}/tasks/task-1?language=en`,
      `GET ${IMAGE_URLS[0]}`,
      `GET ${IMAGE_URLS[1]}`,
    ])
    expect(JSON.parse(streams[0].request.body as string)).toStrictEqual({ model: 'gpt-image-2', prompt: 'A red dot' })
    // The URLs of the images come from an answer: their requests carry no
    // API key. Each request after the first has the time that is left.
    expect(streams.map(({ request }) => request.headers?.Authorization)).toStrictEqual(['Bearer sk-test', 'Bearer sk-test', 'Bearer sk-test', undefined, undefined])
    expect(streams.slice(1).map(({ request }) => request.timeoutMs)).toStrictEqual([JOB_TIMEOUT_MS - 5 * SECOND_MS, JOB_TIMEOUT_MS - 10 * SECOND_MS, JOB_TIMEOUT_MS - 10 * SECOND_MS, JOB_TIMEOUT_MS - 10 * SECOND_MS])
    expect(new Set(streams.map(({ requestId }) => requestId))).toStrictEqual(new Set(['reply-1']))
    expect(httpRequests.map(({ url }) => url)).toStrictEqual([`${MART_URL}/pricing/model?model=gpt-image-2`])
  })

  // A task that APIMart settles at 0 tells no price yet.
  it('counts the quote for a done task that tells no cost', async () => {
    streamAnswers = [SUBMITTED, task({ status: 'completed', cost: 0, result: { images: [{ url: [IMAGE_URLS[0]] }] } }), { status: 200, body: PNG }]

    const result = generateImage()
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)

    expect((await result).cost).toBe(IMAGE_QUOTE_USD)
  })

  // APIMart gives back the money of a task that failed.
  it('tells that the provider did not make the image of a task that failed, with its job id and the cost of 0', async () => {
    streamAnswers = [SUBMITTED, task({ status: 'failed', cost: 0, error: { code: 400, message: 'Prompt breaks the content rules' } })]

    const failure = generateImage().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    const error = await failure as ExplainedError

    expect(error.message).toBe('Mart did not make the image. The cause can be the prompt (Mart can refuse a prompt) or a problem at Mart: the details below tell what Mart said. Change the prompt, or send the request again later. '
      + 'To ask Mart about this image, give its job id: task-1.\n\nDetails: State: failed: Prompt breaks the content rules')
    expect(notMadeJobCost(error)).toBe(0)
    expect(consoleError.mock.calls.map(([text]) => text)).toStrictEqual(['The image job task-1 of Mart (model gpt-image-2) failed:'])
  })

  it('gives up on an image task that does not end in its time', async () => {
    streamAnswers = [SUBMITTED, ...Array.from({ length: 400 }, () => task({ status: 'processing' }))]

    const failure = expect(generateImage()).rejects.toThrow('Mart did not make the image in 30 minutes, the longest time that Dez waits. Send the request again later. To ask Mart about this image, give its job id: task-1.')
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS)
    await failure

    expect(streams.at(-1)).toMatchObject({ at: STARTED_AT + JOB_TIMEOUT_MS - 5 * SECOND_MS, request: { timeoutMs: 5 * SECOND_MS } })
  })

  it('tells that a file URL of the task gave no image', async () => {
    streamAnswers = [SUBMITTED, task({ status: 'completed', result: { images: [{ url: [IMAGE_URLS[0]] }] } }), { status: 200, body: bytesOf('<html>Gone</html>') }]

    const failure = expect(generateImage()).rejects.toThrow('Mart sent an answer that Dez cannot use. Send the request again. If the error stays, report it at Help › Dez on GitHub. To ask Mart about this image, give its job id: task-1.\n\nDetails: The image is not a PNG, JPEG, GIF, WebP, or SVG image.')
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure
  })

  // A task that ran while Dez was closed: no image request, no price
  // request, and the first poll goes at once.
  it('asks again for a task of an earlier start at once, with no request that costs money, and counts its quote', async () => {
    streamAnswers = [task({ status: 'completed', cost: 0, result: { images: [{ url: [IMAGE_URLS[0]] }] } }), { status: 200, body: PNG }]
    const steps: MediaProgress[] = []
    const beforeSend = vi.fn()

    const result = await generateImage({ resume: { data: { data: [{ task_id: 'task-1' }] }, quote: 0.02 }, beforeSend, onProgress: (progress: MediaProgress) => steps.push(progress) })

    expect(result).toStrictEqual({ media: [{ bytes: PNG, mediaType: 'image/png' }], clips: [], cost: 0.02 })
    expect(streamUrls()).toStrictEqual([`GET ${MART_URL}/tasks/task-1?language=en`, `GET ${IMAGE_URLS[0]}`])
    expect(steps.map(({ phase }) => phase)).toStrictEqual(['queued', 'downloading'])
    expect([httpRequests, beforeSend.mock.calls]).toStrictEqual([[], []])
  })
})

describe('a clip job of an earlier start', () => {
  const resumeVideo = (input: Record<string, unknown> = {}) =>
    generate({ kind: 'video', resume: { data: { queue_id: 'q-1', download_url: 'https://share.example.com/v1/share/token-1' }, quote: 0.4 }, ...input })

  it('asks for the state at once, gets the clip, and counts the stored quote, with no request that costs money', async () => {
    answers = [json({ status: 'COMPLETED' }), clip('video/mp4')]
    const steps: MediaProgress[] = []
    const beforeSend = vi.fn()

    const result = await resumeVideo({ beforeSend, onProgress: (progress: MediaProgress) => steps.push(progress) })

    expect(result).toStrictEqual({ media: [], clips: [{ kind: 'video', mediaType: 'video/mp4', jobId: 'q-1', src: tempPath(2, 'mp4'), url: null, expires: isoAfter(DAY_MS) }], cost: 0.4 })
    expect(requestUrls()).toStrictEqual([`POST ${VENICE_URL}/video/retrieve`, 'GET https://share.example.com/v1/share/token-1'])
    expect(steps).toStrictEqual([
      { phase: 'queued', jobId: 'q-1', resume: { queue_id: 'q-1', download_url: 'https://share.example.com/v1/share/token-1' } },
      { phase: 'downloading', jobId: 'q-1' },
    ])
    expect([httpRequests, beforeSend.mock.calls]).toStrictEqual([[], []])
  })

  // The provider runs the job already: the resume never waits for a turn,
  // and its time limit starts now.
  it('takes a turn over the cap of the provider, and gets a new time limit', async () => {
    sbp('dez.model/customProviders/save', { id: 'venice-like', name: 'Media server', baseUrl: VENICE_URL, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey', mediaApi: { format: 'venice', maxRequestsAtOnce: 1 } })
    let finish = (_answer: NativeHttpDownload) => {}
    answers = [() => new Promise((resolve) => { finish = resolve })]
    const first = resumeVideo({ requestId: 'first' })
    answers.push(json({ status: 'PROCESSING' }))
    const waiting: MediaProgress[] = []
    const second = resumeVideo({ requestId: 'second', timeoutMs: 60 * SECOND_MS, onProgress: (progress: MediaProgress) => waiting.push(progress) })
    await vi.advanceTimersByTimeAsync(0)

    expect(waiting.map(({ phase }) => phase)).toStrictEqual(['queued'])
    expect(downloads.map(({ requestId, request }) => [requestId, request.timeoutMs])).toStrictEqual([['first', JOB_TIMEOUT_MS], ['second', 60 * SECOND_MS]])
    finish(clip('video/mp4'))
    await first
    answers.push(json({ status: 'FAILED' }))
    const failure = expect(second).rejects.toThrow(JOB_ADVICE)
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure
  })

  it('names no job for a resume value that its format refuses', async () => {
    await expect(generate({ kind: 'video', resume: { data: { status: 'QUEUED' } } })).rejects.toThrow(UNUSABLE_ANSWER)
    expect(downloads).toStrictEqual([])
  })
})
