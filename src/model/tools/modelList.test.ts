import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import { providerInfo } from '../providers/testing'
import type { ModelInfo, ProviderInfo } from '../providers/types'
import { MODEL_LIST_LIMIT, modelListText } from './modelList'

function cache(...entries: [ProviderInfo, ModelInfo[]][]): ModelCache {
  return {
    version: 1,
    providers: Object.fromEntries(entries.map(([info, models]) => [info.id, { models, working: true, updatedAt: 0, lastCheckedAt: 0 }])),
  }
}

// The column names and the letter legend of every header.
const COLUMNS = '(full id | name | provider | type | inputs)'
const LEGEND = 'Letters: t text, i image, a audio, v video; ? unknown, - none.'
const HEADER = `${COLUMNS}. ${LEGEND}`

const VENICE = providerInfo('venice', 'Venice')
const OPENROUTER = providerInfo('openrouter', 'OpenRouter')
// Mistral Small and Gemini 3 Flash have unknown outputs and request kinds:
// Dez sends them chat requests.
const VENICE_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', provider: VENICE.id, outputs: ['text'], request: 'chat' },
  { id: 'mistral-small', name: 'Mistral Small', provider: VENICE.id },
  { id: 'z-image-turbo', name: 'Z-Image Turbo', provider: VENICE.id, outputs: ['image'], request: 'image' },
  {
    id: 'wan-2-7-reference-to-video',
    name: 'Wan 2.7 Reference to Video',
    provider: VENICE.id,
    outputs: ['video'],
    request: 'video',
    images: { maxImages: 4 },
    clips: { audio: { use: 'voice' }, video: { use: 'reference', maxClips: 3 } },
  },
]
const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'google/gemini-3-pro-preview', name: 'Google: Gemini 3 Pro Preview', provider: OPENROUTER.id, outputs: ['text', 'image'], request: 'chat' },
  { id: 'google/gemini-3-flash', name: 'Google: Gemini 3 Flash', provider: OPENROUTER.id },
  { id: 'openai/whisper-2', name: 'OpenAI: Whisper 2', provider: OPENROUTER.id, outputs: ['text'], request: 'transcription', clips: { audio: { use: 'source', maxClips: 1 } } },
]
// The cache lists OpenRouter first; the result follows the provider order.
const CACHE = cache([OPENROUTER, OPENROUTER_MODELS], [VENICE, VENICE_MODELS])
const PROVIDERS = [VENICE, OPENROUTER]

const LINES = {
  veniceGemini: 'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice | t | t,i',
  mistral: 'venice/mistral-small | Mistral Small | Venice | ? | t,i',
  zImage: 'venice/z-image-turbo | Z-Image Turbo | Venice | i | t',
  wan: 'venice/wan-2-7-reference-to-video | Wan 2.7 Reference to Video | Venice | v | t,i,a,v',
  openRouterGemini: 'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i | t,i',
  flash: 'openrouter/google/gemini-3-flash | Google: Gemini 3 Flash | OpenRouter | ? | t,i',
  whisper: 'openrouter/openai/whisper-2 | OpenAI: Whisper 2 | OpenRouter | t | a',
}

describe('modelListText', () => {
  it('lists every model by full id, in provider order and then cache order, with what it makes and what Dez sends it', () => {
    expect(modelListText(CACHE, PROVIDERS)).toBe([
      `7 models ${HEADER}`,
      LINES.veniceGemini,
      LINES.mistral,
      LINES.zImage,
      LINES.wan,
      LINES.openRouterGemini,
      LINES.flash,
      LINES.whisper,
    ].join('\n'))
  })

  it('quotes the filter in the count line of a filtered list', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'gemini preview' })).toBe([
      `2 models match "gemini preview" ${HEADER}`,
      LINES.veniceGemini,
      LINES.openRouterGemini,
    ].join('\n'))
  })

  it('counts one match in the singular', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'mistral' })).toBe([`1 model matches "mistral" ${HEADER}`, LINES.mistral].join('\n'))
    expect(modelListText(cache([VENICE, VENICE_MODELS.slice(1, 2)]), PROVIDERS)).toBe([`1 model ${HEADER}`, LINES.mistral].join('\n'))
  })

  it('selects the models that make one of the given types, and counts unknown outputs as text', () => {
    expect(modelListText(CACHE, PROVIDERS, { type: 'text' })).toBe([
      `5 models match type text ${HEADER}`,
      LINES.veniceGemini,
      LINES.mistral,
      LINES.openRouterGemini,
      LINES.flash,
      LINES.whisper,
    ].join('\n'))
    expect(modelListText(CACHE, PROVIDERS, { type: 'Video, image' })).toBe([
      `3 models match type image,video ${HEADER}`,
      LINES.zImage,
      LINES.wan,
      LINES.openRouterGemini,
    ].join('\n'))
  })

  it('selects the models that Dez can send all of the given inputs in one request', () => {
    expect(modelListText(CACHE, PROVIDERS, { inputs: 'audio,video' })).toBe([`1 model matches inputs audio,video ${HEADER}`, LINES.wan].join('\n'))
    expect(modelListText(CACHE, PROVIDERS, { inputs: 'audio' })).toBe([
      `2 models match inputs audio ${HEADER}`,
      LINES.wan,
      LINES.whisper,
    ].join('\n'))
  })

  it('selects the models that match the filter, the type, and the inputs together', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'venice', type: 'video,text', inputs: 'image' })).toBe([
      `3 models match "venice" and type text,video and inputs image ${HEADER}`,
      LINES.veniceGemini,
      LINES.mistral,
      LINES.wan,
    ].join('\n'))
  })

  it('lists every model for a filter with no letters or digits, and for a type or inputs of only commas and white space', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: ' - ', type: ' , ', inputs: '\t,' })).toBe(modelListText(CACHE, PROVIDERS))
  })

  it('says so when no model matches, with the filter as a JSON string, and tells how to widen the call', () => {
    const filterFix = 'Call model_list again with fewer words in `filter`, or with no `filter` to list every model.'
    expect(modelListText(CACHE, PROVIDERS, { filter: 'xyz' })).toBe(`No models match "xyz". ${filterFix}`)
    expect(modelListText(CACHE, PROVIDERS, { filter: 'say "hi"' })).toBe(`No models match "say \\"hi\\"". ${filterFix}`)
    expect(modelListText(CACHE, PROVIDERS, { type: 'audio' }))
      .toBe('No models match type audio. Call model_list again with other values in `type`, or with no `type` to list every model.')
    expect(modelListText(CACHE, PROVIDERS, { filter: 'mistral', type: 'image', inputs: 'audio' })).toBe('No models match "mistral" and type image and inputs audio. '
      + 'Call model_list again with fewer words in `filter` or other values in `type` or fewer values in `inputs`, '
      + 'or with no `filter` and no `type` and no `inputs` to list every model.')
  })

  it('shows `-` for a model that makes none of the four types and that Dez cannot send anything, and no types select it', () => {
    const models: ModelInfo[] = [{ id: 'embed', name: 'Embed', provider: VENICE.id, outputs: [], request: 'none' }]
    expect(modelListText(cache([VENICE, models]), PROVIDERS)).toBe([`1 model ${HEADER}`, 'venice/embed | Embed | Venice | - | -'].join('\n'))
    expect(modelListText(cache([VENICE, models]), PROVIDERS, { type: 'text,image,audio,video' }))
      .toBe('No models match type text,image,audio,video. Call model_list again with other values in `type`, or with no `type` to list every model.')
  })

  it('refuses a value that a parameter does not take and names the valid values, before it looks at the models', () => {
    const types = 'Use a comma list of: text, image, audio, video.'
    // The letters of the columns are no types.
    expect(() => modelListText(CACHE, PROVIDERS, { type: 'i,v' })).toThrow(`Unknown values "i", "v" in \`type\`. ${types}`)
    expect(() => modelListText(cache(), PROVIDERS, { inputs: 'audio speech' })).toThrow(`Unknown value "speech" in \`inputs\`. ${types}`)
    expect(() => modelListText(cache(), PROVIDERS, { sort: 'date' }))
      .toThrow('Unknown value "date" in `sort`. Use one of: id, name, provider, type, inputs.')
    expect(() => modelListText(cache(), PROVIDERS, { sort: 'name', sort_dir: 'down' })).toThrow('Unknown value "down" in `sort_dir`. Use one of: asc, desc.')
  })

  // The model would read a list in another order than the one it asked for.
  it('refuses a sort direction with no sort column', () => {
    expect(() => modelListText(CACHE, PROVIDERS, { sort_dir: 'desc' })).toThrow('`sort_dir` is the direction of `sort`. '
      + 'Call model_list again with `sort` too (one of: id, name, provider, type, inputs), or with no `sort_dir`.')
  })

  it('says so when the user can use no model, whatever the arguments, and what the user can do', () => {
    const none = 'The user has no models that Dez can use: no provider is set up, or the model lists of the providers did not load. '
      + 'Tell the user to add an API key in Settings › Providers, or to look there for a provider with an error.'
    expect(modelListText(cache(), PROVIDERS)).toBe(none)
    expect(modelListText(CACHE, [providerInfo('venice', 'Venice', false)], { filter: 'gemini', type: 'text', inputs: 'image', sort: 'name' })).toBe(none)
  })

  // Equal values keep provider order, then cache order, in both directions,
  // and an unknown type comes last in both.
  it('sorts by the count of letters and then the table order of the letters', () => {
    expect(modelListText(CACHE, PROVIDERS, { sort: 'type' })).toBe([
      `7 models ${COLUMNS}, sorted by type asc. ${LEGEND}`,
      LINES.veniceGemini,
      LINES.whisper,
      LINES.zImage,
      LINES.wan,
      LINES.openRouterGemini,
      LINES.mistral,
      LINES.flash,
    ].join('\n'))
    expect(modelListText(CACHE, PROVIDERS, { sort: 'type', sort_dir: 'desc' })).toBe([
      `7 models ${COLUMNS}, sorted by type desc. ${LEGEND}`,
      LINES.openRouterGemini,
      LINES.wan,
      LINES.zImage,
      LINES.veniceGemini,
      LINES.whisper,
      LINES.mistral,
      LINES.flash,
    ].join('\n'))
    expect(modelListText(CACHE, PROVIDERS, { inputs: 'image', sort: 'Inputs', sort_dir: 'DESC' }).split('\n').slice(0, 3)).toStrictEqual([
      `5 models match inputs image ${COLUMNS}, sorted by inputs desc. ${LEGEND}`,
      LINES.wan,
      LINES.veniceGemini,
    ])
  })

  it('sorts text as a person reads it: numbers by value, and case does not count', () => {
    const models: ModelInfo[] = ['model 10', 'Model 9', 'alpha', 'Beta'].map((name, index) => ({ id: `m${index}`, name, provider: VENICE.id }))
    const names = (sort_dir?: string) => modelListText(cache([VENICE, models]), PROVIDERS, { sort: 'name', ...(sort_dir && { sort_dir }) })
      .split('\n').slice(1).map((line) => line.split(' | ')[1])

    expect(names()).toStrictEqual(['alpha', 'Beta', 'Model 9', 'model 10'])
    expect(names('desc')).toStrictEqual(['model 10', 'Model 9', 'Beta', 'alpha'])
    expect(modelListText(CACHE, PROVIDERS, { sort: 'provider' }).split('\n').slice(1)).toStrictEqual([
      LINES.openRouterGemini,
      LINES.flash,
      LINES.whisper,
      LINES.veniceGemini,
      LINES.mistral,
      LINES.zImage,
      LINES.wan,
    ])
  })

  it(`stops after ${MODEL_LIST_LIMIT} models and counts the rest, after the sort`, () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}`, name: `M ${index}`, provider: VENICE.id }))
    const full = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT)]), PROVIDERS).split('\n')
    expect(full).toHaveLength(MODEL_LIST_LIMIT + 1)
    expect(full.at(-1)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice | ? | t,i`)

    const over = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT + 3)]), PROVIDERS).split('\n')
    expect(over[0]).toBe(`${MODEL_LIST_LIMIT + 3} models ${HEADER}`)
    expect(over).toHaveLength(MODEL_LIST_LIMIT + 2)
    expect(over.at(-2)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice | ? | t,i`)
    expect(over.at(-1)).toBe('… and 3 more. Use a narrower filter.')

    const newestFirst = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT + 3)]), PROVIDERS, { sort: 'name', sort_dir: 'desc' }).split('\n')
    expect(newestFirst[1]).toBe(`venice/m${MODEL_LIST_LIMIT + 2} | M ${MODEL_LIST_LIMIT + 2} | Venice | ? | t,i`)
    expect(newestFirst.at(-2)).toBe('venice/m3 | M 3 | Venice | ? | t,i')
    expect(newestFirst.at(-1)).toBe('… and 3 more. Use a narrower filter.')
  })

  it('keeps each model on one line when a name holds a line break', () => {
    const models = [{ id: 'odd', name: 'Odd\nName  ', provider: VENICE.id }]
    expect(modelListText(cache([providerInfo('venice', 'Ven\r\nice'), models]), [providerInfo('venice', 'Ven\r\nice')])).toBe([
      `1 model ${HEADER}`,
      'venice/odd | Odd Name | Ven ice | ? | t,i',
    ].join('\n'))
  })

  it('keeps its columns when a name holds a |', () => {
    const piped = providerInfo('venice', 'Ven|ice')
    const models: ModelInfo[] = [{ id: 'odd', name: 'Odd | Name', provider: VENICE.id, outputs: ['audio'], request: 'tts' }]
    expect(modelListText(cache([piped, models]), [piped])).toBe([
      `1 model ${HEADER}`,
      'venice/odd | Odd / Name | Ven/ice | a | t',
    ].join('\n'))
  })
})
