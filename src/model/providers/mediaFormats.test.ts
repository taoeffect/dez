import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../utils/base64'
import type { NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { MEDIA_FORMATS, type ClipFormat, type ClipQuoteFormat, type ImageFormat } from './mediaFormats'
import type { ModelParameter } from './modelParameters'
import type { ChatImagePart, ClipKind } from './types'

const venice = MEDIA_FORMATS.venice.images as ImageFormat
const veniceClips = MEDIA_FORMATS.venice.clips as ClipFormat
const openRouterClips = MEDIA_FORMATS.openrouter.clips as ClipFormat

const VENICE_URL = 'https://api.venice.ai/api/v1'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

// The first bytes of each stored image type, and a few more.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
const GIF = new TextEncoder().encode('GIF89a\x01\x00')
const WEBP = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WEBPVP8 ')
// A RIFF file that is not an image.
const WAV = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WAVEfmt ')

const head = (contentType: string): NativeHttpResponseHead => ({ status: 200, headers: { 'content-type': contentType } })
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

// The parameters of a model with no labels: a label is UI text.
function parameters(format: ClipFormat, kind: ClipKind, entry: unknown, mediaEntry?: unknown): Omit<ModelParameter, 'label'>[] {
  return format.parameters(kind, entry, mediaEntry).map(({ label: _label, ...parameter }) => parameter)
}

describe('venice media requests', () => {
  it('asks /image/generate for a WebP image with no watermark and no safe mode', () => {
    expect(venice.request('image', 'https://api.venice.ai/api/v1/', 'z-image-turbo', { prompt: 'A red fox', images: [] })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/generate',
      body: { model: 'z-image-turbo', prompt: 'A red fox', format: 'webp', hide_watermark: true, safe_mode: false },
    })
  })

  // The endpoint has no `hide_watermark` field, and its schema takes no
  // unknown field.
  it('sends an edit to /image/multi-edit with `modelId`, the images as data URLs in order, and no safe mode', () => {
    const images: ChatImagePart[] = [
      { type: 'image', mediaType: 'image/png', data: bytesToBase64(PNG) },
      { type: 'image', mediaType: 'image/jpeg', data: bytesToBase64(JPEG) },
    ]

    expect(venice.request('imageEdit', 'https://api.venice.ai/api/v1', 'qwen-image-2-1-turbo-edit', { prompt: 'Make it blue', images })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/multi-edit',
      body: {
        modelId: 'qwen-image-2-1-turbo-edit',
        prompt: 'Make it blue',
        images: [`data:image/png;base64,${bytesToBase64(PNG)}`, `data:image/jpeg;base64,${bytesToBase64(JPEG)}`],
        safe_mode: false,
      },
    })
  })
})

describe('venice media responses', () => {
  it('reads every image of a JSON answer, each with the type of its bytes', () => {
    const body = json({ id: 'generate-1', images: [bytesToBase64(WEBP), bytesToBase64(PNG)], timing: {} })

    expect(venice.parseResponse('image', head('application/json; charset=utf-8'), body)).toStrictEqual([
      { bytes: WEBP, mediaType: 'image/webp' },
      { bytes: PNG, mediaType: 'image/png' },
    ])
  })

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ] as const)('takes a binary answer as one %s image', (mediaType, bytes) => {
    expect(venice.parseResponse('imageEdit', head(mediaType), bytes)).toStrictEqual([{ bytes, mediaType }])
  })

  it('takes the type of a binary answer from its bytes, not from its header', () => {
    expect(venice.parseResponse('imageEdit', head('image/png'), JPEG)).toStrictEqual([{ bytes: JPEG, mediaType: 'image/jpeg' }])
    expect(venice.parseResponse('imageEdit', { status: 200, headers: {} }, PNG)).toStrictEqual([{ bytes: PNG, mediaType: 'image/png' }])
  })

  it.each([
    ['a JSON answer with no images', head('application/json'), json({ id: 'generate-1', images: [] }), 'The provider sent no image.'],
    ['a JSON answer with no images list', head('application/json'), json({ error: 'busy' }), 'The provider sent no image.'],
    ['a JSON answer that does not parse', head('application/json'), new TextEncoder().encode('{"images": ['), 'not valid JSON'],
    ['an image that is not base64', head('application/json'), json({ images: [`data:image/png;base64,${bytesToBase64(PNG)}`] }), 'not base64 text'],
    ['an image that is not a string', head('application/json'), json({ images: [{ url: 'https://example.com/a.png' }] }), 'not base64 text'],
    ['a JSON image of a type that Dez does not store', head('application/json'), json({ images: [bytesToBase64(WAV)] }), 'not a PNG, JPEG, GIF, or WebP image'],
    ['a binary answer that is not an image', head('audio/wav'), WAV, 'not a PNG, JPEG, GIF, or WebP image'],
    ['an empty binary answer', head('image/png'), new Uint8Array(), 'not a PNG, JPEG, GIF, or WebP image'],
  ])('refuses %s', (_name, responseHead, body, message) => {
    expect(() => venice.parseResponse('image', responseHead, body)).toThrow(message)
  })
})

describe('venice clip parameters', () => {
  const spec = (modelSpec: Record<string, unknown>) => ({ id: 'm', model_spec: modelSpec })
  const videoModel = (constraints: Record<string, unknown>) => spec({ constraints: { model_type: 'text-to-video', ...constraints } })
  // Every speech model takes the speed of the speech request's schema.
  const SPEECH_SPEED = { name: 'speed', min: 0.25, max: 4, step: 0.05 }

  it('gives a speech model its voices, with no default voice', () => {
    expect(parameters(veniceClips, 'tts', spec({ voices: ['af_alloy', 'af_bella', 'af_alloy'] }))).toStrictEqual([
      { name: 'voice', options: ['af_alloy', 'af_bella'] },
      SPEECH_SPEED,
    ])
  })

  it('gives a speech model its formats that have a file type, with its own default format', () => {
    const model = spec({ voices: ['af_alloy'], default_format: 'wav', supported_formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] })

    expect(parameters(veniceClips, 'tts', model)).toStrictEqual([
      { name: 'voice', options: ['af_alloy'] },
      { name: 'response_format', options: ['mp3', 'opus', 'aac', 'flac', 'wav'], default: 'wav' },
      SPEECH_SPEED,
    ])
  })

  it('gives a speech format no default when the default of the model has no file type', () => {
    expect(parameters(veniceClips, 'tts', spec({ default_format: 'pcm', supported_formats: ['wav', 'pcm'] }))).toStrictEqual([
      { name: 'response_format', options: ['wav'] },
      SPEECH_SPEED,
    ])
  })

  // The speed is a field of the speech request, not of the entry.
  it('gives a speech model with no entry only the speed, with no default', () => {
    expect(parameters(veniceClips, 'tts', undefined)).toStrictEqual([SPEECH_SPEED])
  })

  it.each(['music', 'video'] as const)('gives a %s model with no entry no parameters', (kind) => {
    expect(parameters(veniceClips, kind, undefined)).toStrictEqual([])
  })

  it('gives a music model the speed range of its entry, with its own default speed', () => {
    expect(parameters(veniceClips, 'music', spec({ supports_speed: true, min_speed: 0.7, max_speed: 1.2, default_speed: 1 }))).toStrictEqual([
      { name: 'speed', min: 0.7, max: 1.2, step: 0.05, default: 1 },
    ])
  })

  it.each([
    ['does not say that it takes a speed', { min_speed: 0.7, max_speed: 1.2, default_speed: 1 }],
    ['says that it takes no speed', { supports_speed: false, min_speed: 0.7, max_speed: 1.2 }],
    ['has only one end of the range', { supports_speed: true, min_speed: 0.7 }],
    ['has a range that ends where it starts', { supports_speed: true, min_speed: 1, max_speed: 1 }],
    ['has a range from zero', { supports_speed: true, min_speed: 0, max_speed: 2 }],
  ])('gives a music model that %s no speed', (_name, modelSpec) => {
    expect(parameters(veniceClips, 'music', spec(modelSpec))).toStrictEqual([])
  })

  it('gives a music speed no default when the default of the model is out of the range', () => {
    expect(parameters(veniceClips, 'music', spec({ supports_speed: true, min_speed: 0.5, max_speed: 2, default_speed: 3 }))).toStrictEqual([
      { name: 'speed', min: 0.5, max: 2, step: 0.05 },
    ])
  })

  it('gives a music model a switch for each on/off field that its entry says it takes, with no default', () => {
    const model = spec({ supports_force_instrumental: true, supports_lyrics_optimizer: true, supports_loop: true })

    expect(parameters(veniceClips, 'music', model)).toStrictEqual([
      { name: 'force_instrumental' },
      { name: 'lyrics_optimizer' },
      { name: 'loop' },
    ])
  })

  // The API refuses a field that the model does not take.
  it('gives a music model no switch for a field that its entry does not say it takes', () => {
    const model = spec({ supports_force_instrumental: false, supports_lyrics_optimizer: 'yes', supports_lyrics: true, lyrics_required: true })

    expect(parameters(veniceClips, 'music', model)).toStrictEqual([])
  })

  it('orders the parameters of a music model: length, voice, speed, switches', () => {
    const model = spec({
      supports_loop: true,
      supports_speed: true,
      min_speed: 0.5,
      max_speed: 2,
      voices: ['Aria'],
      min_duration: 1,
      max_duration: 22,
    })

    expect(parameters(veniceClips, 'music', model).map((parameter) => parameter.name)).toStrictEqual(['duration_seconds', 'voice', 'speed', 'loop'])
  })

  it('gives a music model each whole second of its range, with its own default length', () => {
    expect(parameters(veniceClips, 'music', spec({ min_duration: 1, max_duration: 30, default_duration: 5 }))).toStrictEqual([
      { name: 'duration_seconds', min: 1, max: 30, default: 5 },
    ])
  })

  it('gives a music model its list of lengths in place of the range', () => {
    expect(parameters(veniceClips, 'music', spec({ min_duration: 60, max_duration: 210, default_duration: 90, duration_options: [60, 90, 120] }))).toStrictEqual([
      { name: 'duration_seconds', options: [60, 90, 120], default: 90 },
    ])
  })

  it.each([
    ['out of the range', { min_duration: 3, max_duration: 10, default_duration: 60 }],
    ['not there', { min_duration: 3, max_duration: 10 }],
  ])('gives a music length no default when the default of the model is %s', (_name, modelSpec) => {
    expect(parameters(veniceClips, 'music', spec(modelSpec))).toStrictEqual([{ name: 'duration_seconds', min: 3, max: 10 }])
  })

  it.each([
    ['no range', {}],
    ['only one end of the range', { min_duration: 1 }],
    ['a range that ends before it starts', { min_duration: 10, max_duration: 1 }],
    ['a range of part seconds', { min_duration: 0.5, max_duration: 10 }],
  ])('gives a music model with %s no length', (_name, modelSpec) => {
    expect(parameters(veniceClips, 'music', spec(modelSpec))).toStrictEqual([])
  })

  it('gives a music model its voices, with its default voice when the list has it', () => {
    expect([
      parameters(veniceClips, 'music', spec({ voices: ['Aria', 'Kai'], default_voice: 'Kai' })),
      parameters(veniceClips, 'music', spec({ voices: ['Aria', 'Kai'], default_voice: 'Zed' })),
    ]).toStrictEqual([
      [{ name: 'voice', options: ['Aria', 'Kai'], default: 'Kai' }],
      [{ name: 'voice', options: ['Aria', 'Kai'] }],
    ])
  })

  it('gives a video model its lengths and resolutions from low to high with the lowest as the default, and its first aspect ratio', () => {
    const model = videoModel({ durations: ['10s', '5s', '8s'], aspect_ratios: ['16:9', '9:16'], resolutions: ['1080p', '480p', '720p'] })

    expect(parameters(veniceClips, 'video', model)).toStrictEqual([
      { name: 'duration', options: ['5s', '8s', '10s'], default: '5s' },
      { name: 'resolution', options: ['480p', '720p', '1080p'], default: '480p' },
      { name: 'aspect_ratio', options: ['16:9', '9:16'], default: '16:9' },
    ])
  })

  it.each([
    ['line names in upper case and thousands', ['4K', '2k', '768P'], ['768P', '2k', '4K'], '768P'],
    ['names with no place in the order, which come last', ['true_1080p', '2x', '1080p', '720p'], ['720p', '1080p', 'true_1080p', '2x'], '720p'],
  ])('orders resolutions with %s', (_name, resolutions, options, lowest) => {
    expect(parameters(veniceClips, 'video', videoModel({ resolutions }))).toStrictEqual([{ name: 'resolution', options, default: lowest }])
  })

  it('gives a resolution no default when no name has a place in the order', () => {
    expect(parameters(veniceClips, 'video', videoModel({ resolutions: ['1x', '2x'] }))).toStrictEqual([{ name: 'resolution', options: ['1x', '2x'] }])
  })

  it('gives a video model that lists no resolution no resolution parameter', () => {
    expect(parameters(veniceClips, 'video', videoModel({ durations: ['5s'], aspect_ratios: ['auto'], resolutions: [] }))).toStrictEqual([
      { name: 'duration', options: ['5s'], default: '5s' },
      { name: 'aspect_ratio', options: ['auto'], default: 'auto' },
    ])
  })
})

describe('venice clip text rules', () => {
  const spec = (modelSpec: Record<string, unknown>) => ({ id: 'm', model_spec: modelSpec })
  const rules = (kind: ClipKind, entry: unknown) => veniceClips.textRules?.(kind, entry, undefined)

  it('gives every speech model the text limits of the speech request', () => {
    expect(rules('tts', undefined)).toStrictEqual({ minPromptLength: 1, maxPromptLength: 4096 })
  })

  it('reads the prompt and lyrics limits of a music model that needs lyrics', () => {
    const model = spec({ supports_lyrics: true, lyrics_required: true, min_prompt_length: 10, prompt_character_limit: 300, lyrics_character_limit: 3000 })

    expect(rules('music', model)).toStrictEqual({ minPromptLength: 10, maxPromptLength: 300, lyrics: { required: true, maxLength: 3000 } })
  })

  it('tells lyrics that a model takes from lyrics that it needs', () => {
    expect(rules('music', spec({ supports_lyrics: true, lyrics_required: false }))).toStrictEqual({ lyrics: { required: false } })
  })

  it('gives a music model that takes no lyrics only its prompt limits, also when its entry has a lyrics limit', () => {
    const model = spec({ supports_lyrics: false, min_prompt_length: 0, prompt_character_limit: 450, lyrics_character_limit: 3000 })

    expect(rules('music', model)).toStrictEqual({ minPromptLength: 0, maxPromptLength: 450 })
  })

  it.each([
    ['a text', '300'],
    ['a part number', 300.5],
    ['under zero', -1],
  ])('does not know a limit that is %s', (_name, limit) => {
    expect(rules('music', spec({ prompt_character_limit: limit, min_prompt_length: 10 }))).toStrictEqual({ minPromptLength: 10 })
  })

  it.each([
    ['a music model whose entry tells nothing', 'music', spec({})],
    ['a music model with no entry', 'music', undefined],
    ['a video model', 'video', spec({ prompt_character_limit: 300 })],
  ] as const)('has no rules for %s', (_name, kind, entry) => {
    expect(rules(kind, entry)).toBeUndefined()
  })
})

describe('venice clip requests', () => {
  it('sends speech text as `input`, with the voice and the format', () => {
    expect(veniceClips.request('tts', `${VENICE_URL}/`, 'tts-kokoro', { prompt: 'Hi', values: { voice: 'af_bella', response_format: 'mp3' } })).toStrictEqual({
      url: `${VENICE_URL}/audio/speech`,
      body: { voice: 'af_bella', response_format: 'mp3', model: 'tts-kokoro', input: 'Hi' },
    })
  })

  it('queues music with only the model and the prompt when no parameter has a value', () => {
    expect(veniceClips.request('music', VENICE_URL, 'mmaudio-v2-text-to-audio', { prompt: 'Rain', values: {} })).toStrictEqual({
      url: `${VENICE_URL}/audio/queue`,
      body: { model: 'mmaudio-v2-text-to-audio', prompt: 'Rain' },
    })
  })

  it('queues a song with the style as the prompt and the lyrics as `lyrics_prompt`', () => {
    const input = { prompt: 'Slow piano ballad', lyrics: '[Verse]\nRain on the roof', values: { force_instrumental: false, duration_seconds: 60 } }

    expect(veniceClips.request('music', VENICE_URL, 'minimax-music-v2', input)).toStrictEqual({
      url: `${VENICE_URL}/audio/queue`,
      body: { force_instrumental: false, duration_seconds: 60, model: 'minimax-music-v2', prompt: 'Slow piano ballad', lyrics_prompt: '[Verse]\nRain on the roof' },
    })
  })

  // The API takes no `lyrics_prompt` with `lyrics_optimizer: true`.
  it('leaves the lyrics optimizer out of a request that has lyrics, and keeps it in one that has none', () => {
    const values = { lyrics_optimizer: true, loop: true }

    expect([
      veniceClips.request('music', VENICE_URL, 'm', { prompt: 'Pop', lyrics: 'La la', values }).body,
      veniceClips.request('music', VENICE_URL, 'm', { prompt: 'Pop', values }).body,
    ]).toStrictEqual([
      { loop: true, model: 'm', prompt: 'Pop', lyrics_prompt: 'La la' },
      { lyrics_optimizer: true, loop: true, model: 'm', prompt: 'Pop' },
    ])
  })

  it.each(['tts', 'video'] as const)('sends no lyrics in a %s request', (kind) => {
    const values = { duration: '5s', aspect_ratio: '16:9' }

    expect(veniceClips.request(kind, VENICE_URL, 'm', { prompt: 'Hi', lyrics: 'La la', values }).body).not.toHaveProperty('lyrics_prompt')
  })

  it('queues a video with each value as its request field', () => {
    const values = { duration: '5s', resolution: '480p', aspect_ratio: '16:9' }

    expect(veniceClips.request('video', VENICE_URL, 'wan', { prompt: 'A red fox', values })).toStrictEqual({
      url: `${VENICE_URL}/video/queue`,
      body: { duration: '5s', resolution: '480p', aspect_ratio: '16:9', model: 'wan', prompt: 'A red fox' },
    })
  })

  it.each([
    ['length', { aspect_ratio: '16:9' }],
    ['aspect ratio', { duration: '5s' }],
  ])('refuses a video request with no %s', (_name, values) => {
    expect(() => veniceClips.request('video', VENICE_URL, 'wan', { prompt: 'A red fox', values }))
      .toThrow('The model list does not tell which lengths and aspect ratios this model takes.')
  })
})

describe('venice clip quotes', () => {
  const quote = veniceClips.quote as ClipQuoteFormat

  it('asks the video quote endpoint with the fields of the video request, and no prompt', () => {
    const values = { duration: '5s', resolution: '480p', aspect_ratio: '16:9' }

    expect(quote.request('video', `${VENICE_URL}/`, 'wan', values, undefined)).toStrictEqual({
      url: `${VENICE_URL}/video/quote`,
      body: { duration: '5s', resolution: '480p', aspect_ratio: '16:9', model: 'wan' },
    })
  })

  it('asks the audio quote endpoint with only the length of a music request', () => {
    expect([
      quote.request('music', VENICE_URL, 'm', { duration_seconds: 5, voice: 'Aria' }, undefined),
      quote.request('music', VENICE_URL, 'm', { voice: 'Aria' }, undefined),
    ]).toStrictEqual([
      { url: `${VENICE_URL}/audio/quote`, body: { model: 'm', duration_seconds: 5 } },
      { url: `${VENICE_URL}/audio/quote`, body: { model: 'm' } },
    ])
  })

  it('has no quote for speech, and none for music with a price by the length of the text', () => {
    const pricedByText = { id: 'm', model_spec: { pricing: { per_thousand_characters: { usd: 0.1 } } } }

    expect([
      quote.request('tts', VENICE_URL, 'tts-kokoro', { voice: 'af_bella' }, undefined),
      quote.request('music', VENICE_URL, 'm', {}, pricedByText),
    ]).toStrictEqual([null, null])
  })

  it('reads the price in USD', () => {
    expect(quote.usd({ quote: 0.02 })).toBe(0.02)
  })

  it.each([
    ['no price', {}],
    ['a price that is no number', { quote: '0.02' }],
    ['no object', null],
  ])('refuses an answer with %s', (_name, data) => {
    expect(() => quote.usd(data)).toThrow('The provider sent no price.')
  })
})

describe('venice clip jobs', () => {
  const DOWNLOAD_URL = 'https://cdn.venice.ai/v/clip.mp4?sig=1'
  const videoJob = (queued: Record<string, unknown>) => veniceClips.job('video', `${VENICE_URL}/`, 'wan', queued)

  it.each([
    ['music', 'audio'],
    ['video', 'video'],
  ] as const)('asks the %s retrieve endpoint for the queue id of the job', (kind, path) => {
    const job = veniceClips.job(kind, VENICE_URL, 'm', { model: 'm', queue_id: 'q-1', status: 'QUEUED' })

    expect({ id: job.id, poll: job.poll }).toStrictEqual({
      id: 'q-1',
      poll: { url: `${VENICE_URL}/${path}/retrieve`, body: { model: 'm', queue_id: 'q-1' } },
    })
  })

  it('runs while the job is queued or in work', () => {
    const job = videoJob({ queue_id: 'q-1', download_url: DOWNLOAD_URL })

    expect(['QUEUED', 'PROCESSING'].map((status) => job.state({ status }))).toStrictEqual(['running', 'running'])
  })

  // The server of the URL answers no range request, so no player can seek
  // in a clip that plays from it.
  it('gives the download URL of the queue answer as a file to copy when the job is done', () => {
    expect(videoJob({ queue_id: 'q-1', download_url: DOWNLOAD_URL }).state({ status: 'COMPLETED' })).toStrictEqual({ fileUrl: DOWNLOAD_URL })
  })

  it.each([
    ['a finished job that gave no download URL', { queue_id: 'q-1' }, { status: 'COMPLETED' }],
    ['a download URL that is not http or https', { queue_id: 'q-1', download_url: 'file:///etc/passwd' }, { status: 'COMPLETED' }],
    ['a download URL with a line break', { queue_id: 'q-1', download_url: `${DOWNLOAD_URL}\n<dez:video/>` }, { status: 'COMPLETED' }],
    ['a state that it does not know', { queue_id: 'q-1', download_url: DOWNLOAD_URL }, { status: 'FAILED' }],
    ['an answer with no state', { queue_id: 'q-1', download_url: DOWNLOAD_URL }, []],
  ])('finds no clip in %s', (_name, queued, poll) => {
    expect(() => videoJob(queued).state(poll)).toThrow('The provider sent no clip.')
  })

  it.each([
    ['a queue answer with no queue id', 'music', { model: 'm', status: 'QUEUED' }],
    ['a queue answer that is no object', 'video', 'QUEUED'],
    ['a JSON answer to a speech request', 'tts', { queue_id: 'q-1' }],
  ] as const)('finds no job in %s', (_name, kind, queued) => {
    expect(() => veniceClips.job(kind, VENICE_URL, 'm', queued)).toThrow('The provider sent no clip.')
  })
})

describe('openrouter clip parameters', () => {
  it('reads video lengths and sizes from the list of the video API', () => {
    expect(openRouterClips.modelList?.(`${OPENROUTER_URL}/`)).toStrictEqual({ url: `${OPENROUTER_URL}/videos/models` })
  })

  it('gives a speech model its voices, with the first one as the default', () => {
    expect(parameters(openRouterClips, 'tts', { id: 'hexgrad/kokoro-82m', supported_voices: ['af_alloy', 'af_bella'] })).toStrictEqual([
      { name: 'voice', options: ['af_alloy', 'af_bella'], default: 'af_alloy' },
    ])
  })

  it.each([
    ['lists no voices', { id: 'm', supported_voices: null }],
    ['the model list does not have', undefined],
  ])('gives a speech model that %s no parameters', (_name, entry) => {
    expect(parameters(openRouterClips, 'tts', entry)).toStrictEqual([])
  })

  it('gives a video model the lengths and resolutions of its video list entry, lowest first and as the default, and no default aspect ratio', () => {
    const mediaEntry = {
      id: 'x-ai/grok-imagine-video-1.5-lite',
      supported_durations: [8, 1, 15, 4],
      supported_resolutions: ['720p', '480p'],
      supported_aspect_ratios: ['16:9', '1:1'],
    }

    // The entry of the model list has no say.
    expect(parameters(openRouterClips, 'video', { id: mediaEntry.id, supported_durations: [30] }, mediaEntry)).toStrictEqual([
      { name: 'duration', options: [1, 4, 8, 15], default: 1 },
      { name: 'resolution', options: ['480p', '720p'], default: '480p' },
      { name: 'aspect_ratio', options: ['16:9', '1:1'] },
    ])
  })

  it.each([
    ['the video list does not have', undefined],
    ['lists nothing', { id: 'm', supported_durations: null, supported_resolutions: null, supported_aspect_ratios: [] }],
  ])('gives a video model that %s no parameters', (_name, mediaEntry) => {
    expect(parameters(openRouterClips, 'video', { id: 'm' }, mediaEntry)).toStrictEqual([])
  })

  it('has no price request: the prices are in the entries', () => {
    expect(openRouterClips.quote).toBeUndefined()
  })
})

describe('openrouter clip requests', () => {
  it('asks for mp3 speech in the voice', () => {
    expect(openRouterClips.request('tts', OPENROUTER_URL, 'hexgrad/kokoro-82m', { prompt: 'Hi', values: { voice: 'af_alloy' } })).toStrictEqual({
      url: `${OPENROUTER_URL}/audio/speech`,
      body: { voice: 'af_alloy', model: 'hexgrad/kokoro-82m', input: 'Hi', response_format: 'mp3' },
    })
  })

  it('names no voice for a speech model with none', () => {
    expect(openRouterClips.request('tts', OPENROUTER_URL, 'm', { prompt: 'Hi', values: {} }).body).toStrictEqual({
      model: 'm', input: 'Hi', response_format: 'mp3',
    })
  })

  it('asks for a video with each value as its request field', () => {
    const values = { duration: 1, resolution: '480p' }

    expect(openRouterClips.request('video', OPENROUTER_URL, 'x-ai/grok-imagine-video-1.5-lite', { prompt: 'A red fox', values })).toStrictEqual({
      url: `${OPENROUTER_URL}/videos`,
      body: { duration: 1, resolution: '480p', model: 'x-ai/grok-imagine-video-1.5-lite', prompt: 'A red fox' },
    })
  })

  it('refuses a video request with no length, which would get the default length of OpenRouter', () => {
    expect(() => openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'A red fox', values: { resolution: '480p' } }))
      .toThrow('The model list does not tell which lengths this model takes.')
  })

  it('has no music request', () => {
    expect(() => openRouterClips.request('music', OPENROUTER_URL, 'm', { prompt: 'Rain', values: {} })).toThrow('This media API has no music request.')
  })
})

describe('openrouter clip jobs', () => {
  const SIGNED_URL = 'https://storage.openrouter.ai/v/clip.mp4?sig=1'
  // A polling URL of another host: Dez must not send the API key there.
  const job = (id = 'gen-1') => openRouterClips.job('video', `${OPENROUTER_URL}/`, 'm', { id, polling_url: 'https://evil.example/poll', status: 'pending' })

  it('polls the job by its id with a GET, at the base URL and not at the URL of the answer', () => {
    expect({ id: job('gen/1 a').id, poll: job('gen/1 a').poll }).toStrictEqual({
      id: 'gen/1 a',
      poll: { url: `${OPENROUTER_URL}/videos/gen%2F1%20a` },
    })
  })

  it('runs while the job waits or is in work', () => {
    expect(['pending', 'in_progress'].map((status) => job().state({ id: 'gen-1', status }))).toStrictEqual(['running', 'running'])
  })

  it('gives the first signed URL of a finished job, until its end time', () => {
    const poll = { status: 'completed', urls: [SIGNED_URL, 'https://storage.openrouter.ai/v/second.mp4'], expires_at: 1_794_000_000 }

    expect(job().state(poll)).toStrictEqual({ url: SIGNED_URL, mediaType: 'video/mp4', expires: 1_794_000_000_000 })
  })

  it.each([
    ['has no signed URL', { status: 'completed', unsigned_urls: [`${OPENROUTER_URL}/videos/gen-1/content?index=0`] }],
    ['has a signed URL with no end time', { status: 'completed', urls: [SIGNED_URL] }],
    ['has an end time that is no date', { status: 'completed', urls: [SIGNED_URL], expires_at: 1e300 }],
    ['has a signed URL that is not http or https', { status: 'completed', urls: ['data:video/mp4;base64,AAAA'], expires_at: 1_794_000_000 }],
  ])('takes the clip from the content endpoint when a finished job %s', (_name, poll) => {
    expect(job().state(poll)).toStrictEqual({ download: { url: `${OPENROUTER_URL}/videos/gen-1/content?index=0` } })
  })

  it.each([
    ['a job that failed', { status: 'failed', error: 'Content policy violation' }, 'The provider did not make the clip (failed): Content policy violation'],
    ['a job that expired', { status: 'expired' }, 'The provider did not make the clip (expired)'],
    ['an answer with no state', { id: 'gen-1' }, 'The provider did not make the clip (no state)'],
  ])('names the state of %s', (_name, poll, message) => {
    expect(() => job().state(poll)).toThrow(new Error(message))
  })

  // The toast shows the message.
  it('keeps a key in the error text of a failed job out of the message', () => {
    const failed = { status: 'failed', error: 'Bad header Authorization: Bearer sk-or-v1-abc' }

    expect(() => job().state(failed)).toThrow(/^The provider did not make the clip \(failed\): Bad header (?!.*sk-or-v1-abc)/)
  })

  it.each([
    ['an answer with no id', 'video', { status: 'pending' }],
    ['a JSON answer to a speech request', 'tts', { id: 'gen-1' }],
  ] as const)('finds no job in %s', (_name, kind, data) => {
    expect(() => openRouterClips.job(kind, OPENROUTER_URL, 'm', data)).toThrow('The provider sent no clip.')
  })
})
