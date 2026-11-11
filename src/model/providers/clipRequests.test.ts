import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest, NativeHttpResponse } from '../../utils/protocol/nativeHttp'
import type { ModelParameter } from './modelParameters'
import type { ProviderGenerateMediaResult } from './streamTypes'
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
const POST_HEADERS = { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' }

// What the stand-ins received, in order.
let downloads: Download[] = []
let moves: Array<{ from: FileRef, to: FileRef }> = []
let deleted: FileRef[] = []
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

  it('deletes the file of a clip whose type Dez cannot name, and fails', async () => {
    answers = [clip('audio/pcm;rate=24000')]

    await expect(generate({ kind: 'tts' })).rejects.toThrow('Dez does not know the file type of this clip (audio/pcm).')

    expect(deleted).toStrictEqual([tempFile(1, 'part')])
    expect(moves).toEqual([])
  })

  it.each([
    ['a refused request', { status: 402, headers: {}, saved: false, body: bytesOf('Insufficient balance') }, 'Media server returned HTTP 402: Insufficient balance'],
    ['an answer that is neither a clip nor JSON', { status: 200, headers: { 'content-type': 'text/html' }, saved: false, body: bytesOf('<html>') }, 'The provider sent no clip.'],
    ['a JSON answer to a speech request', json({ queue_id: 'q-1' }), 'The provider sent no clip.'],
  ])('fails for %s, and names no job', async (_name, answer, message) => {
    answers = [answer]

    // The message, not the error: a refused request has its own error class.
    const error: unknown = await generate({ kind: 'tts' }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(message)

    expect(downloads).toHaveLength(1)
    expect(moves).toEqual([])
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
  it.each([
    ['venice-like', 'The model list does not tell which lengths and aspect ratios this model takes.'],
    ['router-like', 'The model list does not tell which lengths this model takes.'],
  ])('sends no video request to a %s model whose lengths the model cache does not have', async (providerId, message) => {
    await expect(generate({ providerId, kind: 'video', parameters: { duration: 1 } })).rejects.toThrow(new Error(message))

    expect(downloads).toEqual([])
    expect(httpRequests).toEqual([])
  })

  // The provider took the money when the job started.
  it.each([
    ['a refused state request', [json({ queue_id: 'q-1' }), { status: 500, headers: {}, saved: false, body: bytesOf('Busy') }], 'Media server returned HTTP 500: Busy (job q-1)'],
    ['a state that tells of no clip', [json({ queue_id: 'q-1' }), json({ status: 'FAILED' })], 'The provider sent no clip. (job q-1)'],
  ])('names the job in the error and in the log after %s', async (_name, jobAnswers, message) => {
    answers = jobAnswers

    const failure = expect(generate({ kind: 'music' })).rejects.toThrow(new Error(message))
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure

    expect(consoleError.mock.calls.map(([text]) => text)).toStrictEqual(['The clip job q-1 of Media server (model m) failed:'])
  })

  it('fails when the content request of a finished job gives no clip', async () => {
    cacheModel('router-like', OPENROUTER_VIDEO_PARAMETERS)
    answers = [json({ id: 'gen-1' }, 202), json({ status: 'completed' }), json({ error: 'Not ready' })]

    const failure = expect(generate({ providerId: 'router-like', kind: 'video' })).rejects.toThrow(new Error('The provider sent no clip. (job gen-1)'))
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS)
    await failure
  })

  it('gives up on a job that does not end in 30 minutes', async () => {
    answers = [json({ queue_id: 'q-1' }), ...Array.from({ length: 400 }, () => json({ status: 'PROCESSING' }))]

    const failure = expect(generate({ kind: 'music' })).rejects.toThrow(new Error('The provider did not make the clip in time. (job q-1)'))
    await vi.advanceTimersByTimeAsync(JOB_TIMEOUT_MS)
    await failure

    // The last request had 5 seconds left.
    expect(downloads.at(-1)).toMatchObject({ at: STARTED_AT + JOB_TIMEOUT_MS - 5 * SECOND_MS, request: { timeoutMs: 5 * SECOND_MS } })
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
