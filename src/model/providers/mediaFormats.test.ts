import { describe, expect, it } from 'vitest'
import { ExplainedError } from '../../utils/errorText'
import { base64ToBytes, bytesToBase64 } from '../../utils/base64'
import type { NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { ClipNotMadeError, UnusableAnswerError } from './errors'
import { MEDIA_FORMATS, NO_VIDEO_LENGTH_MESSAGE, type ClipFormat, type ClipQuoteFormat, type ImageFormat, type InputClipPart } from './mediaFormats'
import { effectiveParameterValues, type ModelParameter, type ParameterValues } from './modelParameters'
import type { ChatImagePart, ClipKind, MediaKind } from './types'

const venice = MEDIA_FORMATS.venice.images as ImageFormat
const veniceClips = MEDIA_FORMATS.venice.clips as ClipFormat
const openRouterClips = MEDIA_FORMATS.openrouter.clips as ClipFormat
const openRouterImages = MEDIA_FORMATS.openrouter.images as ImageFormat

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

// The error that `call` throws. Its class tells which text the user gets
// (`explainedProviderError`), so a test compares the whole error.
function thrownError(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  return undefined
}

// The parameters with no labels: a label is UI text.
function withoutLabels(parameters: ModelParameter[]): Omit<ModelParameter, 'label'>[] {
  return parameters.map(({ label: _label, ...parameter }) => parameter)
}

// The parameters of a model with no labels.
function parameters(format: ClipFormat, kind: ClipKind, entry: unknown, mediaEntry?: unknown): Omit<ModelParameter, 'label'>[] {
  return withoutLabels(format.parameters(kind, entry, mediaEntry))
}

// Two input images, and each one as the data URL that a request sends.
const IMAGES: ChatImagePart[] = [
  { type: 'image', mediaType: 'image/png', data: bytesToBase64(PNG) },
  { type: 'image', mediaType: 'image/jpeg', data: bytesToBase64(JPEG) },
]
const PNG_URL = `data:image/png;base64,${bytesToBase64(PNG)}`
const JPEG_URL = `data:image/jpeg;base64,${bytesToBase64(JPEG)}`

// The "Images as" parameter of an OpenRouter video model, with no label.
const IMAGES_AS_FRAMES = { name: 'images_as', options: ['frames', 'references'], default: 'frames' }
const IMAGES_AS_REFERENCES = { name: 'images_as', options: ['references'], default: 'references' }

// Two video and two audio clips of a video request: their bytes as base64,
// and each one as the data URL that a JSON request sends. Each test gives a
// clip its use.
const VIDEOS = ['VjE=', 'VjI=']
const AUDIOS = ['QTE=', 'QTI=']
const VIDEO_URLS = VIDEOS.map((data) => `data:video/mp4;base64,${data}`)
const AUDIO_URLS = AUDIOS.map((data) => `data:audio/mpeg;base64,${data}`)
const clip = (kind: InputClipPart['kind'], use: InputClipPart['use'], data: string): InputClipPart =>
  ({ kind, use, mediaType: kind === 'audio' ? 'audio/mpeg' : 'video/mp4', bytes: base64ToBytes(data) })

describe('venice media requests', () => {
  it('asks /image/generate for a WebP image with no watermark and no safe mode', () => {
    expect(venice.request('image', 'https://api.venice.ai/api/v1/', 'z-image-turbo', { prompt: 'A red fox', images: [], values: {} })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/generate',
      body: { model: 'z-image-turbo', prompt: 'A red fox', format: 'webp', hide_watermark: true, safe_mode: false },
    })
  })

  // The endpoint has no `hide_watermark` field, and its schema takes no
  // unknown field.
  it('sends an edit to /image/multi-edit with `modelId`, the images as data URLs in order, and no safe mode', () => {
    expect(venice.request('imageEdit', 'https://api.venice.ai/api/v1', 'qwen-image-2-1-turbo-edit', { prompt: 'Make it blue', images: IMAGES, values: {} })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/multi-edit',
      body: { modelId: 'qwen-image-2-1-turbo-edit', prompt: 'Make it blue', images: [PNG_URL, JPEG_URL], safe_mode: false },
    })
  })

  it.each([
    ['image', '/image/generate', { model: 'krea-3', prompt: 'A red fox', format: 'webp', hide_watermark: true, safe_mode: false }],
    ['imageEdit', '/image/multi-edit', { modelId: 'krea-3', prompt: 'A red fox', images: [PNG_URL], safe_mode: false }],
  ] as const)('sends the parameter values of a %s request with its fixed fields', (kind, path, fixed) => {
    const values = { aspect_ratio: '16:9', resolution: '2K', quality: 'high' }

    expect(venice.request(kind, VENICE_URL, 'krea-3', { prompt: 'A red fox', images: [IMAGES[0]], values })).toStrictEqual({
      url: `${VENICE_URL}${path}`,
      body: { ...fixed, ...values },
    })
  })

  // The schema has no prompt and no model field.
  it('sends an upscale to /image/upscale with the image as bare base64 and the values, and no prompt or model', () => {
    const input = { prompt: 'Make it larger', images: [IMAGES[1]], values: { scale: 4, creativity: 0.005 } }

    expect(venice.request('upscale', `${VENICE_URL}/`, 'upscaler', input)).toStrictEqual({
      url: `${VENICE_URL}/image/upscale`,
      body: { scale: 4, creativity: 0.005, image: bytesToBase64(JPEG) },
    })
  })
})

describe('venice image parameters', () => {
  // Rules of the request (the docs), so a model with no entry has them too.
  it('gives an upscale model a scale of 2 or 4 and a creativity of 0 to 0.02, whose defaults a request sends', () => {
    const upscale = venice.parameters?.('upscale', undefined, undefined) ?? []

    expect(withoutLabels(upscale)).toStrictEqual([
      { name: 'scale', options: [2, 4], default: 2 },
      { name: 'creativity', min: 0, max: 0.02, step: 0.001, default: 0.01 },
    ])
    expect(effectiveParameterValues(upscale)).toStrictEqual({ scale: 2, creativity: 0.01 })
  })

  // The constraints of `krea-3` (2026-11-11), with fewer aspect ratios.
  const KREA = {
    aspectRatios: ['1:1', '16:9', '9:16'],
    resolutions: ['1K', '2K', '4K'],
    qualities: ['medium', 'high'],
    defaultAspectRatio: '1:1',
    defaultResolution: '1K',
    defaultQuality: 'high',
  }
  const imageParameters = (kind: 'image' | 'imageEdit', constraints: Record<string, unknown>) =>
    withoutLabels(venice.parameters?.(kind, { id: 'm', model_spec: { constraints } }, undefined) ?? [])

  it.each(['image', 'imageEdit'] as const)('gives a %s model the aspect ratios, resolutions, and qualities of its entry, with their defaults', (kind) => {
    expect(imageParameters(kind, KREA)).toStrictEqual([
      { name: 'aspect_ratio', options: ['1:1', '16:9', '9:16'], default: '1:1' },
      { name: 'resolution', options: ['1K', '2K', '4K'], default: '1K' },
      { name: 'quality', options: ['medium', 'high'], default: 'high' },
    ])
  })

  // `qwen-image-2-1-turbo-edit` (2026-11-11): an edit with no aspect ratio
  // takes the one of its first image, so the list names no default.
  it('gives a list with no default no default', () => {
    expect(imageParameters('imageEdit', { aspectRatios: ['auto', '1:1'], resolutions: ['1K', '2K'], defaultResolution: '1K', maxInputImages: 6 })).toStrictEqual([
      { name: 'aspect_ratio', options: ['auto', '1:1'] },
      { name: 'resolution', options: ['1K', '2K'], default: '1K' },
    ])
  })

  it('gives no default that is not in its list, and no row for an empty list', () => {
    expect(imageParameters('image', { aspectRatios: ['1:1', '16:9'], defaultAspectRatio: '4:3', resolutions: [], defaultResolution: '1K', qualities: ['low'] })).toStrictEqual([
      { name: 'aspect_ratio', options: ['1:1', '16:9'] },
      { name: 'quality', options: ['low'] },
    ])
  })

  // `venice-sd35` (2026-11-11) takes a width and a height, which Dez does
  // not send.
  it.each(['image', 'imageEdit'] as const)('gives a %s model with no option lists no parameters', (kind) => {
    expect(imageParameters(kind, { promptCharacterLimit: 1500, steps: { default: 25, max: 30 }, widthHeightDivisor: 16 })).toStrictEqual([])
    expect(venice.parameters?.(kind, { id: 'm', model_spec: {} }, undefined)).toStrictEqual([])
  })
})

describe('venice image quotes', () => {
  const price = (usd: number) => ({ usd, diem: usd })
  const upscale = { '2x': price(0.02), '4x': price(0.08) }
  const usd = (kind: 'image' | 'imageEdit', pricing: Record<string, unknown>, values: ParameterValues = {}) =>
    venice.quote?.usd(kind, values, { entry: { id: 'm', model_spec: { pricing } }, mediaEntry: undefined, records: undefined })
  // The prices of `krea-3` (2026-11-11).
  const KREA_PRICES = {
    resolutions: { '1K': price(0.07), '2K': price(0.1), '4K': price(0.15) },
    quality: {
      '1K': { medium: price(0.04), high: price(0.07) },
      '2K': { medium: price(0.08), high: price(0.1) },
      '4K': { medium: price(0.13), high: price(0.15) },
    },
    upscale,
  }
  // The prices of `seedream-v5-5` (2026-11-11): no `generation` price.
  const SEEDREAM_PRICES = { resolutions: { '1K': price(0.0255), '1.5K': price(0.034), '2K': price(0.051) }, upscale }

  it('gives the price of the resolution and the quality of a request', () => {
    expect([
      usd('image', KREA_PRICES, { resolution: '1K', quality: 'high' }),
      usd('image', KREA_PRICES, { resolution: '4K', quality: 'medium' }),
    ]).toStrictEqual([0.07, 0.13])
  })

  // A resolution such as `1.5K` holds a dot.
  it('gives the price of the resolution of a request', () => {
    expect([
      usd('image', SEEDREAM_PRICES, { resolution: '1.5K' }),
      usd('imageEdit', { inpaint: price(0.02), resolutions: { '1K': price(0.02), '2K': price(0.03) } }, { resolution: '2K' }),
    ]).toStrictEqual([0.034, 0.03])
  })

  it.each([
    ['with no resolution', SEEDREAM_PRICES, {}],
    ['with a resolution that the table does not have', SEEDREAM_PRICES, { resolution: '4K' }],
    ['with no quality', KREA_PRICES, { resolution: '1K' }],
    ['with a resolution that is a key of every object', SEEDREAM_PRICES, { resolution: 'constructor' }],
  ])('gives no price of a request %s', (_name, pricing, values) => {
    expect(usd('image', pricing, values)).toBeUndefined()
  })

  // `seedream-v5-5-edit` (2026-11-11): each image past the included ones
  // costs more, and a quote does not know the count of the images.
  it('gives no price for a model whose price depends on the count of the input images', () => {
    const pricing = {
      inpaint: price(0.0255),
      resolutions: { '1K': price(0.0255), '2K': price(0.051) },
      inputImages: { included: 0, additional: price(0.0102) },
    }

    expect(usd('imageEdit', pricing, { resolution: '1K' })).toBeUndefined()
  })
})

describe('venice input image limits', () => {
  const MAX_BYTES = 25 * 1024 ** 2

  it.each([
    ['an image just under the pixel cap', { width: 4096, height: 4095 }, MAX_BYTES],
    ['an image whose size is not known', null, 1000],
  ])('takes %s', (_name, size, byteLength) => {
    expect(venice.inputImageProblem?.('upscale', size, byteLength)).toBeUndefined()
  })

  it('refuses an upscale of an image that is at the pixel cap, and tells what to do', () => {
    expect(venice.inputImageProblem?.('upscale', { width: 2048, height: 8192 }, 1000))
      .toBe('The image has 2048 × 8192 pixels, and an upscale makes images of at most 16,777,216 pixels (4096 × 4096), so this image cannot get larger. Use an image with fewer pixels.')
  })

  it('refuses an upscale of a file over 25 MB, and tells what to do', () => {
    expect(venice.inputImageProblem?.('upscale', { width: 512, height: 512 }, MAX_BYTES + 200_000))
      .toBe('The image file has 25.2 MB, and the upscale API takes files of at most 25 MB. Use a smaller file of the image, such as a JPEG.')
  })

  it('has no limit of its own for an edit', () => {
    expect(venice.inputImageProblem?.('imageEdit', { width: 8192, height: 8192 }, MAX_BYTES * 2)).toBeUndefined()
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
    ['a JSON answer with no images', head('application/json'), json({ id: 'generate-1', images: [] }), 'The answer holds no image.'],
    ['a JSON answer with no images list', head('application/json'), json({ error: 'busy' }), 'The answer holds no image.'],
    ['a JSON answer that does not parse', head('application/json'), new TextEncoder().encode('{"images": ['), 'The answer is not valid JSON.'],
    ['an image that is not base64', head('application/json'), json({ images: [`data:image/png;base64,${bytesToBase64(PNG)}`] }), 'The image is not base64 text.'],
    ['an image that is not a string', head('application/json'), json({ images: [{ url: 'https://example.com/a.png' }] }), 'The image is not base64 text.'],
    ['a JSON image of a type that Dez does not store', head('application/json'), json({ images: [bytesToBase64(WAV)] }), 'The image is not a PNG, JPEG, GIF, WebP, or SVG image.'],
    ['a binary answer that is not an image', head('audio/wav'), WAV, 'The image is not a PNG, JPEG, GIF, WebP, or SVG image.'],
    ['an empty binary answer', head('image/png'), new Uint8Array(), 'The image is not a PNG, JPEG, GIF, WebP, or SVG image.'],
  ])('refuses %s as an answer that Dez cannot use', (_name, responseHead, body, message) => {
    expect(thrownError(() => venice.parseResponse('image', responseHead, body))).toStrictEqual(new UnusableAnswerError(message))
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

  // With no format, Venice answers in the model's default, which can be a
  // type that Dez cannot make a file of (raw PCM).
  it.each([
    ['has no file type', 'pcm'],
    ['is not in the list of the model', 'mp3'],
    ['is not a format that Dez knows', 'ogg'],
    ['is missing', undefined],
  ])('gives a speech format the first format that has a file type when the default of the model %s', (_name, defaultFormat) => {
    expect(parameters(veniceClips, 'tts', spec({ default_format: defaultFormat, supported_formats: ['pcm', 'ogg', 'flac', 'wav'] }))).toStrictEqual([
      { name: 'response_format', options: ['flac', 'wav'], default: 'flac' },
      SPEECH_SPEED,
    ])
  })

  // The speed is a field of the speech request, not of the entry.
  it('gives a speech model with no entry only the speed, with no default', () => {
    expect(parameters(veniceClips, 'tts', undefined)).toStrictEqual([SPEECH_SPEED])
  })

  it.each(['music', 'video', 'imageToVideo'] as const)('gives a %s model with no entry no parameters', (kind) => {
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

  // Half of the image-to-video models list no aspect ratio, and the API
  // refuses the field for them.
  it('gives an image-to-video model that lists no aspect ratio no aspect ratio parameter', () => {
    const model = spec({ constraints: { model_type: 'image-to-video', durations: ['5s', '10s'], aspect_ratios: [], resolutions: ['720p', '1080p'] } })

    expect(parameters(veniceClips, 'imageToVideo', model)).toStrictEqual([
      { name: 'duration', options: ['5s', '10s'], default: '5s' },
      { name: 'resolution', options: ['720p', '1080p'], default: '720p' },
    ])
  })

  // The API makes sound when a request has no `audio` field.
  it.each(['video', 'imageToVideo'] as const)('gives a %s model that can leave the sound out an Audio switch that is on', (kind) => {
    expect(parameters(veniceClips, kind, videoModel({ audio: true, audio_configurable: true }))).toStrictEqual([{ name: 'audio', default: true }])
  })

  // The API refuses the field for these models.
  it.each([
    ['always makes sound', { audio: true, audio_configurable: false }],
    ['makes no sound', { audio: false, audio_configurable: false }],
    ['does not tell', { audio: true }],
  ])('gives a video model that %s no Audio switch', (_name, constraints) => {
    expect(parameters(veniceClips, 'video', videoModel(constraints))).toStrictEqual([])
  })

  // `duration` is required, and most video-to-video models list only
  // `Auto`, the length of the source clip.
  it('gives a video-to-video model its one length as the default when no length has seconds', () => {
    const model = videoModel({ model_type: 'video', durations: ['Auto'], resolutions: ['1080p', '720p'], video_input: true })

    expect(parameters(veniceClips, 'videoToVideo', model)).toStrictEqual([
      { name: 'duration', options: ['Auto'], default: 'Auto' },
      { name: 'resolution', options: ['720p', '1080p'], default: '720p' },
    ])
  })

  // "Use upscale_factor instead of resolution for upscale models."
  it('gives a video upscale model its factors as numbers in place of resolutions', () => {
    const model = videoModel({ model_type: 'video', durations: ['Auto'], resolutions: ['2x', '4x'], video_input: true })

    expect(parameters(veniceClips, 'videoToVideo', model)).toStrictEqual([
      { name: 'duration', options: ['Auto'], default: 'Auto' },
      { name: 'upscale_factor', options: [2, 4], default: 2 },
    ])
  })

  it('gives the voice changer its voices with its default voice, and a noise switch that is off only when the entry tells of one', () => {
    const voices = { voice_changer: true, voices: ['Aria', 'Roger'], default_voice: 'Aria' }

    expect([
      parameters(veniceClips, 'voiceChange', spec({ ...voices, supports_background_noise_removal: true })),
      parameters(veniceClips, 'voiceChange', spec(voices)),
    ]).toStrictEqual([
      [{ name: 'voice', options: ['Aria', 'Roger'], default: 'Aria' }, { name: 'remove_background_noise' }],
      [{ name: 'voice', options: ['Aria', 'Roger'], default: 'Aria' }],
    ])
  })
})

describe('venice image rules', () => {
  const rules = (kind: MediaKind, constraints?: Record<string, unknown>) =>
    MEDIA_FORMATS.venice.imageRules?.(kind, constraints && { id: 'm', model_spec: { constraints } }, undefined)

  // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
  it.each([
    ['tells its count', { maxInputImages: 6, combineImages: true }, 6],
    ['tells no count', { combineImages: true }, 3],
    ['tells no count and combines no images', { combineImages: false }, 1],
    ['tells a count that is not a whole number above 0', { maxInputImages: 0 }, 3],
    ['tells a count that is text', { maxInputImages: '6', combineImages: false }, 1],
  ])('takes as many images as the docs tell for an edit model that %s', (_name, constraints, maxImages) => {
    expect(rules('imageEdit', constraints)).toStrictEqual({ maxImages })
  })

  it('takes 3 images for an edit model with no entry', () => {
    expect(rules('imageEdit')).toStrictEqual({ maxImages: 3 })
  })

  it('takes a first and a last frame for an image-to-video model', () => {
    expect(rules('imageToVideo')).toStrictEqual({ maxImages: 2 })
  })

  // The counts and names of veniceReferences.ts; the entry tells neither.
  it.each([
    ['grok-imagine-1-5-reference-to-video', { maxImages: 7, references: { promptName: '@Image{n}' } }],
    ['seedance-2-0-fast-reference-to-video', { maxImages: 9, references: { promptName: '<Image {n}>' } }],
    ['seedance-2-5-reference-to-video', { maxImages: 30, references: { promptName: '<Image {n}>' } }],
    ['kling-o3-pro-reference-to-video', { maxImages: 4, references: { promptName: '@Element{n}' } }],
    ['wan-2-7-reference-to-video', { maxImages: 5, references: { promptName: '@Image{n}' } }],
    // A family that the table does not know yet.
    ['acme-1-reference-to-video', { maxImages: 30, references: { promptName: '@Image{n}' } }],
  ])('takes the references of %s, with their names in the prompt', (id, expected) => {
    const entry = { id, model_spec: { constraints: { model_type: 'image-to-video', reference_image_min_short_side_pixels: 300 } } }

    expect(MEDIA_FORMATS.venice.imageRules?.('imageToVideo', entry, undefined)).toStrictEqual({ ...expected, size: { minShortSide: 300 } })
  })

  it('reads the size rules of the images from the entry of the model', () => {
    expect([
      rules('imageToVideo', { reference_image_min_short_side_pixels: 300, reference_image_min_aspect_ratio: 0.4, reference_image_max_aspect_ratio: 2.5 }),
      rules('imageToVideo', { reference_image_min_short_side_pixels: 240, aspect_ratios: ['16:9'] }),
    ]).toStrictEqual([
      { maxImages: 2, size: { minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 } },
      { maxImages: 2, size: { minShortSide: 240 } },
    ])
  })

  it('takes no size rule from a value that cannot be a limit, and keeps the other rules', () => {
    expect([
      rules('imageToVideo', { reference_image_min_short_side_pixels: '300', reference_image_max_aspect_ratio: 2.5 }),
      rules('imageToVideo', { reference_image_min_short_side_pixels: 0, reference_image_min_aspect_ratio: null }),
    ]).toStrictEqual([
      { maxImages: 2, size: { maxAspectRatio: 2.5 } },
      { maxImages: 2 },
    ])
  })

  // Free refusals of 40 images (2026-11-12): a video-to-video model takes
  // reference images only when its entry tells their size.
  it('takes the references of a video-to-video model whose entry tells their size, else one image, and none for an upscale model', () => {
    const entry = (id: string, constraints: Record<string, unknown>) =>
      MEDIA_FORMATS.venice.imageRules?.('videoToVideo', { id, model_spec: { constraints: { model_type: 'video', video_input: true, ...constraints } } }, undefined)

    expect([
      entry('kling-v4-flash-video-to-video', { reference_image_min_short_side_pixels: 300, resolutions: ['720p'] }),
      entry('kling-v3-pro-motion-control', { resolutions: [] }),
      entry('topaz-video-upscale', { reference_image_min_short_side_pixels: 300, resolutions: ['2x', '4x'] }),
    ]).toStrictEqual([
      { maxImages: 10, references: { promptName: '@Image{n}' }, size: { minShortSide: 300 } },
      { maxImages: 1 },
      undefined,
    ])
  })

  it.each(['image', 'video', 'tts', 'music'] as const)('takes no image for a %s model', (kind) => {
    expect(rules(kind, { maxInputImages: 6 })).toBeUndefined()
  })
})

// https://docs.venice.ai/api-reference/endpoint/video/queue
describe('venice clip rules', () => {
  const rules = (kind: MediaKind, id: string, constraints: Record<string, unknown> = {}) =>
    MEDIA_FORMATS.venice.clipRules?.(kind, { id, model_spec: { constraints: { model_type: 'image-to-video', ...constraints } } }, undefined)
  const VIDEO_TYPES = ['video/mp4', 'video/quicktime']
  const AUDIO_TYPES = ['audio/wav', 'audio/mpeg']
  const MB = 1024 ** 2

  // The rules of the family win over `audio_input`, which would make an
  // audio clip the sound of the video.
  it('takes the reference clips of a seedance 2.0 model, and its audio clips only with an image or a video', () => {
    const seconds = { minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15 }

    expect(rules('imageToVideo', 'seedance-2-0-reference-to-video', { audio_input: true })).toStrictEqual({
      video: { use: 'reference', maxClips: 3, ...seconds, maxBytes: 50 * MB, types: VIDEO_TYPES, promptName: '<Video {n}>' },
      audio: { use: 'reference', maxClips: 3, ...seconds, maxBytes: 15 * MB, types: AUDIO_TYPES, promptName: '<Audio {n}>' },
      audioNeedsVisual: true,
    })
  })

  it('takes the voice of each reference for a wan 2.7 model whose entry says so, and no audio clip without it', () => {
    const video = { use: 'reference', maxClips: 5, maxBytes: 50 * MB, types: VIDEO_TYPES }

    expect([
      rules('imageToVideo', 'wan-2-7-reference-to-video', { per_reference_audio: true }),
      rules('imageToVideo', 'wan-2-7-reference-to-video'),
    ]).toStrictEqual([
      { video, audio: { use: 'voice', types: AUDIO_TYPES } },
      { video },
    ])
  })

  it.each([
    ['video', 'wan-2-5-preview-text-to-video'],
    // A reference family that takes no clip.
    ['imageToVideo', 'grok-imagine-1-5-reference-to-video'],
  ] as const)('takes one audio clip as the sound of the %s model %s, whose entry says that it takes audio', (kind, id) => {
    expect(rules(kind, id, { audio_input: true })).toStrictEqual({
      audio: { use: 'background', maxClips: 1, maxSeconds: 30, maxBytes: 15 * MB, types: AUDIO_TYPES },
    })
  })

  it('takes no clip for a video model whose entry says that it takes no audio', () => {
    expect(rules('imageToVideo', 'wan-2-5-preview-image-to-video', { audio_input: false })).toBeUndefined()
  })

  it.each(['music', 'imageEdit'] as const)('takes no clip for a %s model', (kind) => {
    expect(rules(kind, 'seedance-2-0-reference-to-video', { audio_input: true })).toBeUndefined()
  })

  // Live entries of 2026-11-12: Seedance 2.5 Edit is the one model with
  // `video_input: false`, and it refuses `video_url`.
  it('takes the one video of a video-to-video model as its source, or as a reference video when the model refuses video_url', () => {
    expect([
      rules('videoToVideo', 'wan-2-7-video-to-video', { model_type: 'video', video_input: true }),
      rules('videoToVideo', 'seedance-2-5-edit-video-basic', { model_type: 'video', video_input: false }),
    ]).toStrictEqual([
      { video: { use: 'source', maxClips: 1, types: [...VIDEO_TYPES, 'video/webm'] } },
      { video: { use: 'reference', maxClips: 1, minSeconds: 2, maxSeconds: 30, maxTotalSeconds: 30, maxBytes: 50 * MB, types: VIDEO_TYPES, promptName: '<Video {n}>' } },
    ])
  })

  it('takes one audio clip of the types and the length of the voice changer\'s entry, at most 25 MB', () => {
    const entry = { id: 'elevenlabs-voice-changer', model_spec: { voice_changer: true, accepted_audio_formats: ['mp3', 'wav', 'flac'], max_source_audio_duration_seconds: 300 } }

    expect(MEDIA_FORMATS.venice.clipRules?.('voiceChange', entry, undefined)).toStrictEqual({
      audio: { use: 'source', maxClips: 1, maxSeconds: 300, maxBytes: 25 * MB, types: ['audio/mpeg', 'audio/wav'] },
    })
  })

  it('takes one audio clip of a type that the transcription endpoint reads and Dez stores', () => {
    expect(MEDIA_FORMATS.venice.clipRules?.('transcription', { id: 'openai/whisper-large-v3', model_spec: {} }, undefined)).toStrictEqual({
      audio: { use: 'source', maxClips: 1, types: ['audio/wav', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg'] },
    })
  })
})

describe('venice refusals of images', () => {
  // The body of a live refusal (2026-11-11), with the details of the other
  // fields cut.
  const refusal = {
    details: { _errors: [], end_image_url: { _errors: ['This model does not support end_image_url'] } },
    error: 'Invalid request parameters',
  }

  it('tells that an image-to-video model that refuses a last frame takes only one image', () => {
    expect(veniceClips.refusedImages?.('imageToVideo', 400, refusal)).toBe(1)
  })

  // Live texts (2026-11-11), one for each field that Dez sends.
  it.each([
    ['reference_image_urls', 'reference_image_urls must have at most 7 images', 7],
    ['image_references', 'image_references must have at most 5 entries', 5],
    ['elements', 'elements must have at most 4 items', 4],
  ])('tells the count of a reference-to-video model that refuses more `%s`', (field, text, count) => {
    expect(veniceClips.refusedImages?.('imageToVideo', 400, { details: { _errors: [], [field]: { _errors: [text] } }, error: 'Invalid request parameters' })).toBe(count)
  })

  it.each([
    ['another status', 'imageToVideo', 422, refusal],
    ['another kind', 'video', 400, refusal],
    ['a refusal of another field', 'imageToVideo', 400, { details: { duration: { _errors: ['Invalid option'] } }, error: 'Invalid request parameters' }],
    ['a count refusal of a field that Dez does not send', 'imageToVideo', 400, { details: { scene_image_urls: { _errors: ['scene_image_urls must have at most 4 images'] } }, error: 'Invalid request parameters' }],
    ['a body that is not JSON', 'imageToVideo', 400, undefined],
  ] as const)('tells nothing for %s', (_name, kind, status, body) => {
    expect(veniceClips.refusedImages?.(kind, status, body)).toBeUndefined()
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

  // A video entry has its limit under `constraints`, and no other rule.
  it.each(['video', 'imageToVideo'] as const)('reads the prompt limit of a %s model', (kind) => {
    expect(rules(kind, spec({ constraints: { prompt_character_limit: 2000 }, min_prompt_length: 10, supports_lyrics: true })))
      .toStrictEqual({ maxPromptLength: 2000 })
  })

  it.each([
    ['a music model whose entry tells nothing', 'music', spec({})],
    ['a music model with no entry', 'music', undefined],
    ['a video model whose entry tells no limit', 'video', spec({ constraints: { durations: ['5s'] } })],
    ['a video model with no entry', 'video', undefined],
    // No model takes no text at all.
    ['a video model with a limit of 0', 'video', spec({ constraints: { prompt_character_limit: 0 } })],
    ['a video model with a limit that is a text', 'imageToVideo', spec({ constraints: { prompt_character_limit: '2000' } })],
    // Only a music entry has its limit at this place.
    ['a video model with the limit of a music entry', 'imageToVideo', spec({ prompt_character_limit: 300 })],
  ] as const)('has no rules for %s', (_name, kind, entry) => {
    expect(rules(kind, entry)).toBeUndefined()
  })
})

describe('venice clip requests', () => {
  it('sends speech text as `input`, with the voice and the format', () => {
    expect(veniceClips.request('tts', `${VENICE_URL}/`, 'tts-kokoro', { prompt: 'Hi', images: [], values: { voice: 'af_bella', response_format: 'mp3' } })).toStrictEqual({
      url: `${VENICE_URL}/audio/speech`,
      body: { voice: 'af_bella', response_format: 'mp3', model: 'tts-kokoro', input: 'Hi' },
    })
  })

  it('queues music with only the model and the prompt when no parameter has a value', () => {
    expect(veniceClips.request('music', VENICE_URL, 'mmaudio-v2-text-to-audio', { prompt: 'Rain', images: [], values: {} })).toStrictEqual({
      url: `${VENICE_URL}/audio/queue`,
      body: { model: 'mmaudio-v2-text-to-audio', prompt: 'Rain' },
    })
  })

  it('queues a song with the style as the prompt and the lyrics as `lyrics_prompt`', () => {
    const input = { prompt: 'Slow piano ballad', images: [], lyrics: '[Verse]\nRain on the roof', values: { force_instrumental: false, duration_seconds: 60 } }

    expect(veniceClips.request('music', VENICE_URL, 'minimax-music-v2', input)).toStrictEqual({
      url: `${VENICE_URL}/audio/queue`,
      body: { force_instrumental: false, duration_seconds: 60, model: 'minimax-music-v2', prompt: 'Slow piano ballad', lyrics_prompt: '[Verse]\nRain on the roof' },
    })
  })

  // The API takes no `lyrics_prompt` with `lyrics_optimizer: true`.
  it('leaves the lyrics optimizer out of a request that has lyrics, and keeps it in one that has none', () => {
    const values = { lyrics_optimizer: true, loop: true }

    expect([
      veniceClips.request('music', VENICE_URL, 'm', { prompt: 'Pop', images: [], lyrics: 'La la', values }).body,
      veniceClips.request('music', VENICE_URL, 'm', { prompt: 'Pop', images: [], values }).body,
    ]).toStrictEqual([
      { loop: true, model: 'm', prompt: 'Pop', lyrics_prompt: 'La la' },
      { lyrics_optimizer: true, loop: true, model: 'm', prompt: 'Pop' },
    ])
  })

  it.each(['tts', 'video', 'imageToVideo'] as const)('sends no lyrics in a %s request', (kind) => {
    const values = { duration: '5s', aspect_ratio: '16:9' }

    expect(veniceClips.request(kind, VENICE_URL, 'm', { prompt: 'Hi', images: [], lyrics: 'La la', values }).body).not.toHaveProperty('lyrics_prompt')
  })

  it.each([
    ['tts', { model: 'm', input: 'Hi' }],
    ['music', { model: 'm', prompt: 'Hi' }],
  ] as const)('sends no image in a %s request', (kind, body) => {
    expect(veniceClips.request(kind, VENICE_URL, 'm', { prompt: 'Hi', images: IMAGES, values: {} }).body).toStrictEqual(body)
  })

  it('queues a video from a text with each value as its request field, and no image field', () => {
    const values = { duration: '5s', resolution: '480p', aspect_ratio: '16:9', audio: false }

    expect(veniceClips.request('video', VENICE_URL, 'wan', { prompt: 'A red fox', images: [], values })).toStrictEqual({
      url: `${VENICE_URL}/video/queue`,
      body: { duration: '5s', resolution: '480p', aspect_ratio: '16:9', audio: false, model: 'wan', prompt: 'A red fox' },
    })
  })

  it('queues a video from an image with the image as a data URL in `image_url`, and no last frame', () => {
    const values = { duration: '5s', resolution: '480p' }

    expect(veniceClips.request('imageToVideo', VENICE_URL, 'wan-i2v', { prompt: 'It runs', images: [IMAGES[0]], values })).toStrictEqual({
      url: `${VENICE_URL}/video/queue`,
      body: { duration: '5s', resolution: '480p', model: 'wan-i2v', prompt: 'It runs', image_url: PNG_URL },
    })
  })

  it('sends a second image as the last frame, in `end_image_url`', () => {
    expect(veniceClips.request('imageToVideo', VENICE_URL, 'wan-i2v', { prompt: 'It runs', images: IMAGES, values: { duration: '5s' } }).body).toStrictEqual({
      duration: '5s', model: 'wan-i2v', prompt: 'It runs', image_url: PNG_URL, end_image_url: JPEG_URL,
    })
  })

  // https://docs.venice.ai/api-reference/endpoint/video/queue
  it.each([
    ['grok-imagine-1-5-reference-to-video', { reference_image_urls: [PNG_URL, JPEG_URL] }],
    ['wan-2-7-reference-to-video', { image_references: [{ image_url: PNG_URL }, { image_url: JPEG_URL }] }],
    ['kling-o3-standard-reference-to-video', { elements: [{ frontal_image_url: PNG_URL }, { frontal_image_url: JPEG_URL }] }],
  ])('queues the images of %s as references in the field of its family, and no frame', (modelId, references) => {
    expect(veniceClips.request('imageToVideo', VENICE_URL, modelId, { prompt: '@Image1 meets @Image2', images: IMAGES, values: { duration: '5s' } }).body).toStrictEqual({
      duration: '5s', model: modelId, prompt: '@Image1 meets @Image2', ...references,
    })
  })

  it('queues the reference clips of a seedance 2.0 model in the field of their kind, each list in the user\'s order', () => {
    const clips = [clip('video', 'reference', VIDEOS[0]), clip('audio', 'reference', AUDIOS[0]), clip('video', 'reference', VIDEOS[1])]
    const prompt = '<Image 1> dances to <Audio 1>'

    expect(veniceClips.request('imageToVideo', VENICE_URL, 'seedance-2-0-reference-to-video', { prompt, images: IMAGES, clips, values: { duration: '5s' } }).body).toStrictEqual({
      duration: '5s',
      model: 'seedance-2-0-reference-to-video',
      prompt,
      reference_image_urls: [PNG_URL, JPEG_URL],
      reference_video_urls: VIDEO_URLS,
      reference_audio_urls: [AUDIO_URLS[0]],
    })
  })

  it('sends no image field and no audio field in a reference request with only a video clip', () => {
    const input = { prompt: 'Like <Video 1>', images: [], clips: [clip('video', 'reference', VIDEOS[0])], values: { duration: '5s' } }

    expect(veniceClips.request('imageToVideo', VENICE_URL, 'seedance-2-0-reference-to-video', input).body).toStrictEqual({
      duration: '5s', model: 'seedance-2-0-reference-to-video', prompt: 'Like <Video 1>', reference_video_urls: [VIDEO_URLS[0]],
    })
  })

  // The n-th voice is the voice of the n-th reference: the images first,
  // then the videos.
  it('queues each voice of a wan 2.7 model as the `audio_url` of one reference, and none on a reference with no voice', () => {
    const clips = [clip('video', 'reference', VIDEOS[0]), clip('audio', 'voice', AUDIOS[0]), clip('video', 'reference', VIDEOS[1]), clip('audio', 'voice', AUDIOS[1])]

    expect(veniceClips.request('imageToVideo', VENICE_URL, 'wan-2-7-reference-to-video', { prompt: 'They talk', images: [IMAGES[0]], clips, values: { duration: '5s' } }).body).toStrictEqual({
      duration: '5s',
      model: 'wan-2-7-reference-to-video',
      prompt: 'They talk',
      image_references: [{ image_url: PNG_URL, audio_url: AUDIO_URLS[0] }],
      video_references: [{ video_url: VIDEO_URLS[0], audio_url: AUDIO_URLS[1] }, { video_url: VIDEO_URLS[1] }],
    })
  })

  it('queues the sound of the video as `audio_url`, next to the first frame', () => {
    const input = { prompt: 'It sings', images: [IMAGES[0]], clips: [clip('audio', 'background', AUDIOS[0])], values: { duration: '5s' } }

    expect(veniceClips.request('imageToVideo', VENICE_URL, 'wan-2-5-preview-image-to-video', input).body).toStrictEqual({
      duration: '5s', model: 'wan-2-5-preview-image-to-video', prompt: 'It sings', image_url: PNG_URL, audio_url: AUDIO_URLS[0],
    })
  })

  // https://docs.venice.ai/guides/media/video-upscaling
  it('queues the source clip of a video-to-video model as `video_url`, with its one image as `image_url`', () => {
    const input = { prompt: 'Make it rain', images: [IMAGES[0]], clips: [clip('video', 'source', VIDEOS[0])], values: { duration: 'Auto', resolution: '720p' } }

    expect(veniceClips.request('videoToVideo', `${VENICE_URL}/`, 'kling-v3-pro-motion-control', input)).toStrictEqual({
      url: `${VENICE_URL}/video/queue`,
      body: { duration: 'Auto', resolution: '720p', model: 'kling-v3-pro-motion-control', prompt: 'Make it rain', video_url: VIDEO_URLS[0], image_url: PNG_URL },
    })
  })

  it('queues the images of a video-to-video model that takes references as `reference_image_urls`, and a reference video as `reference_video_urls`', () => {
    const input = { prompt: '<Video 1> like <Image 1>', images: IMAGES, imagesAsReferences: true as const, clips: [clip('video', 'reference', VIDEOS[0])], values: { duration: 'Auto' } }

    expect(veniceClips.request('videoToVideo', VENICE_URL, 'seedance-2-5-edit-video-basic', input).body).toStrictEqual({
      duration: 'Auto',
      model: 'seedance-2-5-edit-video-basic',
      prompt: '<Video 1> like <Image 1>',
      reference_video_urls: [VIDEO_URLS[0]],
      reference_image_urls: [PNG_URL, JPEG_URL],
    })
  })

  // "Upscaling does not use text prompts … will return an error if
  // provided".
  it('queues a video upscale with its factor and no prompt', () => {
    const input = { prompt: 'Sharper', images: [], clips: [clip('video', 'source', VIDEOS[0])], values: { duration: 'Auto', upscale_factor: 2 } }

    expect(veniceClips.request('videoToVideo', VENICE_URL, 'topaz-video-upscale', input).body).toStrictEqual({
      duration: 'Auto', upscale_factor: 2, model: 'topaz-video-upscale', video_url: VIDEO_URLS[0],
    })
  })

  // https://docs.venice.ai/guides/media/voice-changer
  it('queues a voice change as a form with the model, the values, and the clip as a file, with no prompt and no switch that is off', () => {
    const input = { prompt: 'Make it deep', images: [], clips: [clip('audio', 'source', AUDIOS[0])], values: { voice: 'Roger', remove_background_noise: false, seed: 7 } }

    expect(veniceClips.request('voiceChange', `${VENICE_URL}/`, 'elevenlabs-voice-changer', input)).toStrictEqual({
      url: `${VENICE_URL}/audio/voice-changer/queue`,
      form: [
        { name: 'model', value: 'elevenlabs-voice-changer' },
        { name: 'voice', value: 'Roger' },
        { name: 'seed', value: '7' },
        { name: 'file', file: { bytes: base64ToBytes(AUDIOS[0]), mediaType: 'audio/mpeg', fileName: 'clip.mp3' } },
      ],
    })
  })

  it.each(['video', 'imageToVideo', 'videoToVideo'] as const)('refuses a %s request with no length', (kind) => {
    expect(thrownError(() => veniceClips.request(kind, VENICE_URL, 'wan', { prompt: 'A red fox', images: [], values: { aspect_ratio: '16:9' } })))
      .toStrictEqual(new ExplainedError(NO_VIDEO_LENGTH_MESSAGE))
  })
})

describe('venice clip quotes', () => {
  const quote = veniceClips.quote as ClipQuoteFormat

  it.each(['video', 'imageToVideo'] as const)('asks the video quote endpoint with the fields of the %s request, and no prompt', (kind) => {
    const values = { duration: '5s', resolution: '480p', aspect_ratio: '16:9' }

    expect(quote.request(kind, `${VENICE_URL}/`, 'wan', values, undefined)).toStrictEqual({
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
    expect(thrownError(() => quote.usd(data))).toStrictEqual(new UnusableAnswerError('The answer holds no price.'))
  })
})

describe('venice clip jobs', () => {
  const DOWNLOAD_URL = 'https://cdn.venice.ai/v/clip.mp4?sig=1'
  const videoJob = (queued: Record<string, unknown>) => veniceClips.job('video', `${VENICE_URL}/`, 'wan', queued)

  it.each([
    ['music', 'audio'],
    ['video', 'video'],
    ['imageToVideo', 'video'],
    ['videoToVideo', 'video'],
    // The voice changer has its own endpoint.
    ['voiceChange', 'audio/voice-changer'],
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
    ['a finished job that gave no download URL', { queue_id: 'q-1' }],
    ['a download URL that is not http or https', { queue_id: 'q-1', download_url: 'file:///etc/passwd' }],
    ['a download URL with a line break', { queue_id: 'q-1', download_url: `${DOWNLOAD_URL}\n<dez:video/>` }],
  ])('finds no clip in %s', (_name, queued) => {
    expect(thrownError(() => videoJob(queued).state({ status: 'COMPLETED' })))
      .toStrictEqual(new UnusableAnswerError('The job is done, and its answer holds no clip and no download URL.'))
  })

  it.each([
    ['a state that it does not know', { status: 'FAILED' }, 'State: FAILED'],
    ['an answer with no state', [], 'State: none'],
  ])('tells that the provider did not make the clip, for %s', (_name, poll, message) => {
    expect(thrownError(() => videoJob({ queue_id: 'q-1', download_url: DOWNLOAD_URL }).state(poll))).toStrictEqual(new ClipNotMadeError(message))
  })

  it.each([
    ['a queue answer with no queue id', 'music', { model: 'm', status: 'QUEUED' }],
    ['a queue answer that is no object', 'video', 'QUEUED'],
    ['a JSON answer to a speech request', 'tts', { queue_id: 'q-1' }],
  ] as const)('finds no job in %s', (_name, kind, queued) => {
    expect(thrownError(() => veniceClips.job(kind, VENICE_URL, 'm', queued)))
      .toStrictEqual(new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.'))
  })
})

describe('openrouter clip parameters', () => {
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
      supported_frame_images: ['first_frame'],
    }

    // The entry of the model list has no say.
    expect(parameters(openRouterClips, 'video', { id: mediaEntry.id, supported_durations: [30] }, mediaEntry)).toStrictEqual([
      { name: 'duration', options: [1, 4, 8, 15], default: 1 },
      { name: 'resolution', options: ['480p', '720p'], default: '480p' },
      { name: 'aspect_ratio', options: ['16:9', '1:1'] },
      // Frames by default, as before the choice came.
      IMAGES_AS_FRAMES,
    ])
  })

  it('gives a video model that the video list does not have no parameters', () => {
    expect(parameters(openRouterClips, 'video', { id: 'm' }, undefined)).toStrictEqual([])
  })

  // Every video model takes references; a model that lists no frame takes
  // its images only as references.
  it.each([
    ['lists nothing', { id: 'm', supported_durations: null, supported_resolutions: null, supported_aspect_ratios: [], supported_frame_images: null }],
    ['lists only a last frame', { id: 'm', supported_frame_images: ['last_frame'] }],
  ])('gives a video model that %s only references', (_name, mediaEntry) => {
    expect(parameters(openRouterClips, 'video', { id: 'm' }, mediaEntry)).toStrictEqual([IMAGES_AS_REFERENCES])
  })

  // A request with no `generate_audio` field gets sound from such a model.
  it('gives a video model that can make sound an Audio switch that is on', () => {
    expect(parameters(openRouterClips, 'video', { id: 'm' }, { id: 'm', generate_audio: true })).toStrictEqual([{ name: 'generate_audio', default: true }, IMAGES_AS_REFERENCES])
  })

  it.each([false, null])('gives a video model whose `generate_audio` is %s no Audio switch', (generateAudio) => {
    expect(parameters(openRouterClips, 'video', { id: 'm' }, { id: 'm', generate_audio: generateAudio })).toStrictEqual([IMAGES_AS_REFERENCES])
  })

  it('has no price request: the prices are in the entries', () => {
    expect(openRouterClips.quote).toBeUndefined()
  })
})

describe('openrouter image rules', () => {
  const rules = (kind: MediaKind, frames: unknown) => MEDIA_FORMATS.openrouter.imageRules?.(kind, { id: 'm' }, { id: 'm', supported_frame_images: frames })
  const REFERENCES = { maxImages: 16, references: {} }

  it.each([
    ['a first frame', ['first_frame'], 1],
    ['a first and a last frame', ['first_frame', 'last_frame'], 2],
    ['a last and a first frame', ['last_frame', 'first_frame'], 2],
  ])('takes %s for a video model whose video list entry says so, and 16 references when the user chose them', (_name, frames, maxImages) => {
    expect(rules('video', frames)).toStrictEqual({ maxImages, whenParameter: { name: 'images_as', value: 'references', rules: REFERENCES } })
  })

  // The images go in the order first frame, last frame.
  it.each([
    ['lists no frame', null],
    ['lists only a last frame', ['last_frame']],
    ['lists an empty list', []],
  ])('takes only references for a video model that %s', (_name, frames) => {
    expect(rules('video', frames)).toStrictEqual(REFERENCES)
  })

  it('takes no image for a video model that the video list does not have, and no frame for a speech or an image model', () => {
    expect([
      MEDIA_FORMATS.openrouter.imageRules?.('video', { id: 'm' }, undefined),
      rules('tts', ['first_frame']),
      rules('imageEdit', ['first_frame']),
    ]).toStrictEqual([undefined, undefined, undefined])
  })
})

// The docs tell no count, length, type, size, or prompt name of a clip.
// https://openrouter.ai/docs/guides/overview/multimodal/video-generation
describe('openrouter clip rules', () => {
  const rules = (kind: MediaKind, inputs: unknown) => MEDIA_FORMATS.openrouter.clipRules?.(kind, { id: 'm', architecture: { input_modalities: inputs } }, undefined)

  it.each([
    ['audio', ['text', 'image', 'audio'], { audio: { use: 'reference', urlOnly: true } }],
    ['video', ['text', 'video'], { video: { use: 'reference', urlOnly: true } }],
    ['audio and video', ['text', 'image', 'audio', 'video'], { audio: { use: 'reference', urlOnly: true }, video: { use: 'reference', urlOnly: true } }],
  ])('takes %s clips as references by web address with no limit for a video model whose entry names them as inputs', (_name, inputs, expected) => {
    expect(rules('video', inputs)).toStrictEqual(expected)
  })

  it('takes no clip for a video model whose entry names neither audio nor video as an input', () => {
    expect(rules('video', ['text', 'image'])).toBeUndefined()
  })

  it.each(['tts', 'image'] as const)('takes no clip for a %s model, whatever its entry names', (kind) => {
    expect(rules(kind, ['text', 'audio', 'video'])).toBeUndefined()
  })

  // https://openrouter.ai/docs/api/api-reference/stt/create-transcription
  it('takes one audio clip of at most 25 MB as the file of a transcription', () => {
    expect(rules('transcription', ['audio'])).toStrictEqual({
      audio: { use: 'source', maxClips: 1, maxBytes: 25 * 1024 ** 2, types: ['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/ogg', 'audio/aac'] },
    })
  })
})

// Entry shapes of the live image list (2026-11-11), with short lists.
describe('openrouter images', () => {
  const entry = (supported: Record<string, unknown>) => ({ id: 'm', supported_parameters: supported })
  const imageParameters = (kind: 'image' | 'imageEdit' | 'upscale', mediaEntry: unknown) =>
    withoutLabels(openRouterImages.parameters?.(kind, { id: 'm' }, mediaEntry) ?? [])
  const references = (range: unknown) => MEDIA_FORMATS.openrouter.imageRules?.('image', { id: 'm' }, entry({ input_references: range }))

  it('asks /images for one image from the prompt and the values, with no reference image', () => {
    expect(openRouterImages.request('image', `${OPENROUTER_URL}/`, 'black-forest-labs/flux-3-image-klein', { prompt: 'A red fox', images: [], values: { resolution: '768' } })).toStrictEqual({
      url: `${OPENROUTER_URL}/images`,
      body: { resolution: '768', model: 'black-forest-labs/flux-3-image-klein', prompt: 'A red fox' },
    })
  })

  it('sends the input images as reference data URLs, in order', () => {
    expect(openRouterImages.request('imageEdit', OPENROUTER_URL, 'krea/k3-edit', { prompt: 'Make it blue', images: IMAGES, values: {} }).body).toStrictEqual({
      model: 'krea/k3-edit',
      prompt: 'Make it blue',
      input_references: [
        { type: 'image_url', image_url: { url: PNG_URL } },
        { type: 'image_url', image_url: { url: JPEG_URL } },
      ],
    })
  })

  it('has no upscale request, and tells the user to choose another model', () => {
    expect(thrownError(() => openRouterImages.request('upscale', OPENROUTER_URL, 'm', { prompt: '', images: IMAGES, values: {} })))
      .toStrictEqual(new ExplainedError('This provider has no upscale request that Dez can use. Choose another model.'))
  })

  it('takes the images of the answer, each with the type of its bytes', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>')
    const body = json({ created: 1, data: [
      { b64_json: bytesToBase64(PNG), media_type: 'image/webp' },
      { b64_json: bytesToBase64(JPEG) },
      { b64_json: bytesToBase64(svg), media_type: 'image/svg+xml' },
    ], usage: { cost: 0.008 } })

    expect(openRouterImages.parseResponse('image', head('application/json'), body)).toStrictEqual([
      { bytes: PNG, mediaType: 'image/png' },
      { bytes: JPEG, mediaType: 'image/jpeg' },
      { bytes: svg, mediaType: 'image/svg+xml' },
    ])
  })

  it.each([
    ['an answer with no image', json({ created: 1, data: [] }), 'The answer holds no image.'],
    ['an answer that is not JSON', PNG, 'The answer is not valid JSON.'],
    ['an image of a type that Dez does not store', json({ data: [{ b64_json: bytesToBase64(WAV), media_type: 'image/tiff' }] }), 'The image is not a PNG, JPEG, GIF, WebP, or SVG image.'],
    ['an image with no base64 text', json({ data: [{ url: 'https://example.com/a.png' }] }), 'The image is not base64 text.'],
  ])('refuses %s as an answer that Dez cannot use', (_name, body, message) => {
    expect(thrownError(() => openRouterImages.parseResponse('image', head('application/json'), body))).toStrictEqual(new UnusableAnswerError(message))
  })

  // `seed` and `size` are `boolean` descriptors: free values, not switches.
  // `n`, `background`, and `output_compression` never go.
  it('gives an image model the resolutions, aspect ratios, qualities, and file types of its entry, with no default', () => {
    const mediaEntry = entry({
      resolution: { type: 'enum', values: ['1k', '2k'] },
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
      quality: { type: 'enum', values: ['low', 'high'] },
      output_format: { type: 'enum', values: ['png', 'webp'] },
      n: { type: 'range', min: 1, max: 4 },
      background: { type: 'enum', values: ['transparent', 'opaque'] },
      output_compression: { type: 'range', min: 0, max: 100 },
      seed: { type: 'boolean' },
      size: { type: 'boolean' },
    })

    expect(imageParameters('image', mediaEntry)).toStrictEqual([
      { name: 'resolution', options: ['1k', '2k'] },
      { name: 'aspect_ratio', options: ['1:1', '16:9'] },
      { name: 'quality', options: ['low', 'high'] },
      { name: 'output_format', options: ['png', 'webp'] },
    ])
  })

  it('offers only the file types that Dez stores, with the first one as the default when the model makes another type too', () => {
    expect(imageParameters('image', entry({ output_format: { type: 'enum', values: ['tiff', 'jpeg', 'png'] } }))).toStrictEqual([
      { name: 'output_format', options: ['jpeg', 'png'], default: 'jpeg' },
    ])
  })

  // The Recraft vector models list only `svg`.
  it('offers SVG as a file type that Dez stores', () => {
    expect(imageParameters('image', entry({ output_format: { type: 'enum', values: ['svg'] } }))).toStrictEqual([
      { name: 'output_format', options: ['svg'] },
    ])
    expect(imageParameters('image', entry({ output_format: { type: 'enum', values: ['SVG', 'png'] } }))).toStrictEqual([
      { name: 'output_format', options: ['SVG', 'png'] },
    ])
  })

  it.each([
    ['the image list does not have', undefined],
    ['lists only free values', entry({ seed: { type: 'boolean' }, size: { type: 'boolean' } })],
  ])('gives an image model that %s no parameters', (_name, mediaEntry) => {
    expect(imageParameters('image', mediaEntry)).toStrictEqual([])
  })

  it.each([
    ['only TIFF', ['tiff'], 'TIFF'],
    ['two types that Dez does not store', ['bmp', 'tiff'], 'BMP or TIFF'],
    ['TIFF and PNG', ['tiff', 'png'], undefined],
    ['only SVG', ['svg'], undefined],
    ['no list', undefined, undefined],
  ])('tells the unstored type of an image model that makes %s', (_name, formats, unstored) => {
    const mediaEntry = entry(formats ? { output_format: { type: 'enum', values: formats } } : {})

    expect(openRouterImages.unstoredOutput?.('image', { id: 'm' }, mediaEntry)).toBe(unstored)
  })

  it.each([
    ['up to 4', { type: 'range', min: 0, max: 4 }, { maxImages: 4 }],
    ['1, and needs it', { type: 'range', min: 1, max: 1 }, { maxImages: 1, minImages: 1 }],
    // The request schema takes 16 at most.
    ['more than the request takes', { type: 'range', min: 0, max: 20 }, { maxImages: 16 }],
    ['none', { type: 'range', min: 0, max: 0 }, undefined],
    ['a count that is not a number', { type: 'range', max: '4' }, undefined],
    ['no count', undefined, undefined],
  ])('takes reference images for an image model whose entry takes %s', (_name, range, rules) => {
    expect(references(range)).toStrictEqual(rules)
  })
})

describe('openrouter clip requests', () => {
  it('asks for mp3 speech in the voice', () => {
    expect(openRouterClips.request('tts', OPENROUTER_URL, 'hexgrad/kokoro-82m', { prompt: 'Hi', images: [], values: { voice: 'af_alloy' } })).toStrictEqual({
      url: `${OPENROUTER_URL}/audio/speech`,
      body: { voice: 'af_alloy', model: 'hexgrad/kokoro-82m', input: 'Hi', response_format: 'mp3' },
    })
  })

  it('names no voice for a speech model with none', () => {
    expect(openRouterClips.request('tts', OPENROUTER_URL, 'm', { prompt: 'Hi', images: IMAGES, values: {} }).body).toStrictEqual({
      model: 'm', input: 'Hi', response_format: 'mp3',
    })
  })

  it('asks for a video from a text with each value as its request field, and no frame', () => {
    const values = { duration: 1, resolution: '480p', generate_audio: false }

    expect(openRouterClips.request('video', OPENROUTER_URL, 'x-ai/grok-imagine-video-1.5-lite', { prompt: 'A red fox', images: [], values })).toStrictEqual({
      url: `${OPENROUTER_URL}/videos`,
      body: { duration: 1, resolution: '480p', generate_audio: false, model: 'x-ai/grok-imagine-video-1.5-lite', prompt: 'A red fox' },
    })
  })

  it.each(['video', 'imageToVideo'] as const)('sends the image of a %s request as the first frame, as a data URL', (kind) => {
    expect(openRouterClips.request(kind, OPENROUTER_URL, 'm', { prompt: 'It runs', images: [IMAGES[0]], values: { duration: 1 } })).toStrictEqual({
      url: `${OPENROUTER_URL}/videos`,
      body: {
        duration: 1,
        model: 'm',
        prompt: 'It runs',
        frame_images: [{ type: 'image_url', image_url: { url: PNG_URL }, frame_type: 'first_frame' }],
      },
    })
  })

  // `images_as` is no request field. A value that is not `references`
  // (none, or one of an old cache) sends frames.
  it.each([undefined, 'frames', 'other'])('sends a second image as the last frame when the images go as %s', (imagesAs) => {
    const values = { duration: 1, ...(imagesAs !== undefined && { images_as: imagesAs }) }

    expect(openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'It runs', images: IMAGES, values }).body).toStrictEqual({
      duration: 1,
      model: 'm',
      prompt: 'It runs',
      frame_images: [
        { type: 'image_url', image_url: { url: PNG_URL }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: JPEG_URL }, frame_type: 'last_frame' },
      ],
    })
  })

  it('sends every image as a reference, and no frame, when the user chose references', () => {
    const images = [...IMAGES, IMAGES[0]]

    expect(openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'They dance', images, values: { duration: 1, images_as: 'references' } }).body).toStrictEqual({
      duration: 1,
      model: 'm',
      prompt: 'They dance',
      input_references: [PNG_URL, JPEG_URL, PNG_URL].map((url) => ({ type: 'image_url', image_url: { url } })),
    })
  })

  it('sends no images field for references when the request has no image', () => {
    expect(openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'A red fox', images: [], values: { duration: 1, images_as: 'references' } }).body).toStrictEqual({
      duration: 1, model: 'm', prompt: 'A red fox',
    })
  })

  // "frame_images takes precedence", which would drop the clips.
  it('sends the images as references, then the clips by their web addresses in the user\'s order, when a clip goes, even when the user chose frames', () => {
    const clips: InputClipPart[] = [
      { kind: 'video', use: 'reference', url: 'https://cdn.example.com/v.mp4' },
      { kind: 'audio', use: 'reference', url: 'https://cdn.example.com/a.mp3' },
    ]

    expect(openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'They dance', images: IMAGES, clips, values: { duration: 1, images_as: 'frames' } }).body).toStrictEqual({
      duration: 1,
      model: 'm',
      prompt: 'They dance',
      input_references: [
        { type: 'image_url', image_url: { url: PNG_URL } },
        { type: 'image_url', image_url: { url: JPEG_URL } },
        { type: 'video_url', video_url: { url: 'https://cdn.example.com/v.mp4' } },
        { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/a.mp3' } },
      ],
    })
  })

  it('refuses a video request with no length, which would get the default length of OpenRouter', () => {
    expect(thrownError(() => openRouterClips.request('video', OPENROUTER_URL, 'm', { prompt: 'A red fox', images: [], values: { resolution: '480p' } })))
      .toStrictEqual(new ExplainedError(NO_VIDEO_LENGTH_MESSAGE))
  })

  it('has no music request, and tells the user to choose another model', () => {
    expect(thrownError(() => openRouterClips.request('music', OPENROUTER_URL, 'm', { prompt: 'Rain', images: [], values: {} })))
      .toStrictEqual(new ExplainedError('This provider has no music request that Dez can use. Choose another model.'))
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
    ['a job that failed', { status: 'failed', error: 'Content policy violation' }, 'State: failed: Content policy violation'],
    ['a job that expired', { status: 'expired' }, 'State: expired'],
    ['an answer with no state', { id: 'gen-1' }, 'State: none'],
  ])('tells that the provider did not make the clip, with the state of %s', (_name, poll, message) => {
    expect(thrownError(() => job().state(poll))).toStrictEqual(new ClipNotMadeError(message))
  })

  // The toast shows the message.
  it('keeps a key in the error text of a failed job out of the message', () => {
    const failed = { status: 'failed', error: 'Bad header Authorization: Bearer sk-or-v1-abc' }

    expect(() => job().state(failed)).toThrow(/^State: failed: Bad header (?!.*sk-or-v1-abc)/)
  })

  it.each([
    ['an answer with no id', 'video', { status: 'pending' }],
    ['a JSON answer to a speech request', 'tts', { id: 'gen-1' }],
  ] as const)('finds no job in %s', (_name, kind, data) => {
    expect(thrownError(() => openRouterClips.job(kind, OPENROUTER_URL, 'm', data)))
      .toStrictEqual(new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.'))
  })
})

// https://docs.venice.ai/api-reference/endpoint/audio/transcriptions
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription
describe('transcriptions', () => {
  const FILE = { name: 'file', file: { bytes: base64ToBytes(AUDIOS[0]), mediaType: 'audio/mpeg', fileName: 'clip.mp3' } }
  const input = { prompt: 'Write it down', images: [], clips: [clip('audio', 'source', AUDIOS[0])], values: {} }

  it('sends the clip to each format as the file of a form, with the model and no prompt', () => {
    expect([
      MEDIA_FORMATS.venice.texts?.request('transcription', `${VENICE_URL}/`, 'openai/whisper-large-v3', input),
      MEDIA_FORMATS.openrouter.texts?.request('transcription', `${OPENROUTER_URL}/`, 'openai/whisper-1', input),
    ]).toStrictEqual([
      {
        url: `${VENICE_URL}/audio/transcriptions`,
        form: [{ name: 'model', value: 'openai/whisper-large-v3' }, { name: 'response_format', value: 'json' }, FILE],
      },
      { url: `${OPENROUTER_URL}/audio/transcriptions`, form: [{ name: 'model', value: 'openai/whisper-1' }, FILE] },
    ])
  })

  it.each(['venice', 'openrouter'] as const)('reads the text of a %s answer as it is, and an empty text as the transcript of a clip with no speech', (format) => {
    const parse = (data: unknown) => MEDIA_FORMATS[format].texts?.parseResponse('transcription', json(data))

    expect([
      parse({ text: ' Hello there. ', duration: 3 }),
      parse({ text: '', usage: { seconds: 2 } }),
    ]).toStrictEqual([' Hello there. ', ''])
  })

  it.each([
    ['no text', json({ duration: 3 }), 'The answer holds no text.'],
    ['a text that is no string', json({ text: ['Hello'] }), 'The answer holds no text.'],
    ['a body that is not JSON', new TextEncoder().encode('Hello'), 'The answer is not valid JSON.'],
  ])('refuses an answer with %s in each format', (_name, body, message) => {
    expect((['venice', 'openrouter'] as const).map((format) => thrownError(() => MEDIA_FORMATS[format].texts?.parseResponse('transcription', body))))
      .toStrictEqual([new UnusableAnswerError(message), new UnusableAnswerError(message)])
  })
})
