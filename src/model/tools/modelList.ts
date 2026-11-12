import { modelRefKey } from '../chat/modelRef'
import { OUTPUT_LETTER_LEGEND, outputLetters, parseOutputLetters } from '../modelOutputs'
import { availableModels, matchingModelsByProvider, searchTerms } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import type { ProviderInfo } from '../providers/types'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

/** The most model lines that one `model_list` result holds. */
export const MODEL_LIST_LIMIT = 50

// The description and the legend come from static tables only (no counts,
// no dates): the tools array is in the provider's prompt cache.
export const MODEL_LIST_TOOL: ToolDefinition = {
  name: 'model_list',
  description: 'List the models that the user can use in Dez. '
    + 'The first line gives the count, the column names, and what the output letters mean. '
    + 'Then each line gives one model: its full id (`provider/model`), its name, the name of its provider, '
    + 'and the letters of the outputs that it makes. '
    + 'The output letters show only when the provider reports what the model makes. '
    + 'With no `filter` and no `outputs`, the list has every model. '
    + `The list stops after ${MODEL_LIST_LIMIT} models.`,
  parameters: [
    {
      name: 'filter',
      type: 'string',
      description: 'Words that select models, as in the Dez model picker. '
        + 'A model matches when every word matches, in any word order. '
        + 'A word matches when it is part of the provider name, the provider id, the model name, or the model id, '
        + 'or when it is made of the starts of consecutive words of one of them: "gem3pro" matches "gemini-3-pro". '
        + 'To match two of them, use two words, as in "venice claude". Case and punctuation do not count.',
      required: false,
    },
    {
      name: 'outputs',
      type: 'string',
      description: `Output letters that select models by what they make (${OUTPUT_LETTER_LEGEND}), as in "iv" or "i,v". `
        + 'A model matches when it makes at least one of them. '
        + 'A model whose provider does not report what it makes counts as a text model. '
        + 'Use it alone or with `filter`.',
      required: false,
    },
  ],
}

const COLUMNS = '(full id | name | provider | outputs)'
const LEGEND = `Outputs: ${OUTPUT_LETTER_LEGEND}.`

// Names come from provider APIs and user input. A line break in one would
// split its model over two lines of the result, and a `|` would read as one
// more column; `/` takes its place, as in conversation titles. The full id
// stays as it is: the model must be able to give it back byte for byte.
function columnText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replaceAll('|', '/')
}

/** The `model_list` result when the user can use no model at all. */
export const NO_MODELS_TEXT = 'The user has no models that Dez can use: no provider is set up, or the model lists of the providers did not load. '
  + 'Tell the user to add an API key in Settings › Providers, or to look there for a provider with an error.'

/** The `model_list` result for the arguments of a call: the models that the
 *  user can pick (as the model picker shows them, with no Favorites group)
 *  that match `filter` and `outputs`, in provider order, then model cache
 *  order. A first line gives the count, the columns, and the output letter
 *  legend; the full id of each model leads its line. A model whose outputs
 *  are unknown (or empty) has no outputs column. A `filter` with no letters
 *  or digits selects every model, as in the picker, and so does an
 *  `outputs` of only commas and white space.
 *
 *  Throws for an `outputs` value with an unknown letter; the error names the
 *  valid letters, for the model to read. With no model, or no match, the
 *  result says why and what the model can do. */
export function modelListText(cache: ModelCache, providers: readonly ProviderInfo[], args: ToolArguments = {}): string {
  const filter = typeof args.filter === 'string' ? args.filter : ''
  const parsedOutputs = parseOutputLetters(typeof args.outputs === 'string' ? args.outputs : '')
  if (!parsedOutputs.ok) throw new ToolError(parsedOutputs.error)
  const { outputs } = parsedOutputs

  const models = availableModels(cache, providers)
  if (models.length === 0) return NO_MODELS_TEXT

  const terms = searchTerms(filter)
  // The arguments that narrow the list: the name of each one, how the
  // result tells its match, and the fix of a call that matches nothing.
  const narrowing = [
    ...(terms.length > 0 ? [{ name: '`filter`', text: JSON.stringify(filter), fix: 'fewer words in `filter`' }] : []),
    ...(outputs.length > 0 ? [{ name: '`outputs`', text: `outputs ${outputLetters(outputs)}`, fix: 'other letters in `outputs`' }] : []),
  ]
  const criteria = narrowing.map((argument) => argument.text).join(' and ')
  const lines = matchingModelsByProvider(providers, models, { terms, outputs }).flatMap(({ provider, models: matches }) =>
    matches.map((model) => {
      const columns = [modelRefKey({ providerId: provider.id, modelId: model.id }), columnText(model.name), columnText(provider.name)]
      const letters = outputLetters(model.outputs ?? [])
      if (letters !== '') columns.push(letters)
      return columns.join(' | ')
    }))
  const count = lines.length
  if (count === 0) {
    const fixes = narrowing.map((argument) => argument.fix).join(' or ')
    const given = narrowing.map((argument) => argument.name).join(' and no ')
    return `No models match ${criteria}. Call model_list again with ${fixes}, or with no ${given} to list every model.`
  }

  const counted = `${count} ${count === 1 ? 'model' : 'models'}`
  const matched = criteria === '' ? counted : `${counted} ${count === 1 ? 'matches' : 'match'} ${criteria}`
  const shown = lines.slice(0, MODEL_LIST_LIMIT)
  if (count > MODEL_LIST_LIMIT) shown.push(`… and ${count - MODEL_LIST_LIMIT} more. Use a narrower filter.`)
  return [`${matched} ${COLUMNS}. ${LEGEND}`, ...shown].join('\n')
}
