import { bytesToBase64 } from '../../utils/base64'
import { byteSizeText } from '../../utils/byteSize'
import { ExplainedError } from '../../utils/errorText'
import type { JsonObject } from '../../utils/json'
import { responseContentType, type NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import type { ImageSize } from '../chat/imageDrawing'
import { imageMediaType, type ImageMediaType } from '../chat/images'
import type { MediaTagKind } from '../chat/mediaTags'
import { clipMediaTypeOfExtension } from '../chat/mediaFiles'
import { apimartFormat } from './apimartFormat'
import { trimTrailingSlashes, type MediaApiFormatId, type MediaEntryPaths } from './config'
import type { ClipUse, InputClipRules } from './clipInputs'
import type { InputImageRules } from './clipImages'
import type { ClipTextRules } from './clipText'
import { usageNumber } from './chatUsage'
import { JobNotMadeError, UnusableAnswerError } from './errors'
import { generatedBase64Image, generatedImage } from './generatedImages'
import { imageSizeRules, positiveLimit, type ImageSizeRules, type InputImageLimits } from './imageSize'
import type { MultipartField } from './multipart'
import { clipFormFile, isClipUrl, jobStateText, jsonBody, lengthSeconds, listedValues, lowestFirstParameter, optionsParameter, resolutionLines, sourceClip, switchParameter, transcriptText, transcriptTimes } from './mediaFormatParts'
import { parameterTakes, type ModelParameter, type OptionValue, type ParameterValues, type RangeParameter } from './modelParameters'
import { priceNumber, roundedPrice, unitPrice, usdText, type ModelPrice } from './modelPrices'
import { isRecord, ownEntry, valueAtPath } from './modelParsing'
import { CLIP_KINDS, type ChatImagePart, type ClipKind, type GeneratedMedia, type ImageKind, type MediaKind, type TextKind, type TranscriptTimes } from './types'
import { VENICE_AUDIO_TYPES, VENICE_MAX_AUDIO_BYTES, VENICE_REFERENCE_FIELDS, VENICE_VIDEO_TYPES, veniceFamilyByIdPrefix, veniceReferenceBody, veniceReferenceClipRules, veniceReferenceFamily } from './veniceReferences'

// What one media request sends: the user's prompt, the input images as
// bytes, in the user's order, the input clips as bytes, and the value of
// each parameter of the model that has one (`ImageFormat.parameters`,
// `ClipFormat.parameters`, `effectiveParameterValues`).
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
  // The model takes the images as references, not as frames
  // (`InputImageRules.references`, for the values of `values`). Only a
  // request that cannot tell it from the model id reads it (Venice's
  // video-to-video models). Missing: frames, or no image.
  imagesAsReferences?: true
  // The clips of a video, in the user's order, each with the way that the
  // model uses its kind, or the one source clip of a model that changes or
  // writes down a clip. The caller gives a request only clips that the
  // model takes (`MediaFormat.clipRules`), in a type that it takes.
  // Missing: none.
  clips?: readonly InputClipPart[]
  values: ParameterValues
  // The rows of the model that gave `values` (`ModelInfo.parameters`), for
  // a request that sends a value by the kind of its row. Missing: the
  // request reads the values alone.
  parameters?: readonly ModelParameter[]
  // A transcription asks for the time of each word and segment, for an API
  // that can give them (`TextFormat.parseResponse` gives them as `times`).
  // Missing: the text only.
  wordTimes?: true
  // The web addresses of `images`, in their order, for an API that takes
  // the input images of a request only at a web address
  // (`MediaFormat.imageUpload`). Missing: the API takes them as data, or
  // the request has no input image.
  imageUrls?: readonly string[]
}

// One input clip of a request, with its use (`ClipKindRules.use`): the
// bytes that Dez read, or, for a kind that the model takes only by a web
// address (`ClipKindRules.urlOnly`), the clip's own `https` URL.
export type InputClipPart =
  | { kind: MediaTagKind, use: ClipUse, url: string }
  | { kind: MediaTagKind, use: ClipUse, mediaType: string, bytes: Uint8Array }

// The URL of a clip in a JSON body: its own URL, or a data URL of its
// bytes. Made only where a body needs it, so a clip that goes as a form
// file is never base64.
function clipUrl(clip: InputClipPart): string {
  return 'url' in clip ? clip.url : `data:${clip.mediaType};base64,${bytesToBase64(clip.bytes)}`
}

// What one clip request sends: a media input (for speech, the prompt is
// the text to speak), and the lyrics of a song when the user wrote some
// (only for a model that takes lyrics, `ClipFormat.textRules`).
export interface ClipInput extends MediaInput {
  lyrics?: string
}

// Why a provider refused the upload of an input image
// (`ImageUploadFormat.refusal`), when its answer tells a cause that the
// status alone does not tell:
// - `freeUploadsUsed`: the free uploads of the account are used up for
//   now, and the account takes no paid upload.
// - `keySpendingLimit`: the spending limit of the API key is too low for
//   the upload.
export type UploadRefusal = 'freeUploadsUsed' | 'keySpendingLimit'

// The upload of one input image of a request (an image or a clip), for an
// API that takes input images only at a web address, never as data.
// generateMedia uploads each image before the request, which then gets
// their addresses (`MediaInput.imageUrls`).
export interface ImageUploadFormat {
  // The request that uploads `image`, the image number `number` (1 for
  // the first one) of the request. Its file has a neutral name: it names
  // no file of the user.
  request(baseUrl: string, image: { bytes: Uint8Array, mediaType: ImageMediaType }, number: number): MediaWireRequest
  // The price in USD of the upload that the JSON of a 2xx response to
  // `request` tells (`AnswerCost`): 0 for a free upload, absent for a paid
  // one whose answer tells no price. Never throws: Dez reads it before the
  // address, so an answer with no address still counts its price.
  cost(data: unknown): AnswerCost
  // The web address of the image in the JSON of a 2xx response to
  // `request`. Throws an `UnusableAnswerError` when the answer holds none.
  url(data: unknown): string
  // Why the provider refused an upload with the status `status` and the
  // JSON `body` (ProviderHttpError.bodyJson), when the body tells a cause
  // of `UploadRefusal`; undefined else.
  refusal?(status: number, body: unknown): UploadRefusal | undefined
}

// The URL and the body of one media request: a POST of a JSON body or of a
// form (`form`, multipart/form-data, for an endpoint that takes a file
// only as an upload), or a GET when it has neither. Provider.mediaApiRequest
// adds the method and the headers, so a format holds no secrets.
export interface MediaWireRequest {
  url: string
  body?: Record<string, unknown>
  form?: readonly MultipartField[]
}

// Where the clip of a finished job is:
// - `url`: at a URL that gives the clip with no header until `expires` (a
//   time in ms). The clip plays from the URL, so its server must answer
//   range requests: a player seeks with them.
// - `download`: in the response to a request of the media API.
// - `fileUrls`: at URLs that give the clips with no header, and that no
//   player can play from: one URL for each clip of the job (a job of some
//   music models makes more than one song). Dez makes a temp copy of each.
// `cost` is the provider's own price of the job in USD, when the answer
// tells it (`AnswerCost`): one price for all clips of the job.
export type ClipLocation = (
  | { url: string, mediaType: string, expires: number }
  | { download: MediaWireRequest }
  | { fileUrls: FileUrls }
) & AnswerCost

// One URL for each file that a finished job made: at least one.
export type FileUrls = readonly [string, ...string[]]

// The provider's own price in USD of the request that an answer answers,
// when the answer tells it. Absent when it does not, so that a result with
// no price has no `cost` key.
export interface AnswerCost {
  cost?: number
}

// A request that the provider runs after its first response (a job), and
// that makes `Done` when it ends.
export interface MediaJob<Done> {
  // The provider's id of the job.
  id: string
  // Asks for the job's state. Some providers answer it with the clip's
  // bytes when the job is done.
  poll: MediaWireRequest
  // What the JSON of a 2xx response to `poll` tells: `running`, or what the
  // job made. Throws for a job that failed, and for a state that the format
  // does not know.
  state(data: unknown): 'running' | Done
  // The first response, cut down to what the format's `job` reads: `job`
  // with it gives this job again, after a restart of Dez
  // (`ProviderGenerateMediaInput.resume`). It is saved in app_state.json,
  // so it holds no text of the request.
  resume: JsonObject
}

// A clip that the provider makes after its first response.
export type ClipJob = MediaJob<ClipLocation>

// Images that the provider makes after its first response (a task): when
// the job is done, the URLs that give its images with no header, one for
// each image, and the provider's own price of the job (`AnswerCost`).
export type ImageJob = MediaJob<{ fileUrls: FileUrls } & AnswerCost>

// The parts of the image requests of a media API that do not depend on
// the form of its answer.
interface ImageFormatParts {
  // What a request to a model of `kind` can set, as for
  // `ClipFormat.parameters`. Missing: no model of the API has parameters.
  parameters?(kind: ImageKind, entry: unknown, mediaEntry: unknown): ModelParameter[]
  // The name of the file type that a model of `kind` makes, from the same
  // two entries, when it makes only types that Dez does not store
  // (generatedImages.ts), such as `BMP`; undefined when it makes a type
  // that Dez stores, as far as the entries tell. Dez sends such a model no
  // request (`ModelInfo.unstoredOutput`), so that the provider bills no
  // image that Dez cannot keep. Missing: every model of the API makes a
  // type that Dez stores.
  unstoredOutput?(kind: ImageKind, entry: unknown, mediaEntry: unknown): string | undefined
  request(kind: ImageKind, baseUrl: string, modelId: string, input: MediaInput): MediaWireRequest
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

// The image requests of an API whose 2xx response holds the images.
export interface ImageAnswerFormat extends ImageFormatParts {
  // The images of a 2xx response to a request of `kind`, and the price of
  // the request when the answer tells it. Throws when the body holds no
  // image.
  parseResponse(kind: ImageKind, head: NativeHttpResponseHead, body: Uint8Array): { media: GeneratedMedia[] } & AnswerCost
  job?: undefined
}

// The image requests of an API whose 2xx response is JSON that names a
// job, whose state Dez asks for until the images are made.
export interface ImageJobFormat extends ImageFormatParts {
  // The job that the JSON of a 2xx response to a request of `kind` names.
  // Throws when it names none.
  job(kind: ImageKind, baseUrl: string, modelId: string, data: unknown): ImageJob
  parseResponse?: undefined
}

// The image requests of a media API.
export type ImageFormat = ImageAnswerFormat | ImageJobFormat

// The price data of an image model, for the price of one request.
export interface ImageQuoteInput {
  // The model's entry in the provider's model list, and in a list of the
  // media API (`MediaFormat.modelLists`); each one undefined when Dez has
  // none.
  entry: unknown
  mediaEntry: unknown
  // The JSON of the 2xx response to `ImageQuoteFormat.recordsRequest`;
  // undefined with no such request.
  records: unknown
  // The JSON of the 2xx response to `ImageQuoteFormat.priceRequest`;
  // undefined with no such request.
  priceAnswer: unknown
}

// What a media API tells about the price of one image request.
export interface ImageQuoteFormat {
  // The request for the price records of a model of `kind`, for an API
  // whose model lists hold no prices. Null: the entries hold them.
  recordsRequest?(kind: ImageKind, baseUrl: string, modelId: string): MediaWireRequest | null
  // The request that asks for the price of the image request of `kind`
  // with `values`, for an API that tells the price of one request. Its
  // answer can hold facts of the account, so it is no price record of
  // the model. Null: the API has no such request for the kind or the
  // model.
  priceRequest?(kind: ImageKind, baseUrl: string, modelId: string, values: ParameterValues): MediaWireRequest | null
  // The price in USD of one request of `kind` with `values`; undefined
  // when the entries, the records, and the price answer tell no one price
  // for it.
  usd(kind: ImageKind, values: ParameterValues, input: ImageQuoteInput): number | undefined
}

// What a media API tells about the price of one clip before the request.
export interface ClipQuoteFormat {
  // The request that asks for the price of the clip that
  // `ClipFormat.request` with the same values asks for. `entry` is the
  // model's entry in the provider's model list. Null: the API has no such
  // request for the kind or the model; its prices are in its entries then.
  request(kind: ClipKind, baseUrl: string, modelId: string, values: ParameterValues, entry: unknown): MediaWireRequest | null
  // The price in USD in the JSON of a 2xx response to `request` with
  // `values`, for a price that the answer does not count in full. Throws
  // when it holds none.
  usd(data: unknown, values: ParameterValues): number
}

// The price of one clip request that the entries of a model tell
// (`ClipFormat.entryPrice`): the price in USD, with a note when the inputs
// of the request change it or it is an estimate; or why the entries, which
// hold the model's prices, tell no one price of the request. The texts are
// for the model that reads `model_info`.
export type ClipEntryPrice = { usd: number, note?: string } | { error: string }

// The clip requests (speech, music, video) of a media API. A 2xx response
// to `request` is the clip's bytes, or JSON that names a job (`job`).
export interface ClipFormat {
  // What a request to a model of `kind` can set, from the model's entry in
  // the provider's model list (`entry`) and in a list of the media API
  // (`MediaFormat.modelLists`, `mediaEntry`). Each one is undefined when
  // its list does not have the model. `paths` are where `entry` tells
  // more (`mediaApi.modelEntryPaths` of the provider's config; `{}` with
  // none). The name of a parameter is the name of its request field, but
  // for one that `request` reads itself (`images_as` of OpenRouter and
  // APIMart).
  parameters(kind: ClipKind, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): ModelParameter[]
  // What a model of `kind` takes as the text of a request, from the same
  // two entries and `paths`; undefined when the API tells nothing about
  // it.
  textRules?(kind: ClipKind, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): ClipTextRules | undefined
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
  // The price of one request of `kind` with `values`, from the model's
  // entries and the paths of the facts that they tell (as for
  // `parameters`), for an API whose model lists hold the prices of its
  // clips. Undefined when they hold none for the model.
  entryPrice?(kind: ClipKind, values: ParameterValues, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): ClipEntryPrice | undefined
  // The size in bits of one sample of the raw PCM audio (`audio/pcm`,
  // pcmAudio.ts) that the API can answer with. A response tells the rate
  // and the channels, but not this. Missing: the API's docs do not tell
  // it, and Dez takes no raw PCM from the API.
  pcmSampleBits?: number
}

// The requests of a media API whose answer is text (a transcription of an
// audio clip). One request; its 2xx response is JSON that holds the text.
export interface TextFormat {
  request(kind: TextKind, baseUrl: string, modelId: string, input: MediaInput): MediaWireRequest
  // The text of the JSON of a 2xx response to a request of `kind`, as the
  // model wrote it (an empty text for a clip with no speech), the times of
  // its words and segments when the request asked for them and the answer
  // holds some, and the price of the request when the answer tells it.
  // Throws when it holds no text.
  parseResponse(kind: TextKind, body: Uint8Array): { text: string, times?: TranscriptTimes } & AnswerCost
}

// Everything that differs between the media APIs that a provider can speak
// (`mediaApi.format` in config.ts). A format with no `images` makes no
// images, one with no `clips` makes no clips, and one with no `texts`
// writes down no clip.
// A format serves each provider of its API, custom ones too, so it knows
// no provider name: a bad answer throws an `UnusableAnswerError` with what
// was wrong, and `explainedProviderError` (errors.ts) makes the text for
// the reader, with the name.
export interface MediaFormat {
  images?: ImageFormat
  clips?: ClipFormat
  texts?: TextFormat
  // For an API that takes the input images of a request (an image or a
  // clip) only at a web address: the upload of each image before the
  // request.
  imageUpload?: ImageUploadFormat
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
  // What a model of `kind` takes as input clips, from the same two
  // entries, and the paths of the facts that `entry` tells (as for
  // `ClipFormat.parameters`). Undefined for a model that takes none, as
  // far as the API tells.
  clipRules?(kind: MediaKind, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): InputClipRules | undefined
  // The list price of a model of `kind` (`ModelInfo.price`), from the same
  // two entries and the paths of the facts that they tell (as for
  // `ClipFormat.parameters`), for the default values of its parameters
  // (`values`). Undefined when the entries tell no price, or none that Dez
  // can read with no input of the request.
  listPrice?(kind: MediaKind, values: ParameterValues, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): ModelPrice | undefined
}

// The price that OpenRouter gives in the JSON `data` of an answer of its
// image, transcription, and video APIs (`usage.cost`, in USD; the video
// API gives it with the state of a finished job), as a part of a result.
// https://openrouter.ai/docs/api/api-reference/images/generate-an-image
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription
// https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status
function openRouterAnswerCost(data: unknown): AnswerCost {
  const cost = usageNumber(valueAtPath(data, 'usage.cost'))
  return cost === undefined ? {} : { cost }
}

// The step of a speed field. The APIs take any number of the range (the
// speech schema of Venice: "minimum: 0.25, maximum: 4", with no step), so
// the range has `anyNumber`: a step rule in Dez would refuse a speed that
// the provider takes (1.12). The step is only for the arrows of the
// settings field. Checked 2026-11-15.
// https://docs.venice.ai/api-reference/endpoint/audio/speech
// https://docs.venice.ai/api-reference/endpoint/audio/queue
const SPEED_STEP = 0.05

// The parameter of a `speed` field (1 is the normal speed) that takes the
// numbers from `min` to `max`; none when they are no range. `defaultValue`
// is its default when the range takes it.
function speedParameter(min: unknown, max: unknown, defaultValue?: unknown): ModelParameter[] {
  if (typeof min !== 'number' || typeof max !== 'number' || !(min > 0) || !(min < max)) return []
  const range: RangeParameter = { name: 'speed', label: 'Speed', min, max, step: SPEED_STEP, anyNumber: true }
  if (parameterTakes(range, defaultValue)) range.default = defaultValue
  return [range]
}

// An input image as a data URL: Dez has no URL that a provider could
// fetch.
function imageDataUrl(image: ChatImagePart): string {
  return `data:${image.mediaType};base64,${image.data}`
}

// The refusal of a video request with no length. A model has no length
// when its entry in the model list tells none, or when the list that tells
// it did not load at a model check and no earlier check knew the model
// (`withKeptClipData` in keptClipData.ts). Only in the second case does a
// new check help. A format that can tell the two apart refuses only the
// second case (OpenRouter); one that cannot refuses both (Venice, whose
// video request needs a length).
export const NO_VIDEO_LENGTH_MESSAGE = 'Dez does not know which lengths this model takes: the provider\'s model list did not tell them. Check the provider again (Settings › Providers, "Check again").'

// The readers of the fields of a Venice model entry: `spec` reads
// `model_spec.<field>`, and `constraint` reads
// `model_spec.constraints.<field>`.
function veniceEntryFields(entry: unknown): { spec: (field: string) => unknown, constraint: (field: string) => unknown } {
  const spec = (field: string) => valueAtPath(entry, `model_spec.${field}`)
  return { spec, constraint: (field) => spec(`constraints.${field}`) }
}

// The `voice` parameter of a Venice speech, music, or voice changer model:
// the voices of its entry, with the entry's default voice when the list
// has it. The list of most models is closed: the API answers 400 for
// another voice. Two fields of an entry tell that the model takes more,
// and then the parameter also takes a text that the list does not hold:
// - `supports_custom_voice_id: true` (the ElevenLabs models): "Models with
//   `supports_custom_voice_id=true` … also accept a raw ElevenLabs Voice
//   ID" (the queue request; the speech request and the voice changer say
//   the same).
// - a `voice_cloning` record (`tts-chatterbox-hd`): the speech request
//   "also accepts a cloned-voice handle (`vv_…`) from `POST /audio/voices`
//   (same `model` that created it)". Dez has no clone request, but the
//   user can have a handle of the account.
// A voice that the provider does not know gets a 400 that costs nothing,
// or a failed job that is refunded. Checked 2026-11-15.
// https://docs.venice.ai/api-reference/endpoint/audio/speech
// https://docs.venice.ai/api-reference/endpoint/audio/queue
// https://docs.venice.ai/guides/media/voice-changer
function veniceVoice(entry: unknown): ModelParameter[] {
  const { spec } = veniceEntryFields(entry)
  const takesOtherVoices = spec('supports_custom_voice_id') === true || isRecord(spec('voice_cloning'))
  return optionsParameter('voice', 'Voice', listedValues(spec('voices')), spec('default_voice'), takesOtherVoices)
}

// The length of a Venice music clip, in seconds: one of the entry's
// `duration_options` when it has them, else each whole second from
// `min_duration` to `max_duration`. A model with neither takes no length.
// The default is the model's own (`default_duration`), not the lowest: the
// lowest is a second or a few, which is no piece of music.
function veniceMusicLength(entry: unknown): ModelParameter[] {
  const { spec } = veniceEntryFields(entry)
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

// The factors of a Venice video upscale model (Topaz), which its entry
// lists as its resolutions (`2x`, `4x`); none for any other model. The
// API takes them only as `upscale_factor`, a number ("Use upscale_factor
// instead of resolution for upscale models"), and such a model takes no
// prompt: "`prompt`: Upscaling does not use text prompts … will return an
// error if provided".
// https://docs.venice.ai/guides/media/video-upscaling
function veniceUpscaleFactors(entry: unknown): number[] {
  const factors = listedValues(valueAtPath(entry, 'model_spec.constraints.resolutions'))
    .map((resolution) => (typeof resolution === 'string' ? /^(\d+)x$/i.exec(resolution)?.[1] : undefined))
  return factors.length > 0 && factors.every((factor) => factor !== undefined) ? factors.map(Number) : []
}

// The factor of a Venice video upscale that makes no pixel more, which no
// entry lists (the entry tells the factors as resolutions, and `1x` is no
// resolution): "`upscale_factor` | number | No | `1`, `2` (default), or
// `4`", and "`1` | Same as input | Quality enhancement only (denoising,
// sharpening)". Checked 2026-11-15.
// https://docs.venice.ai/guides/media/video-upscaling
const VENICE_SAME_SIZE_FACTOR = 1

// What a Venice music model takes as text, from its entry: the least and
// the most characters of the prompt, and whether it takes lyrics
// (`lyrics_prompt`). A limit that is no count is not known.
function veniceMusicText(entry: unknown): ClipTextRules | undefined {
  const { spec } = veniceEntryFields(entry)
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

// The price key of each Venice image kind in the model entry
// (`model_spec.pricing`), and the keys of the table that are prices of
// other requests (every image model repeats the upscale table). The table
// of a model whose price depends on the options of the request also has
// `resolutions` (resolution → price) or `quality` (resolution → quality →
// price), and some such tables have no price key. An edit model's table
// can have `inputImages` (the images that the price includes, and the price
// of each more); a quote does not know the count of the images, so such a
// model gets no quote, and its list price tells that price in a note. A
// table with any other key gets no price. The entry of an upscale model has
// the price of each scale (`upscale` → `2x`, `4x`).
// https://docs.venice.ai/pricing
const VENICE_IMAGE_PRICES: Readonly<Record<Exclude<ImageKind, 'upscale'>, { key: string, others: readonly string[] }>> = {
  image: { key: 'generation', others: ['upscale', 'inpaint'] },
  imageEdit: { key: 'inpaint', others: ['upscale', 'generation'] },
}
const VENICE_OPTION_PRICES: readonly string[] = ['resolutions', 'quality']

// The entry of a Venice price table for the option value `value` of a
// request; none when the request has no value, or the table has no price
// for it. A plain lookup, not `valueAtPath`: a resolution such as `1.5K`
// holds a dot.
function venicePriceOf(table: unknown, value: unknown): unknown {
  return isRecord(table) && (typeof value === 'string' || typeof value === 'number') && Object.hasOwn(table, value) ? table[value] : undefined
}

// The USD of one price of a Venice price table (`{ usd, diem }`).
function veniceUsd(price: unknown): number | undefined {
  return usageNumber(valueAtPath(price, 'usd'))
}

// The price of one Venice image request of `kind` with `values`, from the
// model's price table, with the option values that the price is for. An
// upscale has the price of its scale, whatever the other keys. None when
// the table has a key that Dez does not know (but `moreKeys`, which the
// caller reads), or no price for the values.
function veniceImagePrice(kind: ImageKind, values: ParameterValues, pricing: Record<string, unknown>, moreKeys: readonly string[] = []): { usd: number, options: string[] } | undefined {
  const priced = (usd: number | undefined, options: unknown[]) => (usd === undefined ? undefined : { usd, options: options.map(String) })
  if (kind === 'upscale') {
    const scale = `${String(values.scale)}x`
    return priced(veniceUsd(venicePriceOf(pricing.upscale, scale)), [scale])
  }
  const { key, others } = VENICE_IMAGE_PRICES[kind]
  const known = [key, ...others, ...VENICE_OPTION_PRICES, ...moreKeys]
  if (Object.keys(pricing).some((name) => !known.includes(name))) return undefined
  const { resolution, quality } = values
  if (Object.hasOwn(pricing, 'quality')) return priced(veniceUsd(venicePriceOf(venicePriceOf(pricing.quality, resolution), quality)), [resolution, quality])
  if (Object.hasOwn(pricing, 'resolutions')) return priced(veniceUsd(venicePriceOf(pricing.resolutions, resolution)), [resolution])
  return priced(veniceUsd(pricing[key]), [])
}

// The list price of a Venice image model: one image for the default
// values, which the note names. The note of an edit model whose price
// holds fewer input images than a request can have (`inputImages`) tells
// the price of each extra image.
function veniceImageListPrice(kind: ImageKind, values: ParameterValues, pricing: Record<string, unknown>): ModelPrice | undefined {
  const price = veniceImagePrice(kind, values, pricing, kind === 'imageEdit' ? ['inputImages'] : [])
  if (!price) return undefined
  const notes = price.options.length > 0 ? [price.options.join(', ')] : []
  if (kind === 'imageEdit' && Object.hasOwn(pricing, 'inputImages')) {
    const included = valueAtPath(pricing, 'inputImages.included')
    const more = veniceUsd(valueAtPath(pricing, 'inputImages.additional'))
    if (typeof included !== 'number' || !Number.isInteger(included) || included < 0 || more === undefined) return undefined
    notes.push(`+${usdText(more)} per input image${included > 0 ? ` over ${included}` : ''}`)
  }
  return unitPrice('image', price.usd, notes.join('; '))
}

// The tier of a Venice `durations` price table (`{ usd, min_seconds,
// max_seconds }` by length) that holds a clip of `seconds`; with no
// length, the cheapest tier.
function veniceDurationTier(table: unknown, seconds: unknown): { usd: number, maxSeconds: number } | undefined {
  if (!isRecord(table)) return undefined
  const tiers = Object.values(table).flatMap((tier) => {
    const usd = veniceUsd(tier)
    const minSeconds = valueAtPath(tier, 'min_seconds')
    const maxSeconds = valueAtPath(tier, 'max_seconds')
    return usd !== undefined && typeof minSeconds === 'number' && typeof maxSeconds === 'number' ? [{ usd, minSeconds, maxSeconds }] : []
  })
  if (typeof seconds === 'number') return tiers.find((tier) => tier.minSeconds <= seconds && seconds <= tier.maxSeconds)
  return tiers.reduce<typeof tiers[number] | undefined>((cheapest, tier) => (cheapest && cheapest.usd <= tier.usd ? cheapest : tier), undefined)
}

// The list price of a Venice clip or transcription model, from the one
// price of its table: per 1M characters of the text (a speech model's
// `input`; `per_thousand_characters`), per second of the clip that the
// model makes or reads (`per_second`, `per_audio_second`), per clip
// (`generation`), or per clip of a length tier (`durations`: the tier of
// the default length; a voice changer's tier is the length of its source
// clip, so its price is the cheapest tier). A table with more than one
// price has a rule that Dez does not know. Venice video entries hold no
// price (their quote is the only source).
// https://docs.venice.ai/pricing
function veniceClipListPrice(kind: Exclude<MediaKind, ImageKind>, values: ParameterValues, pricing: Record<string, unknown>): ModelPrice | undefined {
  const keys = Object.keys(pricing)
  if (keys.length !== 1) return undefined
  const [key] = keys
  const price = pricing[key]
  switch (`${kind} ${key}`) {
    case 'tts input':
      return unitPrice('character', veniceUsd(price))
    case 'transcription per_audio_second':
    case 'music per_second':
      return unitPrice('second', veniceUsd(price))
    case 'music per_thousand_characters': {
      const usd = veniceUsd(price)
      return unitPrice('character', usd === undefined ? undefined : usd * 1000)
    }
    case 'music generation':
      return unitPrice('clip', veniceUsd(price))
    case 'music durations': {
      const seconds = values.duration_seconds
      const tier = veniceDurationTier(price, seconds)
      return unitPrice('clip', tier?.usd, typeof seconds === 'number' ? `${seconds} s` : `up to ${tier?.maxSeconds} s`)
    }
    case 'voiceChange durations': {
      const tier = veniceDurationTier(price, undefined)
      return unitPrice('clip', tier?.usd, `a source clip of up to ${tier?.maxSeconds} s`)
    }
  }
  return undefined
}

const VENICE_MAX_SIDE = 1280
const VENICE_DEFAULT_SIDE = 1024

// The `width` and `height` rows of a Venice image model that takes a size
// in pixels. The docs: "Pixel-based models accept width and height, for
// example venice-sd35"; the schema of `/image/generate` gives integers of
// at most 1280, with 1024 as the default. Such an entry has
// `widthHeightDivisor` (the size is a multiple of it) and no
// `aspectRatios` list. An aspect-ratio model (the Qwen family, whose
// divisor is 1) refuses `width` and `height` with an HTTP 400, so it gets
// no row. Every edit model lists aspect ratios (2026-11-14), and the edit
// schema allows no field that it does not name, so an edit gets no row.
// https://docs.venice.ai/api-reference/endpoint/image/generate
function venicePixelSize(constraint: (field: string) => unknown): RangeParameter[] {
  const divisor = constraint('widthHeightDivisor')
  if (constraint('aspectRatios') !== undefined || typeof divisor !== 'number' || !Number.isInteger(divisor) || divisor < 1 || divisor > VENICE_MAX_SIDE) return []
  const side = (name: string, label: string): RangeParameter => {
    const range: RangeParameter = { name, label, min: divisor, max: Math.floor(VENICE_MAX_SIDE / divisor) * divisor, step: divisor }
    if (parameterTakes(range, VENICE_DEFAULT_SIDE)) range.default = VENICE_DEFAULT_SIDE
    return range
  }
  return [side('width', 'Width'), side('height', 'Height')]
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
    // the range (`anyNumber`; checked 2026-11-15), and the step is only
    // for the arrows of the settings field.
    // https://docs.venice.ai/api-reference/endpoint/image/upscale
    // https://docs.venice.ai/guides/media/image-upscaling
    // image, imageEdit: the option lists of the entry
    // (`model_spec.constraints`; camelCase keys, where the video entries
    // have snake_case ones), whose names are the request fields of both
    // endpoints. A model with `qualities` takes only those. A list's
    // default is the default only when the list holds it; else the popup
    // shows "Default" and the request sends no field, so the model's own
    // default applies (an edit with no `aspect_ratio` takes the one of its
    // first image). A model that takes a size in pixels has none of the
    // lists: see `venicePixelSize`.
    // https://docs.venice.ai/api-reference/endpoint/image/generate
    // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
    parameters: (kind, entry) => {
      if (kind === 'upscale') {
        return [
          { name: 'scale', label: 'Scale', options: [2, 4], default: 2 },
          { name: 'creativity', label: 'Creativity', min: 0, max: 0.02, step: 0.001, anyNumber: true, default: 0.01 },
        ]
      }
      const { constraint } = veniceEntryFields(entry)
      return [
        ...optionsParameter('aspect_ratio', 'Aspect ratio', listedValues(constraint('aspectRatios')), constraint('defaultAspectRatio')),
        ...optionsParameter('resolution', 'Resolution', listedValues(constraint('resolutions')), constraint('defaultResolution')),
        ...optionsParameter('quality', 'Quality', listedValues(constraint('qualities')), constraint('defaultQuality')),
        ...(kind === 'image' ? venicePixelSize(constraint) : []),
      ]
    },
    request: (kind, baseUrl, modelId, { prompt, images, values }) => {
      const base = trimTrailingSlashes(baseUrl)
      switch (kind) {
        case 'image':
          // WebP is Venice's default; it is set so that the files keep one
          // type if the default changes.
          return { url: `${base}/image/generate`, body: { model: modelId, prompt, format: 'webp', hide_watermark: true, safe_mode: false, ...values } }
        case 'imageEdit':
          // This endpoint names the model `modelId`, not `model`. The first
          // image is the one to edit; the others are references. Each one
          // goes as a data URL, as Dez has no URL that a provider could
          // fetch. It has `safe_mode` but no `hide_watermark`, and its
          // schema allows no field that it does not name, so only
          // `safe_mode` goes, with the values of the parameters. (The
          // `/image/edit` endpoint refuses `quality`.)
          // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
          // https://docs.venice.ai/api-reference/endpoint/image/edit
          return {
            url: `${base}/image/multi-edit`,
            body: { modelId, prompt, images: images.map(imageDataUrl), safe_mode: false, ...values },
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
      if (!responseContentType(head).startsWith('application/json')) return { media: [generatedImage(body)] }

      const data = jsonBody(body)
      const images = isRecord(data) && Array.isArray(data.images) ? data.images : []
      if (images.length === 0) throw new UnusableAnswerError('The answer holds no image.')
      return { media: images.map((image) => generatedBase64Image(image)) }
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
        return veniceImagePrice(kind, values, pricing)?.usd
      },
    },
  },
  clips: {
    // voice (tts, music, voiceChange): `veniceVoice`.
    // tts: the entry names no default voice, and each model has its own.
    // The format is a parameter so that every request names it: the
    // model's own default when Dez stores its type, else the first type
    // that Dez stores. A request with no `response_format` gets the
    // model's default, which can be raw PCM (no file). Also, `tts-kokoro`
    // answers such a request in WAV with the header `audio/mpeg`, and Dez
    // names a clip's file after that header. With the format in the
    // request, the header agrees with the audio (checked live, 2026-11-10).
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
    // field that the model does not take. Some models have no length
    // field in their entries (`minimax-music-v2`), so they have no length
    // to set. There is no format parameter (the queue request
    // has no format field) and no language parameter (the API gives no
    // list of the languages).
    parameters: (kind, entry) => {
      const { spec } = veniceEntryFields(entry)
      switch (kind) {
        case 'tts': {
          const formats = listedValues(spec('supported_formats')).filter((format) => VENICE_SPEECH_FORMATS.has(format))
          const modelDefault = spec('default_format')
          return [
            ...veniceVoice(entry),
            ...optionsParameter('response_format', 'Format', formats, formats.find((format) => format === modelDefault) ?? formats[0]),
            // The speech request takes 0.25 to 4 for every model (its
            // schema); the entries hold no speed. No default: with no
            // value, the API's own (1) applies.
            ...speedParameter(0.25, 4),
          ]
        }
        case 'music':
          return [
            ...veniceMusicLength(entry),
            ...veniceVoice(entry),
            ...(spec('supports_speed') === true ? speedParameter(spec('min_speed'), spec('max_speed'), spec('default_speed')) : []),
            ...switchParameter('force_instrumental', 'Instrumental', spec('supports_force_instrumental')),
            // The model writes the lyrics itself.
            ...switchParameter('lyrics_optimizer', 'Lyrics from the prompt', spec('supports_lyrics_optimizer')),
            // The end of the clip goes over into its start with no seam.
            ...switchParameter('loop', 'Loop', spec('supports_loop')),
          ]
        case 'video':
        case 'imageToVideo':
        case 'videoToVideo': {
          const aspectRatios = listedValues(spec('constraints.aspect_ratios'))
          const factors = kind === 'videoToVideo' ? veniceUpscaleFactors(entry) : []
          return [
            // `duration` is required, and most video-to-video models list
            // only `Auto` (the length of the source clip), which no
            // length in seconds puts first. So a list with no length in
            // seconds gets its first entry as the default.
            ...lowestFirstParameter('duration', 'Length', spec('constraints.durations'), lengthSeconds)
              .map((length) => ('options' in length ? { default: length.options[0], ...length } : length)),
            // The entry's first factor stays the default (2, as the
            // API's own): a request with no factor would send a prompt,
            // which an upscale refuses.
            ...(factors.length > 0
              ? optionsParameter('upscale_factor', 'Upscale factor', [...new Set([VENICE_SAME_SIZE_FACTOR, ...factors])], factors[0])
              : lowestFirstParameter('resolution', 'Resolution', spec('constraints.resolutions'), resolutionLines)),
            ...optionsParameter('aspect_ratio', 'Aspect ratio', aspectRatios, aspectRatios[0]),
            ...switchParameter('audio', 'Audio', spec('constraints.audio_configurable'), true),
          ]
        }
        case 'voiceChange':
          // No seed: a seed gives the same speech again, which a user who
          // asks once more does not want.
          return [
            ...veniceVoice(entry),
            ...switchParameter('remove_background_noise', 'Remove background noise', spec('supports_background_noise_removal')),
          ]
      }
    },
    // tts: 1 to 4096 characters for every model (the speech request's
    // schema). music: the limits are in the entry. video: some entries tell
    // the most characters of the prompt
    // (`constraints.prompt_character_limit`, 1000 to 26000); a longer text
    // gets a 400 from the API, so Dez refuses it first. A limit of 0 is
    // not a limit that a model can have. voiceChange: the request has no
    // text.
    textRules: (kind, entry) => {
      switch (kind) {
        case 'tts':
          return { minPromptLength: 1, maxPromptLength: 4096 }
        case 'music':
          return veniceMusicText(entry)
        case 'video':
        case 'imageToVideo':
        case 'videoToVideo': {
          const maxPromptLength = veniceCharacterCount(valueAtPath(entry, 'model_spec.constraints.prompt_character_limit'))
          return maxPromptLength ? { maxPromptLength } : undefined
        }
        case 'voiceChange':
          return undefined
      }
    },
    // The schemas allow no field that they do not name, and a field that
    // the model does not take is an error. The values are the fields of the
    // model's own parameters, so they go as they are.
    request: (kind, baseUrl, modelId, { prompt, images, imagesAsReferences, clips = [], lyrics, values }) => {
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
          // or a data URL"). So are the clips: the reference clips and the
          // voices go in the family's fields, and a background audio clip
          // in `audio_url` (`clipRules`).
          // https://docs.venice.ai/api-reference/endpoint/video/queue
          if (values.duration === undefined) throw new ExplainedError(NO_VIDEO_LENGTH_MESSAGE)
          const urls = images.map(imageDataUrl)
          const family = veniceReferenceFamily(modelId)
          const [firstFrame, lastFrame] = urls
          const references = clips.filter((clip) => clip.use !== 'background').map((clip) => ({ kind: clip.kind, use: clip.use, url: clipUrl(clip) }))
          const background = clips.find((clip) => clip.use === 'background')
          return {
            url: `${base}/video/queue`,
            body: {
              ...values,
              model: modelId,
              prompt,
              ...(family && veniceReferenceBody(family, urls, references)),
              ...(!family && firstFrame !== undefined && { image_url: firstFrame }),
              ...(!family && lastFrame !== undefined && { end_image_url: lastFrame }),
              ...(background && { audio_url: clipUrl(background) }),
            },
          }
        }
        case 'videoToVideo': {
          // The source clip goes as `video_url` ("Input video URL or data
          // URL. Supported formats: MP4, MOV, WebM"), or as a reference
          // video for a model that refuses `video_url` (`clipRules`). The
          // images go as references (`reference_image_urls`) to a model
          // that takes them so (`imageRules`), else as `image_url`: the
          // person or the thing of a motion control model. An upscale
          // model (`upscale_factor`) refuses a prompt
          // (`veniceUpscaleFactors`).
          // https://docs.venice.ai/guides/media/video-upscaling
          // https://docs.venice.ai/guides/media/reference-to-video
          if (values.duration === undefined) throw new ExplainedError(NO_VIDEO_LENGTH_MESSAGE)
          const urls = images.map(imageDataUrl)
          const source = clips.find((clip) => clip.use === 'source')
          const references = clips.filter((clip) => clip.use === 'reference').map(clipUrl)
          return {
            url: `${base}/video/queue`,
            body: {
              ...values,
              model: modelId,
              ...(values.upscale_factor === undefined && { prompt }),
              ...(source && { video_url: clipUrl(source) }),
              ...(references.length > 0 && { reference_video_urls: references }),
              ...(urls.length > 0 && (imagesAsReferences ? { reference_image_urls: urls } : { image_url: urls[0] })),
            },
          }
        }
        case 'voiceChange':
          // The queue takes the clip as a form file, or by an `http(s)`
          // address, which a clip of Dez has only for a while; so it goes
          // as a file, and the request is a form, with the values as text
          // fields. A switch that is off goes as no field. No prompt: the
          // schema has no such field.
          // https://docs.venice.ai/guides/media/voice-changer
          return {
            url: `${base}/audio/voice-changer/queue`,
            form: [
              { name: 'model', value: modelId },
              ...Object.entries(values).flatMap(([name, value]) => (value === false ? [] : [{ name, value: String(value) }])),
              clipFormFile('file', sourceClip(clips)),
            ],
          }
      }
    },
    // A model that takes no last frame refuses `end_image_url` with a 400
    // whose `details` (zod's error format: one entry per field) name the
    // field: "This model does not support end_image_url". A
    // reference-to-video or video-to-video model refuses more references
    // than it takes in the same way: "reference_image_urls must have at
    // most 7 images", "image_references must have at most 5 entries",
    // "elements must have at most 4 items". Those are validation errors,
    // so the request cost nothing (checked live, 2026-11-11). No field of
    // an entry tells the last frame, and the counts of veniceReferences.ts
    // can get old (see `imageRules`).
    refusedImages: (kind, status, body) => {
      if ((kind !== 'imageToVideo' && kind !== 'videoToVideo') || status !== 400) return undefined
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
    // `COMPLETED` means that the URL has the clip. That URL goes in
    // `fileUrls`, not in `url`: its server answers a range request with the
    // whole file (seen 2026-11-10), and a seek in the player then fails
    // with a network error. The voice changer has its own retrieve
    // endpoint, which answers the same way (its clip is `audio/mpeg`).
    // `delete_media_on_completion` is never sent: a download that breaks
    // would lose a paid clip.
    // https://docs.venice.ai/api-reference/endpoint/audio/retrieve
    // https://docs.venice.ai/api-reference/endpoint/video/retrieve
    // https://docs.venice.ai/guides/media/voice-changer
    job: (kind, baseUrl, modelId, data) => {
      const queueId = isRecord(data) ? data.queue_id : undefined
      if (kind === 'tts' || typeof queueId !== 'string' || queueId === '') throw new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.')
      const downloadUrl = isRecord(data) && isClipUrl(data.download_url) ? data.download_url : null
      const retrievePath = kind === 'voiceChange' ? 'audio/voice-changer/retrieve' : `${CLIP_KINDS[kind]}/retrieve`
      return {
        id: queueId,
        resume: { queue_id: queueId, ...(downloadUrl !== null && { download_url: downloadUrl }) },
        poll: {
          url: `${trimTrailingSlashes(baseUrl)}/${retrievePath}`,
          body: { model: modelId, queue_id: queueId },
        },
        state: (poll) => {
          const status = isRecord(poll) ? poll.status : undefined
          if (status === 'QUEUED' || status === 'PROCESSING') return 'running'
          // A state that is new, or that ends the job with no clip.
          if (status !== 'COMPLETED') throw new JobNotMadeError(jobStateText(status))
          if (downloadUrl === null) throw new UnusableAnswerError('The job is done, and its answer holds no clip and no download URL.')
          return { fileUrls: [downloadUrl] }
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
          case 'videoToVideo':
          case 'voiceChange':
            // The price is by the length of the source clip ("Edit,
            // motion-control and upscale modes bill by the length of your
            // source video"; the voice changer by its started minutes). A
            // quote of an upscale needs the clip itself ("video_url is
            // required for quotes on this model"), and a price request
            // sends no clip.
            return null
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
  // videoToVideo: the API refuses `reference_image_urls` ("This model does
  // not support reference images") from each model whose entry tells no
  // size of a reference image, and takes it from the others, as many as
  // their family takes (free refusals of 40 images, 2026-11-12). The
  // others take one `image_url`, the person or the thing of a motion
  // control model; the docs tell of no other model that reads it. An
  // upscale model takes no image (`veniceUpscaleFactors`).
  imageRules: (kind, entry) => {
    const { constraint } = veniceEntryFields(entry)
    if (kind === 'imageEdit') {
      const maxImages = constraint('maxInputImages')
      if (typeof maxImages === 'number' && Number.isInteger(maxImages) && maxImages > 0) return { maxImages }
      return { maxImages: constraint('combineImages') === false ? 1 : 3 }
    }
    if (kind !== 'imageToVideo' && kind !== 'videoToVideo') return undefined
    const size = imageSizeRules({
      minShortSide: constraint('reference_image_min_short_side_pixels'),
      minAspectRatio: constraint('reference_image_min_aspect_ratio'),
      maxAspectRatio: constraint('reference_image_max_aspect_ratio'),
    })
    const id = valueAtPath(entry, 'id')
    if (kind === 'videoToVideo') {
      if (veniceUpscaleFactors(entry).length > 0) return undefined
      if (!size || typeof id !== 'string') return { maxImages: 1 }
      const family = veniceFamilyByIdPrefix(id)
      return { maxImages: family.maxImages, references: { promptName: family.promptName }, size }
    }
    const family = typeof id === 'string' ? veniceReferenceFamily(id) : undefined
    if (family) return { maxImages: family.maxImages, references: { promptName: family.promptName }, ...(size && { size }) }
    return { maxImages: 2, ...(size && { size }) }
  },
  // A reference-to-video model: the reference clips of its family, and the
  // voice of each reference when its entry says that it takes one
  // (`per_reference_audio`; veniceReferences.ts). Any other video model
  // whose entry says that it takes audio (`audio_input`) takes one audio
  // clip as the sound of the video (`audio_url`: "WAV, MP3. Max: 30s,
  // 15MB"). The entries' `video_input` is false for every model of these
  // kinds (2026-11-11), so it tells nothing of reference videos.
  // https://docs.venice.ai/api-reference/endpoint/video/queue
  // videoToVideo: the one video that the model changes, as `video_url`.
  // A model whose entry has `video_input: false` refuses that field ("This
  // model does not support video input"; Seedance 2.5 Edit) and takes the
  // video as a reference video, with the rules and the prompt name of its
  // family's references (`<Video 1>`).
  // voiceChange: the entry tells the types (`accepted_audio_formats`) and
  // the most seconds; a larger file than 25 MB gets a 413. The types are
  // containers ("Venice checks the bytes, not the extension, so a file has
  // to actually be one of the accepted containers"), so an Opus file,
  // which is an Ogg file, goes as it is (`VENICE_VOICE_CHANGER_TYPES`).
  // transcription: the types of the endpoint's list that Dez stores ("A
  // file is accepted when either its MIME type or its extension is on that
  // list, and the uploaded bytes must also pass a magic-byte check").
  // https://docs.venice.ai/guides/media/voice-changer
  // https://docs.venice.ai/api-reference/endpoint/audio/transcriptions
  clipRules: (kind, entry) => {
    const { constraint } = veniceEntryFields(entry)
    const id = valueAtPath(entry, 'id')
    switch (kind) {
      case 'video':
      case 'imageToVideo': {
        const family = typeof id === 'string' ? veniceReferenceFamily(id) : undefined
        const references = family && veniceReferenceClipRules(family, constraint('per_reference_audio') === true)
        if (references) return references
        if (constraint('audio_input') !== true) return undefined
        return { audio: { use: 'background', maxClips: 1, maxSeconds: 30, maxBytes: VENICE_MAX_AUDIO_BYTES, types: [...VENICE_AUDIO_TYPES] } }
      }
      case 'videoToVideo': {
        if (constraint('video_input') !== false) return { video: { use: 'source', maxClips: 1, types: [...VENICE_VIDEO_TYPES, 'video/webm'] } }
        const video = typeof id === 'string' ? veniceReferenceClipRules(veniceFamilyByIdPrefix(id), false)?.video : undefined
        return video && { video: { ...video, maxClips: 1 } }
      }
      case 'voiceChange': {
        const formats = listedValues(valueAtPath(entry, 'model_spec.accepted_audio_formats'))
        const types = formats.flatMap((format) => ownEntry(VENICE_VOICE_CHANGER_TYPES, format) ?? [])
        const maxSeconds = valueAtPath(entry, 'model_spec.max_source_audio_duration_seconds')
        return {
          audio: {
            use: 'source',
            maxClips: 1,
            ...(typeof maxSeconds === 'number' && maxSeconds > 0 && { maxSeconds }),
            maxBytes: 25 * 1024 ** 2,
            ...(types.length > 0 && { types }),
          },
        }
      }
      case 'transcription':
        return { audio: { use: 'source', maxClips: 1, types: ['audio/wav', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg'] } }
      default:
        return undefined
    }
  },
  // The transcription endpoint takes only a form (`file`, `model`,
  // `response_format`, `timestamps`, `language`; no other field), and
  // answers `{ text, duration?, timestamps? }` for `json`. `timestamps=true`
  // asks for the times of the words and the segments (`wordTimes`):
  // `timestamps: { word?, segment?, char? }`, each list of `{ word | text,
  // start, end }`. Dez drops `char`.
  // https://docs.venice.ai/api-reference/endpoint/audio/transcriptions
  texts: {
    request: (_kind, baseUrl, modelId, { clips = [], wordTimes }) => ({
      url: `${trimTrailingSlashes(baseUrl)}/audio/transcriptions`,
      form: [
        { name: 'model', value: modelId },
        { name: 'response_format', value: 'json' },
        ...(wordTimes ? [{ name: 'timestamps', value: 'true' }] : []),
        clipFormFile('file', sourceClip(clips)),
      ],
    }),
    parseResponse: (_kind, body) => {
      const data = jsonBody(body)
      const times = transcriptTimes(data, { words: 'timestamps.word', segments: 'timestamps.segment' })
      return { text: transcriptText(data), ...(times && { times }) }
    },
  },
  listPrice: (kind, values, entry) => {
    const pricing = valueAtPath(entry, 'model_spec.pricing')
    if (!isRecord(pricing)) return undefined
    switch (kind) {
      case 'image':
      case 'imageEdit':
      case 'upscale':
        return veniceImageListPrice(kind, values, pricing)
      default:
        return veniceClipListPrice(kind, values, pricing)
    }
  },
}

// The media types of the audio formats that Venice's voice changer names
// in a model entry (`accepted_audio_formats`). A format is a container,
// which Venice finds in the bytes of the file, so `ogg` is both types that
// Dez stores an Ogg file as. Without `audio/opus`, an Opus clip would go
// as a WAV copy, many times its size, which then breaks the 25 MB limit.
// Checked 2026-11-15.
// https://docs.venice.ai/guides/media/voice-changer
const VENICE_VOICE_CHANGER_TYPES: Readonly<Record<string, readonly string[]>> = {
  mp3: ['audio/mpeg'],
  wav: ['audio/wav'],
  ogg: ['audio/ogg', 'audio/opus'],
  mp4: ['audio/mp4'],
  aac: ['audio/aac'],
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

// An input image of an OpenRouter image or video request, as a data URL.
function openRouterImageItem(image: ChatImagePart): { type: 'image_url', image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: imageDataUrl(image) } }
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
// that Dez stores. The values are extension names (`png`, `jpeg`, `webp`,
// `svg`), so the extension map of the stored types reads them.
function isStoredImageFormat(format: OptionValue): boolean {
  return typeof format === 'string' && imageMediaType(`.${format.toLowerCase()}`) !== null
}

// The values of `response_format` of OpenRouter's speech request whose
// answer Dez stores: a file (`mp3`, `wav`), or raw PCM (`pcm`), of which
// Dez makes a WAV file (`pcmSampleBits`).
// https://openrouter.ai/docs/api/api-reference/tts/create-speech
const OPENROUTER_STORED_SPEECH_FORMATS: readonly OptionValue[] = ['mp3', 'wav', 'pcm']

// The value at a path of the provider's config (`mediaApi.modelEntryPaths`)
// in an entry; none with no path.
function entryValue(entry: unknown, path: string | undefined): unknown {
  return path === undefined ? undefined : valueAtPath(entry, path)
}

// The Format row of a speech model whose entry lists the formats that it
// makes, at the provider's `paths.speechFormats`: the listed formats that
// Dez stores. mp3 is the default when the list has it (the smallest file),
// else wav (a file that plays), else the first. None with no list, or with
// no stored format: the request then asks for mp3 (`clips.request`).
// OpenRouter's entries list no formats, so its config has no path.
function openRouterSpeechFormat(entry: unknown, paths: MediaEntryPaths): ModelParameter[] {
  if (paths.speechFormats === undefined) return []
  const formats = listedValues(valueAtPath(entry, paths.speechFormats)).filter((format) => OPENROUTER_STORED_SPEECH_FORMATS.includes(format))
  const preferred = formats.includes('mp3') ? 'mp3' : formats.includes('wav') ? 'wav' : formats[0]
  return optionsParameter('response_format', 'Format', formats, preferred)
}

// The Speed row of a speech model whose entry tells its speeds, at the
// provider's `paths.speechSpeed` (`{ min, max, default }`): only for a
// real range. The request schema has `speed`, but OpenRouter's entries
// tell no range, so its config has no path.
// https://openrouter.ai/docs/api/api-reference/tts/create-speech
function openRouterSpeechSpeed(entry: unknown, paths: MediaEntryPaths): ModelParameter[] {
  const speed = entryValue(entry, paths.speechSpeed)
  return speedParameter(valueAtPath(speed, 'min'), valueAtPath(speed, 'max'), valueAtPath(speed, 'default'))
}

// The audio clip that an OpenRouter transcription model takes: one, as a
// form file. The docs: "The format is derived from the filename extension
// or the file part content type. Max 25 MB"; the types are those of the
// docs' list that Dez stores ("Supported formats vary by provider"). An
// entry can tell its own file formats, size, and length at the provider's
// `paths` (`transcriptionFormats`, a list of extension names such as
// `mp3`; `transcriptionMaxBytes`, a positive whole number;
// `transcriptionMaxSeconds`, a positive number); a value of another form
// counts as none. With a list that has `wav`, a clip of another type goes
// as a WAV copy (`needsWavCopy`).
// https://openrouter.ai/docs/api/api-reference/stt/create-transcription
function openRouterTranscriptionRules(entry: unknown, paths: MediaEntryPaths): InputClipRules {
  const names = listedValues(entryValue(entry, paths.transcriptionFormats))
  const listedTypes = names.flatMap((name) => {
    const type = typeof name === 'string' ? clipMediaTypeOfExtension(name) : null
    return type?.startsWith('audio/') ? [type] : []
  })
  const maxSeconds = positiveLimit(entryValue(entry, paths.transcriptionMaxSeconds), false)
  return {
    audio: {
      use: 'source',
      maxClips: 1,
      maxBytes: positiveLimit(entryValue(entry, paths.transcriptionMaxBytes), true) ?? 25 * 1024 ** 2,
      ...(maxSeconds !== undefined && { maxSeconds }),
      types: listedTypes.length > 0 ? [...new Set(listedTypes)] : ['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/mp4', 'audio/ogg', 'audio/aac'],
    },
  }
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
// no record of their own). A request with no resolution gets the model's
// own default, which an entry of TrustedRouter's image list tells
// (`supported_parameters.resolution.default`) and one of OpenRouter's does
// not (both checked 2026-11-21): its price is that of the default.
// https://trustedrouter.com/docs#media-discovery
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
  const ownDefault = valueAtPath(mediaEntry, 'supported_parameters.resolution.default')
  const resolution = values.resolution ?? (typeof ownDefault === 'string' && resolutions.includes(ownDefault.toLowerCase()) ? ownDefault : undefined)
  return (resolution === undefined ? undefined : prices.get(String(resolution).toLowerCase())) ?? prices.get(undefined)
}

// One price of an OpenRouter video model (a key and its value in
// `pricing_skus`, the model's entry of the video list), in USD: of each
// second of the video, of each video token, or of each input image. A key
// can name the resolution (lower case, as `480p` or `4k`) and the sound
// that its price is for; a key that names neither is for any. A
// `videoInput` price is only for a request with an input video clip.
interface OpenRouterVideoSku {
  key: string
  per: 'second' | 'token' | 'inputImage'
  usd: number
  resolution?: string
  audio?: boolean
  videoInput?: true
}

// The key forms whose rule Dez knows. The docs tell nothing of the keys
// ("Pricing SKUs with provider prefix stripped, values as strings"), so
// these are the forms of the live list (2026-11-13) whose names tell their
// rule; a key with `cents` in its name is in US cents. Any other key that
// costs something (a price of a long clip, of references, of an image to
// video or a text to video, a minimum, a price by megapixel) leaves the
// price of a request unknown: its rule is in no data.
// https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models
const OPENROUTER_VIDEO_SKU_FORMS: readonly { pattern: RegExp, per: OpenRouterVideoSku['per'], cents: boolean, videoInput?: true }[] = [
  { pattern: /^duration_seconds(?:_(?<audio>with|without)_audio)?(?:_(?<resolution>\d+[pk]))?$/, per: 'second', cents: false },
  { pattern: /^cents_per_video_output_second(?:_(?<resolution>\d+[pk]))?$/, per: 'second', cents: true },
  { pattern: /^cents_per_second_output(?:_(?<resolution>\d+[pk]))?$/, per: 'second', cents: true },
  { pattern: /^cents_per_second_video_continuation(?:_(?<resolution>\d+[pk]))?$/, per: 'second', cents: true, videoInput: true },
  { pattern: /^video_tokens(?:_(?<resolution>\d+[pk]))?(?:_(?<audio>with|without)_audio)?(?<videoInput>_with_video_input)?$/, per: 'token', cents: false },
  { pattern: /^cents_per_image_input$/, per: 'inputImage', cents: true },
]

// The size of a video by which OpenRouter estimates the video tokens of a
// request before it runs: "(width x height x fps x duration) / 1024 video
// tokens at 24 fps", with "the standard dimensions for each resolution
// tier" whatever the aspect ratio; the final charge comes from the tokens
// of the video that the model makes. The blog names 854x480 and 1280x720;
// its Seedance 2.0 prices at 1080p ($0.374 a second) and 4K ($0.778) fit
// 1920x1080 and 3840x2160.
// https://openrouter.ai/blog/insights/seedance-2-5-review/
const OPENROUTER_TOKEN_FRAME_PIXELS: Readonly<Record<string, number>> = {
  '480p': 854 * 480,
  '720p': 1280 * 720,
  '1080p': 1920 * 1080,
  '4k': 3840 * 2160,
}
const OPENROUTER_TOKEN_FPS = 24
const OPENROUTER_PIXELS_PER_TOKEN = 1024

// The price `price` (a number of the key's unit) of `key` in
// `pricing_skus`; null for a key of no known form.
function openRouterVideoSku(key: string, price: number): OpenRouterVideoSku | null {
  for (const form of OPENROUTER_VIDEO_SKU_FORMS) {
    const match = form.pattern.exec(key)
    if (!match) continue
    const { resolution, audio, videoInput } = match.groups ?? {}
    return {
      key,
      per: form.per,
      usd: form.cents ? price / 100 : price,
      ...(resolution !== undefined && { resolution }),
      ...(audio !== undefined && { audio: audio === 'with' }),
      ...((form.videoInput || videoInput !== undefined) && { videoInput: true as const }),
    }
  }
  return null
}

// The error of a video price that Dez cannot compute: why, then `where`,
// the sentence that tells the calling model where the prices are, so that
// it can read them itself.
function videoPriceError(reason: string, where: string): { error: string } {
  return { error: `Dez cannot compute the price of a request with these values: ${reason}. ${where}` }
}

// The sound of a video request, in the text of a price error.
function soundText(sound: boolean | undefined): string {
  return sound === undefined ? '' : sound ? ', with sound' : ', no sound'
}

// The length in seconds of a video request with `values`, for a price by
// the length; an error (`videoPriceError`) when the request has none.
function videoPriceSeconds(values: ParameterValues, where: string): number | { error: string } {
  const seconds = values.duration
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : videoPriceError('the price is by the length, and the request has no length (`duration`)', where)
}

// The sound of the videos of an OpenRouter-format video model: `choice`
// when a request can turn it on or off (the Audio switch), else whether
// they have sound; undefined when its entry tells nothing. The provider's
// own sound mode (`videoAudioMode`, config.ts) wins over the `generate_audio`
// flag of OpenRouter's video list, which is true for a model that can make
// sound. A request of a `choice` model with no `generate_audio` field gets
// sound in both: OpenRouter's field "Defaults to the endpoint's
// generate_audio capability flag", and every TrustedRouter model with
// `configurable` sound had `generate_audio.default: true` in
// `trustedrouter.media.parameters` (2026-11-21).
// https://openrouter.ai/docs/api/api-reference/video-generation/create-videos
// https://trustedrouter.com/docs#media-discovery
function openRouterVideoSound(mediaEntry: unknown, paths: MediaEntryPaths): boolean | 'choice' | undefined {
  if (paths.videoAudioMode !== undefined) {
    const mode = valueAtPath(mediaEntry, paths.videoAudioMode)
    return mode === 'configurable' ? 'choice' : mode === 'always' ? true : mode === 'none' ? false : undefined
  }
  const flag = valueAtPath(mediaEntry, 'generate_audio')
  return flag === true ? 'choice' : flag === false ? false : undefined
}

// Whether the video of a request with `values` has sound: the Audio
// switch, else the sound of the model (`openRouterVideoSound`).
function openRouterRequestSound(values: ParameterValues, mediaEntry: unknown, paths: MediaEntryPaths): boolean | undefined {
  if (typeof values.generate_audio === 'boolean') return values.generate_audio
  const sound = openRouterVideoSound(mediaEntry, paths)
  return sound === 'choice' ? true : sound
}

// The price in USD of one OpenRouter video request with `values` and no
// input image or clip, from the model's prices (`pricing_skus`), with the
// rate that applies, the price of each input image (when the model has
// one), and all the prices of the model. Undefined for a model with no
// prices.
//
// Of the prices of a second or a token that fit the request (the
// resolution and the sound of `values`, else any), the ones that name the
// most of the two apply: `duration_seconds_480p` over `duration_seconds`.
// With two things to name, these are the ones that no other fitting price
// names more of. Two that each name what the other leaves open
// (`video_tokens_1080p` and `video_tokens_without_audio` for a 1080p video
// with no sound) leave the price unknown when they differ, as no data
// tells which one applies. A price never comes from a guess: any key whose
// rule Dez does not know gives an error that tells the calling model to
// read the prices itself.
//
// A request with no `generate_audio` field gets the sound of the model
// (`openRouterRequestSound`): a model with no Audio switch makes its videos
// always or never with sound.
function skuVideoPrice(values: ParameterValues, mediaEntry: unknown, paths: MediaEntryPaths): { usd: number, rate: OpenRouterVideoSku, inputImageUsd?: number, skus: OpenRouterVideoSku[] } | { error: string } | undefined {
  const table = valueAtPath(mediaEntry, 'pricing_skus')
  if (!isRecord(table)) return undefined
  const where = 'The prices are in `pricing_skus` of `mediaEntry` (a key with `cents` in its name is in US cents); the zeros of `pricing` in `providerEntry` are no price.'
  const skus: OpenRouterVideoSku[] = []
  const unknownKeys: string[] = []
  for (const [key, value] of Object.entries(table)) {
    const price = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    const sku = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? openRouterVideoSku(key, price) : null
    if (sku) skus.push(sku)
    // A price of 0 adds nothing to a request, whatever its rule.
    else if (price !== 0) unknownKeys.push(`\`${key}\``)
  }
  if (unknownKeys.length > 0) return videoPriceError(`no data tells the rule of the prices ${unknownKeys.join(', ')}`, where)
  if (skus.length === 0) return undefined

  const resolution = typeof values.resolution === 'string' ? values.resolution.toLowerCase() : undefined
  const audio = openRouterRequestSound(values, mediaEntry, paths)
  const fits = skus.filter((sku) => sku.per !== 'inputImage' && !sku.videoInput
    && (sku.resolution === undefined || sku.resolution === resolution)
    && (sku.audio === undefined || sku.audio === audio))
  const namedCounts = fits.map((sku) => Number(sku.resolution !== undefined) + Number(sku.audio !== undefined))
  const best = fits.filter((_, index) => namedCounts[index] === Math.max(...namedCounts))
  const request = `${resolution ?? 'no resolution'}${soundText(audio)}`
  if (best.length === 0) return videoPriceError(`no price fits a request of ${request}`, where)
  if (new Set(best.map((sku) => `${sku.per} ${sku.usd}`)).size > 1) {
    return videoPriceError(`the prices ${best.map((sku) => `\`${sku.key}\``).join(', ')} each fit a request of ${request}, and no data tells which one applies`, where)
  }

  const rate = best[0]
  const seconds = videoPriceSeconds(values, where)
  if (typeof seconds !== 'number') return seconds
  let usd = rate.usd * seconds
  if (rate.per === 'token') {
    const pixels = ownEntry(OPENROUTER_TOKEN_FRAME_PIXELS, resolution)
    if (pixels === undefined) return videoPriceError(`the price is by video token, and Dez does not know the size in pixels of a video of ${resolution ?? 'no resolution'}`, where)
    usd *= pixels * OPENROUTER_TOKEN_FPS / OPENROUTER_PIXELS_PER_TOKEN
  }
  const inputImage = skus.find((sku) => sku.per === 'inputImage' && sku.usd > 0)
  return { usd: roundedUsd(usd), rate, ...(inputImage && { inputImageUsd: roundedUsd(inputImage.usd) }), skus }
}

// The total in USD of a request of `seconds` by one price example of a
// route (`routeVideoPrice`); undefined when the example tells none for
// that length. No live entry had `usd_by_duration` (2026-11-21), and the
// docs do not show its form: Dez reads it as totals by the seconds of the
// length, and any other form gives no price, never a price by the second.
function routeExampleTotal(example: Record<string, unknown>, seconds: number): number | undefined {
  if (example.usd_by_duration !== undefined) {
    return isRecord(example.usd_by_duration) ? priceNumber(example.usd_by_duration[String(seconds)]) : undefined
  }
  const perSecond = priceNumber(example.usd_per_second)
  if (perSecond !== undefined && Array.isArray(example.priced_durations) && example.priced_durations.includes(seconds)) return perSecond * seconds
  return example.duration === seconds ? priceNumber(example.cost_usd) : undefined
}

// The price in USD of one video request with `values` and only a prompt,
// from a provider's prices by route at `pricesPath` of the model's entry
// (`videoRoutePrices`, config.ts): TrustedRouter's `pricing.routes` of its
// video list. Undefined for a model with no prices there: "an empty route
// map means no prepaid price is available".
//
// The prices are "by prepaid provider route". The route of a request is
// the one that `videoRoute` names when the prices have it, else the one
// route of the prices; with more routes and none named, the route is
// unknown, and so is the price. Two live jobs with no `provider` field
// (2026-11-21) went to such a route and cost its price: Wan 2.7 to
// `alibaba`, which `trustedrouter.provider` names (its prices also have
// `venice`), and Veo 3.1 Fast to `google-vertex`, the one route of its
// prices, though `trustedrouter.provider` names `google-ai-studio`.
//
// The prices of a route are `{ unit: 'job', examples }`. An example is
// "the total for the exact settings shown" (`cost_usd` for its
// `duration`, `resolution`, `generate_audio`, and `input_mode`), with the
// price of a second (`usd_per_second`) for each length of
// `priced_durations`, or the exact totals by length (`usd_by_duration`)
// "where rounding or a minimum applies". An example fits a request of its
// resolution and sound, with only a prompt (`input_mode: text`): "Match
// the provider, resolution, audio and input mode". Fitting examples with
// other prices leave the price unknown, and so does a route that "quotes
// each job" (`status: live_quote`) or that bills by another unit (a price
// of a million output tokens: no data tells the tokens of a video).
// "Neither means free."
// https://trustedrouter.com/docs#media-discovery
function routeVideoPrice(values: ParameterValues, mediaEntry: unknown, paths: MediaEntryPaths, pricesPath: string): { usd: number, byRoute: true } | { error: string } | undefined {
  const routes = valueAtPath(mediaEntry, pricesPath)
  if (!isRecord(routes)) return undefined
  const names = Object.keys(routes)
  if (names.length === 0) return undefined
  const where = `The prices by route are in \`${pricesPath}\` of \`mediaEntry\`.`
  const named = entryValue(mediaEntry, paths.videoRoute)
  const route = typeof named === 'string' && Object.hasOwn(routes, named) ? named : names.length === 1 ? names[0] : undefined
  if (route === undefined) return videoPriceError(`the prices are by route (${names.map((name) => `\`${name}\``).join(', ')}), and no data tells which route the request takes`, where)
  const prices = routes[route]
  if (valueAtPath(prices, 'status') === 'live_quote') return videoPriceError(`the route of the request (\`${route}\`) tells its price only when it runs the job (\`live_quote\`)`, where)
  const unit = valueAtPath(prices, 'unit')
  if (unit !== 'job') {
    return videoPriceError(`the route of the request (\`${route}\`) bills by ${typeof unit === 'string' ? `the unit \`${unit}\`` : 'a unit that no data tells'}, and no data tells how many of them a video takes`, where)
  }

  const seconds = videoPriceSeconds(values, where)
  if (typeof seconds !== 'number') return seconds
  const resolution = typeof values.resolution === 'string' ? values.resolution.toLowerCase() : undefined
  const sound = openRouterRequestSound(values, mediaEntry, paths)
  const examples = valueAtPath(prices, 'examples')
  const fits = (Array.isArray(examples) ? examples : []).filter(isRecord).filter((example) => (example.input_mode === undefined || example.input_mode === 'text')
    && (example.resolution === undefined || (typeof example.resolution === 'string' && example.resolution.toLowerCase() === resolution))
    && (example.generate_audio === undefined || example.generate_audio === sound))
  const totals = new Set(fits.flatMap((example) => {
    const total = routeExampleTotal(example, seconds)
    return total === undefined ? [] : [roundedUsd(total)]
  }))
  const request = `${seconds} s, ${resolution ?? 'no resolution'}${soundText(sound)}, and only a prompt (\`input_mode\` \`text\`)`
  if (totals.size === 0) return videoPriceError(`no price of the route \`${route}\` fits a request of ${request}`, where)
  if (totals.size > 1) return videoPriceError(`the route \`${route}\` has several prices that fit a request of ${request}, and no data tells which one applies`, where)
  return { usd: [...totals][0], byRoute: true }
}

// The length and the resolution of a video request, for the note of its
// list price.
function videoValuesText(values: ParameterValues): string[] {
  return [`${String(values.duration)} s`, ...(values.resolution === undefined ? [] : [String(values.resolution)])]
}

// The price in USD of one OpenRouter-format video request with `values`
// and no input image or clip: by route, for a provider whose config has a
// path to such prices (`routeVideoPrice`; the model's `pricing_skus` are
// then not read), else from `pricing_skus` (`skuVideoPrice`).
function openRouterVideoRequestPrice(values: ParameterValues, mediaEntry: unknown, paths: MediaEntryPaths): ReturnType<typeof skuVideoPrice> | ReturnType<typeof routeVideoPrice> {
  return paths.videoRoutePrices === undefined
    ? skuVideoPrice(values, mediaEntry, paths)
    : routeVideoPrice(values, mediaEntry, paths, paths.videoRoutePrices)
}

// The price of one OpenRouter-format video request for the model that
// reads `model_info` (`openRouterVideoRequestPrice`), with a note of the
// estimate and of the prices of input images and clips.
function openRouterVideoPrice(values: ParameterValues, mediaEntry: unknown, paths: MediaEntryPaths): ClipEntryPrice | undefined {
  const price = openRouterVideoRequestPrice(values, mediaEntry, paths)
  if (price === undefined || 'error' in price) return price
  if ('byRoute' in price) {
    return { usd: price.usd, note: '`usd` is for a request with only a prompt (`input_mode` `text`): a request with an input image or clip can have another price.' }
  }
  const { usd, rate, inputImageUsd, skus } = price
  const notes = [
    ...(rate.per === 'token'
      ? ['The provider bills by video tokens: `usd` is its estimate for a video of the standard size of the resolution, and the charge comes from the video that the model makes, so it can differ (for example with another aspect ratio).']
      : []),
    ...(inputImageUsd === undefined ? [] : [`\`usd\` is for a request with no input image: each input image adds ${inputImageUsd} USD.`]),
    ...(skus.some((sku) => sku.videoInput) ? ['`usd` is for a request with no input video clip: with one, the price is another one, which Dez cannot compute.'] : []),
  ]
  return { usd, ...(notes.length > 0 && { note: notes.join(' ') }) }
}

// The price of a speech or transcription model at the provider's paths,
// for an API whose main list has rates that OpenRouter's does not: per
// character of the text of a speech request (`speechCharacterPrice`), per
// minute of the clip of a transcription (`transcriptionMinutePrice`, as a
// price per second), or per request, whatever the length of the text or
// the clip (`requestPrice`, as a price per clip). None when the entry has
// no such rate.
// https://trustedrouter.com/docs#media-discovery
function openRouterAudioRatePrice(kind: 'tts' | 'transcription', entry: unknown, paths: MediaEntryPaths): ModelPrice | undefined {
  const rate = (path: string | undefined) => priceNumber(entryValue(entry, path))
  const perCharacter = kind === 'tts' ? rate(paths.speechCharacterPrice) : undefined
  if (perCharacter !== undefined) return unitPrice('character', perCharacter * 1_000_000)
  const perMinute = kind === 'transcription' ? rate(paths.transcriptionMinutePrice) : undefined
  if (perMinute !== undefined) return unitPrice('second', perMinute / 60)
  return unitPrice('clip', rate(paths.requestPrice))
}

// The list price of an OpenRouter-format model of a media kind. A video:
// the price of one clip for the default values (the shortest length, the
// lowest resolution, the sound of the Audio switch) and only a prompt; for
// prices from `pricing_skus`, the note names the price of each input
// image, if any. Speech and transcription: the rates at the provider's
// paths (`openRouterAudioRatePrice`), else the rates of the main list
// (`pricing`), which are per character of the text (`prompt`), or per
// second of the clip (speech: `completion`, with no `prompt` price;
// transcription: `prompt`, with no `completion` price), or, with both,
// per token. An image-only model gets none: the main list has only its
// price per output token, and its price per image is in its endpoint
// records, a request of its own (`ImageQuoteFormat`).
// https://openrouter.ai/docs/guides/overview/multimodal/tts
// https://openrouter.ai/docs/guides/overview/multimodal/stt
function openRouterListPrice(kind: MediaKind, values: ParameterValues, entry: unknown, mediaEntry: unknown, paths: MediaEntryPaths): ModelPrice | undefined {
  switch (kind) {
    case 'video':
    case 'imageToVideo': {
      const price = openRouterVideoRequestPrice(values, mediaEntry, paths)
      if (price === undefined || 'error' in price) return undefined
      if ('byRoute' in price) return unitPrice('clip', price.usd, videoValuesText(values).join(', '))
      const options = [...videoValuesText(values), ...(price.rate.per === 'token' ? ['estimate'] : [])]
      const notes = [options.join(', '), ...(price.inputImageUsd === undefined ? [] : [`+${usdText(price.inputImageUsd)} per input image`])]
      return unitPrice('clip', price.usd, notes.join('; '))
    }
    case 'tts':
    case 'transcription': {
      const rate = openRouterAudioRatePrice(kind, entry, paths)
      if (rate) return rate
      const input = priceNumber(valueAtPath(entry, 'pricing.prompt'))
      const output = priceNumber(valueAtPath(entry, 'pricing.completion'))
      if (input === undefined || output === undefined) return undefined
      if (input > 0 && output > 0) return { unit: 'token', input: roundedPrice(input * 1_000_000), output: roundedPrice(output * 1_000_000) }
      if (kind === 'tts') return output > 0 ? unitPrice('second', output) : unitPrice('character', input * 1_000_000)
      return output > 0 ? undefined : unitPrice('second', input)
    }
    default:
      return undefined
  }
}

// A price in USD with no float noise (`0.30000000000000004`): no price of
// a provider has more than six decimal places of a dollar.
function roundedUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
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
    // A model whose list holds only types that Dez does not store: its
    // answer would be a file that Dez cannot keep, at the full price. On
    // 2026-11-11 no model did (the Recraft vector models list only `svg`).
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
            input_references: images.map(openRouterImageItem),
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
      return { media: images.map((image) => generatedBase64Image(isRecord(image) ? image.b64_json : undefined)), ...openRouterAnswerCost(data) }
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
    parameters: (kind, entry, mediaEntry, paths) => {
      switch (kind) {
        case 'tts': {
          // `voice` is a text for every model ("Voice identifier
          // (provider-specific)", no list in the request's schema), and no
          // field of an entry tells that its `supported_voices` list is
          // complete. Some lists are not: the ElevenLabs models also take
          // "its ElevenLabs voice ID as `voice`", a MiniMax model "accepts
          // arbitrary MiniMax voice IDs" (its description), and the Fish
          // Audio and Seed Audio models list no voice and take a voice id
          // of the provider. Only the Azure models have a list that the
          // docs call full. So every voice list takes another text, and a
          // model with no list gets a voice with no option: a refusal of
          // the provider costs nothing ("failed generations are not
          // billed"), and a closed list in Dez would stop a voice that
          // works. Checked 2026-11-15.
          // A request with no `voice` goes only to the providers that have
          // a default voice, so the first voice is the default.
          // https://openrouter.ai/docs/api/api-reference/tts/create-speech
          // https://openrouter.ai/docs/guides/overview/multimodal/tts
          // https://openrouter.ai/blog/announcements/elevenlabs-on-openrouter/
          const voices = listedValues(valueAtPath(entry, 'supported_voices'))
          return [...optionsParameter('voice', 'Voice', voices, voices[0], true), ...openRouterSpeechFormat(entry, paths), ...openRouterSpeechSpeed(entry, paths)]
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
            // The switch is for a model whose videos can have sound or
            // not (`openRouterVideoSound`), on by default, as for Venice: a
            // request with no field gets sound.
            ...switchParameter('generate_audio', 'Audio', openRouterVideoSound(mediaEntry, paths) === 'choice', true),
            ...optionsParameter(OPENROUTER_IMAGES_AS, 'Images as', imagesAs, imagesAs[0]),
          ]
        }
        case 'music':
        case 'videoToVideo':
        case 'voiceChange':
          return []
      }
    },
    // The most characters of the text of a speech request, when the entry
    // tells it at the provider's `paths.speechMaxCharacters`. OpenRouter's
    // entries tell none, so its config has no path.
    textRules: (kind, entry, _mediaEntry, paths) => {
      const maxPromptLength = kind === 'tts' ? positiveLimit(entryValue(entry, paths.speechMaxCharacters), true) : undefined
      return maxPromptLength === undefined ? undefined : { maxPromptLength }
    },
    request: (kind, baseUrl, modelId, { prompt, images, clips = [], values }) => {
      const base = trimTrailingSlashes(baseUrl)
      switch (kind) {
        case 'tts': {
          // The answer is the audio. The default format is raw PCM, which
          // no player plays, so the request asks for mp3, or the format of
          // the model's Format row (`openRouterSpeechFormat`), last in the
          // body as `mp3` was before the row came. A few models make only
          // PCM (Gemini TTS, HeyGen Voice) and answer 400 to mp3; no field
          // of an OpenRouter entry tells which, so the provider's config
          // names them and gives them `pcm` in place of `mp3`
          // (`mediaApi.modelRequestBodies`), and the refusal of a new one
          // sends the request again with `pcm` (`refusalBody`).
          // https://openrouter.ai/docs/guides/overview/multimodal/tts
          const { response_format: format = 'mp3', ...fields } = values
          return { url: `${base}/audio/speech`, body: { ...fields, model: modelId, input: prompt, response_format: format } }
        }
        case 'video':
        case 'imageToVideo': {
          // A request with no length gets the provider's default length,
          // which can cost many times the shortest one. So a model whose
          // lengths Dez does not know (the video list does not have it, or
          // the list did not load) gets no request. Such a model has no
          // `images_as` value either: only a model of the loaded video list
          // has that parameter, and it always has a default.
          // A model of the list whose entry tells no lengths
          // (`supported_durations` null or absent) takes no length, so its
          // request goes with none, at the provider's default length:
          // `duration` is no required field of the request. Its price is
          // then unknown. OpenRouter's models that change a video of the
          // user (`runway/aleph-2`; their pages send no length) are such
          // models (checked 2026-11-15).
          // https://openrouter.ai/docs/api/api-reference/video-generation/create-videos
          // https://openrouter.ai/runway/aleph-2/llms.txt
          // The images are frames of the video (`frame_images`) or
          // references (`input_references`), as the user chose
          // (OPENROUTER_IMAGES_AS), each as a data URL; never both. Any
          // value but `references` (a cache from before the parameter) sends
          // frames, which the model's image rules then count.
          // The clips are references too (`audio_url`, `video_url` items),
          // each by its web address (`clipRules`). A request with a clip
          // sends its images as references whatever the user chose: "If
          // both fields are provided, frame_images takes precedence and the
          // request is treated as image-to-video", which would drop the
          // clips. Its images stay as many as the rules of the user's
          // choice take.
          // https://openrouter.ai/docs/guides/overview/multimodal/video-generation
          // https://openrouter.ai/docs/cookbook/video-generation/image-to-video
          // https://openrouter.ai/docs/cookbook/video-generation/reference-to-video
          const { [OPENROUTER_IMAGES_AS]: imagesAs, ...fields } = values
          if (fields.duration === undefined && imagesAs === undefined) throw new ExplainedError(NO_VIDEO_LENGTH_MESSAGE)
          const imageUrls = images.map(openRouterImageItem)
          const clipUrls = clips.map((clip) => (clip.kind === 'audio'
            ? { type: 'audio_url', audio_url: { url: clipUrl(clip) } }
            : { type: 'video_url', video_url: { url: clipUrl(clip) } }))
          const references = [...imageUrls, ...clipUrls]
          return {
            url: `${base}/videos`,
            body: {
              ...fields,
              model: modelId,
              prompt,
              ...(references.length > 0 && (imagesAs === OPENROUTER_AS_REFERENCES || clipUrls.length > 0
                ? { input_references: references }
                : { frame_images: OPENROUTER_FRAMES.slice(0, imageUrls.length).map((frame, index) => ({ ...imageUrls[index], frame_type: frame })) })),
            },
          }
        }
        case 'music':
          throw new ExplainedError('This provider has no music request that Dez can use. Choose another model.')
        case 'videoToVideo':
          throw new ExplainedError('This provider has no video-to-video request that Dez can use. Choose another model.')
        case 'voiceChange':
          throw new ExplainedError('This provider has no voice changer request that Dez can use. Choose another model.')
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
        resume: { id },
        poll: { url: jobUrl },
        state: (poll) => {
          const status = isRecord(poll) ? poll.status : undefined
          if (status === 'pending' || status === 'in_progress') return 'running'
          if (!isRecord(poll) || status !== 'completed') {
            // `failed`, `cancelled`, `expired`, or a state that is new.
            throw new JobNotMadeError(jobStateText(status, isRecord(poll) ? poll.error : undefined))
          }
          const url = Array.isArray(poll.urls) ? poll.urls[0] : undefined
          // A time that a Date cannot hold has no ISO text for the clip's
          // tag; the content endpoint then gives the clip.
          const expires = typeof poll.expires_at === 'number' ? poll.expires_at * 1000 : Number.NaN
          if (isClipUrl(url) && !Number.isNaN(new Date(expires).getTime())) {
            // The docs name no type for the stored copy; every example is
            // an mp4 file.
            return { url, mediaType: 'video/mp4', expires, ...openRouterAnswerCost(poll) }
          }
          return { download: { url: `${jobUrl}/content?index=0` }, ...openRouterAnswerCost(poll) }
        },
      }
    },
    // The video list gives each model's prices (`pricing_skus`), or the
    // provider's prices by route (`videoRoutePrices`, config.ts); a
    // request of a model with an input image or clip can have prices of
    // its own, which `openRouterVideoPrice` tells only in a note. A speech
    // model with a price per request (`requestPrice`) costs that, whatever
    // the values; one with a price per character has no entry price, as
    // its price needs the text (`textLengthCost`, modelPrices.ts).
    entryPrice: (kind, values, entry, mediaEntry, paths) => {
      if (kind === 'video' || kind === 'imageToVideo') return openRouterVideoPrice(values, mediaEntry, paths)
      const price = kind === 'tts' ? openRouterAudioRatePrice(kind, entry, paths) : undefined
      return price?.unit === 'clip' ? { usd: price.usd } : undefined
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
    if ((kind !== 'video' && kind !== 'imageToVideo') || !isRecord(mediaEntry)) return undefined
    const frames = openRouterFrameCount(mediaEntry)
    const references = { maxImages: OPENROUTER_MAX_REFERENCES, references: {} }
    if (frames === 0) return references
    return { maxImages: frames, whenParameter: { name: OPENROUTER_IMAGES_AS, value: OPENROUTER_AS_REFERENCES, rules: references } }
  },
  // A video model takes the clip kinds that its entry in the provider's
  // model list names as inputs (`architecture.input_modalities`: `audio`,
  // `video`), as references (`input_references`), each only by its web
  // address: a data URL gets a 400 ("Invalid reference URL:
  // input_references[0].audio_url.url: Only HTTPS URLs are allowed";
  // `video_url` the same, 2026-11-11). The docs tell no count, length,
  // type, size, or prompt name, so the provider checks them.
  // A transcription model takes one audio clip as a form file
  // (`openRouterTranscriptionRules`).
  // https://openrouter.ai/docs/guides/overview/multimodal/video-generation
  clipRules: (kind, entry, _mediaEntry, paths) => {
    if (kind === 'transcription') return openRouterTranscriptionRules(entry, paths)
    if (kind !== 'video' && kind !== 'imageToVideo') return undefined
    const inputs = listedValues(valueAtPath(entry, 'architecture.input_modalities'))
    const rules: InputClipRules = {
      ...(inputs.includes('audio') && { audio: { use: 'reference', urlOnly: true } }),
      ...(inputs.includes('video') && { video: { use: 'reference', urlOnly: true } }),
    }
    return rules.audio || rules.video ? rules : undefined
  },
  // The transcription endpoint takes a form (`model`, `file`), and answers
  // `{ text, usage }` (`response_format` `json`, its default). A form needs
  // no base64 copy of the clip, which the JSON body (`input_audio`) does.
  // It gives no times (`wordTimes`): only `verbose_json` holds them, and
  // only the "OpenAI-compatible providers" of a model give that.
  // https://openrouter.ai/docs/api/api-reference/stt/create-transcription
  texts: {
    request: (_kind, baseUrl, modelId, { clips = [] }) => ({
      url: `${trimTrailingSlashes(baseUrl)}/audio/transcriptions`,
      form: [{ name: 'model', value: modelId }, clipFormFile('file', sourceClip(clips))],
    }),
    parseResponse: (_kind, body) => {
      const data = jsonBody(body)
      return { text: transcriptText(data), ...openRouterAnswerCost(data) }
    },
  },
  listPrice: openRouterListPrice,
}

// The APIMart format is a module of its own (apimartFormat.ts), which
// imports only types of this one.
export const MEDIA_FORMATS: Record<MediaApiFormatId, MediaFormat> = {
  venice: veniceFormat,
  openrouter: openRouterFormat,
  apimart: apimartFormat,
}
