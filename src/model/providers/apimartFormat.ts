import { ExplainedError } from '../../utils/errorText'
import type { JsonObject } from '../../utils/json'
import { sanitizeErrorText } from '../../utils/protocol/errors'
import { imageExtension } from '../chat/images'
import { APIMART_AS_REFERENCES, APIMART_IMAGES_AS, APIMART_TIMED_TRANSCRIPTION_MODELS, APIMART_WHOLE_NUMBER_FIELDS, apimartImageModel, apimartMusicModel, apimartVideoModel, type ApimartVideoImages } from './apimartModels'
import { usageNumber } from './chatUsage'
import type { InputImageRules } from './clipImages'
import { cloneClipTextRules } from './clipText'
import { trimTrailingSlashes } from './config'
import { JobNotMadeError, UnusableAnswerError } from './errors'
import { clipFormFile, isClipUrl, jsonBody, lengthSeconds, listedValues, lowestFirstParameter, optionsParameter, resolutionLines, sourceClip, transcriptText, transcriptTimes } from './mediaFormatParts'
import type { AnswerCost, ClipInput, ImageJobFormat, ImageUploadFormat, MediaFormat } from './mediaFormats'
import { parameterTakes, type ModelParameter, type ParameterValues, type RangeParameter } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'

// The media format of APIMart (`mediaApi.format: 'apimart'`): image,
// video, and music requests as tasks, and transcriptions. An image, video,
// or music request starts a task, and Dez asks for its state until it
// ends. These endpoints take images and clips at web addresses (some image
// models also take images as data, but Dez sends none so): so Dez uploads
// each input image of a request first (`imageUpload`), and sends no clip
// to them. A transcription model gets its clip as the file of a form. The
// music models have no schema in the model list, so only the music models
// of the doc facts (`APIMART_MUSIC_MODELS`) take a request.
// https://docs.apimart.ai/en/api-reference/tasks/status (checked 2026-11-24)

// The fields of the general schema of the model list that get no row:
// those that Dez fills (`model`, `prompt`; the image fields of a model of
// the doc facts), those that Dez never sends (`webhook`: Dez asks for the
// state; `metadata`, `messages`, `url`, `from_task`; the image fields of
// another model, the mask of an edit, and the clip fields), and
// `multi_shot` and `sequential_image_generation`, which need a list or an
// object (`multi_prompt`, `sequential_image_generation_options`) that the
// panel cannot hold.
const UNSHOWN_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'prompt',
  'messages',
  'metadata',
  'webhook',
  'webhook_secret',
  'url',
  'from_task',
  'first_frame_image',
  'last_frame_image',
  'image_urls',
  'image_with_roles',
  'mask_url',
  'video_urls',
  'audio_urls',
  'multi_prompt',
  'multi_shot',
  'sequential_image_generation',
  'sequential_image_generation_options',
])

// The names of the rows of the schema fields whose request names do not
// tell them well. Any other row gets its field name, with spaces.
const SCHEMA_LABELS: ReadonlyMap<string, string> = new Map([
  ['duration', 'Length (seconds)'],
  ['generate_audio', 'Audio'],
])

function schemaLabel(name: string): string {
  const spaced = name.replaceAll('_', ' ')
  return SCHEMA_LABELS.get(name) ?? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

// A row with no list that takes one line of text.
function textParameter(name: string): ModelParameter[] {
  return optionsParameter(name, schemaLabel(name), [], undefined, true)
}

// A list of a schema that holds a value in two cases (`2K`, `2k`) gives
// one option, the first one.
function withoutCaseCopies(list: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  return list.filter((value) => {
    if (typeof value !== 'string') return true
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// The row of one field of a model's schema (JSON Schema), only when the
// schema states it safely: a list (`enum`) gives its options, a boolean a
// switch, a number with both limits a range, and a text a text field. A
// whole number with no upper limit is a text field only for the fields of
// `APIMART_WHOLE_NUMBER_FIELDS`, which the request sends as numbers; so a
// text with no list in such a field gets no row. As in the other formats,
// a length or a resolution has its lowest value as its default
// (`lowestFirstParameter`); another field has the default of its schema,
// when the row takes it.
function schemaParameter(name: string, schema: Record<string, unknown>): ModelParameter[] {
  const label = schemaLabel(name)
  if (Array.isArray(schema.enum)) {
    const options = withoutCaseCopies(schema.enum)
    if (name === 'duration') return lowestFirstParameter(name, label, options, lengthSeconds)
    if (name === 'resolution') return lowestFirstParameter(name, label, options, resolutionLines)
    return optionsParameter(name, label, listedValues(options), schema.default)
  }
  switch (schema.type) {
    case 'boolean':
      return [{ name, label, ...(typeof schema.default === 'boolean' && { default: schema.default }) }]
    case 'string':
      return APIMART_WHOLE_NUMBER_FIELDS.has(name) ? [] : textParameter(name)
    case 'integer':
    case 'number': {
      const { minimum: min, maximum: max } = schema
      if (typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && Number.isFinite(max) && min < max) {
        const range: RangeParameter = { name, label, min, max, ...(schema.type === 'number' && { anyNumber: true as const }) }
        const defaultValue = name === 'duration' ? min : schema.default
        if (parameterTakes(range, defaultValue)) range.default = defaultValue
        return [range]
      }
      return schema.type === 'integer' && APIMART_WHOLE_NUMBER_FIELDS.has(name) ? textParameter(name) : []
    }
    default:
      return []
  }
}

// The rows of an image or a video model with no doc facts
// (`APIMART_IMAGE_MODELS`, `APIMART_VIDEO_MODELS`), from the schema of its
// entry (`parameters.input_schema.properties`).
function schemaParameters(entry: unknown): ModelParameter[] {
  const properties = valueAtPath(entry, 'parameters.input_schema.properties')
  if (!isRecord(properties)) return []
  return Object.entries(properties).flatMap(([name, schema]) => (UNSHOWN_SCHEMA_FIELDS.has(name) || !isRecord(schema) ? [] : schemaParameter(name, schema)))
}

const WHOLE_NUMBER_TEXT = /^-?\d+$/

// `values` as the request sends them, with the rows that gave them
// (`MediaInput.parameters`). A text in a field of
// `APIMART_WHOLE_NUMBER_FIELDS` that its row does not list is the text of
// a text row: it goes as the number. Throws for a text that is no whole
// number: the request would fail. A listed option goes as it is.
function sentValues(values: ParameterValues, parameters: readonly ModelParameter[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    if (!APIMART_WHOLE_NUMBER_FIELDS.has(name) || typeof value !== 'string') return [name, value]
    const row = parameters.find((parameter) => parameter.name === name)
    if (row && 'options' in row && row.options.includes(value)) return [name, value]
    const text = value.trim()
    if (!WHOLE_NUMBER_TEXT.test(text)) {
      throw new ExplainedError(`The parameter ${JSON.stringify(name)} of this model takes a whole number, not ${JSON.stringify(sanitizeErrorText(value, 40))}. Change its value.`)
    }
    return [name, Number(text)]
  }))
}

// The whole number of seconds of the length of a request: a number, or the
// text of one; undefined for none.
function wholeSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  return typeof value === 'string' && WHOLE_NUMBER_TEXT.test(value.trim()) ? Number(value.trim()) : undefined
}

// The most bytes of the file of a transcription request (the docs).
const MAX_TRANSCRIPTION_BYTES = 25 * 1024 ** 2

function refusedKind(): never {
  throw new ExplainedError('This provider has no request of this kind that Dez can use. Choose another model.')
}

// The URL of the task `taskId` of a request of `kind`: music tasks have
// their own endpoint. The URL is built from the id, never taken from a
// response: it gets the API key. `language=en` gives the reason of a
// failure in English.
function taskUrl(kind: 'image' | 'video' | 'music', baseUrl: string, taskId: string): string {
  const tasks = kind === 'music' ? 'music/tasks' : 'tasks'
  return `${trimTrailingSlashes(baseUrl)}/${tasks}/${encodeURIComponent(taskId)}?language=en`
}

// The id of the task that the answer to an image, video, or music request
// names: `{ code, data: [{ status: 'submitted', task_id }] }`. Undefined
// when it names none.
function submittedTaskId(data: unknown): string | undefined {
  const first = isRecord(data) && Array.isArray(data.data) ? data.data[0] : undefined
  const taskId = isRecord(first) ? first.task_id : undefined
  return typeof taskId === 'string' && taskId !== '' ? taskId : undefined
}

// The answer to a request cut down to the id of its task, which
// `submittedTaskId` reads (`ClipJob.resume`).
function taskResume(taskId: string): JsonObject {
  return { data: [{ task_id: taskId }] }
}

// What the answer to a poll of a task tells:
// `{ code, data: { status, cost, result, error } }`. `running` for a task
// that runs (with `unknownRuns`, also for the state `unknown`: a music task
// can tell it for a time, and the docs tell to keep its id and ask again),
// else the task when it is done. Throws a `JobNotMadeError` (of `made`)
// for a task that ended with nothing made, with the cost that the answer
// tells: a task that failed costs nothing (`cost` 0: APIMart gives the
// money back).
// https://docs.apimart.ai/en/api-reference/tasks/status
// https://docs.apimart.ai/en/api-reference/audios/suno/overview
function doneTask(answer: unknown, made: 'clip' | 'image', unknownRuns: boolean): 'running' | Record<string, unknown> {
  const task = isRecord(answer) ? answer.data : undefined
  const status = isRecord(task) ? task.status : undefined
  if (status === 'submitted' || status === 'pending' || status === 'processing' || (unknownRuns && status === 'unknown')) return 'running'
  if (isRecord(task) && status === 'completed') return task
  // `failed`, `cancelled`, or a state that is new. The texts come from the
  // provider and show in the details of the error toast.
  const message = valueAtPath(task, 'error.message')
  const reason = typeof message === 'string' && message !== '' ? `: ${sanitizeErrorText(message)}` : ''
  throw new JobNotMadeError(`State: ${typeof status === 'string' ? sanitizeErrorText(status, 40) : 'none'}${reason}`, usageNumber(valueAtPath(task, 'cost')), made)
}

// The price of a done task: `cost`, what APIMart took in USD for the whole
// task. Seedance settles its price by tokens a few seconds after the end,
// so a cost of 0 then is no price yet: the quote counts.
function taskCost(task: Record<string, unknown>): AnswerCost {
  const cost = usageNumber(task.cost)
  return cost !== undefined && cost > 0 ? { cost } : {}
}

// The URL of the video of a done task: `result.videos[0].url`, a list of
// one URL in a live answer of MiniMax-H3 (2026-11-24) and in the docs of
// Seedance 2.5 Flash, a text in the docs of MiniMax-H3.
// https://docs.apimart.ai/en/api-reference/videos/seedance-2-5-flash/generation
function videoFiles(task: Record<string, unknown>): [string] {
  const videos = valueAtPath(task, 'result.videos')
  const video: unknown = Array.isArray(videos) ? videos[0] : undefined
  const url = isRecord(video) && Array.isArray(video.url) ? video.url[0] : valueAtPath(video, 'url')
  if (!isClipUrl(url)) throw new UnusableAnswerError('The task is done, and its answer holds no video URL.')
  return [url]
}

// The URLs of the songs of a done music task: `audio_url` of each entry of
// `result.music` (two for a live Suno task, one for Flow Music, MP3 and
// M4A; 2026-11-24). Flow Music also gives a `wav_url`, which Dez does not
// copy. An entry with no usable URL is left out.
// https://docs.apimart.ai/en/api-reference/audios/suno/overview
// https://docs.apimart.ai/en/api-reference/audios/flow-music/query
function musicFiles(task: Record<string, unknown>): readonly [string, ...string[]] {
  const songs = valueAtPath(task, 'result.music')
  const urls = (Array.isArray(songs) ? songs : []).map((song) => valueAtPath(song, 'audio_url')).filter(isClipUrl)
  const [first, ...rest] = urls
  if (first === undefined) throw new UnusableAnswerError('The task is done, and its answer holds no song URL.')
  return [first, ...rest]
}

// The URLs of the images of a done image task: each `url` list of
// `result.images` (`{ url: [..], expires_at }` for each image, in the docs
// and in a live answer of gpt-image-2). A URL that is not usable is left
// out.
// https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation
function imageFiles(task: Record<string, unknown>): readonly [string, ...string[]] {
  const images = valueAtPath(task, 'result.images')
  const urls = (Array.isArray(images) ? images : []).flatMap((image): unknown[] => {
    const url = isRecord(image) ? image.url : undefined
    return Array.isArray(url) ? url : [url]
  }).filter(isClipUrl)
  const [first, ...rest] = urls
  if (first === undefined) throw new UnusableAnswerError('The task is done, and its answer holds no image URL.')
  return [first, ...rest]
}

// The image rules of a video model that takes images: a first and a last
// frame, or, when the user chooses references (`APIMART_IMAGES_AS`), as
// many references as the model takes. Copies, which share no object with
// the doc facts.
function videoImageRules(images: ApimartVideoImages): InputImageRules {
  return {
    maxImages: 2,
    size: { ...images.size },
    whenParameter: {
      name: APIMART_IMAGES_AS,
      value: APIMART_AS_REFERENCES,
      rules: { maxImages: images.maxReferences, size: { ...images.size }, references: { ...images.references } },
    },
  }
}

const FRAME_ROLES = ['first_frame', 'last_frame'] as const

// The image fields of a video request, with the web addresses of its
// uploaded images (`MediaInput.imageUrls`): the references, or the first
// and the last frame. The fields that a request with frames needs
// (`frameFields`) take the place of the values of the panel.
function videoImageFields(images: ApimartVideoImages | undefined, { imageUrls = [], imagesAsReferences }: ClipInput): Record<string, unknown> {
  if (imageUrls.length === 0) return {}
  if (imagesAsReferences) return { image_urls: [...imageUrls] }
  return {
    ...images?.frameFields,
    image_with_roles: imageUrls.slice(0, FRAME_ROLES.length).map((url, index) => ({ url, role: FRAME_ROLES[index] })),
  }
}

// The upload of an input image of a request (`imageUpload`). The field
// `retention_days` is a field of the query only, and 3 days is the one
// tier with free uploads: with no field, the default tier of the account
// goes, which can be a paid one. The Help panel tells the days.
// https://docs.apimart.ai/en/api-reference/uploads/images (checked
// 2026-11-25)
export const APIMART_UPLOAD_DAYS = 3

// Statuses of a refused upload whose body can tell its cause.
const TOO_MANY_UPLOADS = 429
const PAYMENT_REQUIRED = 402

// The upload answers `{ url, …, overage? }`: `overage` comes only for a
// charged upload (`charged`, `cost_usd`), so an answer with none was free.
// A refusal has a root `error` and can have a root `overage` that tells
// its cause: a 429 with `overage`, or with the type `rate_limit_exceeded`,
// tells that the free uploads are used up and that the account takes no
// paid one now; a 402 with the reason `insufficient_key_quota` tells the
// spending limit of the key. A 429 with the type `rate_limit_error` is the
// limit of requests in time.
// https://docs.apimart.ai/en/api-reference/uploads/images (checked
// 2026-11-25)
const imageUpload: ImageUploadFormat = {
  request: (baseUrl, { bytes, mediaType }, number) => ({
    url: `${trimTrailingSlashes(baseUrl)}/uploads/images?retention_days=${APIMART_UPLOAD_DAYS}`,
    form: [{ name: 'file', file: { bytes, mediaType, fileName: `image-${number}.${imageExtension(mediaType)}` } }],
  }),
  cost: (data) => {
    const overage = isRecord(data) ? data.overage : undefined
    if (!isRecord(overage) || overage.charged === false) return { cost: 0 }
    const cost = usageNumber(overage.cost_usd)
    return cost === undefined ? {} : { cost }
  },
  url: (data) => {
    const url = isRecord(data) ? data.url : undefined
    if (!isClipUrl(url)) throw new UnusableAnswerError('The answer to the image upload holds no web address.')
    return url
  },
  refusal: (status, body) => {
    const overage = isRecord(body) ? body.overage : undefined
    if (status === TOO_MANY_UPLOADS && (isRecord(overage) || valueAtPath(body, 'error.type') === 'rate_limit_exceeded')) return 'freeUploadsUsed'
    if (status === PAYMENT_REQUIRED && isRecord(overage) && overage.reason === 'insufficient_key_quota') return 'keySpendingLimit'
    return undefined
  },
}

// The most pixels of an input image: the upload takes at most 40 million,
// and Seedream 5.5 at most 36 million. The rule is of the request, not of
// a model, so the lower one counts for each model.
// https://docs.apimart.ai/en/api-reference/images/seedream-5-5/generation
const MAX_INPUT_IMAGE_PIXELS = 36_000_000

// The image requests (kind `image`; an edit is an image request with input
// images). The answer names a task, and a done task gives the URLs of its
// images, which end after about 24 hours, so Dez copies the files.
// https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation
// (checked 2026-11-25)
const images: ImageJobFormat = {
  parameters: (kind, entry) => {
    if (kind !== 'image') return []
    const known = apimartImageModel(valueAtPath(entry, 'id'))
    return known ? [...structuredClone(known.parameters)] : schemaParameters(entry)
  },
  request: (kind, baseUrl, modelId, { prompt, values, parameters, imageUrls = [] }) => {
    if (kind !== 'image') refusedKind()
    return {
      url: `${trimTrailingSlashes(baseUrl)}/images/generations`,
      body: { ...sentValues(values, parameters), ...(imageUrls.length > 0 && { image_urls: [...imageUrls] }), model: modelId, prompt },
    }
  },
  job: (_kind, baseUrl, _modelId, data) => {
    const taskId = submittedTaskId(data)
    if (taskId === undefined) throw new UnusableAnswerError('The answer to the image request names no task.')
    return {
      id: taskId,
      resume: taskResume(taskId),
      poll: { url: taskUrl('image', baseUrl, taskId) },
      state: (answer) => {
        const task = doneTask(answer, 'image', false)
        return task === 'running' ? task : { fileUrls: imageFiles(task), ...taskCost(task) }
      },
    }
  },
  inputImageSize: { image: { maxPixels: MAX_INPUT_IMAGE_PIXELS } },
  // The account's own price of the request, as `total_usd`, as for a clip
  // (`clips.quote`): the price of the resolution, the size, the quality,
  // and the count of images. It does not count the price of the input
  // images of a few models (Seedream 5.5, Kling) or of the moderation
  // check: the task's `cost` gives the real price. A model that APIMart
  // bills by tokens (MiniMax-H3 Image) has no price in the answer
  // (`total_usd` null), and a model with no price at all gets a refusal
  // (`no_valid_pricing`).
  quote: {
    priceRequest: (kind, baseUrl, modelId, values) => {
      if (kind !== 'image') return null
      const query = new URLSearchParams({ model: modelId })
      const priced = apimartImageModel(modelId)?.pricedResolutions
      for (const name of ['resolution', 'size', 'quality', 'n']) {
        const value = values[name]
        if (typeof value !== 'string' && typeof value !== 'number') continue
        if (name === 'resolution' && priced && !priced.includes(String(value))) continue
        query.set(name, String(value))
      }
      return { url: `${trimTrailingSlashes(baseUrl)}/pricing/model?${query.toString()}` }
    },
    usd: (_kind, _values, { answer }) => (isRecord(answer) ? usageNumber(answer.total_usd) : undefined),
  },
}

export const apimartFormat: MediaFormat = {
  images,
  imageUpload,
  clips: {
    parameters: (kind, entry) => {
      const modelId = valueAtPath(entry, 'id')
      if (kind === 'music') return [...structuredClone(apimartMusicModel(modelId)?.parameters ?? [])]
      if (kind !== 'video') return []
      const known = apimartVideoModel(modelId)
      return known ? [...structuredClone(known.parameters)] : schemaParameters(entry)
    },
    textRules: (kind, entry) => {
      const modelId = valueAtPath(entry, 'id')
      if (kind === 'music') {
        const music = apimartMusicModel(modelId)
        return music && cloneClipTextRules(music.textRules)
      }
      const maxPromptLength = kind === 'video' ? apimartVideoModel(modelId)?.maxPromptLength : undefined
      return maxPromptLength === undefined ? undefined : { maxPromptLength }
    },
    // A video request with no length gets the model's default length, and
    // its price is then unknown (`quote`). No `webhook`: Dez asks for the
    // state. `images_as` is a choice of Dez, not a field of the request.
    request: (kind, baseUrl, modelId, input) => {
      if (kind === 'music') {
        const music = apimartMusicModel(modelId)
        if (!music) throw new ExplainedError('Dez does not know the request fields of this music model. Choose another model.')
        return { url: `${trimTrailingSlashes(baseUrl)}/music/generations`, body: { ...music.body(input), model: modelId } }
      }
      if (kind !== 'video') refusedKind()
      const values = { ...input.values }
      delete values[APIMART_IMAGES_AS]
      return {
        url: `${trimTrailingSlashes(baseUrl)}/videos/generations`,
        body: { ...sentValues(values, input.parameters), ...videoImageFields(apimartVideoModel(modelId)?.images, input), model: modelId, prompt: input.prompt },
      }
    },
    // A done task gives the URLs of its files, which end after about 24
    // hours, so Dez copies the files.
    job: (kind, baseUrl, _modelId, data) => {
      const taskId = submittedTaskId(data)
      if ((kind !== 'video' && kind !== 'music') || taskId === undefined) throw new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.')
      return {
        id: taskId,
        resume: taskResume(taskId),
        poll: { url: taskUrl(kind, baseUrl, taskId) },
        state: (answer) => {
          const task = doneTask(answer, 'clip', kind === 'music')
          if (task === 'running') return task
          return { fileUrls: kind === 'music' ? musicFiles(task) : videoFiles(task), ...taskCost(task) }
        },
      }
    },
    // The account's own price of the request (APIMart's rules, with its
    // discounts), as `total_usd`. The request is free, with the key (a URL
    // that Dez builds), at most 60 each minute. The price does not count
    // the extra price of a few models (the sound of Kling, the moderation
    // check): the task's `cost` gives the real price.
    // - Video: the price of the length and the resolution. With no length
    //   the answer tells only the price of one second, so no request goes,
    //   and the price is unknown.
    // - Music: one price for each task. The answer reads `version` (the
    //   tier `custom` is the price of a custom model), but not `max_mode`,
    //   which doubles the price: `usd` doubles it, also for a request in
    //   which the mode leaves max mode out. A live Suno quote told $0.068
    //   for a task that cost $0.05 (2026-11-24): a quote over the price is
    //   the safe side of a money limit, and the cost of the task counts at
    //   the end.
    // https://docs.apimart.ai/en/api-reference/account/request-logs
    // (checked 2026-11-24)
    quote: {
      request: (kind, baseUrl, modelId, values) => {
        const query = new URLSearchParams({ model: modelId })
        if (kind === 'music') {
          const version = values.custom_model_id === undefined ? values.version : 'custom'
          if (typeof version === 'string') query.set('version', version)
        } else {
          const seconds = wholeSeconds(values.duration)
          if (kind !== 'video' || seconds === undefined) return null
          query.set('duration', String(seconds))
          if (typeof values.resolution === 'string') query.set('resolution', values.resolution)
        }
        return { url: `${trimTrailingSlashes(baseUrl)}/pricing/model?${query.toString()}` }
      },
      usd: (data, values) => {
        const usd = isRecord(data) ? usageNumber(data.total_usd) : undefined
        if (usd === undefined) throw new UnusableAnswerError('The answer holds no price.')
        return values.max_mode === true ? usd * 2 : usd
      },
    },
  },
  // The video models of the doc facts (`APIMART_VIDEO_MODELS`) take
  // images, and so do the image models of the doc facts
  // (`APIMART_IMAGE_MODELS`) and those whose schema tells the most images
  // (`image_urls.maxItems`). The schema of another model tells no image
  // rules.
  imageRules: (kind, entry) => {
    const modelId = valueAtPath(entry, 'id')
    if (kind === 'image') {
      const maxImages = apimartImageModel(modelId)?.maxImages ?? valueAtPath(entry, 'parameters.input_schema.properties.image_urls.maxItems')
      return typeof maxImages === 'number' && Number.isInteger(maxImages) && maxImages > 0 ? { maxImages } : undefined
    }
    const images = kind === 'video' ? apimartVideoModel(modelId)?.images : undefined
    return images && videoImageRules(images)
  },
  // A transcription model takes one audio clip, of the types of the docs
  // that Dez stores (mp3, mp4, m4a, wav; the docs also tell mpeg, mpga,
  // and webm). Another audio clip goes as a WAV copy (`needsWavCopy`).
  // https://docs.apimart.ai/en/api-reference/audios/whisper-1
  clipRules: (kind) => (kind === 'transcription'
    ? { audio: { use: 'source', maxClips: 1, maxBytes: MAX_TRANSCRIPTION_BYTES, types: ['audio/mpeg', 'audio/mp4', 'audio/wav'] } }
    : undefined),
  // The transcription endpoint takes a form (`file`, `model`,
  // `response_format`, `language`, `prompt`, `temperature`; Dez sends no
  // `language`, `prompt`, or `temperature`) and answers `{ text, usage }`
  // for `json`. The times of the words and the segments (`wordTimes`) need
  // `verbose_json` with two `timestamp_granularities[]` fields, which only
  // the models of `APIMART_TIMED_TRANSCRIPTION_MODELS` take; that answer
  // adds `duration`, `words` (`{ word, start, end }`), and `segments`
  // (`{ text, start, end, … }`). The answer tells no cost, only `usage`
  // (seconds or tokens), so the price of a transcription is unknown.
  // https://docs.apimart.ai/en/api-reference/audios/whisper-1 (and live
  // checks of whisper-1 and gpt-4o-mini-transcribe, 2026-11-24)
  texts: {
    request: (kind, baseUrl, modelId, { clips = [], wordTimes }) => {
      if (kind !== 'transcription') refusedKind()
      const timed = wordTimes === true && APIMART_TIMED_TRANSCRIPTION_MODELS.has(modelId)
      return {
        url: `${trimTrailingSlashes(baseUrl)}/audio/transcriptions`,
        form: [
          { name: 'model', value: modelId },
          { name: 'response_format', value: timed ? 'verbose_json' : 'json' },
          ...(timed ? [{ name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' }] : []),
          clipFormFile('file', sourceClip(clips)),
        ],
      }
    },
    parseResponse: (_kind, body) => {
      const data = jsonBody(body)
      const times = transcriptTimes(data, { words: 'words', segments: 'segments' })
      return { text: transcriptText(data), ...(times && { times }) }
    },
  },
}
