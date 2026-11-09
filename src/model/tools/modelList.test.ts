import { describe, expect, it } from 'vitest'
import type { ModelCache } from '../persistence/types'
import type { ModelInfo, ProviderInfo } from '../providers/types'
import { MODEL_LIST_LIMIT, modelListText } from './modelList'

function provider(id: string, name: string, configured = true): ProviderInfo {
  return { id, name, builtIn: false, auth: 'apiKey', apiFormat: 'openai', baseUrl: 'http://localhost/v1', hasKey: configured, configured, supportsThinking: false }
}

function cache(...entries: [ProviderInfo, ModelInfo[]][]): ModelCache {
  return {
    version: 1,
    providers: Object.fromEntries(entries.map(([info, models]) => [info.id, { models, working: true, updatedAt: 0, lastCheckedAt: 0 }])),
  }
}

const VENICE = provider('venice', 'Venice')
const OPENROUTER = provider('openrouter', 'OpenRouter')
const VENICE_MODELS: ModelInfo[] = [
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', provider: VENICE.id },
  { id: 'mistral-small', name: 'Mistral Small', provider: VENICE.id },
]
const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'google/gemini-3-pro-preview', name: 'Google: Gemini 3 Pro Preview', provider: OPENROUTER.id },
  { id: 'google/gemini-3-flash', name: 'Google: Gemini 3 Flash', provider: OPENROUTER.id },
]
// The cache lists OpenRouter first; the result follows the provider order.
const CACHE = cache([OPENROUTER, OPENROUTER_MODELS], [VENICE, VENICE_MODELS])
const PROVIDERS = [VENICE, OPENROUTER]

describe('modelListText', () => {
  it('lists every model by full id, in provider order and then cache order', () => {
    expect(modelListText(CACHE, PROVIDERS)).toBe([
      '4 models (full id | name | provider):',
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice',
      'venice/mistral-small | Mistral Small | Venice',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter',
      'openrouter/google/gemini-3-flash | Google: Gemini 3 Flash | OpenRouter',
    ].join('\n'))
  })

  it('quotes the filter in the count line of a filtered list', () => {
    expect(modelListText(CACHE, PROVIDERS, 'gemini preview')).toBe([
      '2 models match "gemini preview" (full id | name | provider):',
      'venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice',
      'openrouter/google/gemini-3-pro-preview | Google: Gemini 3 Pro Preview | OpenRouter',
    ].join('\n'))
  })

  it('counts one match in the singular', () => {
    expect(modelListText(CACHE, PROVIDERS, 'mistral')).toBe([
      '1 model matches "mistral" (full id | name | provider):',
      'venice/mistral-small | Mistral Small | Venice',
    ].join('\n'))
    expect(modelListText(cache([VENICE, VENICE_MODELS.slice(1)]), PROVIDERS)).toBe([
      '1 model (full id | name | provider):',
      'venice/mistral-small | Mistral Small | Venice',
    ].join('\n'))
  })

  it('lists every model for a filter with no letters or digits', () => {
    expect(modelListText(CACHE, PROVIDERS, ' - ')).toBe(modelListText(CACHE, PROVIDERS))
  })

  it('says so when no model matches, with the filter as a JSON string', () => {
    expect(modelListText(CACHE, PROVIDERS, 'xyz')).toBe('No models match "xyz".')
    expect(modelListText(CACHE, PROVIDERS, 'say "hi"')).toBe('No models match "say \\"hi\\"".')
  })

  it('says so when the user can use no model, whatever the filter', () => {
    expect(modelListText(cache(), PROVIDERS)).toBe('No models are available.')
    expect(modelListText(CACHE, [provider('venice', 'Venice', false)], 'gemini')).toBe('No models are available.')
  })

  it(`stops after ${MODEL_LIST_LIMIT} models and counts the rest`, () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}`, name: `M ${index}`, provider: VENICE.id }))
    const full = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT)]), PROVIDERS).split('\n')
    expect(full).toHaveLength(MODEL_LIST_LIMIT + 1)
    expect(full.at(-1)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice`)

    const over = modelListText(cache([VENICE, many(MODEL_LIST_LIMIT + 3)]), PROVIDERS).split('\n')
    expect(over[0]).toBe(`${MODEL_LIST_LIMIT + 3} models (full id | name | provider):`)
    expect(over).toHaveLength(MODEL_LIST_LIMIT + 2)
    expect(over.at(-2)).toBe(`venice/m${MODEL_LIST_LIMIT - 1} | M ${MODEL_LIST_LIMIT - 1} | Venice`)
    expect(over.at(-1)).toBe('… and 3 more. Use a narrower filter.')
  })

  it('keeps each model on one line when a name holds a line break', () => {
    const models = [{ id: 'odd', name: 'Odd\nName  ', provider: VENICE.id }]
    expect(modelListText(cache([provider('venice', 'Ven\r\nice'), models]), [provider('venice', 'Ven\r\nice')])).toBe([
      '1 model (full id | name | provider):',
      'venice/odd | Odd Name | Ven ice',
    ].join('\n'))
  })

  it('keeps three columns when a name holds a |', () => {
    const piped = provider('venice', 'Ven|ice')
    const models = [{ id: 'odd', name: 'Odd | Name', provider: VENICE.id }]
    expect(modelListText(cache([piped, models]), [piped])).toBe([
      '1 model (full id | name | provider):',
      'venice/odd | Odd / Name | Ven/ice',
    ].join('\n'))
  })
})
