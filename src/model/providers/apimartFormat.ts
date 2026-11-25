import { ExplainedError } from '../../utils/errorText'
import { sanitizeErrorText } from '../../utils/protocol/errors'
import { APIMART_WHOLE_NUMBER_FIELDS, apimartMusicModel, apimartVideoModel } from './apimartModels'
import { usageNumber } from './chatUsage'
import { cloneClipTextRules } from './clipText'
import { trimTrailingSlashes } from './config'
import { ClipNotMadeError, UnusableAnswerError } from './errors'
import { isClipUrl, lengthSeconds, listedValues, lowestFirstParameter, optionsParameter, resolutionLines } from './mediaFormatParts'
import type { MediaFormat } from './mediaFormats'
import { parameterTakes, type ModelParameter, type ParameterValues, type RangeParameter } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'

// The media format of APIMart (`mediaApi.format: 'apimart'`): video and
// music requests as tasks. A request starts a task, and Dez asks for its
// state until it ends. Only the `video` and `music` request kinds: Dez
// sends APIMart no input image or clip (its API takes them only as web
// addresses). The music models have no schema in the model list, so only
// the music models of the doc facts (`APIMART_MUSIC_MODELS`) take a
// request.
// https://docs.apimart.ai/en/api-reference/tasks/status (checked 2026-11-24)

// The fields of the general schema of the model list that get no row:
// those that Dez fills (`model`, `prompt`), those that Dez never sends
// (`webhook`: Dez asks for the state; `metadata`, `messages`, `url`,
// `from_task`), the image and clip fields, and `multi_shot`, which needs
// `multi_prompt` (a list that the panel cannot hold).
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
  'video_urls',
  'audio_urls',
  'multi_prompt',
  'multi_shot',
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

// The row of one field of a model's schema (JSON Schema), only when the
// schema states it safely: a list (`enum`) gives its options, a boolean a
// switch, a number with both limits a range, and a text a text field. A
// whole number with no upper limit is a text field only for the fields of
// `APIMART_WHOLE_NUMBER_FIELDS`, which the request sends as numbers. As in
// the other formats, a length or a resolution has its lowest value as
// its default (`lowestFirstParameter`); another field has the default of
// its schema, when the row takes it.
function schemaParameter(name: string, schema: Record<string, unknown>): ModelParameter[] {
  const label = schemaLabel(name)
  if (Array.isArray(schema.enum)) {
    if (name === 'duration') return lowestFirstParameter(name, label, schema.enum, lengthSeconds)
    if (name === 'resolution') return lowestFirstParameter(name, label, schema.enum, resolutionLines)
    return optionsParameter(name, label, listedValues(schema.enum), schema.default)
  }
  switch (schema.type) {
    case 'boolean':
      return [{ name, label, ...(typeof schema.default === 'boolean' && { default: schema.default }) }]
    case 'string':
      return textParameter(name)
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

// The rows of a video model with no doc facts (`APIMART_VIDEO_MODELS`),
// from the schema of its entry (`parameters.input_schema.properties`).
function schemaParameters(entry: unknown): ModelParameter[] {
  const properties = valueAtPath(entry, 'parameters.input_schema.properties')
  if (!isRecord(properties)) return []
  return Object.entries(properties).flatMap(([name, schema]) => (UNSHOWN_SCHEMA_FIELDS.has(name) || !isRecord(schema) ? [] : schemaParameter(name, schema)))
}

const WHOLE_NUMBER_TEXT = /^-?\d+$/

// `values` as the request sends them: the text of a whole number in a
// field of `APIMART_WHOLE_NUMBER_FIELDS` (a text row) as the number. Throws
// for any other text in such a field: the request would fail.
function sentValues(values: ParameterValues): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    if (!APIMART_WHOLE_NUMBER_FIELDS.has(name) || typeof value !== 'string') return [name, value]
    const text = value.trim()
    if (!WHOLE_NUMBER_TEXT.test(text)) {
      throw new ExplainedError(`The parameter ${JSON.stringify(name)} of this model takes a whole number, not ${JSON.stringify(sanitizeErrorText(value, 40))}. Change its value.`)
    }
    return [name, Number(text)]
  }))
}

// The whole number of the length of a request, as `sentValues` sends it;
// undefined for none.
function wholeSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  return typeof value === 'string' && WHOLE_NUMBER_TEXT.test(value.trim()) ? Number(value.trim()) : undefined
}

function refusedKind(): never {
  throw new ExplainedError('This provider has no request of this kind that Dez can use. Choose another model.')
}

// The URL of the task `taskId` of a request of `kind`: music tasks have
// their own endpoint. The URL is built from the id, never taken from a
// response: it gets the API key. `language=en` gives the reason of a
// failure in English.
function taskUrl(kind: 'video' | 'music', baseUrl: string, taskId: string): string {
  const tasks = kind === 'music' ? 'music/tasks' : 'tasks'
  return `${trimTrailingSlashes(baseUrl)}/${tasks}/${encodeURIComponent(taskId)}?language=en`
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

export const apimartFormat: MediaFormat = {
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
    // state.
    request: (kind, baseUrl, modelId, input) => {
      if (kind === 'music') {
        const music = apimartMusicModel(modelId)
        if (!music) throw new ExplainedError('Dez does not know the request fields of this music model. Choose another model.')
        return { url: `${trimTrailingSlashes(baseUrl)}/music/generations`, body: { ...music.body(input), model: modelId } }
      }
      if (kind !== 'video') refusedKind()
      return { url: `${trimTrailingSlashes(baseUrl)}/videos/generations`, body: { ...sentValues(input.values), model: modelId, prompt: input.prompt } }
    },
    // The answer is `{ code, data: [{ status: 'submitted', task_id }] }`.
    // The poll answers `{ code, data: { status, cost, result, error } }`.
    // The URLs of the files end after about 24 hours, so Dez copies the
    // files. `cost` is what APIMart took in USD, for the whole task. A task
    // that failed costs nothing (`cost` 0: APIMart gives the money back),
    // and its error tells that cost (`ClipNotMadeError.cost`). A music task
    // can tell the state `unknown` for a time: the docs tell to keep its id
    // and ask again.
    // https://docs.apimart.ai/en/api-reference/tasks/status
    // https://docs.apimart.ai/en/api-reference/audios/suno/overview
    job: (kind, baseUrl, _modelId, data) => {
      const first = isRecord(data) && Array.isArray(data.data) ? data.data[0] : undefined
      const taskId = isRecord(first) ? first.task_id : undefined
      if ((kind !== 'video' && kind !== 'music') || typeof taskId !== 'string' || taskId === '') throw new UnusableAnswerError('The answer to the clip request is neither a clip nor a job.')
      return {
        id: taskId,
        poll: { url: taskUrl(kind, baseUrl, taskId) },
        state: (answer) => {
          const task = isRecord(answer) ? answer.data : undefined
          const status = isRecord(task) ? task.status : undefined
          if (status === 'submitted' || status === 'pending' || status === 'processing' || (kind === 'music' && status === 'unknown')) return 'running'
          if (!isRecord(task) || status !== 'completed') {
            // `failed`, `cancelled`, or a state that is new. The texts come
            // from the provider and show in the details of the error toast.
            const message = valueAtPath(task, 'error.message')
            const reason = typeof message === 'string' && message !== '' ? `: ${sanitizeErrorText(message)}` : ''
            throw new ClipNotMadeError(`State: ${typeof status === 'string' ? sanitizeErrorText(status, 40) : 'none'}${reason}`, usageNumber(valueAtPath(task, 'cost')))
          }
          const fileUrls = kind === 'music' ? musicFiles(task) : videoFiles(task)
          // Seedance settles its price by tokens a few seconds after the
          // end, so a cost of 0 then is no price yet: the quote counts.
          const cost = usageNumber(task.cost)
          return { fileUrls, ...(cost !== undefined && cost > 0 && { cost }) }
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
}
