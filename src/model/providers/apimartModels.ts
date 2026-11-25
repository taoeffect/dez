import type { ModelParameter } from './modelParameters'

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
