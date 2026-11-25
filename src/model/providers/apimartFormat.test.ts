import { describe, expect, it } from 'vitest'
import { ExplainedError } from '../../utils/errorText'
import { apimartFormat } from './apimartFormat'
import { ClipNotMadeError, UnusableAnswerError } from './errors'
import type { ClipFormat, ClipQuoteFormat } from './mediaFormats'
import type { ModelParameter, ParameterValues } from './modelParameters'
import { thrownError } from './testing'

const clips = apimartFormat.clips as ClipFormat
const quote = clips.quote as ClipQuoteFormat

const BASE_URL = 'https://api.apimart.ai/v1'
const VIDEO_URL = 'https://upload.apimart.ai/f/video/task_01_0.mp4'

// The parameters with no labels: a label is UI text.
function parameters(entry: unknown): Omit<ModelParameter, 'label'>[] {
  return clips.parameters('video', entry, undefined, {}).map(({ label: _label, ...parameter }) => parameter)
}

// A video entry of the model list, with the fields of a schema (live list,
// 2026-11-24, with the descriptions and the image fields cut).
const videoEntry = (id: string, properties?: Record<string, unknown>) =>
  ({ id, object: 'model', category: 'video', ...(properties && { parameters: { input_schema: { type: 'object', properties: { model: { type: 'string' }, prompt: { type: 'string' }, image_urls: { type: 'array', items: { type: 'string' } }, ...properties } } } }) })

describe('apimart video parameters', () => {
  // The doc facts of the model, not its entry: the entry holds the general
  // schema with no lists.
  it('gives a model that the docs tell in full its own rows, with the lowest length and resolution as the defaults', () => {
    expect(parameters(videoEntry('MiniMax-H3', { duration: { type: 'integer', minimum: 1 } }))).toStrictEqual([
      { name: 'duration', min: 4, max: 15, default: 4 },
      { name: 'resolution', options: ['768P', '2K'], default: '768P' },
      { name: 'aspect_ratio', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
      { name: 'watermark' },
      { name: 'nsfw_check' },
    ])
    expect(clips.textRules?.('video', videoEntry('MiniMax-H3'), undefined, {})).toStrictEqual({ maxPromptLength: 7000 })
  })

  it('gives each request its own copy of the rows of a model that the docs tell', () => {
    const rows = clips.parameters('video', videoEntry('seedance-2-5-flash'), undefined, {})
    rows.length = 0

    expect(parameters(videoEntry('seedance-2-5-flash')).map((row) => row.name)).toStrictEqual(['resolution', 'size', 'duration', 'generate_audio', 'watermark', 'seed', 'output_format', 'web_search', 'nsfw_check'])
    expect(clips.textRules?.('video', videoEntry('seedance-2-5-flash'), undefined, {})).toBeUndefined()
  })

  // The general schema of 60 of the 62 video models (kling-v3): no lists
  // and no upper limits. A text field takes what the docs tell.
  it('gives a model with the general schema a text row for each text and whole-number field, and a switch for each boolean', () => {
    expect(parameters(videoEntry('kling-v3', {
      aspect_ratio: { type: 'string' },
      duration: { type: 'integer', minimum: 1 },
      generate_audio: { type: 'boolean' },
      quality: { type: 'string' },
      resolution: { type: 'string' },
      seed: { type: 'integer' },
      webhook: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      messages: { type: 'array' },
    }))).toStrictEqual([
      { name: 'aspect_ratio', options: [], custom: true },
      { name: 'duration', options: [], custom: true },
      { name: 'generate_audio' },
      { name: 'quality', options: [], custom: true },
      { name: 'resolution', options: [], custom: true },
      { name: 'seed', options: [], custom: true },
    ])
  })

  it('gives a list its options, and a length and a resolution their lowest value as the default, not the schema default', () => {
    // Omni-Flash-Ext and muse-video-ext (live list, 2026-11-24).
    expect(parameters(videoEntry('Omni-Flash-Ext', {
      duration: { type: 'integer', enum: [8, 4, 10, 6], default: 8, minimum: 4, maximum: 10 },
      resolution: { type: 'string', enum: ['720p', '4k', '360p', '1080p'], default: '720p' },
      size: { type: 'string', enum: ['1:1', '16:9', 'auto'], default: '16:9' },
    }))).toStrictEqual([
      { name: 'duration', options: [4, 6, 8, 10], default: 4 },
      { name: 'resolution', options: ['360p', '720p', '1080p', '4k'], default: '360p' },
      { name: 'size', options: ['1:1', '16:9', 'auto'], default: '16:9' },
    ])
    expect(parameters(videoEntry('muse-video-ext', {
      duration: { type: 'integer', default: 10, minimum: 2, maximum: 10 },
      strength: { type: 'number', default: 0.5, minimum: 0, maximum: 1 },
      steps: { type: 'integer', default: 90, minimum: 1, maximum: 50 },
    }))).toStrictEqual([
      { name: 'duration', min: 2, max: 10, default: 2 },
      { name: 'strength', min: 0, max: 1, anyNumber: true, default: 0.5 },
      { name: 'steps', min: 1, max: 50 },
    ])
  })

  it('gives no rows to an entry with no schema, and to a request kind other than video', () => {
    expect([parameters(videoEntry('new-model')), clips.parameters('tts', videoEntry('MiniMax-H3'), undefined, {})]).toStrictEqual([[], []])
  })
})

describe('apimart video requests', () => {
  const request = (values: ParameterValues) => clips.request('video', `${BASE_URL}/`, 'kling-v3', { prompt: 'A fox in snow', images: [], values })

  // https://docs.apimart.ai/en/api-reference/videos/minimax-h3/generation
  it('posts the prompt and the values to /videos/generations, with the text of a whole-number field as a number', () => {
    expect(request({ duration: ' 5 ', seed: '-7', aspect_ratio: '9:16', generate_audio: true })).toStrictEqual({
      url: `${BASE_URL}/videos/generations`,
      body: { duration: 5, seed: -7, aspect_ratio: '9:16', generate_audio: true, model: 'kling-v3', prompt: 'A fox in snow' },
    })
  })

  it('tells the user to fix a whole-number field that holds another text, before the request goes', () => {
    expect(thrownError(() => request({ duration: '5.5' }))).toStrictEqual(new ExplainedError('The parameter "duration" of this model takes a whole number, not "5.5". Change its value.'))
  })

  it('refuses a request kind other than video', () => {
    expect(thrownError(() => clips.request('tts', BASE_URL, 'suno', { prompt: 'Hi', images: [], values: {} }))).toStrictEqual(new ExplainedError('This provider has no request of this kind that Dez can use. Choose another model.'))
  })
})

describe('apimart video tasks', () => {
  // The answer to the request (live, 2026-11-24).
  const job = (taskId: unknown = 'task_01KX') => clips.job('video', `${BASE_URL}/`, 'MiniMax-H3', { code: 200, data: [{ status: 'submitted', task_id: taskId }] })
  const poll = (data: Record<string, unknown>) => ({ code: 200, data: { id: 'task_01KX', progress: 100, created: 1763088289, ...data } })

  // The poll URL is Dez's own, with the id escaped: it gets the API key.
  it('asks /tasks/<id> for the state of the task, in English', () => {
    expect([job().id, job().poll, job('a/../b').poll]).toStrictEqual([
      'task_01KX',
      { url: `${BASE_URL}/tasks/task_01KX?language=en` },
      { url: `${BASE_URL}/tasks/a%2F..%2Fb?language=en` },
    ])
  })

  it.each([
    ['no task', { code: 200, data: [] }],
    ['an empty task id', { code: 200, data: [{ status: 'submitted', task_id: '' }] }],
    ['an error', { error: { code: 400, message: 'Invalid model' } }],
  ])('tells that an answer with %s is no job', (_name, answer) => {
    expect(thrownError(() => clips.job('video', BASE_URL, 'MiniMax-H3', answer))).toStrictEqual(new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.'))
  })

  it.each(['submitted', 'pending', 'processing'])('waits while the task is %s', (status) => {
    expect(job().state(poll({ status, progress: 30 }))).toBe('running')
  })

  // MiniMax-H3 docs: a text; Seedance 2.5 Flash docs and the image tasks:
  // a list. The link ends after about 24 hours, so Dez copies the file.
  it.each([
    ['a text', VIDEO_URL],
    ['a list', [VIDEO_URL, 'https://upload.apimart.ai/f/video/other.mp4']],
  ])('copies the file of the video whose URL is %s, at the cost of the task', (_name, url) => {
    expect(job().state(poll({ status: 'completed', cost: 0.22848, result: { videos: [{ url, expires_at: 1763174708 }] } }))).toStrictEqual({ fileUrl: VIDEO_URL, cost: 0.22848 })
  })

  // Seedance settles its price by tokens a few seconds after the end.
  it('has no cost for a done task whose cost is 0 or missing, so that the quote counts', () => {
    expect([
      job().state(poll({ status: 'completed', cost: 0, result: { videos: [{ url: VIDEO_URL }] } })),
      job().state(poll({ status: 'completed', result: { videos: [{ url: VIDEO_URL }] } })),
    ]).toStrictEqual([{ fileUrl: VIDEO_URL }, { fileUrl: VIDEO_URL }])
  })

  it.each([
    ['no video', { videos: [] }],
    ['a URL that is not a web address', { videos: [{ url: 'file:///etc/passwd' }] }],
    ['a URL with a space', { videos: [{ url: 'https://upload.apimart.ai/a b.mp4' }] }],
  ])('tells that a done task with %s holds no video URL', (_name, result) => {
    expect(thrownError(() => job().state(poll({ status: 'completed', result })))).toStrictEqual(new UnusableAnswerError('The task is done, and its answer holds no video URL.'))
  })

  // APIMart gives back the money of a task that failed: its cost is 0.
  it.each([
    ['failed', { status: 'failed', cost: 0, error: { code: 400, message: 'Prompt breaks the content rules' } }, 'State: failed: Prompt breaks the content rules', 0],
    ['cancelled', { status: 'cancelled' }, 'State: cancelled', undefined],
    ['in a new state', { status: 'archived', cost: 0.3 }, 'State: archived', 0.3],
    ['with no state', {}, 'State: none', undefined],
  ])('tells that the provider did not make the clip of a task %s, with the cost that it told', (_name, data, message, cost) => {
    const error = thrownError(() => job().state(poll(data)))

    expect(error).toStrictEqual(new ClipNotMadeError(message, cost))
    expect((error as ClipNotMadeError).cost).toBe(cost)
  })
})

// The account's own price (live, 2026-11-24: MiniMax-H3 768P 4 s, $0.22848).
// https://docs.apimart.ai/en/api-reference/account/request-logs
describe('apimart video quotes', () => {
  it('asks /pricing/model for the price of the length and the resolution of the request', () => {
    expect([
      quote.request('video', `${BASE_URL}/`, 'MiniMax-H3', { duration: 4, resolution: '768P', watermark: true }, undefined),
      quote.request('video', BASE_URL, 'kling-v3', { duration: ' 5 ' }, undefined),
    ]).toStrictEqual([
      { url: `${BASE_URL}/pricing/model?model=MiniMax-H3&duration=4&resolution=768P` },
      { url: `${BASE_URL}/pricing/model?model=kling-v3&duration=5` },
    ])
  })

  // With no length, the answer tells only the price of one second.
  it('asks for no price of a request with no whole length, and of a kind other than video', () => {
    expect([
      quote.request('video', BASE_URL, 'kling-v3', {}, undefined),
      quote.request('video', BASE_URL, 'kling-v3', { duration: '5.5' }, undefined),
      quote.request('video', BASE_URL, 'kling-v3', { duration: 5.5 }, undefined),
      quote.request('tts', BASE_URL, 'suno', { duration: 5 }, undefined),
    ]).toStrictEqual([null, null, null, null])
  })

  it('reads the price in USD, and throws for an answer with none', () => {
    expect(quote.usd({ billing_type: 'per_second', total_usd: 0.22848, quantity: 4, spec: '768P', estimated: false })).toBe(0.22848)
    expect(thrownError(() => quote.usd({ billing_type: 'per_second', unit_price_usd: 0.05712 }))).toStrictEqual(new UnusableAnswerError('The answer holds no price.'))
  })
})
