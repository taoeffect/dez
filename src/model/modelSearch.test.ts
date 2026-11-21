import { describe, expect, it } from 'vitest'
import type { ModelOutput } from './modelOutputs'
import { availableModels, matchingModelsByProvider, modelMatches } from './modelSearch'
import type { CachedProvider, ModelCache } from './persistence/types'
import { providerInfo } from './providers/testing'
import type { ModelInfo, ProviderInfo } from './providers/types'
import { searchTerms } from './textSearch'

function cached (models: ModelInfo[], working = true): CachedProvider {
  return { models, working, updatedAt: 0, lastCheckedAt: 0 }
}

const ACME = providerInfo('acme-cloud', 'Acme Cloud')
const BETA = providerInfo('beta_hub', 'Beta Hub')
const ACME_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: ACME.id, outputs: ['text'] },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: ACME.id },
  { id: 'gemini-flash', name: 'Gemini Flash', provider: ACME.id, outputs: ['text', 'image'] },
]
const BETA_MODELS: ModelInfo[] = [
  { id: 'meta/llama-3.1-70b', name: 'Llama 3.1 70B', provider: BETA.id },
  { id: 'google/gemini-3-flash', name: 'Google: Gemini 3 Flash', provider: BETA.id, outputs: ['image'] },
]
const MODELS = [...ACME_MODELS, ...BETA_MODELS]

/** The ids of the models that match `query` and the output filter
 *  `outputs`, as `provider id: model ids`. */
function search (query: string, providers: ProviderInfo[] = [ACME, BETA], outputs: ModelOutput[] = []): string[] {
  return matchingModelsByProvider(providers, MODELS, { terms: searchTerms(query), outputs })
    .map((group) => `${group.provider.id}: ${group.models.map((model) => model.id).join(', ')}`)
}

// The rule of a term is textMatches (textSearch.test.ts); these tests tell
// which texts of a model it reads.
describe('modelMatches', () => {
  const mini = ACME_MODELS[1]

  it('matches every model when there are no terms', () => {
    expect(modelMatches(ACME, mini, [])).toBe(true)
  })

  it('reads the provider name, the provider id, the model name, and the model id', () => {
    const cobalt = providerInfo('c3', 'Cobalt')
    const one = { id: 'one-7b', name: 'Fast One', provider: cobalt.id }
    for (const term of ['cobalt', 'c3', 'fast', '7b']) {
      expect(modelMatches(cobalt, one, [term]), term).toBe(true)
    }
    expect(modelMatches(cobalt, one, ['slow'])).toBe(false)
  })

  it('never lets a term span two of them', () => {
    // `cloudgpt` spans the provider name and the model name.
    expect(modelMatches(ACME, mini, ['cloudgpt'])).toBe(false)
    expect(modelMatches(ACME, mini, searchTerms('cloud gpt'))).toBe(true)
  })
})

describe('availableModels', () => {
  it('lists the cached models of configured providers whose last fetch worked, in cache order', () => {
    const offline = providerInfo('offline', 'Offline')
    const keyless = providerInfo('keyless', 'Keyless', false)
    const cache: ModelCache = {
      version: 1,
      providers: {
        [BETA.id]: cached(BETA_MODELS),
        [offline.id]: cached([{ id: 'down', name: 'Down', provider: offline.id }], false),
        [keyless.id]: cached([{ id: 'locked', name: 'Locked', provider: keyless.id }]),
        [ACME.id]: cached(ACME_MODELS),
      },
    }
    // `uncached` has no cache entry and gives no models.
    const providers = [ACME, BETA, offline, keyless, providerInfo('uncached', 'Uncached')]
    expect(availableModels(cache, providers)).toStrictEqual([...BETA_MODELS, ...ACME_MODELS])
  })
})

describe('matchingModelsByProvider', () => {
  it('groups every model by provider, in provider order, when there are no terms', () => {
    expect(search('', [BETA, ACME])).toStrictEqual([
      'beta_hub: meta/llama-3.1-70b, google/gemini-3-flash',
      'acme-cloud: gpt-4o, gpt-4o-mini, gemini-flash',
    ])
  })

  it('keeps every model of a provider that the terms match', () => {
    expect(search('acme')).toStrictEqual(['acme-cloud: gpt-4o, gpt-4o-mini, gemini-flash'])
    expect(search('b h')).toStrictEqual(['beta_hub: meta/llama-3.1-70b, google/gemini-3-flash'])
  })

  it('leaves out the providers with no matching model', () => {
    expect(search('gemini')).toStrictEqual(['acme-cloud: gemini-flash', 'beta_hub: google/gemini-3-flash'])
    expect(search('cloud flash')).toStrictEqual(['acme-cloud: gemini-flash'])
    expect(search('xyz')).toStrictEqual([])
  })

  it('keeps only the models that make one of the filter types, with the terms', () => {
    expect(search('', [ACME, BETA], ['image'])).toStrictEqual(['acme-cloud: gemini-flash', 'beta_hub: google/gemini-3-flash'])
    // A model with unknown outputs counts as a text model.
    expect(search('', [ACME, BETA], ['text'])).toStrictEqual([
      'acme-cloud: gpt-4o, gpt-4o-mini, gemini-flash',
      'beta_hub: meta/llama-3.1-70b',
    ])
    // Terms that match a provider keep only its models of the filter types.
    expect(search('acme', [ACME, BETA], ['image'])).toStrictEqual(['acme-cloud: gemini-flash'])
    expect(search('gemini', [ACME, BETA], ['text'])).toStrictEqual(['acme-cloud: gemini-flash'])
    expect(search('', [ACME, BETA], ['audio', 'video'])).toStrictEqual([])
  })
})
