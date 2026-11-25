import { describe, expect, it } from 'vitest'
import { ExplainedError } from '../../utils/errorText'
import { apimartFormat } from './apimartFormat'
import { ClipNotMadeError, UnusableAnswerError } from './errors'
import type { ClipFormat, ClipQuoteFormat, MediaInput, TextFormat } from './mediaFormats'
import type { ModelParameter, ParameterValues } from './modelParameters'
import { thrownError } from './testing'

const clips = apimartFormat.clips as ClipFormat
const quote = clips.quote as ClipQuoteFormat
const texts = apimartFormat.texts as TextFormat

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
    expect(job().state(poll({ status: 'completed', cost: 0.22848, result: { videos: [{ url, expires_at: 1763174708 }] } }))).toStrictEqual({ fileUrls: [VIDEO_URL], cost: 0.22848 })
  })

  // Seedance settles its price by tokens a few seconds after the end.
  it('has no cost for a done task whose cost is 0 or missing, so that the quote counts', () => {
    expect([
      job().state(poll({ status: 'completed', cost: 0, result: { videos: [{ url: VIDEO_URL }] } })),
      job().state(poll({ status: 'completed', result: { videos: [{ url: VIDEO_URL }] } })),
    ]).toStrictEqual([{ fileUrls: [VIDEO_URL] }, { fileUrls: [VIDEO_URL] }])
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
    expect(quote.usd({ billing_type: 'per_second', total_usd: 0.22848, quantity: 4, spec: '768P', estimated: false }, { duration: 4 })).toBe(0.22848)
    expect(thrownError(() => quote.usd({ billing_type: 'per_second', unit_price_usd: 0.05712 }, { duration: 4 }))).toStrictEqual(new UnusableAnswerError('The answer holds no price.'))
  })
})

describe('apimart music models', () => {
  const entry = (id: string) => ({ id, object: 'model', category: 'audio', parameters: null })

  // The entries of the music models hold no schema (live list, 2026-11-24).
  it('gives a music model of the doc facts its rows and its text rules, and an unknown music model neither', () => {
    expect(clips.parameters('music', entry('suno'), undefined, {}).map(({ name }) => name)).toContain('negative_tags')
    expect(clips.textRules?.('music', entry('suno'), undefined, {})?.lyrics).toMatchObject({ required: false, maxLength: 5000 })
    expect([clips.parameters('music', entry('new-music'), undefined, {}), clips.textRules?.('music', entry('new-music'), undefined, {})]).toStrictEqual([[], undefined])
  })

  it('refuses a request to a music model whose fields Dez does not know, before the request goes', () => {
    expect(thrownError(() => clips.request('music', BASE_URL, 'new-music', { prompt: 'A song', images: [], values: {} })))
      .toStrictEqual(new ExplainedError('Dez does not know the request fields of this music model. Choose another model.'))
  })
})

// https://docs.apimart.ai/en/api-reference/audios/suno/generation
describe('apimart Suno requests', () => {
  const request = (input: { prompt: string, lyrics?: string, values?: ParameterValues }) =>
    clips.request('music', `${BASE_URL}/`, 'suno', { images: [], values: {}, ...input })
  // A value for each field that only custom mode takes, and for each field
  // that both modes take.
  const CUSTOM_ONLY = { title: 'Morning', negative_tags: 'metal', auto_lyrics: true, persona_id: 'p-1', max_mode: true, duration: 120 }
  const BOTH_MODES = { version: 'v6', instrumental: true, vocal_gender: 'Female', style_weight: 0.6, weirdness_constraint: 0.3, audio_weight: 0.5, variety: 'high', audio_format: 'm4a' }

  it('sends a message with no lyrics in inspiration mode, as the description, with only the fields that both modes take', () => {
    expect(request({ prompt: 'A cheerful ukulele jingle', values: { ...CUSTOM_ONLY, ...BOTH_MODES } })).toStrictEqual({
      url: `${BASE_URL}/music/generations`,
      body: { ...BOTH_MODES, custom: false, prompt: 'A cheerful ukulele jingle', model: 'suno' },
    })
  })

  it('sends lyrics in custom mode, with the text before them as the style, whatever the Custom mode row', () => {
    expect([
      request({ prompt: 'synthwave, female vocal', lyrics: '[Verse]\nNeon streets', values: { ...CUSTOM_ONLY, version: 'v6' } }).body,
      request({ prompt: '', lyrics: 'La la la', values: { custom: true } }).body,
    ]).toStrictEqual([
      { ...CUSTOM_ONLY, version: 'v6', custom: true, prompt: '[Verse]\nNeon streets', style: 'synthwave, female vocal', model: 'suno' },
      { custom: true, prompt: 'La la la', model: 'suno' },
    ])
  })

  // The docs: custom mode takes no prompt only for an instrumental.
  it('sends a message with no lyrics in Custom mode as the style of an instrumental, and refuses it without Instrumental', () => {
    expect(request({ prompt: 'lo-fi piano, rain', values: { custom: true, instrumental: true, title: 'Rain' } }).body)
      .toStrictEqual({ instrumental: true, title: 'Rain', custom: true, style: 'lo-fi piano, rain', model: 'suno' })
    expect(thrownError(() => request({ prompt: 'lo-fi piano, rain', values: { custom: true } }))).toStrictEqual(new ExplainedError(
      'In Custom mode, this model makes a song only from lyrics, or an instrumental. Write the style, then a line "Lyrics:", then the lyrics; or turn on Instrumental, or turn off Custom mode, in the model parameters.',
    ))
  })

  // The docs: `custom_model_id` excludes `version` and `persona_id`.
  it('leaves out the version and the persona of a request with a custom model id', () => {
    expect(request({ prompt: 'pop', lyrics: 'Hey', values: { version: 'v6', persona_id: 'p-1', custom_model_id: 'm-1' } }).body)
      .toStrictEqual({ custom_model_id: 'm-1', custom: true, prompt: 'Hey', style: 'pop', model: 'suno' })
  })

  it('takes a style of 1,000 characters and a title of 80, and tells the user to make a longer one shorter', () => {
    expect(request({ prompt: 's'.repeat(1000), lyrics: 'Hey', values: { title: 't'.repeat(80) } }).body).toMatchObject({ title: 't'.repeat(80) })
    expect(thrownError(() => request({ prompt: 's'.repeat(1001), lyrics: 'Hey' }))).toStrictEqual(new ExplainedError(
      'In Custom mode, this model takes a style (the text before the "Lyrics:" line, or the message of an instrumental) of at most 1000 characters. This one has 1001. Make it shorter.',
    ))
    expect(thrownError(() => request({ prompt: 'pop', lyrics: 'Hey', values: { title: 't'.repeat(81) } })))
      .toStrictEqual(new ExplainedError('This model takes a title of at most 80 characters. This one has 81. Change the Title parameter.'))
    // Inspiration mode sends no style and no title.
    expect(request({ prompt: 's'.repeat(1001), values: { title: 't'.repeat(81) } }).body).toStrictEqual({ custom: false, prompt: 's'.repeat(1001), model: 'suno' })
  })
})

// https://docs.apimart.ai/en/api-reference/audios/flow-music/music
describe('apimart Flow Music requests', () => {
  it('sends the prompt as the sound prompt and the lyrics as they are, each only when there is one, with the values', () => {
    const request = (prompt: string, lyrics?: string) =>
      clips.request('music', BASE_URL, 'flowmusic', { prompt, ...(lyrics !== undefined && { lyrics }), images: [], values: { version: 'lyria-3.5', bpm: '120', length: 30 } })
    expect([request('upbeat pop', 'La la'), request('', 'La la'), request('calm piano')]).toStrictEqual([
      { url: `${BASE_URL}/music/generations`, body: { version: 'lyria-3.5', bpm: '120', length: 30, sound_prompt: 'upbeat pop', lyrics: 'La la', model: 'flowmusic' } },
      { url: `${BASE_URL}/music/generations`, body: { version: 'lyria-3.5', bpm: '120', length: 30, lyrics: 'La la', model: 'flowmusic' } },
      { url: `${BASE_URL}/music/generations`, body: { version: 'lyria-3.5', bpm: '120', length: 30, sound_prompt: 'calm piano', model: 'flowmusic' } },
    ])
  })
})

describe('apimart music tasks', () => {
  const job = (kind: 'music' | 'video' = 'music') => clips.job(kind, `${BASE_URL}/`, 'suno', { code: 200, data: [{ status: 'submitted', task_id: 'task_01M8' }] })
  // A done Suno task (live, 2026-11-24, with the URLs and fields cut).
  const SONG_URLS = ['https://getapib.org/audio/1-f49bbfd9.mp3', 'https://getapib.org/audio/2-677929c1.mp3']
  const doneSuno = (music: unknown[]) => ({
    code: 200,
    data: { id: 'task_01M8', status: 'completed', progress: 100, cost: 0.05, credits_cost: 0.5, billing_status: 'settled', result: { music } },
  })
  const song = (audio_url: unknown) => ({ audio_id: 'f49bbfd9', title: 'Good Morning', duration: 38.8, audio_url, image_url: 'https://cdn2.suno.ai/image.jpeg' })

  it('asks /music/tasks/<id> for the state of a music task, in English', () => {
    expect(job().poll).toStrictEqual({ url: `${BASE_URL}/music/tasks/task_01M8?language=en` })
  })

  // The docs of Suno: keep the task id of a task in the state `unknown`.
  it('waits while a music task is pending, in work, or in the state unknown, but not a video task in that state', () => {
    expect(['pending', 'processing', 'unknown'].map((status) => job().state({ code: 200, data: { status, progress: 10, cost: 0.05, billing_status: 'held' } }))).toStrictEqual(['running', 'running', 'running'])
    expect(thrownError(() => job('video').state({ code: 200, data: { status: 'unknown' } }))).toStrictEqual(new ClipNotMadeError('State: unknown'))
  })

  it('copies the file of each song of a done task, at the cost of the task, and leaves out a song with no usable URL', () => {
    expect([
      job().state(doneSuno(SONG_URLS.map(song))),
      job().state(doneSuno([song(SONG_URLS[0]), song('file:///etc/passwd'), { title: 'No file' }, song(SONG_URLS[1])])),
    ]).toStrictEqual([{ fileUrls: SONG_URLS, cost: 0.05 }, { fileUrls: SONG_URLS, cost: 0.05 }])
  })

  it('tells that a done task with no usable song URL holds no song', () => {
    expect(thrownError(() => job().state(doneSuno([song('file:///etc/passwd')])))).toStrictEqual(new UnusableAnswerError('The task is done, and its answer holds no song URL.'))
  })
})

// The account's own price of one task (live, 2026-11-24: suno $0.068, also
// with `version=v6-mini` or `custom`; flowmusic $0.06). It ignores
// `max_mode` and `custom_model_id`.
describe('apimart music quotes', () => {
  it('asks /pricing/model for the price of the version, with the tier custom for a custom model', () => {
    expect([
      quote.request('music', BASE_URL, 'suno', { version: 'v6-mini', duration: 120 }, undefined),
      quote.request('music', BASE_URL, 'suno', { version: 'v6', custom_model_id: 'm-1' }, undefined),
      quote.request('music', BASE_URL, 'flowmusic', { length: 30 }, undefined),
    ]).toStrictEqual([
      { url: `${BASE_URL}/pricing/model?model=suno&version=v6-mini` },
      { url: `${BASE_URL}/pricing/model?model=suno&version=custom` },
      { url: `${BASE_URL}/pricing/model?model=flowmusic` },
    ])
  })

  it('doubles the price of a request with max mode on', () => {
    const answer = { billing_type: 'per_call', total_usd: 0.068, quantity: 1, spec: { key: 'music-v6' } }
    expect([quote.usd(answer, { version: 'v6' }), quote.usd(answer, { version: 'v6', max_mode: true })]).toStrictEqual([0.068, 0.136])
  })
})

// https://docs.apimart.ai/en/api-reference/audios/whisper-1
describe('apimart transcriptions', () => {
  const BYTES = new Uint8Array([1, 2, 3])
  const FILE = { name: 'file', file: { bytes: BYTES, mediaType: 'audio/mp4', fileName: 'clip.m4a' } }
  const input: MediaInput = { prompt: 'Write it down', images: [], clips: [{ kind: 'audio', use: 'source', mediaType: 'audio/mp4', bytes: BYTES }], values: {} }
  const form = (modelId: string, wordTimes?: true) => texts.request('transcription', `${BASE_URL}/`, modelId, { ...input, ...(wordTimes && { wordTimes }) })

  it('takes one audio clip only for a transcription, of the types of the docs, and no clip for a video or a song', () => {
    expect([
      apimartFormat.clipRules?.('transcription', undefined, undefined, {}),
      apimartFormat.clipRules?.('video', undefined, undefined, {}),
      apimartFormat.clipRules?.('music', undefined, undefined, {}),
    ]).toStrictEqual([
      { audio: { use: 'source', maxClips: 1, maxBytes: 25 * 1024 ** 2, types: ['audio/mpeg', 'audio/mp4', 'audio/wav'] } },
      undefined,
      undefined,
    ])
  })

  it('posts the clip to /audio/transcriptions as the file of a form, with the model and no prompt', () => {
    expect(form('gpt-4o-mini-transcribe')).toStrictEqual({
      url: `${BASE_URL}/audio/transcriptions`,
      form: [{ name: 'model', value: 'gpt-4o-mini-transcribe' }, { name: 'response_format', value: 'json' }, FILE],
    })
  })

  // A live check (2026-11-24): `gpt-4o-mini-transcribe` refuses
  // `verbose_json` with a 400.
  it('asks whisper-1 for the times of the words and the segments of a call that wants them, and the other models for no times', () => {
    expect([form('whisper-1', true).form, form('whisper-1').form, form('gpt-4o-transcribe', true).form]).toStrictEqual([
      [
        { name: 'model', value: 'whisper-1' },
        { name: 'response_format', value: 'verbose_json' },
        { name: 'timestamp_granularities[]', value: 'word' },
        { name: 'timestamp_granularities[]', value: 'segment' },
        FILE,
      ],
      [{ name: 'model', value: 'whisper-1' }, { name: 'response_format', value: 'json' }, FILE],
      [{ name: 'model', value: 'gpt-4o-transcribe' }, { name: 'response_format', value: 'json' }, FILE],
    ])
  })

  // A live `verbose_json` answer of whisper-1 (2026-11-24, with the words
  // and the fields of the segment cut).
  it('reads the words and the segments of a verbose answer to the millisecond, and no times of a json answer', () => {
    const parse = (data: unknown) => texts.parseResponse('transcription', new TextEncoder().encode(JSON.stringify(data)))

    expect(parse({
      task: 'transcribe',
      language: 'english',
      duration: 3.0299999713897705,
      text: 'Hello from Ben. This is a short test.',
      words: [{ word: 'Hello', start: 0, end: 0.3400000035762787 }, { word: 'test', start: 2.2799999713897705, end: 2.640000104904175 }],
      segments: [{ id: 0, seek: 0, start: 0, end: 2.640000104904175, text: ' Hello from Ben. This is a short test.', tokens: [50364], temperature: 0, no_speech_prob: 0.002 }],
      usage: { type: 'duration', seconds: 4 },
    })).toStrictEqual({
      text: 'Hello from Ben. This is a short test.',
      times: {
        duration: 3.03,
        words: [{ word: 'Hello', start: 0, end: 0.34 }, { word: 'test', start: 2.28, end: 2.64 }],
        segments: [{ text: ' Hello from Ben. This is a short test.', start: 0, end: 2.64 }],
      },
    })
    expect(parse({ text: 'Hello from Ben. This is a short test.', usage: { type: 'duration', seconds: 4 } })).toStrictEqual({ text: 'Hello from Ben. This is a short test.' })
  })
})
