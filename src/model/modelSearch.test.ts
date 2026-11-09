import { describe, expect, it } from 'vitest'
import { availableModels, matchingModelsByProvider, modelMatches, searchTerms } from './modelSearch'
import type { CachedProvider, ModelCache } from './persistence/types'
import { providerInfo } from './providers/testing'
import type { ModelInfo, ProviderInfo } from './providers/types'

function cached (models: ModelInfo[], working = true): CachedProvider {
  return { models, working, updatedAt: 0, lastCheckedAt: 0 }
}

const ACME = providerInfo('acme-cloud', 'Acme Cloud')
const BETA = providerInfo('beta_hub', 'Beta Hub')
const ACME_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: ACME.id },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: ACME.id },
  { id: 'gemini-flash', name: 'Gemini Flash', provider: ACME.id },
]
const BETA_MODELS: ModelInfo[] = [
  { id: 'meta/llama-3.1-70b', name: 'Llama 3.1 70B', provider: BETA.id },
  { id: 'google/gemini-3-flash', name: 'Google: Gemini 3 Flash', provider: BETA.id },
]
const MODELS = [...ACME_MODELS, ...BETA_MODELS]

/** The ids of the matching models, as `provider id: model ids`. */
function search (query: string, providers: ProviderInfo[] = [ACME, BETA]): string[] {
  return matchingModelsByProvider(providers, MODELS, searchTerms(query))
    .map((group) => `${group.provider.id}: ${group.models.map((model) => model.id).join(', ')}`)
}

describe('searchTerms', () => {
  it('splits a query into lower-case words of letters and digits', () => {
    expect(searchTerms('  Llama-3.1_70B  gpt/4o ')).toStrictEqual(['llama', '3', '1', '70b', 'gpt', '4o'])
  })

  it('gives no words for a blank or punctuation-only query', () => {
    expect(searchTerms('')).toStrictEqual([])
    expect(searchTerms(' -- / ')).toStrictEqual([])
  })
})

describe('modelMatches', () => {
  const mini = ACME_MODELS[1]

  it('matches every model when there are no terms', () => {
    expect(modelMatches(ACME, mini, [])).toBe(true)
  })

  it('needs every term, in any order', () => {
    expect(modelMatches(ACME, mini, searchTerms('mini 4o'))).toBe(true)
    expect(modelMatches(ACME, mini, searchTerms('4o mini'))).toBe(true)
    expect(modelMatches(ACME, mini, searchTerms('mini max'))).toBe(false)
  })

  it('matches a term that is a substring of one field', () => {
    expect(modelMatches(ACME, mini, ['ini'])).toBe(true)
    expect(modelMatches(ACME, mini, ['me'])).toBe(true)
    // The provider id and the model id count too: `3` is only in the
    // provider id `c3`, and `meta` only in the model id.
    expect(modelMatches(providerInfo('c3', 'Cobalt'), { id: 'one', name: 'One', provider: 'c3' }, ['c3'])).toBe(true)
    expect(modelMatches(BETA, BETA_MODELS[0], ['meta'])).toBe(true)
  })

  it('matches a term made of the starts of consecutive words of one field', () => {
    expect(modelMatches(ACME, mini, ['acmecloud'])).toBe(true)
    expect(modelMatches(ACME, mini, ['gpt4omini'])).toBe(true)
    expect(modelMatches(ACME, mini, ['gp4om'])).toBe(true)
    expect(modelMatches(ACME, mini, ['4pg'])).toBe(false)
  })

  it('starts a word at a lower-to-upper case change and at a letter-digit change', () => {
    const deepSeek = { id: 'deepseek-v3.1', name: 'DeepSeek V3.1', provider: ACME.id }
    expect(modelMatches(ACME, deepSeek, ['dsv31'])).toBe(true)
    const qwen = { id: 'qwen3-coder', name: 'Qwen3 Coder', provider: ACME.id }
    expect(modelMatches(ACME, qwen, ['q3c'])).toBe(true)
  })

  it('never lets a term skip a word or span two fields', () => {
    // `g4m` skips the `o` of `gpt-4o-mini`; `cloudgpt` spans the provider
    // name and the model name.
    expect(modelMatches(ACME, mini, ['g4m'])).toBe(false)
    expect(modelMatches(ACME, mini, ['cloudgpt'])).toBe(false)
    // Junk that looser rules give on a real model list.
    expect(modelMatches(ACME, { id: 'pareto-code-router', name: 'Pareto Code Router', provider: ACME.id }, ['pro'])).toBe(false)
    const openRouter = providerInfo('openrouter', 'OpenRouter')
    const gpt5Mini = { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', provider: openRouter.id }
    expect(modelMatches(openRouter, gpt5Mini, ['gemini'])).toBe(false)
  })

  it('ignores case and punctuation in the query and the fields', () => {
    expect(modelMatches(BETA, BETA_MODELS[0], searchTerms('LLAMA 3 1'))).toBe(true)
    expect(modelMatches(BETA, BETA_MODELS[0], searchTerms('llama-3.1'))).toBe(true)
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
})
