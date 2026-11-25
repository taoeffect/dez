import { ExplainedError } from '../../utils/errorText'
import type { ClipTextRules } from './clipText'
import type { ClipInput } from './mediaFormats'
import type { ModelParameter, ParameterValues } from './modelParameters'

// What the doc page of an APIMart video model tells, and its entry in the
// model list does not: the entries of almost all video models hold the
// same general schema, with no option lists and no limits (checked
// 2026-11-24, 60 of 62 models). So the parameters of the models that the
// docs tell in full are here, and `apimartFormat` reads the schema only
// for the other models.
//
// The default of a length or a resolution is the lowest value, as in the
// other formats (`lowestFirstParameter`, mediaFormatParts.ts): Dez shows no
// price before a request, so with no choice a request asks for the
// cheapest clip. A row with no default sends no field until the user
// chooses a value, and the provider's own default applies.
export interface ApimartVideoModel {
  parameters: readonly ModelParameter[]
  // The most characters of the prompt, when the docs tell it.
  maxPromptLength?: number
}

// An integer field of the request with no list and no upper limit: a text
// row, which the request sends as a number (`apimartFormat`).
export const APIMART_WHOLE_NUMBER_FIELDS: ReadonlySet<string> = new Set(['duration', 'seed'])

const WATERMARK: ModelParameter = { name: 'watermark', label: 'Watermark' }

// APIMart checks the prompt and the input images with a moderation model
// before the task starts. This costs a small extra amount that the price
// request does not count.
const MODERATION_CHECK: ModelParameter = { name: 'nsfw_check', label: 'Moderation check' }

export const APIMART_VIDEO_MODELS: Readonly<Record<string, ApimartVideoModel>> = {
  // `aspect_ratio` has no default: a video from a prompt then gets 16:9,
  // and the docs list no `adaptive` for it. The image and clip fields are
  // left out: Dez sends APIMart no input image or clip.
  // https://docs.apimart.ai/en/api-reference/videos/minimax-h3/generation
  // (checked 2026-11-24)
  'MiniMax-H3': {
    parameters: [
      { name: 'duration', label: 'Length (seconds)', min: 4, max: 15, default: 4 },
      { name: 'resolution', label: 'Resolution', options: ['768P', '2K'], default: '768P' },
      { name: 'aspect_ratio', label: 'Aspect ratio', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
      WATERMARK,
      MODERATION_CHECK,
    ],
    maxPromptLength: 7000,
  },
  // `size` is the aspect ratio (the docs' default is `adaptive`). The
  // length `-1` (the model chooses it) is left out: its price is not
  // known before the task ends, and APIMart holds the price of 30 seconds.
  // `return_last_frame` is left out (Dez does not get the image of the
  // last frame), and so are the media fields and `tools`, which
  // `web_search` does the work of.
  // https://docs.apimart.ai/en/api-reference/videos/seedance-2-5-flash/generation
  // (checked 2026-11-24)
  'seedance-2-5-flash': {
    parameters: [
      { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
      { name: 'size', label: 'Aspect ratio', options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] },
      { name: 'duration', label: 'Length (seconds)', min: 4, max: 30, default: 4 },
      { name: 'generate_audio', label: 'Audio', default: true },
      WATERMARK,
      { name: 'seed', label: 'Seed', options: [], custom: true },
      { name: 'output_format', label: 'File type', options: ['mp4', 'mov'] },
      { name: 'web_search', label: 'Web search' },
      MODERATION_CHECK,
    ],
  },
}

// The doc facts of the model `modelId`; undefined for a model that the
// table does not have.
export function apimartVideoModel(modelId: unknown): ApimartVideoModel | undefined {
  return typeof modelId === 'string' && Object.hasOwn(APIMART_VIDEO_MODELS, modelId) ? APIMART_VIDEO_MODELS[modelId] : undefined
}

// What the doc pages of an APIMart music model tell. The entries of the
// music models in the model list hold no schema (checked 2026-11-24), so
// every row is here. A music request has one price, whatever its length,
// so a length has no default here: with no choice, the model chooses it.
export interface ApimartMusicModel {
  parameters: readonly ModelParameter[]
  textRules: ClipTextRules
  // The fields of the request, but `model`: the text of the message and
  // the values of the rows, as the docs of the model tell to send them.
  // Throws an `ExplainedError` for a text that the model does not take
  // with these values.
  body(input: ClipInput): Record<string, unknown>
}

// A row with no list that takes one line of text.
function textRow(name: string, label: string): ModelParameter {
  return { name, label, options: [], custom: true }
}

// A weight of a Suno request, from 0 to 1 in both modes.
function weightRow(name: string, label: string): ModelParameter {
  return { name, label, min: 0, max: 1, step: 0.1, anyNumber: true }
}

// The Suno fields that only custom mode takes: inspiration mode ignores
// the first four, and max mode and the length need custom mode.
const SUNO_CUSTOM_FIELDS: ReadonlySet<string> = new Set(['title', 'negative_tags', 'auto_lyrics', 'persona_id', 'max_mode', 'duration'])
// The fields that a request with a custom model id must not have.
const SUNO_NOT_WITH_CUSTOM_MODEL: ReadonlySet<string> = new Set(['version', 'persona_id'])
const SUNO_MAX_STYLE_LENGTH = 1000
const SUNO_MAX_TITLE_LENGTH = 80

// Suno has two modes. Inspiration mode (`custom: false`) makes the whole
// song, lyrics too, from a description (`prompt`). Custom mode
// (`custom: true`) takes the lyrics as `prompt` and the style as `style`,
// or, for an instrumental, only the style. Lyrics turn on custom mode, as
// they need it. With no lyrics, the "Custom mode" row tells the mode, and
// the message is then the style of an instrumental: custom mode makes no
// song with a voice from no lyrics (`auto_lyrics` only rewrites lyrics).
// The fields that a mode does not take are left out, so that a value of
// the panel never makes a request fail.
function sunoBody({ prompt, lyrics, values }: ClipInput): Record<string, unknown> {
  const custom = lyrics !== undefined || values.custom === true
  if (custom && lyrics === undefined && values.instrumental !== true) {
    throw new ExplainedError('In Custom mode, this model makes a song only from lyrics, or an instrumental. Write the style, then a line "Lyrics:", then the lyrics; or turn on Instrumental, or turn off Custom mode, in the model parameters.')
  }
  if (custom && prompt.length > SUNO_MAX_STYLE_LENGTH) {
    throw new ExplainedError(`In Custom mode, this model takes a style (the text before the "Lyrics:" line, or the message of an instrumental) of at most ${SUNO_MAX_STYLE_LENGTH} characters. This one has ${prompt.length}. Make it shorter.`)
  }
  const title = values.title
  if (custom && typeof title === 'string' && title.length > SUNO_MAX_TITLE_LENGTH) {
    throw new ExplainedError(`This model takes a title of at most ${SUNO_MAX_TITLE_LENGTH} characters. This one has ${title.length}. Change the Title parameter.`)
  }
  const withCustomModel = values.custom_model_id !== undefined
  const sent: ParameterValues = Object.fromEntries(Object.entries(values).filter(([name]) => name !== 'custom'
    && (custom || !SUNO_CUSTOM_FIELDS.has(name))
    && !(withCustomModel && SUNO_NOT_WITH_CUSTOM_MODEL.has(name))))
  if (!custom) return { ...sent, custom, prompt }
  return { ...sent, custom, ...(lyrics !== undefined && { prompt: lyrics }), ...(prompt !== '' && { style: prompt }) }
}

export const APIMART_MUSIC_MODELS: Readonly<Record<string, ApimartMusicModel>> = {
  // A task makes more than one song (two in the docs' example). `version`
  // has a default: a request needs a version or a custom model id. The
  // style (at most 1,000 characters) and the description (at most 3,000)
  // come from the message, as a text row holds one short line.
  // https://docs.apimart.ai/en/api-reference/audios/suno/generation
  // (checked 2026-11-24)
  suno: {
    parameters: [
      { name: 'version', label: 'Version', options: ['v6', 'v6-wild', 'v6-mini'], default: 'v6' },
      { name: 'custom', label: 'Custom mode' },
      { name: 'instrumental', label: 'Instrumental' },
      textRow('title', 'Title (Custom mode)'),
      textRow('negative_tags', 'Styles to avoid (Custom mode)'),
      { name: 'auto_lyrics', label: 'Rewrite the lyrics' },
      { name: 'vocal_gender', label: 'Voice', options: ['Male', 'Female'] },
      { name: 'duration', label: 'Length (seconds, Custom mode)', min: 10, max: 360 },
      textRow('persona_id', 'Persona id (Custom mode)'),
      textRow('custom_model_id', 'Custom model id'),
      { name: 'variety', label: 'Variety', options: ['off', 'normal', 'high', 'extra', 'max'] },
      { name: 'max_mode', label: 'Max mode (Custom mode, 2× price)' },
      weightRow('style_weight', 'Style weight'),
      weightRow('weirdness_constraint', 'Weirdness'),
      weightRow('audio_weight', 'Audio weight'),
      { name: 'audio_format', label: 'File type', options: ['mp3', 'm4a', 'wav'] },
    ],
    textRules: {
      maxPromptLength: 3000,
      lyrics: {
        required: false,
        maxLength: 5000,
        note: `Lyrics turn on Custom mode: the text before the "Lyrics:" line is then the style (at most ${SUNO_MAX_STYLE_LENGTH} characters). With no lyrics, the message tells what song to make; with Custom mode and Instrumental on, it is the style of the instrumental.`,
      },
    },
    body: sunoBody,
  },
  // One song for each task. `sound_prompt` and `lyrics` cannot both be
  // empty. `bpm` and `seed` are texts in the docs, so they go as texts.
  // The version `lyria-3.5` keeps the model `flowmusic`; with no version,
  // the model is Flow Music's own. A live task with no version and a
  // `length` of 10 gave a song of 105 seconds (2026-11-24): the model can
  // take the length as a hint only.
  // https://docs.apimart.ai/en/api-reference/audios/flow-music/music
  // https://docs.apimart.ai/en/api-reference/audios/flow-music/music-lyria-3-5
  // (checked 2026-11-24)
  flowmusic: {
    parameters: [
      { name: 'version', label: 'Version', options: ['lyria-3.5'] },
      textRow('title', 'Title'),
      { name: 'length', label: 'Length (seconds)', min: 1, max: 240 },
      textRow('bpm', 'Beats a minute'),
      textRow('seed', 'Seed'),
    ],
    textRules: { lyrics: { required: false } },
    body: ({ prompt, lyrics, values }) => ({ ...values, ...(prompt !== '' && { sound_prompt: prompt }), ...(lyrics !== undefined && { lyrics }) }),
  },
}

// The doc facts of the music model `modelId`; undefined for a model that
// the table does not have.
export function apimartMusicModel(modelId: unknown): ApimartMusicModel | undefined {
  return typeof modelId === 'string' && Object.hasOwn(APIMART_MUSIC_MODELS, modelId) ? APIMART_MUSIC_MODELS[modelId] : undefined
}

// The transcription models that give the times of the words and the
// segments: only `whisper-1` takes `response_format=verbose_json`. The
// `gpt-4o-transcribe` models refuse it with a 400 (a live check of
// `gpt-4o-mini-transcribe`, 2026-11-24), so they get no times.
// https://docs.apimart.ai/en/api-reference/audios/whisper-1
export const APIMART_TIMED_TRANSCRIPTION_MODELS: ReadonlySet<string> = new Set(['whisper-1'])
