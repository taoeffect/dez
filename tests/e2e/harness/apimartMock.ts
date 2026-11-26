import type { MockProvider } from './mockServer'

// A custom provider of the `apimart` media format on the mock
// (`startMockProviderApp(MART, APIMART_CONFIG, { jsonAnswers: { [MODELS_PATH]:
// MODEL_LIST, … } })`), with the video, music, transcription, and image
// models of APIMart's live list. A spec adds the answers of its requests.

// The id `apimart` is the id of the built-in provider.
export const MART: MockProvider = { id: 'mart', name: 'Mart Mock', modelId: 'MiniMax-H3', modelName: 'MiniMax-H3' }
export const GENERAL_MODEL = 'kling-v3'
// The music models are config models of the provider (as in the built-in
// APIMart config) that show when the list holds them.
export const SUNO = { id: 'suno', name: 'Suno' }
export const FLOW_MUSIC = { id: 'flowmusic', name: 'Flow Music' }
// A transcription model, a config model of the provider as in the built-in
// APIMart config.
export const WHISPER = 'whisper-1'
// An image model that Dez knows from its docs.
export const IMAGE_MODEL = 'gpt-image-2'

// The general schema of almost all video models (kling-v3 in the live
// list, 2026-11-24, with the descriptions and some image fields cut).
const GENERAL_SCHEMA = {
  model: { type: 'string' },
  prompt: { type: 'string' },
  aspect_ratio: { type: 'string' },
  duration: { minimum: 1, type: 'integer' },
  first_frame_image: { type: 'string' },
  generate_audio: { type: 'boolean' },
  image_urls: { items: { type: 'string' }, minItems: 1, type: 'array' },
  quality: { type: 'string' },
  resolution: { type: 'string' },
  seed: { type: 'integer' },
  timestamps: { type: 'string' },
  webhook: { type: 'string' },
}

const videoEntry = (id: string) => ({
  id,
  object: 'model',
  created: 1626777600,
  owned_by: 'custom',
  supported_endpoint_types: ['openai'],
  category: 'video',
  capability_tags: ['Image to Video', 'Text to Video'],
  parameters: { endpoint: '/v1/videos/generations', method: 'POST', input_schema: { type: 'object', properties: GENERAL_SCHEMA } },
})

// The entries of the music models hold no schema (live list, 2026-11-24).
const musicEntry = (id: string) =>
  ({ id, object: 'model', created: 1626777600, owned_by: 'custom', supported_endpoint_types: ['openai'], category: 'audio', capability_tags: ['Text to Audio'], parameters: null })

// The entry of an image model, with a few fields of its schema (live
// list, 2026-11-25, with the descriptions cut).
const imageEntry = (id: string) => ({
  id,
  object: 'model',
  created: 1626777600,
  owned_by: 'custom',
  supported_endpoint_types: ['openai'],
  category: 'image',
  capability_tags: ['Text to Image'],
  parameters: {
    endpoint: '/v1/images/generations',
    method: 'POST',
    input_schema: { type: 'object', properties: { image_urls: { items: { type: 'string' }, minItems: 1, type: 'array' }, n: { type: 'integer' }, prompt: { type: 'string' }, size: { type: 'string' } } },
  },
})

// The entry of whisper-1 (live list, 2026-11-24).
const WHISPER_ENTRY = { id: WHISPER, object: 'model', created: 1626777600, owned_by: 'openai', supported_endpoint_types: ['openai'], category: 'audio', capability_tags: ['Audio'] }

/** The path of the model list, which the mock answers with `MODEL_LIST`. */
export const MODELS_PATH = `/${MART.id}/v1/models?expand=parameters`

export const MODEL_LIST = { object: 'list', success: true, data: [videoEntry(MART.modelId), videoEntry(GENERAL_MODEL), musicEntry(SUNO.id), musicEntry(FLOW_MUSIC.id), WHISPER_ENTRY, imageEntry(IMAGE_MODEL)] }

/** The config of the provider (the `config` of `startMockProviderApp`). */
export const APIMART_CONFIG = {
  mediaApi: { format: 'apimart' },
  // Every video model comes from the list of the mock.
  fetchModels: true,
  models: [
    { ...SUNO, fetchedOnly: true, outputs: ['audio'], request: 'music' },
    { ...FLOW_MUSIC, fetchedOnly: true, outputs: ['audio'], request: 'music' },
    { id: WHISPER, fetchedOnly: true, outputs: ['text'], request: 'transcription' },
  ],
  modelListQuery: { expand: 'parameters' },
  modelOutputs: { path: 'category', values: { video: { outputs: ['video'], request: 'video' }, audio: { outputs: [] }, image: { outputs: ['image'], request: 'image' } } },
}
