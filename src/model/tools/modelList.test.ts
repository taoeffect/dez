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

// The column names and the output letter legend of every header.
const COLUMNS = '(full id | name | provider | outputs). Outputs: t text, i image, a audio, v video.'

const VENICE = providerInfo('venice', 'Venice')
const OPENROUTER = providerInfo('openrouter', 'OpenRouter')
// Mistral Small and Gemini 3 Flash have unknown outputs.
const VENICE_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', provider: VENICE.id, outputs: ['text'] },
  { id: 'mistral-small', name: 'Mistral Small', provider: VENICE.id },
  { id: 'z-image-turbo', name: 'Z-Image Turbo', provider: VENICE.id, outputs: ['image'] },
]
const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'google/gemini-3-pro-preview', name: 'Google: Gemini 3 Pro Preview', provider: OPENROUTER.id, outputs: ['text', 'image'] },
  { id: 'google/gemini-3-flash', name: 'Google: Gemini 3 Flash', provider: OPENROUTER.id },
]
// The cache lists OpenRouter first; the result follows the provider order.
const CACHE = cache([OPENROUTER, OPENROUTER_MODELS], [VENICE, VENICE_MODELS])
const PROVIDERS = [VENICE, OPENROUTER]

describe('modelListText', () => {
  it('lists every model by full id, in provider order and then cache order, with the letters of known outputs', () => {
    expect(modelListText(CACHE, PROVIDERS)).toBe([
      `5 models ${COLUMNS}`,
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice | t',
      'venice/mistral-small | Mistral Small | Venice',
      'venice/z-image-turbo | Z-Image Turbo | Venice | i',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i',
      'openrouter/google/gemini-3-flash | Google: Gemini 3 Flash | OpenRouter',
    ].join('\n'))
  })

  it('quotes the filter in the count line of a filtered list', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'gemini preview' })).toBe([
      `2 models match "gemini preview" ${COLUMNS}`,
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice | t',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i',
    ].join('\n'))
  })

  it('counts one match in the singular', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'mistral' })).toBe([
      `1 model matches "mistral" ${COLUMNS}`,
      'venice/mistral-small | Mistral Small | Venice',
    ].join('\n'))
    expect(modelListText(cache([VENICE, VENICE_MODELS.slice(1, 2)]), PROVIDERS)).toBe([
      `1 model ${COLUMNS}`,
      'venice/mistral-small | Mistral Small | Venice',
    ].join('\n'))
  })

  it('selects the models that make one of the given outputs, and counts unknown outputs as text', () => {
    expect(modelListText(CACHE, PROVIDERS, { outputs: 't' })).toBe([
      `4 models match outputs t ${COLUMNS}`,
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice | t',
      'venice/mistral-small | Mistral Small | Venice',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i',
      'openrouter/google/gemini-3-flash | Google: Gemini 3 Flash | OpenRouter',
    ].join('\n'))
    expect(modelListText(CACHE, PROVIDERS, { outputs: 'V, i' })).toBe([
      `2 models match outputs i,v ${COLUMNS}`,
      'venice/z-image-turbo | Z-Image Turbo | Venice | i',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i',
    ].join('\n'))
  })

  it('selects the models that match both the filter and the outputs', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'gemini', outputs: 'i' })).toBe([
      `1 model matches "gemini" and outputs i ${COLUMNS}`,
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter | t,i',
    ].join('\n'))
  })

  it('lists every model for a filter or outputs with no letters or digits', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: ' - ' })).toBe(modelListText(CACHE, PROVIDERS))
    expect(modelListText(CACHE, PROVIDERS, { outputs: ' , ' })).toBe(modelListText(CACHE, PROVIDERS))
  })

  it('says so when no model matches, with the filter as a JSON string', () => {
    expect(modelListText(CACHE, PROVIDERS, { filter: 'xyz' })).toBe('No models match "xyz".')
    expect(modelListText(CACHE, PROVIDERS, { filter: 'say "hi"' })).toBe('No models match "say \\"hi\\"".')
    expect(modelListText(CACHE, PROVIDERS, { outputs: 'a' })).toBe('No models match outputs a.')
    expect(modelListText(CACHE, PROVIDERS, { filter: 'mistral', outputs: 'av' })).toBe('No models match "mistral" and outputs a,v.')
  })

  it('shows no outputs column for a model that makes none of the four outputs, and no outputs select it', () => {
    const models = [{ id: 'embed', name: 'Embed', provider: VENICE.id, outputs: [] }]
    expect(modelListText(cache([VENICE, models]), PROVIDERS)).toBe([
      `1 model ${COLUMNS}`,
      'venice/embed | Embed | Venice',
    ].join('\n'))
    expect(modelListText(cache([VENICE, models]), PROVIDERS, { outputs: 'tiav' })).toBe('No models match outputs t,i,a,v.')
  })

  it('refuses outputs with an unknown letter and names the valid letters, before it looks at the models', () => {
    const error = 'Unknown output letter "x". Valid letters: t text, i image, a audio, v video.'
    expect(() => modelListText(CACHE, PROVIDERS, { outputs: 'ix' })).toThrow(error)
    expect(() => modelListText(cache(), PROVIDERS, { outputs: 'x' })).toThrow(error)
  })

  it('says so when the user can use no model, whatever the filter', () => {
    expect(modelListText(cache(), PROVIDERS)).toBe('No models are available.')
    expect(modelListText(CACHE, [providerInfo('venice', 'Venice', false)], { filter: 'gemini', outputs: 't' })).toBe('No models are available.')
  })

  it(`stops after ${MODEL_LIST_LIMIT} models and counts the rest`, () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}`, name: `M ${index}`, provider: VENICE.id }))
    const full = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT)]), PROVIDERS).split('\n')
    expect(full).toHaveLength(MODEL_LIST_LIMIT + 1)
    expect(full.at(-1)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice`)

    const over = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT + 3)]), PROVIDERS).split('\n')
    expect(over[0]).toBe(`${MODEL_LIST_LIMIT + 3} models ${COLUMNS}`)
    expect(over).toHaveLength(MODEL_LIST_LIMIT + 2)
    expect(over.at(-2)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice`)
    expect(over.at(-1)).toBe('… and 3 more. Use a narrower filter.')
  })

  it('keeps each model on one line when a name holds a line break', () => {
    const models = [{ id: 'odd', name: 'Odd\nName  ', provider: VENICE.id }]
    expect(modelListText(cache([providerInfo('venice', 'Ven\r\nice'), models]), [providerInfo('venice', 'Ven\r\nice')])).toBe([
      `1 model ${COLUMNS}`,
      'venice/odd | Odd Name | Ven ice',
    ].join('\n'))
  })

  it('keeps its columns when a name holds a |', () => {
    const piped = providerInfo('venice', 'Ven|ice')
    const models: ModelInfo[] = [{ id: 'odd', name: 'Odd | Name', provider: VENICE.id, outputs: ['audio'] }]
    expect(modelListText(cache([piped, models]), [piped])).toBe([
      `1 model ${COLUMNS}`,
      'venice/odd | Odd / Name | Ven/ice | a',
    ].join('\n'))
  })
})
