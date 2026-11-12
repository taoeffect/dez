import { matchesInputFilter } from './modelInputs'
import { matchesOutputFilter, type ModelOutput } from './modelOutputs'
import type { ModelCache } from './persistence/types'
import type { ModelInfo, ProviderInfo } from './providers/types'

// The model search of the model picker and of the `model_list` tool, so that
// a search and an output filter find the same models in both.

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

// Lower case, and each run of characters other than `a-z0-9` becomes one
// space, so `Llama-3.1`, `llama 3 1`, and `LLAMA_3_1` read the same.
function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// The lower-case words of a field. A word starts after a character other
// than `A-Za-z0-9`, at a change from lower to upper case, and at a change
// between letters and digits: `DeepSeek-V3.1` gives `deep seek v 3 1`, and
// `gpt-4o` gives `gpt 4 o`. Capitals and the lower-case letters after them
// stay one word (`GPTs`).
function fieldWords(field: string): string[] {
  return (field.match(/[a-z]+|[A-Z]+[a-z]*|[0-9]+/g) ?? []).map((word) => word.toLowerCase())
}

// True when `term` splits into pieces that each start a word, in
// consecutive words: `gem3pro` in `gemini 3 pro`. `reached` holds the term
// offsets that a match can be at when the next word starts; 0 is always one
// of them, as a match can start at any word.
function startsConsecutiveWords(words: readonly string[], term: string): boolean {
  let reached = new Set([0])
  for (const word of words) {
    const next = new Set([0])
    for (const offset of reached) {
      for (let length = 1; length <= word.length && term[offset + length - 1] === word[length - 1]; length += 1) {
        if (offset + length === term.length) return true
        next.add(offset + length)
      }
    }
    reached = next
  }
  return false
}

/** The normalized words of a search query, in query order. A blank query
 *  has none. */
export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(' ').filter(Boolean)
}

/** True when every term matches one of the fields "provider name, provider
 *  id, model name, model id". A term matches a field when it is a substring
 *  of the field (`mini` in `gpt-4o-mini`), or when it splits into pieces
 *  that each start a word, in consecutive words of the field (`gpt4o` in
 *  `gpt-4o`, `dsv4` in `DeepSeek V4`). No terms match every model.
 *
 *  This is the VS Code command palette rule with fixed limits: a term never
 *  spans two fields, and its pieces never skip a word. Either one lets
 *  short terms match long texts by chance: with skips, `pro` finds "Pareto
 *  Code Router"; as letters in order over all fields, `gemini` finds GPT-5
 *  Mini. The user types two words instead (`gpt mini`). */
export function modelMatches(provider: ProviderInfo, model: ModelInfo, terms: readonly string[]): boolean {
  const fields = [provider.name, provider.id, model.name, model.id]
    .map((field) => ({ text: normalizeSearchText(field), words: fieldWords(field) }))
  return terms.every((term) => fields.some(({ text, words }) =>
    text.includes(term) || startsConsecutiveWords(words, term)))
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
