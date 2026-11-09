import { modelRefKey } from '../chat/modelRef'
import { availableModels, matchingModelsByProvider, searchTerms } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import type { ProviderInfo } from '../providers/types'
import type { ToolDefinition } from './types'

/** The most model lines that one `model_list` result holds. */
export const MODEL_LIST_LIMIT = 50

export const MODEL_LIST_TOOL: ToolDefinition = {
  name: 'model_list',
  description: 'List the models that the user can use in Dez. After a first line with the count, '
    + 'each line gives one model: its full id (`provider/model`), its name, and the name of its provider. '
    + `The list stops after ${MODEL_LIST_LIMIT} models.`,
  parameters: [
    {
      name: 'filter',
      type: 'string',
      description: 'Words that select models, as in the Dez model picker. '
        + 'A model matches when every word matches, in any word order. '
        + 'A word matches when its letters and digits occur in the same order in the text '
        + '"provider name, provider id, model name, model id": a substring matches, '
        + 'and so does "gem3pro" for "gemini-3-pro". Case and punctuation do not count. '
        + 'Leave it out to list every model.',
      required: false,
    },
  ],
}

const COLUMNS = '(full id | name | provider)'

// Names come from provider APIs and user input. A line break in one would
// split its model over two lines of the result.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** The `model_list` result: the models that the user can pick (as the model
 *  picker shows them, with no Favorites group) that match `filter`, in
 *  provider order, then model cache order. A first line gives the count; the
 *  full id of each model leads its line. A filter with no letters or digits
 *  lists every model, as it does in the picker. */
export function modelListText(cache: ModelCache, providers: readonly ProviderInfo[], filter?: string): string {
  const models = availableModels(cache, providers)
  if (models.length === 0) return 'No models are available.'

  const terms = searchTerms(filter ?? '')
  const quotedFilter = terms.length > 0 ? JSON.stringify(filter) : null
  const lines = matchingModelsByProvider(providers, models, terms).flatMap(({ provider, models: matches }) =>
    matches.map((model) => {
      const fullId = modelRefKey({ providerId: provider.id, modelId: model.id })
      return `${fullId} | ${oneLine(model.name)} | ${oneLine(provider.name)}`
    }))
  const count = lines.length
  if (count === 0) return `No models match ${quotedFilter}.`

  const counted = `${count} ${count === 1 ? 'model' : 'models'}`
  const header = quotedFilter === null
    ? `${counted} ${COLUMNS}:`
    : `${counted} ${count === 1 ? 'matches' : 'match'} ${quotedFilter} ${COLUMNS}:`
  const shown = lines.slice(0, MODEL_LIST_LIMIT)
  if (count > MODEL_LIST_LIMIT) shown.push(`… and ${count - MODEL_LIST_LIMIT} more. Use a narrower filter.`)
  return [header, ...shown].join('\n')
}
