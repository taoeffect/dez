import { byteSizeText } from '../../utils/byteSize'
import { ExplainedError } from '../../utils/errorText'
import { sanitizeErrorText } from '../../utils/protocol/errors'
import { responseContentType, type NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import type { ImageSize } from '../chat/imageDrawing'
import { isImageMediaType } from '../chat/images'
import { trimTrailingSlashes, type MediaApiFormatId } from './config'
import type { InputImageRules } from './clipImages'
import type { ClipTextRules } from './clipText'
import { ClipNotMadeError, UnusableAnswerError } from './errors'
import { generatedBase64Image, generatedImage } from './generatedImages'
import { imageSizeRules, type ImageSizeRules, type InputImageLimits } from './imageSize'
import { isOptionValue, parameterTakes, type ModelParameter, type OptionsParameter, type OptionValue, type ParameterValues, type RangeParameter } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'
import { CLIP_KINDS, isClipKind, type ChatImagePart, type ClipKind, type GeneratedMedia, type ImageKind, type MediaKind } from './types'
import { VENICE_REFERENCE_FIELDS, veniceReferenceBody, veniceReferenceFamily } from './veniceReferences'

// What one media request sends: the user's prompt, the input images as
// bytes, in the user's order, and the value of each parameter of the model
// that has one (`ImageFormat.parameters`, `ClipFormat.parameters`,
// `effectiveParameterValues`).
export interface MediaInput {
  prompt: string
  // The images of an edit, the one image of an upscale, the reference
  // images of a new image, or the images of a video: its frames, the first
  // image the first frame and the second one the last frame, or its
  // references (`InputImageRules.references`). The caller gives a request
  // no more images than the model takes (`MediaFormat.imageRules`, for the
  // values of `values`). A request of a kind that takes no image does not
  // send them.
  images: readonly ChatImagePart[]
  values: ParameterValues
}

// What one clip request sends: a media input (for speech, the prompt is
// the text to speak), and the lyrics of a song when the user wrote some
// (only for a model that takes lyrics, `ClipFormat.textRules`).
export interface ClipInput extends MediaInput {
  lyrics?: string
}

// The URL and the JSON body of one media request: a POST, or a GET when it
// has no body. Provider.mediaApiRequest adds the method and the headers, so
// a format holds no secrets.
export interface MediaWireRequest {
  url: string
  body?: Record<string, unknown>
}

// Where the clip of a finished job is:
// - `url`: at a URL that gives the clip with no header until `expires` (a
//   time in ms). The clip plays from the URL, so its server must answer
//   range requests: a player seeks with them.
// - `download`: in the response to a request of the media API.
// - `fileUrl`: at a URL that gives the clip with no header, and that no
//   player can play from. Dez makes a temp copy of it.
export type ClipLocation =
  | { url: string, mediaType: string, expires: number }
  | { download: MediaWireRequest }
  | { fileUrl: string }

// A clip that the provider makes after its first response.
export interface ClipJob {
  // The provider's id of the job.
  id: string
  // Asks for the job's state. Some providers answer it with the clip's
  // bytes when the job is done.
  poll: MediaWireRequest
  // What the JSON of a 2xx response to `poll` tells. Throws for a job that
  // failed, and for a state that the format does not know.
  state(data: unknown): 'running' | ClipLocation
}

// The image requests of a media API.
export interface ImageFormat {
  // What a request to a model of `kind` can set, as for
  // `ClipFormat.parameters`. Missing: no model of the API has parameters.
  parameters?(kind: ImageKind, entry: unknown, mediaEntry: unknown): ModelParameter[]
  // The name of the file type that a model of `kind` makes, from the same
  // two entries, when it makes only types that Dez does not store
  // (generatedImages.ts), such as `SVG`; undefined when it makes a type
  // that Dez stores, as far as the entries tell. Dez sends such a model no
  // request (`ModelInfo.unstoredOutput`). Missing: every model of the API
  // makes a type that Dez stores.
  unstoredOutput?(kind: ImageKind, entry: unknown, mediaEntry: unknown): string | undefined
  request(kind: ImageKind, baseUrl: string, modelId: string, input: MediaInput): MediaWireRequest
  // The images of a 2xx response to a request of `kind`. Throws when the
  // body holds none.
  parseResponse(kind: ImageKind, head: NativeHttpResponseHead, body: Uint8Array): GeneratedMedia[]
  // The size rules of each input image of a request of a kind, for an API
  // whose docs tell them. They are rules of the request, not of a model.
  inputImageSize?: Readonly<Partial<Record<ImageKind, ImageSizeRules>>>
  // The limits of each input image of a request of a kind that no fit can
  // meet (imageSize.ts), for an API whose docs tell them.
  inputImageLimits?: Readonly<Partial<Record<ImageKind, InputImageLimits>>>
  // Why the API refuses an input image of a request of `kind`, as a
  // sentence for the user; undefined when it takes it. The image is the
  // one that goes, after the fit to `inputImageSize`: `size` is its size
  // (null when it was not decoded), and `byteLength` the length of its
  // file. For a limit of `inputImageLimits`. The text names no model and no
  // message, because a tool can send a request too.
  inputImageProblem?(kind: ImageKind, size: ImageSize | null, byteLength: number): string | undefined
  quote?: ImageQuoteFormat
}

// The price records of an image model, for the price of one request.
export interface ImageQuoteInput {
  // The model's entry in the provider's model list, and in a list of the
  // media API (`MediaFormat.modelLists`); each one undefined when Dez has
  // none.
  entry: unknown
  mediaEntry: unknown
  // The JSON of the 2xx response to `ImageQuoteFormat.recordsRequest`;
  // undefined with no such request.
  records: unknown
}

// What a media API tells about the price of one image request.
export interface ImageQuoteFormat {
  // The request for the price records of a model of `kind`, for an API
  // whose model lists hold no prices. Null: the entries hold them.
  recordsRequest?(kind: ImageKind, baseUrl: string, modelId: string): MediaWireRequest | null
  // The price in USD of one request of `kind` with `values`; undefined
  // when the entries and the records tell no one price for it.
  usd(kind: ImageKind, values: ParameterValues, input: ImageQuoteInput): number | undefined
}

// What a media API tells about the price of one clip before the request.
export interface ClipQuoteFormat {
  // The request that asks for the price of the clip that
  // `ClipFormat.request` with the same values asks for. `entry` is the
  // model's entry in the provider's model list. Null: the API has no such
  // request for the kind or the model; its prices are in its entries then.
  request(kind: ClipKind, baseUrl: string, modelId: string, values: ParameterValues, entry: unknown): MediaWireRequest | null
  // The price in USD in the JSON of a 2xx response to `request`. Throws
  // when it holds none.
  usd(data: unknown): number
}

// The clip requests (speech, music, video) of a media API. A 2xx response
// to `request` is the clip's bytes, or JSON that names a job (`job`).
export interface ClipFormat {
  // What a request to a model of `kind` can set, from the model's entry in
  // the provider's model list (`entry`) and in a list of the media API
  // (`MediaFormat.modelLists`, `mediaEntry`). Each one is undefined when
  // its list does not have the model. The name of a parameter is the name
  // of its request field, but for one that `request` reads itself
  // (OpenRouter's `images_as`).
  parameters(kind: ClipKind, entry: unknown, mediaEntry: unknown): ModelParameter[]
  // What a model of `kind` takes as the text of a request, from the same
  // two entries; undefined when the API tells nothing about it.
  textRules?(kind: ClipKind, entry: unknown, mediaEntry: unknown): ClipTextRules | undefined
  request(kind: ClipKind, baseUrl: string, modelId: string, input: ClipInput): MediaWireRequest
  // The most input images that a model of `kind` takes, when `body` (the
  // JSON of the provider's refusal of a first request with the status
  // `status`, ProviderHttpError.bodyJson) tells that the request had too
  // many; undefined when it tells nothing of the kind. For an API that
  // tells this only in a refusal, not in its model data.
  refusedImages?(kind: ClipKind, status: number, body: unknown): number | undefined
  // The body fields with which a first request of `kind` that the provider
  // refused (the same `status` and `body`) can go once more, when the
  // refusal tells a field value that the model needs; undefined when it
  // tells none. For a fact of a model that its entries do not tell. Only a
  // refusal that costs nothing and a request for the same clip can use
  // this: never a refusal of the images (see `refusedImages`).
  refusalBody?(kind: ClipKind, status: number, body: unknown): Record<string, unknown> | undefined
  // The job that the JSON of a 2xx response to `request` names. Throws when
  // it names none.
  job(kind: ClipKind, baseUrl: string, modelId: string, data: unknown): ClipJob
  quote?: ClipQuoteFormat
  // The size in bits of one sample of the raw PCM audio (`audio/pcm`,
  // pcmAudio.ts) that the API can answer with. A response tells the rate
  // and the channels, but not this. Missing: the API's docs do not tell
  // it, and Dez takes no raw PCM from the API.
  pcmSampleBits?: number
}

// Everything that differs between the media APIs that a provider can speak
// (`mediaApi.format` in config.ts). A format with no `images` makes no
// images, and one with no `clips` makes no clips.
export interface MediaFormat {
  images?: ImageFormat
  clips?: ClipFormat
  // The model lists that only the media API has, for an API whose model
  // data is not all in the provider's model list: requests whose responses
  // are `{ data: [...] }`, with an `id` in each entry. A model is in one
  // list at most (Provider.mediaModelEntries keeps the first entry of an
  // id). Missing: the API has none.
  modelLists?(baseUrl: string): MediaWireRequest[]
  // What a model of `kind` takes as input images, from its entry in the
  // provider's model list (`entry`) and in a list of `modelLists`
  // (`mediaEntry`; each one undefined when its list does not have the
  // model), with the size rules of each image when an entry tells them.
  // Undefined for a model that takes none, as far as the API tells.
  imageRules?(kind: MediaKind, entry: unknown, mediaEntry: unknown): InputImageRules | undefined
}

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new UnusableAnswerError('The image answer is not valid JSON.')
  }
}

// A URL that a player can load: http or https, with no space or line break
// (a media tag is one line).
function isClipUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value)
}

// The texts and numbers of a list in a model entry, each once, in the
// list's order.
function listedValues(list: unknown): OptionValue[] {
  return [...new Set((Array.isArray(list) ? list : []).filter(isOptionValue))]
}

// The parameter of a request field that takes one of `options`; none when
// there is no option. `defaultValue` is its default when it is an option.
function optionsParameter(name: string, label: string, options: OptionValue[], defaultValue?: unknown): ModelParameter[] {
  if (options.length === 0) return []
  const parameter: OptionsParameter = { name, label, options }
  if (parameterTakes(parameter, defaultValue)) parameter.default = defaultValue
  return [parameter]
}

// The step of a speed field. The APIs take any number of the range. A step
// gives the arrows of the settings field a use, and `model_info` a list of
// values that has an end.
const SPEED_STEP = 0.05

// The parameter of a `speed` field (1 is the normal speed) that takes the
// numbers from `min` to `max`; none when they are no range. `defaultValue`
// is its default when the range takes it.
function speedParameter(min: unknown, max: unknown, defaultValue?: unknown): ModelParameter[] {
  if (typeof min !== 'number' || typeof max !== 'number' || !(min > 0) || !(min < max)) return []
  const range: RangeParameter = { name: 'speed', label: 'Speed', min, max, step: SPEED_STEP }
  if (parameterTakes(range, defaultValue)) range.default = defaultValue
  return [range]
}

// The switch of a request field that a model takes only when its entry
// says so (`supported` is true). With no `defaultValue`, a switch that the
// user did not turn on puts no field into the request.
function switchParameter(name: string, label: string, supported: unknown, defaultValue?: boolean): ModelParameter[] {
  if (supported !== true) return []
  return [{ name, label, ...(defaultValue !== undefined && { default: defaultValue }) }]
}

// An input image as a data URL: Dez has no URL that a provider could
// fetch.
function imageDataUrl(image: ChatImagePart): string {
  return `data:${image.mediaType};base64,${image.data}`
}

// The seconds of a length, as a model list writes it: a number (OpenRouter)
// or a text such as `5s` (Venice). NaN for any other entry, such as `auto`.
function lengthSeconds(length: OptionValue): number {
  if (typeof length === 'number') return length > 0 ? length : Number.NaN
  const match = /^(\d+(?:\.\d+)?)s?$/i.exec(length)
  return match ? Number(match[1]) : Number.NaN
}

// The lines of a resolution: names of lines (`480p`, `768P`) and of
// thousands (`2k`, `4K`) count. NaN for a name such as `2x` or
// `true_1080p`, which has no place in the order.
function resolutionLines(resolution: OptionValue): number {
  const match = typeof resolution === 'string' ? /^(\d+)([pk])$/i.exec(resolution) : null
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1000 : 1) : Number.NaN
}

// The parameter of a length or a resolution, from the list of a model
// entry. Its default is the lowest value: Dez shows no price before a
// request, so with no choice a request asks for the cheapest clip that the
// model makes. For one model, the default length and size of a provider
// can cost 5 to 20 times more. The options go from low to high; the values
// that `size` gives no number come last, in the list's order, and are never
// the default.
function lowestFirstParameter(name: string, label: string, list: unknown, size: (value: OptionValue) => number): ModelParameter[] {
  const values = listedValues(list)
  const sized = values.filter((value) => !Number.isNaN(size(value))).sort((a, b) => size(a) - size(b))
  return optionsParameter(name, label, [...sized, ...values.filter((value) => Number.isNaN(size(value)))], sized[0])
}

// The refusal of a video request with no length. A model has no length
// when its entry in the model list tells none, or when the list that tells
// it did not load at a model check and no earlier check knew the model
// (`withKeptClipData` in keptClipData.ts). Only in the second case does a
// new check help, and a format cannot tell the two apart.
export const NO_VIDEO_LENGTH_MESSAGE = 'Dez does not know which lengths this model takes: the provider\'s model list did not tell them. Check the provider again (Settings › Providers, "Check again").'

// The length of a Venice music clip, in seconds: one of the entry's
// `duration_options` when it has them, else each whole second from
// `min_duration` to `max_duration`. A model with neither takes no length.
// The default is the model's own (`default_duration`), not the lowest: the
// lowest is a second or a few, which is no piece of music.
function veniceMusicLength(entry: unknown): ModelParameter[] {
  const spec = (field: string) => valueAtPath(entry, `model_spec.${field}`)
  const name = 'duration_seconds'
  const label = 'Length (seconds)'
  const defaultLength = spec('default_duration')
  const options = listedValues(spec('duration_options'))
  if (options.length > 0) return optionsParameter(name, label, options, defaultLength)

  const min = spec('min_duration')
  const max = spec('max_duration')
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(min) || !Number.isInteger(max) || min > max) return []
  const range: RangeParameter = { name, label, min, max }
  if (parameterTakes(range, defaultLength)) range.default = defaultLength
  return [range]
}

// A count of characters of a Venice entry; undefined for a value that is
// no count.
function veniceCharacterCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

// What a Venice music model takes as text, from its entry: the least and
// the most characters of the prompt, and whether it takes lyrics
// (`lyrics_prompt`). A limit that is no count is not known.
function veniceMusicText(entry: unknown): ClipTextRules | undefined {
  const spec = (field: string) => valueAtPath(entry, `model_spec.${field}`)
  const count = (field: string) => veniceCharacterCount(spec(field))
  const rules: ClipTextRules = {}
  const minPromptLength = count('min_prompt_length')
  const maxPromptLength = count('prompt_character_limit')
  const maxLyricsLength = count('lyrics_character_limit')
  if (minPromptLength !== undefined) rules.minPromptLength = minPromptLength
  if (maxPromptLength !== undefined) rules.maxPromptLength = maxPromptLength
  const required = spec('lyrics_required') === true
  if (required || spec('supports_lyrics') === true) {
    rules.lyrics = { required, ...(maxLyricsLength !== undefined && { maxLength: maxLyricsLength }) }
  }
  return Object.keys(rules).length > 0 ? rules : undefined
}

// The speech formats that Dez asks Venice for: the ones that it has a file
// type for (mediaFiles.ts). A model can also list `pcm`, which is samples
// with no file format; the docs do not tell the size of its samples, so Dez
// cannot make a file of it (`pcmSampleBits`).
const VENICE_SPEECH_FORMATS: ReadonlySet<OptionValue> = new Set(['mp3', 'wav', 'flac', 'aac', 'opus'])

// The limits of the input image of a Venice upscale ("final dimensions
// after scaling must not exceed 16777216 pixels. File size must be less
// than 25MB"; the guide: "25 MB or smaller"). The server lowers the scale
// of an image that would get larger than the pixel cap, so only an image
// that is already at the cap cannot go. The docs do not tell which "MB",
// so Dez refuses only a file that is too large in both readings; one
// between the two gets the provider's answer. The text of the refusal
// uses the same unit as `byteSizeText`.
// https://docs.venice.ai/api-reference/endpoint/image/upscale
// https://docs.venice.ai/guides/media/image-upscaling
const VENICE_UPSCALE_LIMITS = { pixelsBelow: 16_777_216, maxBytes: 25 * 1024 ** 2 } as const satisfies InputImageLimits

// The price key of each Venice image kind with a price table, in the
// model entry (`model_spec.pricing`), and the keys of the table that are
// prices of other requests (every image model repeats the upscale table).
// A table with any other key (`resolutions`, `quality`, `inputImages`)
// has a price that depends on a field that Dez does not send, or on the
// input images, so it tells no one price of a request. The entry of an
// upscale model has the price of each scale (`upscale` → `2x`, `4x`).
// https://docs.venice.ai/pricing
const VENICE_IMAGE_PRICES: Readonly<Record<Exclude<ImageKind, 'upscale'>, { key: string, others: readonly string[] }>> = {
  image: { key: 'generation', others: ['upscale', 'inpaint'] },
  imageEdit: { key: 'inpaint', others: ['upscale', 'generation'] },
}

// The USD of one price of a Venice price table (`{ usd, diem }`).
function veniceUsd(price: unknown): number | undefined {
  const usd = valueAtPath(price, 'usd')
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined
}

// The Venice media API (https://docs.venice.ai/api-reference).
const veniceFormat: MediaFormat = {
  // The user's choice for every image: no Venice watermark (it is on by
  // default, at the bottom left), and safe mode off (on by default: Venice
  // blurs images that it classes as adult content). These are fixed values,
  // not settings.
  images: {
    // upscale: the two fields are rules of the request, which every model
    // of the kind takes (one model, `upscaler`, 2026-11-11); its entry
    // tells neither. `scale`: "Must be either 2 or 4" (other numbers are
    // billed at the 4x rate; the prices of the entry are `2x` and `4x`).
    // `creativity`: "0–0.02, default 0.01"; the API takes any number of
    // the range, and the step gives the field's arrows a use.
    // https://docs.venice.ai/api-reference/endpoint/image/upscale
    // https://docs.venice.ai/guides/media/image-upscaling
    parameters: (kind) => {
      if (kind !== 'upscale') return []
      return [
        { name: 'scale', label: 'Scale', options: [2, 4], default: 2 },
        { name: 'creativity', label: 'Creativity', min: 0, max: 0.02, step: 0.001, default: 0.01 },
      ]
    },
    request: (kind, baseUrl, modelId, { prompt, images, values }) => {
      const base = trimTrailingSlashes(baseUrl)
      switch (kind) {
        case 'image':
          // WebP is Venice's default; it is set so that the files keep one
          // type if the default changes.
          return { url: `${base}/image/generate`, body: { model: modelId, prompt, format: 'webp', hide_watermark: true, safe_mode: false } }
        case 'imageEdit':
          // This endpoint names the model `modelId`, not `model`. The first
          // image is the one to edit; the others are references. Each one
          // goes as a data URL, as Dez has no URL that a provider could
          // fetch. It has `safe_mode` but no `hide_watermark`, and its
          // schema allows no field that it does not name, so only
          // `safe_mode` goes.
          // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
          return {
            url: `${base}/image/multi-edit`,
            body: { modelId, prompt, images: images.map(imageDataUrl), safe_mode: false },
          }
        case 'upscale':
          // The schema has no prompt and no model field: the endpoint has
          // one model. (The curl of the model page sends `"model":
          // "upscaler"`; that looks like the template of the page, so it
          // does not go.) The image goes as bare base64, as in the docs'
          // examples. generateMedia refuses a request with no image before
          // this.
          // https://docs.venice.ai/api-reference/endpoint/image/upscale
          // https://docs.venice.ai/models/upscaler
          return { url: `${base}/image/upscale`, body: { ...values, image: images[0].data } }
      }
    },
    // `/image/generate` answers JSON `{ images: [base64, …] }` (no URL
    // form), and the edit and upscale endpoints answer the bytes of one
    // image, with no JSON form ("The edit endpoints have no
    // `response_format` parameter"; the upscale answer is `image/png`).
    // https://docs.venice.ai/api-reference/endpoint/image/generate
    // https://docs.venice.ai/guides/media/image-editing
    // https://docs.venice.ai/api-reference/endpoint/image/upscale
    parseResponse: (_kind, head, body) => {
      if (!responseContentType(head).startsWith('application/json')) return [generatedImage(body)]

      const data = jsonBody(body)
      const images = isRecord(data) && Array.isArray(data.images) ? data.images : []
      if (images.length === 0) throw new UnusableAnswerError('The answer holds no image.')
      return images.map((image) => generatedBase64Image(image))
    },
    // edit: "For edit endpoints, images must be at least 256×256 pixels,
    // and the total pixel count must not exceed 33,177,600 (8K
    // resolution)." The API reference says "at least 65536 pixels" (256 ×
    // 256) in place of the first part; an image whose sides are both 256 or
    // more passes both readings.
    // upscale: the same two readings of the least size ("Must be at least
    // 256×256 pixels"; the reference: "at least 65536 pixels"). The most
    // pixels are not a fit: a smaller copy would lose the detail that the
    // user wants larger (`inputImageProblem`).
    // https://docs.venice.ai/guides/media/image-editing
    // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
    // https://docs.venice.ai/guides/media/image-upscaling
    inputImageSize: {
      imageEdit: { minShortSide: 256, maxPixels: 33_177_600 },
      upscale: { minShortSide: 256 },
    },
    inputImageLimits: { upscale: VENICE_UPSCALE_LIMITS },
    inputImageProblem: (kind, size, byteLength) => {
      if (kind !== 'upscale') return undefined
      if (size && size.width * size.height >= VENICE_UPSCALE_LIMITS.pixelsBelow) {
        return `The image has ${size.width} × ${size.height} pixels, and an upscale makes images of at most 16,777,216 pixels (4096 × 4096), so this image cannot get larger. Use an image with fewer pixels.`
      }
      if (byteLength > VENICE_UPSCALE_LIMITS.maxBytes) {
        return `The image file has ${byteSizeText(byteLength)}, and the upscale API takes files of at most 25 MB. Use a smaller file of the image, such as a JPEG.`
      }
      return undefined
    },
    quote: {
      usd: (kind, values, { entry }) => {
        const pricing = valueAtPath(entry, 'model_spec.pricing')
        if (!isRecord(pricing)) return undefined
        if (kind === 'upscale') return veniceUsd(valueAtPath(pricing, `upscale.${String(values.scale)}x`))
        const { key, others } = VENICE_IMAGE_PRICES[kind]
        if (Object.keys(pricing).some((name) => name !== key && !others.includes(name))) return undefined
        return veniceUsd(pricing[key])
      },
    },
  },
  clips: {
    // tts: the entry names no default voice, and each model has its own.
    // The format is a parameter so that every request names it, with the
    // model's own default: `tts-kokoro` answers a request with no
    // `response_format` in WAV with the header `audio/mpeg`, and Dez names
    // a clip's file after that header. With the format in the request, the
    // header agrees with the audio (checked live, 2026-11-10).
    // video: the first aspect ratio is the model's main one (`16:9` for
    // most). A model takes only the fields that its entry lists values
    // for: some list no resolution, and half of the image-to-video models
    // list no aspect ratio (the API then refuses the field, checked
    // 2026-11-11). `audio` is a field only of the models with
    // `audio_configurable` (the others refuse it). The switch is on by
    // default, as the API's own default is, so that it shows what a
    // request does; a video with no sound costs less for some models.
    // music: every field but the prompt and the lyrics is a parameter, and
    // each one only when the entry says that the model takes it
    // (`supports_…`, or a list or a range of values): the API refuses a
    // field that the model does not take. Four models have no length
    // field in their entries (`minimax-music-v2`, 2026-11-10), so they have
    // no length to set. There is no format parameter (the queue request
    // has no format field) and no language parameter (the API gives no
    // list of the languages).
    parameters: (kind, entry) => {
      const spec = (field: string) => valueAtPath(entry, `model_spec.${field}`)
      switch (kind) {
        case 'tts': {
          const formats = listedValues(spec('supported_formats')).filter((format) => VENICE_SPEECH_FORMATS.has(format))
          return [
            ...optionsParameter('voice', 'Voice', listedValues(spec('voices'))),
            ...optionsParameter('response_format', 'Format', formats, spec('default_format')),
            // The speech request takes 0.25 to 4 for every model (its
            // schema); the entries hold no speed. No default: with no
            // value, the API's own (1) applies.
            ...speedParameter(0.25, 4),
          ]
        }
        case 'music':
          return [
            ...veniceMusicLength(entry),
            ...optionsParameter('voice', 'Voice', listedValues(spec('voices')), spec('default_voice')),
            ...(spec('supports_speed') === true ? speedParameter(spec('min_speed'), spec('max_speed'), spec('default_speed')) : []),
            ...switchParameter('force_instrumental', 'Instrumental', spec('supports_force_instrumental')),
            // The model writes the lyrics itself.
            ...switchParameter('lyrics_optimizer', 'Lyrics from the prompt', spec('supports_lyrics_optimizer')),
            // The end of the clip goes over into its start with no seam.
            ...switchParameter('loop', 'Loop', spec('supports_loop')),
          ]
        case 'video':
        case 'imageToVideo': {
          const aspectRatios = listedValues(spec('constraints.aspect_ratios'))
          return [
            ...lowestFirstParameter('duration', 'Length', spec('constraints.durations'), lengthSeconds),
            ...lowestFirstParameter('resolution', 'Resolution', spec('constraints.resolutions'), resolutionLines),
            ...optionsParameter('aspect_ratio', 'Aspect ratio', aspectRatios, aspectRatios[0]),
            ...switchParameter('audio', 'Audio', spec('constraints.audio_configurable'), true),
          ]
        }
      }
    },
    // tts: 1 to 4096 characters for every model (the speech request's
    // schema). music: the limits are in the entry. video: some entries tell
    // the most characters of the prompt
    // (`constraints.prompt_character_limit`, 1000 to 26000); a longer text
    // gets a 400 from the API, so Dez refuses it first. A limit of 0 is
    // not a limit that a model can have.
    textRules: (kind, entry) => {
      switch (kind) {
        case 'tts':
          return { minPromptLength: 1, maxPromptLength: 4096 }
        case 'music':
          return veniceMusicText(entry)
        case 'video':
        case 'imageToVideo': {
          const maxPromptLength = veniceCharacterCount(valueAtPath(entry, 'model_spec.constraints.prompt_character_limit'))
          return maxPromptLength ? { maxPromptLength } : undefined
        }
      }
    },
    // The schemas allow no field that they do not name, and a field that
    // the model does not take is an error. The values are the fields of the
    // model's own parameters, so they go as they are.
    request: (kind, baseUrl, modelId, { prompt, images, lyrics, values }) => {
      const base = trimTrailingSlashes(baseUrl)
      switch (kind) {
        case 'tts':
          // The answer is the audio, in the format that `response_format`
          // names (see `parameters`).
          // https://docs.venice.ai/api-reference/endpoint/audio/speech
          return { url: `${base}/audio/speech`, body: { ...values, model: modelId, input: prompt } }
        case 'music': {
          // `lyrics_optimizer` tells the model to write the lyrics, and the
          // API then takes no `lyrics_prompt` ("lyrics_prompt must be empty
          // when this is true"). Lyrics that the user wrote are the newer
          // and the clearer wish, so the switch does not go with them.
          // https://docs.venice.ai/api-reference/endpoint/audio/queue
          const fields = lyrics === undefined ? values : Object.fromEntries(Object.entries(values).filter(([name]) => name !== 'lyrics_optimizer'))
          return { url: `${base}/audio/queue`, body: { ...fields, model: modelId, prompt, ...(lyrics !== undefined && { lyrics_prompt: lyrics }) } }
        }
        case 'video':
        case 'imageToVideo': {
          // `duration` has no default: a request with none gets a 400
          // (checked live, 2026-11-10), and each model takes only the
          // values of its own entry. The images are the first and the
          // last frame, or the references of a reference-to-video model
          // (veniceReferences.ts), each as a data URL ("a URL (http/https)
          // or a data URL").
          // https://docs.venice.ai/api-reference/endpoint/video/queue
          if (values.duration === undefined) throw new ExplainedError(NO_VIDEO_LENGTH_MESSAGE)
          const urls = images.map(imageDataUrl)
          const family = veniceReferenceFamily(modelId)
          const [firstFrame, lastFrame] = urls
          return {
            url: `${base}/video/queue`,
            body: {
              ...values,
              model: modelId,
              prompt,
              ...(family && urls.length > 0 && veniceReferenceBody(family, urls)),
              ...(!family && firstFrame !== undefined && { image_url: firstFrame }),
              ...(!family && lastFrame !== undefined && { end_image_url: lastFrame }),
            },
          }
        }
      }
    },
    // A model that takes no last frame refuses `end_image_url` with a 400
    // whose `details` (zod's error format: one entry per field) name the
    // field: "This model does not support end_image_url". A
    // reference-to-video model refuses more references than it takes in
    // the same way: "reference_image_urls must have at most 7 images",
    // "image_references must have at most 5 entries", "elements must have
    // at most 4 items". Those are validation errors, so the request cost
    // nothing (checked live, 2026-11-11). No field of an entry tells the
    // last frame, and the counts of veniceReferences.ts can get old (see
    // `imageRules`).
    refusedImages: (kind, status, body) => {
      if (kind !== 'imageToVideo' || status !== 400) return undefined
      const errors = (field: string) => {
        const texts = valueAtPath(body, `details.${field}._errors`)
        return Array.isArray(texts) ? texts.filter((text): text is string => typeof text === 'string') : []
      }
      if (errors('end_image_url').some((text) => text.includes('does not support'))) return 1
      for (const text of VENICE_REFERENCE_FIELDS.flatMap(errors)) {
        const most = /must have at most (\d+)/.exec(text)
        if (most && Number(most[1]) > 0) return Number(most[1])
      }
      return undefined
    },
    // The queue endpoints answer `{ queue_id, … }`. Venice takes the money
    // at this time and has no list of jobs, so the id is the only way back
    // to the clip. The retrieve endpoint answers JSON `{ status }` while the
    // job runs, and then the clip's bytes. A video model that stores its
    // clips at Venice also gives a `download_url` here (good for 24 hours,
    // with no header); its retrieve then always answers JSON, and
    // `COMPLETED` means that the URL has the clip. That URL is a `fileUrl`
    // and not a `url`: its server answers a range request with the whole
    // file (seen 2026-11-10), and a seek in the player then fails with a
    // network error.
    // `delete_media_on_completion` is never sent: a download that breaks
    // would lose a paid clip.
    // https://docs.venice.ai/api-reference/endpoint/audio/retrieve
    // https://docs.venice.ai/api-reference/endpoint/video/retrieve
    job: (kind, baseUrl, modelId, data) => {
      const queueId = isRecord(data) ? data.queue_id : undefined
      if (kind === 'tts' || typeof queueId !== 'string' || queueId === '') throw new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.')
      const downloadUrl = isRecord(data) && isClipUrl(data.download_url) ? data.download_url : null
      return {
        id: queueId,
        poll: {
          url: `${trimTrailingSlashes(baseUrl)}/${CLIP_KINDS[kind]}/retrieve`,
          body: { model: modelId, queue_id: queueId },
        },
        state: (poll) => {
          const status = isRecord(poll) ? poll.status : undefined
          if (status === 'QUEUED' || status === 'PROCESSING') return 'running'
          // A state that is new, or that ends the job with no clip.
          if (status !== 'COMPLETED') throw new ClipNotMadeError(`State: ${typeof status === 'string' ? sanitizeErrorText(status, 40) : 'none'}`)
          if (downloadUrl === null) throw new UnusableAnswerError('The job is done, and its answer holds no clip and no download URL.')
          return { fileUrl: downloadUrl }
        },
      }
    },
    // The quote endpoints are free and answer `{ quote }`, a price in USD.
    // A Venice video entry holds no price, so the quote is the only source
    // of it. The schemas allow no field that they do not name.
    // https://docs.venice.ai/api-reference/endpoint/video/quote
    // https://docs.venice.ai/api-reference/endpoint/audio/quote
    quote: {
      request: (kind, baseUrl, modelId, values, entry) => {
        const base = trimTrailingSlashes(baseUrl)
        switch (kind) {
          case 'tts':
            // The price is by the text's length; the entry holds it.
            return null
          case 'music':
            // A model with a price by the text's length gets a quote only
            // with the count of the characters, which no one knows before
            // the request has its text.
            if (valueAtPath(entry, 'model_spec.pricing.per_thousand_characters') !== undefined) return null
            return {
              url: `${base}/audio/quote`,
              body: { model: modelId, ...(values.duration_seconds !== undefined && { duration_seconds: values.duration_seconds }) },
            }
          case 'video':
          case 'imageToVideo':
            // The price does not depend on the input images, and the
            // schema has no field for them.
            return { url: `${base}/video/quote`, body: { ...values, model: modelId } }
        }
      },
      usd: (data) => {
        const quote = isRecord(data) ? data.quote : undefined
        if (typeof quote !== 'number' || !Number.isFinite(quote)) throw new UnusableAnswerError('The answer holds no price.')
        return quote
      },
    },
  },
  // edit: the first image is the one to edit, and the others are
  // references. "The maximum number of input images is model-specific.
  // Read `model_spec.constraints.maxInputImages` … When the field is
  // absent, the cap is 3, or 1 when `combineImages` is `false`."
  // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
  // video: an image-to-video request takes a first frame (`image_url`)
  // and a last frame (`end_image_url`). No field of an entry tells which
  // models take the last frame; one that takes none refuses the request
  // (`refusedImages`). A text-to-video model takes no image. A
  // reference-to-video model takes references in place of frames, as many
  // as its family takes, and its prompt names them (veniceReferences.ts).
  // Some video entries tell the size that an image must have
  // (`reference_image_…`): the least length of its shorter side, and the
  // limits of width / height, which the image must be between ("Image
  // aspect ratio (W / H): exclusive (0.4, 2.5)"). The API refuses an
  // image outside them with a 400; the Wan 3.0 models scale a small
  // image up themselves, which gives the same image.
  // https://docs.venice.ai/guides/media/seedance-2-0
  // https://docs.venice.ai/guides/media/wan-3-0
  imageRules: (kind, entry) => {
    const constraint = (field: string) => valueAtPath(entry, `model_spec.constraints.${field}`)
    if (kind === 'imageEdit') {
      const maxImages = constraint('maxInputImages')
      if (typeof maxImages === 'number' && Number.isInteger(maxImages) && maxImages > 0) return { maxImages }
      return { maxImages: constraint('combineImages') === false ? 1 : 3 }
    }
    if (kind !== 'imageToVideo') return undefined
    const size = imageSizeRules({
      minShortSide: constraint('reference_image_min_short_side_pixels'),
      minAspectRatio: constraint('reference_image_min_aspect_ratio'),
      maxAspectRatio: constraint('reference_image_max_aspect_ratio'),
    })
    const id = valueAtPath(entry, 'id')
    const family = typeof id === 'string' ? veniceReferenceFamily(id) : undefined
    if (family) return { maxImages: family.maxImages, references: { promptName: family.promptName }, ...(size && { size }) }
    return { maxImages: 2, ...(size && { size }) }
  },
}

// The frames of a video that an OpenRouter request can give an image for
// (`frame_type`), in the order of the input images.
const OPENROUTER_FRAMES = ['first_frame', 'last_frame'] as const

// The most reference images of one OpenRouter image request: the request
// schema caps `input_references` at 16 (`maxItems`), and the image list
// tells a higher count (20) for some models (2026-11-11).
// https://openrouter.ai/docs/api/api-reference/images/generate-an-image
const OPENROUTER_MAX_REFERENCES = 16

// The parameter of an OpenRouter video model that tells how the images of
// a request go: as frames of the video (`frame_images`), or as references
// (`input_references`), which the model uses for the look of the video
// ("Use frame_images when you need exact frame control"). The request
// reads it and sends it as no field. The video list tells which models
// take frames (`supported_frame_images`) and nothing of references, which
// every video model takes ("Image references are supported by all
// providers").
// https://openrouter.ai/docs/cookbook/video-generation/reference-to-video
// https://openrouter.ai/docs/api/api-reference/video-generation/create-videos
const OPENROUTER_IMAGES_AS = 'images_as'
const OPENROUTER_AS_FRAMES = 'frames'
const OPENROUTER_AS_REFERENCES = 'references'

// The frames of a video that an OpenRouter model takes an image for, in the
// order of the input images: a last frame counts only with a first one.
function openRouterFrameCount(mediaEntry: unknown): number {
  const frames = listedValues(valueAtPath(mediaEntry, 'supported_frame_images'))
  const firstMissing = OPENROUTER_FRAMES.findIndex((frame) => !frames.includes(frame))
  return firstMissing === -1 ? OPENROUTER_FRAMES.length : firstMissing
}

// The values of the request field `name` that an entry of OpenRouter's
// image list tells in its `supported_parameters`: the `values` of an
// `enum` descriptor. A `range` descriptor gives none, and so does a
// `boolean` one, which tells only that the model takes the field with any
// value (`seed`, `size`), not that the field is a switch.
// https://openrouter.ai/docs/guides/overview/multimodal/image-generation
function openRouterImageOptions(mediaEntry: unknown, name: string): OptionValue[] {
  return listedValues(valueAtPath(mediaEntry, `supported_parameters.${name}.values`))
}

// Whether an `output_format` value of OpenRouter's image list names a type
// that Dez stores (`png`, `jpeg`, `webp`, `gif`; not `svg`).
function isStoredImageFormat(format: OptionValue): boolean {
  return typeof format === 'string' && isImageMediaType(`image/${format.toLowerCase()}`)
}

// The reference images that an OpenRouter image model takes: the range of
// `input_references` in its entry of the image list (`{ type: 'range',
// min, max }`, a count of images). A model with no such field takes none
// (`meta/muse-image` reads images by its input modalities, but its entry
// has no `input_references`, 2026-11-11), and a `min` of 1 (`krea/k3-edit`,
// the Recraft styles models) tells that it makes nothing without one.
function openRouterReferenceRules(mediaEntry: unknown): InputImageRules | undefined {
  const range = valueAtPath(mediaEntry, 'supported_parameters.input_references')
  const max = valueAtPath(range, 'max')
  const min = valueAtPath(range, 'min')
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return undefined
  const maxImages = Math.min(max, OPENROUTER_MAX_REFERENCES)
  const minImages = typeof min === 'number' && Number.isInteger(min) && min >= 1 ? Math.min(min, maxImages) : undefined
  return { maxImages, ...(minImages !== undefined && { minImages }) }
}

// The price in USD of one OpenRouter image request with `values`, from the
// price records of the model (`records`: the answer to `GET
// /images/models/<id>/endpoints`, `{ endpoints: [{ pricing: [{ billable,
// unit, cost_usd, variant? }] }] }`, checked live 2026-11-11; the image
// list has no prices). A request makes one image (Dez never sends `n`), so
// the records tell one price only when they are plain: each endpoint (a
// provider that serves the model) has the same records, each record that
// costs something is the price of one output image, and each variant is a
// resolution of the model in lower case (`1k` for `1K`). Any other record
// (a price per token or per megapixel, a price of the input images, a
// variant such as `high_resolution`) gives a price that depends on what
// the model does with the request. Of plain records, the price is the one
// that every resolution has, else the record of the request's resolution,
// else the record with no variant (the one of the resolutions that have
// no record of their own).
function openRouterImageUsd(values: ParameterValues, mediaEntry: unknown, records: unknown): number | undefined {
  const endpoints = valueAtPath(records, 'endpoints')
  if (!Array.isArray(endpoints) || endpoints.length === 0) return undefined
  const tables = endpoints.map((endpoint) => JSON.stringify(valueAtPath(endpoint, 'pricing') ?? null))
  if (tables.some((table) => table !== tables[0])) return undefined
  const pricing = valueAtPath(endpoints[0], 'pricing')
  if (!Array.isArray(pricing)) return undefined

  const resolutions = openRouterImageOptions(mediaEntry, 'resolution').map((resolution) => String(resolution).toLowerCase())
  // Price by variant; the key `undefined` is the record with no variant.
  const prices = new Map<string | undefined, number>()
  for (const record of pricing) {
    const cost = valueAtPath(record, 'cost_usd')
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined
    if (valueAtPath(record, 'billable') !== 'output_image' || valueAtPath(record, 'unit') !== 'image') {
      if (cost > 0) return undefined
      continue
    }
    const variant = valueAtPath(record, 'variant')
    if (variant !== undefined && (typeof variant !== 'string' || !resolutions.includes(variant))) return undefined
    if (prices.has(variant)) return undefined
    prices.set(variant, cost)
  }
  const costs = new Set(prices.values())
  if (costs.size === 1) return [...costs][0]
  const resolution = values.resolution
  return (resolution === undefined ? undefined : prices.get(String(resolution).toLowerCase())) ?? prices.get(undefined)
}

// The OpenRouter image, speech, and video APIs. Its image-only models
// answer only through the image API (`/images`); its image + text models
// answer through chat (`imageOutputBody` in builtins.ts), and so do its
// music models.
const openRouterFormat: MediaFormat = {
  // `POST /images` makes a new image from the prompt, with the input
  // images as references (`input_references`, each one a data URL, as Dez
  // has no URL that a provider could fetch). The fields that a model takes
  // are in its entry of the image list (`supported_parameters`). Of those,
  // Dez sends only the ones that change the image that the user gets
  // (`parameters`); never `n` (each image costs), `size` (a free text
  // that the API refuses with `resolution` or `aspect_ratio`), `seed` (a
  // free number, for which Dez has no parameter type), `background`
  // (`transparent` fails with `jpeg`), or `output_compression`. A failed
  // image costs nothing ("all-or-nothing").
  // https://openrouter.ai/docs/guides/overview/multimodal/image-generation
  // https://openrouter.ai/docs/api/api-reference/images/generate-an-image
  images: {
    // No default for a field that a model takes from a list: the model's
    // own default applies. The one exception: `output_format` holds only
    // the types that Dez stores, and a model whose list also holds another
    // type gets the first stored type, so that it never makes the other
    // one.
    parameters: (kind, _entry, mediaEntry) => {
      if (kind === 'upscale') return []
      const formats = openRouterImageOptions(mediaEntry, 'output_format')
      const storedFormats = formats.filter(isStoredImageFormat)
      return [
        ...optionsParameter('resolution', 'Resolution', openRouterImageOptions(mediaEntry, 'resolution')),
        ...optionsParameter('aspect_ratio', 'Aspect ratio', openRouterImageOptions(mediaEntry, 'aspect_ratio')),
        ...optionsParameter('quality', 'Quality', openRouterImageOptions(mediaEntry, 'quality')),
        ...optionsParameter('output_format', 'Format', storedFormats, storedFormats.length < formats.length ? storedFormats[0] : undefined),
      ]
    },
    // The Recraft vector models list only `svg` (2026-11-11). The answer
    // would be an SVG file, which Dez does not store, at the full price.
    unstoredOutput: (kind, _entry, mediaEntry) => {
      if (kind === 'upscale') return undefined
      const formats = openRouterImageOptions(mediaEntry, 'output_format')
      if (formats.length === 0 || formats.some(isStoredImageFormat)) return undefined
      return new Intl.ListFormat('en', { type: 'disjunction' }).format(formats.map((format) => String(format).toUpperCase()))
    },
    request: (kind, baseUrl, modelId, { prompt, images, values }) => {
      if (kind === 'upscale') throw new ExplainedError('This provider has no upscale request that Dez can use. Choose another model.')
      return {
        url: `${trimTrailingSlashes(baseUrl)}/images`,
        body: {
          ...values,
          model: modelId,
          prompt,
          ...(images.length > 0 && {
            input_references: images.map((image) => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })),
          }),
        },
      }
    },
    // The answer is JSON `{ data: [{ b64_json, media_type }], usage }`,
    // one entry for each image (a request asks for one).
    parseResponse: (_kind, _head, body) => {
      const data = jsonBody(body)
      const images = isRecord(data) && Array.isArray(data.data) ? data.data : []
      if (images.length === 0) throw new UnusableAnswerError('The answer holds no image.')
      return images.map((image) => generatedBase64Image(isRecord(image) ? image.b64_json : undefined))
    },
    quote: {
      recordsRequest: (kind, baseUrl, modelId) => {
        if (kind === 'upscale') return null
        const path = modelId.split('/').map(encodeURIComponent).join('/')
        return { url: `${trimTrailingSlashes(baseUrl)}/images/models/${path}/endpoints` }
      },
      usd: (_kind, values, { mediaEntry, records }) => openRouterImageUsd(values, mediaEntry, records),
    },
  },
  // The resolutions, aspect ratios, reference images, and file types of an
  // image model are only in the list of the image API, and the lengths,
  // resolutions, and prices of a video model only in the list of the video
  // API. A model is in one of them at most.
  modelLists: (baseUrl) => {
    const base = trimTrailingSlashes(baseUrl)
    return [{ url: `${base}/images/models` }, { url: `${base}/videos/models` }]
  },
  clips: {
    parameters: (kind, entry, mediaEntry) => {
      switch (kind) {
        case 'tts': {
          // A request with no `voice` goes only to the providers that have
          // a default voice, so the first voice is the default.
          const voices = listedValues(valueAtPath(entry, 'supported_voices'))
          return optionsParameter('voice', 'Voice', voices, voices[0])
        }
        case 'video':
        case 'imageToVideo': {
          // Frames by default, as before the parameter came; a model that
          // takes no frame has only references, so that the user sees it. A
          // model that the list does not have gets none, as for the other
          // parameters, so that its kept data stays (keptClipData.ts).
          const imagesAs = !isRecord(mediaEntry)
            ? []
            : openRouterFrameCount(mediaEntry) > 0 ? [OPENROUTER_AS_FRAMES, OPENROUTER_AS_REFERENCES] : [OPENROUTER_AS_REFERENCES]
          return [
            ...lowestFirstParameter('duration', 'Length (seconds)', valueAtPath(mediaEntry, 'supported_durations'), lengthSeconds),
            ...lowestFirstParameter('resolution', 'Resolution', valueAtPath(mediaEntry, 'supported_resolutions'), resolutionLines),
            // No default: the model's own aspect ratio applies.
            ...optionsParameter('aspect_ratio', 'Aspect ratio', listedValues(valueAtPath(mediaEntry, 'supported_aspect_ratios'))),
            // `generate_audio` is true in the entry of a model that can
            // make sound, and a request with no field then gets sound
            // ("Defaults to the endpoint's generate_audio capability
            // flag"). So the switch is on by default, as for Venice.
            ...switchParameter('generate_audio', 'Audio', valueAtPath(mediaEntry, 'generate_audio'), true),
            ...optionsParameter(OPENROUTER_IMAGES_AS, 'Images as', imagesAs, imagesAs[0]),
          ]
        }
        case 'music':
          return []
      }
    },
    request: (kind, baseUrl, modelId, { prompt, images, values }) => {
      const base = trimTrailingSlashes(baseUrl)
      switch (kind) {
        case 'tts':
          // The answer is the audio. The default format is raw PCM, which
          // no player plays, so the request asks for mp3. A few models make
          // only PCM (Gemini TTS, HeyGen Voice) and answer 400 to this; no
          // field of a model entry tells which, so the provider's config
          // names them and gives them `pcm` in place of `mp3`
          // (`mediaApi.modelRequestBodies`), and the refusal of a new one
          // sends the request again with `pcm` (`refusalBody`).
          // https://openrouter.ai/docs/guides/overview/multimodal/tts
          return { url: `${base}/audio/speech`, body: { ...values, model: modelId, input: prompt, response_format: 'mp3' } }
        case 'video':
        case 'imageToVideo': {
          // A request with no length gets the provider's default length,
          // which can cost many times the shortest one. So a model whose
          // lengths Dez does not know (the video list does not have it, or
          // the list did not load) gets no request.
          // The images are frames of the video (`frame_images`) or
          // references (`input_references`), as the user chose
          // (OPENROUTER_IMAGES_AS), each as a data URL; never both. Any
          // value but `references` (a cache from before the parameter) sends
          // frames, which the model's image rules then count.
          // https://openrouter.ai/docs/guides/overview/multimodal/video-generation
          // https://openrouter.ai/docs/cookbook/video-generation/image-to-video
          // https://openrouter.ai/docs/cookbook/video-generation/reference-to-video
          const { [OPENROUTER_IMAGES_AS]: imagesAs, ...fields } = values
          if (fields.duration === undefined) throw new ExplainedError(NO_VIDEO_LENGTH_MESSAGE)
          const imageUrls = images.map((image) => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } }))
          return {
            url: `${base}/videos`,
            body: {
              ...fields,
              model: modelId,
              prompt,
              ...(imageUrls.length > 0 && (imagesAs === OPENROUTER_AS_REFERENCES
                ? { input_references: imageUrls }
                : { frame_images: OPENROUTER_FRAMES.slice(0, imageUrls.length).map((frame, index) => ({ ...imageUrls[index], frame_type: frame })) })),
            },
          }
        }
        case 'music':
          throw new ExplainedError('This provider has no music request that Dez can use. Choose another model.')
      }
    },
    // A speech model that makes only PCM refuses mp3 with a 400 that names
    // the field and its value: "HeyGen Voice only supports response_format
    // \"pcm\"." (seen by the user, 2026-11). A refusal costs nothing, and
    // the request with `pcm` asks for the same speech.
    // https://openrouter.ai/docs/guides/overview/multimodal/tts
    refusalBody: (kind, status, body) => {
      const message = valueAtPath(body, 'error.message')
      const pcmOnly = kind === 'tts' && status === 400 && typeof message === 'string' && message.includes('response_format') && message.includes('"pcm"')
      return pcmOnly ? { response_format: 'pcm' } : undefined
    },
    // `POST /videos` answers `{ id, polling_url, status }`. The poll and
    // content URLs are built from the id, never taken from a response: they
    // get the API key. A finished job has `urls` (signed URLs that need no
    // key, until `expires_at` in Unix seconds) only when OpenRouter stores
    // a copy; else the content endpoint gives the bytes. The first output
    // is the clip (a request asks for one).
    // https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status
    job: (kind, baseUrl, _modelId, data) => {
      const id = isRecord(data) ? data.id : undefined
      if (CLIP_KINDS[kind] !== 'video' || typeof id !== 'string' || id === '') throw new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.')
      const jobUrl = `${trimTrailingSlashes(baseUrl)}/videos/${encodeURIComponent(id)}`
      return {
        id,
        poll: { url: jobUrl },
        state: (poll) => {
          const status = isRecord(poll) ? poll.status : undefined
          if (status === 'pending' || status === 'in_progress') return 'running'
          if (!isRecord(poll) || status !== 'completed') {
            // `failed`, `cancelled`, `expired`, or a state that is new. The
            // texts come from the provider and show in the details of the
            // error toast.
            const reason = isRecord(poll) && typeof poll.error === 'string' && poll.error !== '' ? `: ${sanitizeErrorText(poll.error)}` : ''
            throw new ClipNotMadeError(`State: ${typeof status === 'string' ? sanitizeErrorText(status, 40) : 'none'}${reason}`)
          }
          const url = Array.isArray(poll.urls) ? poll.urls[0] : undefined
          // A time that a Date cannot hold has no ISO text for the clip's
          // tag; the content endpoint then gives the clip.
          const expires = typeof poll.expires_at === 'number' ? poll.expires_at * 1000 : Number.NaN
          if (isClipUrl(url) && !Number.isNaN(new Date(expires).getTime())) {
            // The docs name no type for the stored copy; every example is
            // an mp4 file.
            return { url, mediaType: 'video/mp4', expires }
          }
          return { download: { url: `${jobUrl}/content?index=0` } }
        },
      }
    },
    // "audio/pcm for pcm — 16-bit little-endian"
    // https://openrouter.ai/docs/api/api-reference/tts/create-speech
    pcmSampleBits: 16,
  },
  // An image model: the reference images of its entry in the image list
  // (`openRouterReferenceRules`). The docs tell no size that a reference
  // image must have.
  // A video model: the frames that it takes an image for
  // (`openRouterFrameCount`), or, when the user chose references
  // (OPENROUTER_IMAGES_AS), as many references as an image request takes:
  // the video schema caps `input_references` at no count. A model that
  // takes no frame has only references. A model that the video list does
  // not have gets no rules, so that its kept rules stay (keptClipData.ts).
  // No size rules: `supported_sizes` and `supported_aspect_ratios` are
  // the sizes of the video, and the docs tell no size that an image of a
  // video request must have.
  imageRules: (kind, _entry, mediaEntry) => {
    if (kind === 'image' || kind === 'imageEdit') return openRouterReferenceRules(mediaEntry)
    if (!isClipKind(kind) || CLIP_KINDS[kind] !== 'video' || !isRecord(mediaEntry)) return undefined
    const frames = openRouterFrameCount(mediaEntry)
    const references = { maxImages: OPENROUTER_MAX_REFERENCES, references: {} }
    if (frames === 0) return references
    return { maxImages: frames, whenParameter: { name: OPENROUTER_IMAGES_AS, value: OPENROUTER_AS_REFERENCES, rules: references } }
  },
}

export const MEDIA_FORMATS: Record<MediaApiFormatId, MediaFormat> = {
  venice: veniceFormat,
  openrouter: openRouterFormat,
}
