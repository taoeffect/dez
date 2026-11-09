import type { ModelCache } from './persistence/types'
import type { ModelInfo, ProviderInfo } from './providers/types'

// The model search of the model picker and of the `model_list` tool, so that
// a filter finds the same models in both.

/** One provider's models in a search result. */
export interface ProviderModels {
  provider: ProviderInfo
  models: ModelInfo[]
}

// Lower case, and each run of characters other than `a-z0-9` becomes one
// space, so `Llama-3.1`, `llama 3 1`, and `LLAMA_3_1` read the same.
function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// True when the characters of `term` occur in `text` in the same order,
// with any characters between them: `gp4` is in `gpt 4o`.
function includesInOrder(text: string, term: string): boolean {
  let termIndex = 0
  for (let textIndex = 0; textIndex < text.length && termIndex < term.length; textIndex += 1) {
    if (text[textIndex] === term[termIndex]) termIndex += 1
  }
  return termIndex === term.length
}

/** The normalized words of a search query, in query order. A blank query
 *  has none. */
export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(' ').filter(Boolean)
}

/** True when every term occurs, in order of its characters, in the text
 *  "provider name, provider id, model name, model id". The text is one
 *  string, so a term can start in one field and end in the next, and a
 *  substring is the simplest match. No terms match every model. */
export function modelMatches(provider: ProviderInfo, model: ModelInfo, terms: readonly string[]): boolean {
  const text = normalizeSearchText([provider.name, provider.id, model.name, model.id].join(' '))
  return terms.every((term) => includesInOrder(text, term))
}

/** The models that the user can pick, in model cache order: the cached
 *  models of each configured provider whose last model fetch did not fail. */
export function availableModels(cache: ModelCache, providers: readonly ProviderInfo[]): ModelInfo[] {
  const configured = new Set(providers.filter((provider) => provider.configured).map((provider) => provider.id))
  const models: ModelInfo[] = []
  for (const [providerId, entry] of Object.entries(cache.providers)) {
    if (!entry || entry.working === false || !configured.has(providerId)) continue
    models.push(...entry.models)
  }
  return models
}

/** The `models` (from `availableModels`) that match `terms`, grouped by
 *  provider in `providers` order, each group in `models` order. Providers
 *  with no match are left out. The provider's name and id lead the text
 *  that `modelMatches` reads, so terms that match a provider keep all its
 *  models. */
export function matchingModelsByProvider(
  providers: readonly ProviderInfo[],
  models: readonly ModelInfo[],
  terms: readonly string[],
): ProviderModels[] {
  const groups: ProviderModels[] = []
  for (const provider of providers) {
    const matches = models.filter((model) => model.provider === provider.id && modelMatches(provider, model, terms))
    if (matches.length > 0) groups.push({ provider, models: matches })
  }
  return groups
}
