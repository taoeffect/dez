import { matchesInputFilter } from './modelInputs'
import { matchesOutputFilter, type ModelOutput } from './modelOutputs'
import type { ModelCache } from './persistence/types'
import type { ModelInfo, ProviderInfo } from './providers/types'
import { textMatches } from './textSearch'

// The model search of the model picker and of the `model_list` tool, so that
// a search and an output filter find the same models in both. The rule of
// the words of a search is in textSearch.ts.

/** One provider's models in a search result. */
export interface ProviderModels {
  provider: ProviderInfo
  models: ModelInfo[]
}

/** A model search: the words of the query (`searchTerms`), the output
 *  filter (`matchesOutputFilter`; empty for every output), and the input
 *  filter (`matchesInputFilter`; absent or empty for every model; only
 *  `model_list` sets it). */
export interface ModelQuery {
  terms: readonly string[]
  outputs: readonly ModelOutput[]
  inputs?: readonly ModelOutput[]
}

/** True when every term matches one of the fields "provider name, provider
 *  id, model name, model id", by the rule of `textMatches`: a term never
 *  spans two fields. No terms match every model. */
export function modelMatches(provider: ProviderInfo, model: ModelInfo, terms: readonly string[]): boolean {
  return textMatches([provider.name, provider.id, model.name, model.id], terms)
}

/** True when the model makes one of the query's outputs, takes all its
 *  inputs, and matches all its terms (`modelMatches`). */
export function modelMatchesQuery(provider: ProviderInfo, model: ModelInfo, query: ModelQuery): boolean {
  return matchesOutputFilter(model, query.outputs) && matchesInputFilter(model, query.inputs ?? []) && modelMatches(provider, model, query.terms)
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

/** The `models` (from `availableModels`) that match `query`, grouped by
 *  provider in `providers` order, each group in `models` order. Providers
 *  with no match are left out. `modelMatches` reads the provider's name and
 *  id, so terms that match a provider keep all its models (that pass the
 *  output filter). */
export function matchingModelsByProvider(
  providers: readonly ProviderInfo[],
  models: readonly ModelInfo[],
  query: ModelQuery,
): ProviderModels[] {
  const groups: ProviderModels[] = []
  for (const provider of providers) {
    const matches = models.filter((model) => model.provider === provider.id && modelMatchesQuery(provider, model, query))
    if (matches.length > 0) groups.push({ provider, models: matches })
  }
  return groups
}
