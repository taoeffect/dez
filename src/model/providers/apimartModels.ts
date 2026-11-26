import { ExplainedError } from '../../utils/errorText'
import type { ReferenceImages } from './clipImages'
import type { ClipTextRules } from './clipText'
import type { ImageSizeRules } from './imageSize'
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
  // How the model takes input images, for a model that takes them
  // (`apimartFormat`): as the first and the last frame of the video, or,
  // when the user chooses so (`APIMART_IMAGES_AS`), as references.
  images?: ApimartVideoImages
}

export interface ApimartVideoImages {
  // The most reference images of one request.
  maxReferences: number
  references: ReferenceImages
  // The size rules of each image, frame or reference.
  size: ImageSizeRules
  // The body fields that a request with frames needs, in place of the
  // values of the panel.
  frameFields?: Readonly<Record<string, string>>
}

// The parameter that tells how the images of a request go: as the frames
// of the video, or as references. The request reads it and sends it as no
// field.
export const APIMART_IMAGES_AS = 'images_as'
export const APIMART_AS_REFERENCES = 'references'
const IMAGES_AS: ModelParameter = { name: APIMART_IMAGES_AS, label: 'Images as', options: ['frames', APIMART_AS_REFERENCES], default: 'frames' }

// The integer fields of the request: one with no list and no upper limit
// gets a text row, whose text the request sends as a number
// (`apimartFormat`). A listed option of such a field goes as it is.
export const APIMART_WHOLE_NUMBER_FIELDS: ReadonlySet<string> = new Set(['duration', 'seed'])

const WATERMARK: ModelParameter = { name: 'watermark', label: 'Watermark' }

// APIMart checks the prompt and the input images with a moderation model
// before the task starts. This costs a small extra amount that the price
// request does not count.
const MODERATION_CHECK: ModelParameter = { name: 'nsfw_check', label: 'Moderation check' }

// A row with no list that takes one line of text.
function textRow(name: string, label: string): ModelParameter {
  return { name, label, options: [], custom: true }
}

export const APIMART_VIDEO_MODELS: Readonly<Record<string, ApimartVideoModel>> = {
  // `aspect_ratio` has no default: a video from a prompt then gets 16:9,
  // and the docs list no `adaptive` for it. With frames, the model takes
  // the aspect ratio of the image. The clip fields are left out: Dez
  // sends APIMart no input clip.
  // Images: at most 9 references. The price of the account tells that
  // only the first 5 images of a request are free
  // (`input_image_free_count`), and the quote of a request does not count
  // the others, so Dez sends at most 5: a quote under the price would let
  // a request go over the money limit of a tab.
  // Each side of an image is 256 to 5760 pixels (`maxLongSide`). So no
  // image has more than 5760² pixels, under the 40 million of the upload.
  // https://docs.apimart.ai/en/api-reference/videos/minimax-h3/generation
  // (checked 2026-11-25)
  'MiniMax-H3': {
    parameters: [
      { name: 'duration', label: 'Length (seconds)', min: 4, max: 15, default: 4 },
      { name: 'resolution', label: 'Resolution', options: ['768P', '2K'], default: '768P' },
      { name: 'aspect_ratio', label: 'Aspect ratio', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
      IMAGES_AS,
      WATERMARK,
      MODERATION_CHECK,
    ],
    maxPromptLength: 7000,
    images: {
      maxReferences: 5,
      references: {},
      size: { minShortSide: 256, maxLongSide: 5760, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
    },
  },
  // `size` is the aspect ratio (the docs' default is `adaptive`). The
  // length `-1` (the model chooses it) is left out: its price is not
  // known before the task ends, and APIMart holds the price of 30 seconds.
  // `return_last_frame` is left out (Dez does not get the image of the
  // last frame), and so are the clip fields and `tools`, which
  // `web_search` does the work of.
  // Images: at most 10 references, which the prompt names `@图片1`,
  // `@图片2` (the docs' names). A request with frames needs the size
  // `adaptive`. Each side of an image is 300 to 6000 pixels
  // (`maxLongSide`). So no image has more than 6000² pixels, under the 40
  // million of the upload.
  // https://docs.apimart.ai/en/api-reference/videos/seedance-2-5-flash/generation
  // (checked 2026-11-25)
  'seedance-2-5-flash': {
    parameters: [
      { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], default: '480p' },
      { name: 'size', label: 'Aspect ratio', options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] },
      { name: 'duration', label: 'Length (seconds)', min: 4, max: 30, default: 4 },
      { name: 'generate_audio', label: 'Audio', default: true },
      IMAGES_AS,
      WATERMARK,
      textRow('seed', 'Seed'),
      { name: 'output_format', label: 'File type', options: ['mp4', 'mov'] },
      { name: 'web_search', label: 'Web search' },
      MODERATION_CHECK,
    ],
    images: {
      maxReferences: 10,
      references: { promptName: '@图片{n}' },
      size: { minShortSide: 300, maxLongSide: 6000, minAspectRatio: 0.4, maxAspectRatio: 2.5 },
      frameFields: { size: 'adaptive' },
    },
  },
}

// What the doc page of an APIMart image model tells, and its entry in the
// model list does not: the entries of most image models hold the same
// general schema, with no option lists and no image count (checked
// 2026-11-25). An image request with input images is an edit: Dez uploads
// them first (`MediaFormat.imageUpload`), also for a model whose docs take
// them as data. As for a video, a resolution has the cheapest value as its
// default, and a row with no default sends no field.
export interface ApimartImageModel {
  parameters: readonly ModelParameter[]
  // The most input images of one request.
  maxImages: number
  // The values of `resolution` that the price request of the account
  // takes, for a model whose price request refuses the others: a request
  // with another value gets the price of the default resolution. Missing:
  // the price request takes every value.
  pricedResolutions?: readonly string[]
}

// The aspect ratios of the Gemini 3 Pro image model, which the docs of
// Gemini 3.1 Flash also list, with more.
const GEMINI_PRO_RATIOS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

export const APIMART_IMAGE_MODELS: Readonly<Record<string, ApimartImageModel>> = {
  // `size` (the aspect ratio) has no default: an edit with no size keeps
  // the size of its input image, and a new image gets 1:1. The docs tell
  // that `n` takes only 1, so it has no row; `official_fallback` (another
  // channel, at another price) has none either. Images: at most 15.
  // https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation
  // (checked 2026-11-25)
  'gpt-image-2': {
    parameters: [
      { name: 'size', label: 'Aspect ratio', options: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'] },
      { name: 'resolution', label: 'Resolution', options: ['1k', '2k', '4k'], default: '1k' },
      MODERATION_CHECK,
    ],
    maxImages: 15,
  },
  // The default resolution is 1K, not 0.5K: the price of the account told
  // $0.012 for 1K and $0.015 for 0.5K (2026-11-25). Images: at most 14.
  // The Google search fields are left out: the docs tell no price of
  // theirs.
  // https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation
  // (checked 2026-11-25)
  'gemini-3.1-flash-image-preview': {
    parameters: [
      { name: 'size', label: 'Aspect ratio', options: [...GEMINI_PRO_RATIOS, '1:4', '4:1', '1:8', '8:1'] },
      { name: 'resolution', label: 'Resolution', options: ['0.5K', '1K', '2K', '4K'], default: '1K' },
      MODERATION_CHECK,
    ],
    maxImages: 14,
  },
  // The price request takes only the resolution 4K: it refused 1K and 2K
  // with a 400 ("supported: 4K") and told $0.02 with no resolution and
  // $0.03 for 4K (2026-11-25). Images: at most 14.
  // https://docs.apimart.ai/en/api-reference/images/gemini-3-pro/generation
  // (checked 2026-11-25)
  'gemini-3-pro-image-preview': {
    parameters: [
      { name: 'size', label: 'Aspect ratio', options: GEMINI_PRO_RATIOS },
      { name: 'resolution', label: 'Resolution', options: ['1K', '2K', '4K'], default: '1K' },
      MODERATION_CHECK,
    ],
    maxImages: 14,
    pricedResolutions: ['4K'],
  },
  // The resolution counts only with an aspect ratio: with no `size`, the
  // model makes a 2K image. So `size` has the default 1:1. `n` must be 1.
  // The layer mode (`layer_decomposition`) is left out: it makes up to 30
  // images from one, at a price that the docs do not tell. Images: at
  // most 10, each one of at most 36 million pixels.
  // https://docs.apimart.ai/en/api-reference/images/seedream-5-5/generation
  // (checked 2026-11-25)
  'seedream-5-5': {
    parameters: [
      { name: 'size', label: 'Aspect ratio', options: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '2:1', '1:2'], default: '1:1' },
      { name: 'resolution', label: 'Resolution', options: ['1K', '1.5K', '2K'], default: '1K' },
      { name: 'background', label: 'Background', options: ['auto', 'transparent', 'opaque'] },
      WATERMARK,
      MODERATION_CHECK,
    ],
    maxImages: 10,
  },
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

// A weight of a Suno request, from 0 to 1 in both modes.
function weightRow(name: string, label: string): ModelParameter {
  return { name, label, min: 0, max: 1, step: 0.1, anyNumber: true }
}

// The Suno fields that only custom mode takes: inspiration mode ignores
// the first four, and max mode needs custom mode.
const SUNO_CUSTOM_FIELDS: ReadonlySet<string> = new Set(['title', 'negative_tags', 'auto_lyrics', 'persona_id', 'max_mode'])
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
// the panel never makes a request fail. The one exception is a length in
// inspiration mode, which is refused: APIMart refuses it (HTTP 400,
// "`duration` requires custom mode"), and a length that Dez left out gave
// the user paid songs of a length that the user did not ask for (live,
// 2026-11-25).
function sunoBody({ prompt, lyrics, values }: ClipInput): Record<string, unknown> {
  const custom = lyrics !== undefined || values.custom === true
  if (!custom && values.duration !== undefined) {
    throw new ExplainedError('This model takes a length only in Custom mode. Write the style, then a line "Lyrics:", then the lyrics; or turn on Custom mode and Instrumental, or clear Target length, in the model parameters.')
  }
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
  // A task makes more than one song (two in the docs' example). No field
  // sets the count: a task with `n: 1` (not in the docs) still gave two
  // songs (live, 2026-11-25). `version` has a default: a request needs a
  // version or a custom model id. The style (at most 1,000 characters) and
  // the description (at most 3,000) come from the message, as a text row
  // holds one short line. Custom mode keeps the length as a target, with
  // lyrics and for an instrumental: two tasks that asked for 30 seconds
  // gave songs of 30 and 29.8, and of 32.76 and 29.8 seconds (live,
  // 2026-11-25).
  // https://docs.apimart.ai/en/api-reference/audios/suno/generation
  // (checked 2026-11-25)
  suno: {
    parameters: [
      { name: 'version', label: 'Version', options: ['v6', 'v6-wild', 'v6-mini'], default: 'v6' },
      { name: 'custom', label: 'Custom mode' },
      { name: 'instrumental', label: 'Instrumental' },
      textRow('title', 'Title (Custom mode)'),
      textRow('negative_tags', 'Styles to avoid (Custom mode)'),
      { name: 'auto_lyrics', label: 'Rewrite the lyrics' },
      { name: 'vocal_gender', label: 'Voice', options: ['Male', 'Female'] },
      { name: 'duration', label: 'Target length (seconds, Custom mode)', min: 10, max: 360 },
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
  // the model is Flow Music's own. Both take `length` only as a target,
  // which a song can miss by far, most of all a short one. Live tasks with
  // no version: 10 → 105 seconds (2026-11-24), 30 → 131.85, 200 → 175.89;
  // with `lyria-3.5`: 30 → 57.48, 200 → 181.18 (2026-11-25).
  // https://docs.apimart.ai/en/api-reference/audios/flow-music/music
  // https://docs.apimart.ai/en/api-reference/audios/flow-music/music-lyria-3-5
  // (checked 2026-11-25)
  flowmusic: {
    parameters: [
      { name: 'version', label: 'Version', options: ['lyria-3.5'] },
      textRow('title', 'Title'),
      { name: 'length', label: 'Target length (seconds)', min: 1, max: 240 },
      textRow('bpm', 'Beats a minute'),
      textRow('seed', 'Seed'),
    ],
    textRules: { lyrics: { required: false } },
    body: ({ prompt, lyrics, values }) => ({ ...values, ...(prompt !== '' && { sound_prompt: prompt }), ...(lyrics !== undefined && { lyrics }) }),
  },
}

// The transcription models that give the times of the words and the
// segments: only `whisper-1` takes `response_format=verbose_json`. The
// `gpt-4o-transcribe` models refuse it with a 400 (a live check of
// `gpt-4o-mini-transcribe`, 2026-11-24), so they get no times.
// https://docs.apimart.ai/en/api-reference/audios/whisper-1
export const APIMART_TIMED_TRANSCRIPTION_MODELS: ReadonlySet<string> = new Set(['whisper-1'])
