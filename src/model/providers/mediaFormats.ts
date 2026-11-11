import { sanitizeErrorText } from '../../utils/protocol/errors'
import { responseContentType, type NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { trimTrailingSlashes, type MediaApiFormatId } from './config'
import type { InputImageRules } from './clipImages'
import type { ClipTextRules } from './clipText'
import { generatedBase64Image, generatedImage } from './generatedImages'
import { imageSizeRules, type ImageSizeRules } from './imageSize'
import { isOptionValue, parameterTakes, type ModelParameter, type OptionsParameter, type OptionValue, type ParameterValues, type RangeParameter } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'
import { CLIP_KINDS, isClipKind, type ChatImagePart, type ClipKind, type GeneratedMedia, type ImageKind, type MediaKind } from './types'

// What one image request sends: the user's prompt, and the input images as
// bytes, in the user's order.
export interface MediaInput {
  prompt: string
  // The images of an edit, or the frames of a video: the first image is
  // the first frame, and the second one is the last frame. The caller gives
  // a request no more images than the model takes
  // (`MediaFormat.imageRules`). A request of a kind that takes no image
  // does not send them.
  images: readonly ChatImagePart[]
}

// What one clip request sends: the user's prompt (for speech, the text to
// speak), the input images, the lyrics of a song when the user wrote some
// (only for a model that takes lyrics, `ClipFormat.textRules`), and the
// value of each parameter of the model that has one
// (`ClipFormat.parameters`, `effectiveParameterValues`).
export interface ClipInput extends MediaInput {
  lyrics?: string
  values: ParameterValues
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
  request(kind: ImageKind, baseUrl: string, modelId: string, input: MediaInput): MediaWireRequest
  // The images of a 2xx response to a request of `kind`. Throws when the
  // body holds none.
  parseResponse(kind: ImageKind, head: NativeHttpResponseHead, body: Uint8Array): GeneratedMedia[]
  // The size rules of each image of an `imageEdit` request, for an API
  // whose docs tell them. They are rules of the request, not of a model.
  editImageSize?: ImageSizeRules
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
  // The model list that only the media API has, for an API whose model data
  // is not all in the provider's model list: a request whose response is
  // `{ data: [...] }`, with an `id` in each entry.
  modelList?(baseUrl: string): MediaWireRequest
  // What a request to a model of `kind` can set, from the model's entry in
  // the provider's model list (`entry`) and in `modelList` (`mediaEntry`).
  // Each one is undefined when its list does not have the model. The name
  // of a parameter is the name of its request field.
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
  // What a model of `kind` takes as input images, from its entry in the
  // provider's model list (`entry`) and in `ClipFormat.modelList`
  // (`mediaEntry`; each one undefined when its list does not have the
  // model), with the size rules of each image when an entry tells them.
  // Undefined for a model that takes none, as far as the API tells.
  imageRules?(kind: MediaKind, entry: unknown, mediaEntry: unknown): InputImageRules | undefined
}

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new Error('The provider sent an image response that is not valid JSON.')
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
// The Venice media API (https://docs.venice.ai/api-reference).
const veniceFormat: MediaFormat = {
  // The user's choice for every image: no Venice watermark (it is on by
  // default, at the bottom left), and safe mode off (on by default: Venice
  // blurs images that it classes as adult content). These are fixed values,
  // not settings.
  images: {
    request: (kind, baseUrl, modelId, { prompt, images }) => {
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
      }
    },
    // `/image/generate` answers JSON `{ images: [base64, …] }` (no URL
    // form), and the edit endpoints answer the bytes of one image, with no
    // JSON form ("The edit endpoints have no `response_format` parameter").
    // https://docs.venice.ai/api-reference/endpoint/image/generate
    // https://docs.venice.ai/guides/media/image-editing
    parseResponse: (_kind, head, body) => {
      if (!responseContentType(head).startsWith('application/json')) return [generatedImage(body)]

      const data = jsonBody(body)
      const images = isRecord(data) && Array.isArray(data.images) ? data.images : []
      if (images.length === 0) throw new Error('The provider sent no image.')
      return images.map((image) => generatedBase64Image(image))
    },
    // "For edit endpoints, images must be at least 256×256 pixels, and the
    // total pixel count must not exceed 33,177,600 (8K resolution)." The
    // API reference says "at least 65536 pixels" (256 × 256) in place of
    // the first part; an image whose sides are both 256 or more passes
    // both readings.
    // https://docs.venice.ai/guides/media/image-editing
    // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
    editImageSize: { minShortSide: 256, maxPixels: 33_177_600 },
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
          // last frame, each as a data URL ("a URL (http/https) or a data
          // URL").
          // https://docs.venice.ai/api-reference/endpoint/video/queue
          if (values.duration === undefined) throw new Error(NO_VIDEO_LENGTH_MESSAGE)
          const [firstFrame, lastFrame] = images.map(imageDataUrl)
          return {
            url: `${base}/video/queue`,
            body: {
              ...values,
              model: modelId,
              prompt,
              ...(firstFrame !== undefined && { image_url: firstFrame }),
              ...(lastFrame !== undefined && { end_image_url: lastFrame }),
            },
          }
        }
      }
    },
    // A model that takes no last frame refuses `end_image_url` with a 400
    // whose `details` (zod's error format: one entry per field) name the
    // field: "This model does not support end_image_url". That is a
    // validation error, so the request cost nothing (checked live,
    // 2026-11-11). No field of an entry tells it before (see
    // `imageRules`).
    refusedImages: (kind, status, body) => {
      if (kind !== 'imageToVideo' || status !== 400) return undefined
      const errors = valueAtPath(body, 'details.end_image_url._errors')
      const refused = Array.isArray(errors) && errors.some((text) => typeof text === 'string' && text.includes('does not support'))
      return refused ? 1 : undefined
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
      if (kind === 'tts' || typeof queueId !== 'string' || queueId === '') throw new Error('The provider sent no clip.')
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
          if (status !== 'COMPLETED' || downloadUrl === null) throw new Error('The provider sent no clip.')
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
        if (typeof quote !== 'number' || !Number.isFinite(quote)) throw new Error('The provider sent no price.')
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
  // (`refusedImages`). A text-to-video model takes no image. (The
  // reference images of the "reference-to-video" models are other
  // fields, which Dez does not send.)
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
    return { maxImages: 2, ...(size && { size }) }
  },
}

// The frames of a video that an OpenRouter request can give an image for
// (`frame_type`), in the order of the input images.
const OPENROUTER_FRAMES = ['first_frame', 'last_frame'] as const

// The OpenRouter speech and video APIs. Its image-only models have an own
// API too (`/images`), which Dez does not speak yet, and its music models
// answer through chat.
const openRouterFormat: MediaFormat = {
  clips: {
    // The lengths, resolutions, and prices of a video model are only in
    // the list of the video API.
    modelList: (baseUrl) => ({ url: `${trimTrailingSlashes(baseUrl)}/videos/models` }),
    parameters: (kind, entry, mediaEntry) => {
      switch (kind) {
        case 'tts': {
          // A request with no `voice` goes only to the providers that have
          // a default voice, so the first voice is the default.
          const voices = listedValues(valueAtPath(entry, 'supported_voices'))
          return optionsParameter('voice', 'Voice', voices, voices[0])
        }
        case 'video':
        case 'imageToVideo':
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
          ]
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
        case 'imageToVideo':
          // A request with no length gets the provider's default length,
          // which can cost many times the shortest one. So a model whose
          // lengths Dez does not know (the video list does not have it, or
          // the list did not load) gets no request.
          // The images are frames of the video (`frame_images`), each as a
          // data URL. `input_references`, the images of a
          // reference-to-video request, is never sent.
          // https://openrouter.ai/docs/guides/overview/multimodal/video-generation
          // https://openrouter.ai/docs/cookbook/video-generation/image-to-video
          if (values.duration === undefined) throw new Error(NO_VIDEO_LENGTH_MESSAGE)
          return {
            url: `${base}/videos`,
            body: {
              ...values,
              model: modelId,
              prompt,
              ...(images.length > 0 && {
                frame_images: OPENROUTER_FRAMES.slice(0, images.length).map((frame, index) => ({
                  type: 'image_url',
                  image_url: { url: imageDataUrl(images[index]) },
                  frame_type: frame,
                })),
              }),
            },
          }
        case 'music':
          throw new Error('This media API has no music request: choose another model.')
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
      if (CLIP_KINDS[kind] !== 'video' || typeof id !== 'string' || id === '') throw new Error('The provider sent no clip.')
      const jobUrl = `${trimTrailingSlashes(baseUrl)}/videos/${encodeURIComponent(id)}`
      return {
        id,
        poll: { url: jobUrl },
        state: (poll) => {
          const status = isRecord(poll) ? poll.status : undefined
          if (status === 'pending' || status === 'in_progress') return 'running'
          if (!isRecord(poll) || status !== 'completed') {
            // `failed`, `cancelled`, `expired`, or a state that is new. The
            // texts come from the provider and show in the error toast.
            const reason = isRecord(poll) && typeof poll.error === 'string' && poll.error !== '' ? `: ${sanitizeErrorText(poll.error)}` : ''
            throw new Error(`The provider did not make the clip (${typeof status === 'string' ? sanitizeErrorText(status, 40) : 'no state'})${reason}`)
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
  // The video list tells which frames a model takes an image for
  // (`supported_frame_images`). The images of a request go in the order
  // of OPENROUTER_FRAMES, so a last frame counts only with a first one.
  // No size rules: `supported_sizes` and `supported_aspect_ratios` are
  // the sizes of the video, and the docs tell no size that a frame image
  // must have.
  imageRules: (kind, _entry, mediaEntry) => {
    if (!isClipKind(kind) || CLIP_KINDS[kind] !== 'video') return undefined
    const frames = listedValues(valueAtPath(mediaEntry, 'supported_frame_images'))
    const firstMissing = OPENROUTER_FRAMES.findIndex((frame) => !frames.includes(frame))
    const maxImages = firstMissing === -1 ? OPENROUTER_FRAMES.length : firstMissing
    return maxImages > 0 ? { maxImages } : undefined
  },
}

export const MEDIA_FORMATS: Record<MediaApiFormatId, MediaFormat> = {
  venice: veniceFormat,
  openrouter: openRouterFormat,
}
