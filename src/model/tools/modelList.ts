import { modelRefKey } from '../chat/modelRef'
import { modelInputs } from '../modelInputs'
import { MODEL_OUTPUT_IDS, OUTPUT_LETTER_LEGEND, outputLetters, parseOutputTypes, type ModelOutput } from '../modelOutputs'
import { availableModels, matchingModelsByProvider, searchTerms } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import type { ModelInfo, ProviderInfo } from '../providers/types'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

/** The most model lines that one `model_list` result holds. */
export const MODEL_LIST_LIMIT = 50

// One model of the list, with what its columns read.
interface ListedModel {
  provider: ProviderInfo
  model: ModelInfo
  inputs: readonly ModelOutput[]
}

interface ListColumn {
  // The `sort` value of the column.
  key: string
  // The name of the column in the first line of a result.
  title: string
  text: (row: ListedModel) => string
  // What `sort` compares, numbers in order (`compareNumbers`); undefined
  // for a value that the provider does not tell, which sorts last. Absent:
  // `sort` compares the text (`LIST_COLLATOR`).
  order?: (row: ListedModel) => readonly number[] | undefined
}

const UNKNOWN_TEXT = '?'
const NO_TYPES_TEXT = '-'

// Names come from provider APIs and user input. A line break in one would
// split its model over two lines of the result, and a `|` would read as one
// more column; `/` takes its place, as in conversation titles. The full id
// stays as it is: the model must be able to give it back byte for byte.
function columnText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replaceAll('|', '/')
}

// The letters of a list of types (`t,i`); `-` for none, `?` for a list
// that the provider does not tell.
function typesText(types: readonly ModelOutput[] | undefined): string {
  if (types === undefined) return UNKNOWN_TEXT
  return outputLetters(types) || NO_TYPES_TEXT
}

// The sort order of a list of types: the count of types first, then the
// table index of each one, so `t` < `i` < `v` < `t,i` < `t,a`.
function typesOrder(types: readonly ModelOutput[]): number[] {
  const indexes = MODEL_OUTPUT_IDS.flatMap((type, index) => (types.includes(type) ? [index] : []))
  return [indexes.length, ...indexes]
}

// The columns of a result, in line order. The header, each line, and the
// `sort` values all come from this list.
const LIST_COLUMNS: readonly ListColumn[] = [
  { key: 'id', title: 'full id', text: (row) => modelRefKey({ providerId: row.provider.id, modelId: row.model.id }) },
  { key: 'name', title: 'name', text: (row) => columnText(row.model.name) },
  { key: 'provider', title: 'provider', text: (row) => columnText(row.provider.name) },
  { key: 'type', title: 'type', text: (row) => typesText(row.model.outputs), order: (row) => row.model.outputs && typesOrder(row.model.outputs) },
  { key: 'inputs', title: 'inputs', text: (row) => typesText(row.inputs), order: (row) => typesOrder(row.inputs) },
  { key: 'released', title: 'released', text: (row) => row.model.released ?? UNKNOWN_TEXT, order: (row) => row.model.released?.split('-').map(Number) },
]

const SORT_KEYS = LIST_COLUMNS.map((column) => column.key)

const SORT_DIRECTIONS = ['asc', 'desc'] as const

type SortDirection = (typeof SORT_DIRECTIONS)[number]

const TYPE_VALUES = MODEL_OUTPUT_IDS.join(', ')

// The description and the legend come from static tables only (no counts,
// no dates): the tools array is in the provider's prompt cache.
export const MODEL_LIST_TOOL: ToolDefinition = {
  name: 'model_list',
  description: 'List the models that the user can use in Dez. '
    + 'The first line gives the count, the column names, and what the letters mean; '
    + 'when `filter` left out models that `type` or `inputs` alone select, it also gives their count. '
    + 'Then each line gives one model: its full id (`provider/model`), its name, the name of its provider, '
    + 'its type (the letters of the outputs that it makes), '
    + 'its inputs (the letters of what Dez can send it in one request: the text of the message, images, audio clips, video clips), '
    + 'and its release date (`YYYY-MM-DD`: the date that its provider gives, for some providers the day that the provider added the model). '
    + 'Dez sends a chat model only text and images, whatever its provider says that it reads; `model_info` tells more. '
    + '`?` stands for a value that the provider does not tell, and `-` for none. '
    + 'With no `filter`, no `type`, and no `inputs`, the list has every model. '
    + `The list stops after ${MODEL_LIST_LIMIT} models. \`sort\` orders all the models that match before that, `
    + 'so `sort: released` with `sort_dir: desc` lists the newest models first.',
  parameters: [
    {
      name: 'filter',
      type: 'string',
      description: 'Words that select models, as in the Dez model picker. '
        + 'A model matches when every word matches, in any word order. '
        + 'A word matches when it is part of the provider name, the provider id, the model name, or the model id, '
        + 'or when it is made of the starts of consecutive words of one of them: "gem3pro" matches "gemini-3-pro". '
        + 'To match two of them, use two words, as in "venice claude". Case and punctuation do not count. '
        + 'A word never matches a type: to select models by type, use `type` or `inputs`.',
      required: false,
    },
    {
      name: 'type',
      type: 'string',
      description: `Output types that select models by what they make: a comma list of ${TYPE_VALUES}, as in "image,video". `
        + 'A model matches when it makes at least one of them, as in the type filter of the Dez model picker. '
        + 'A model whose type is `?` counts as a text model. '
        + 'Use it alone or with the other parameters.',
      required: false,
    },
    {
      name: 'inputs',
      type: 'string',
      description: `Input types that select models by what Dez can send them: a comma list of ${TYPE_VALUES}, as in "audio,video". `
        + 'A model matches when it takes all of them in one request. '
        + 'Use it alone or with the other parameters.',
      required: false,
    },
    {
      name: 'sort',
      type: 'string',
      description: `The column that orders the list: ${SORT_KEYS.join(', ')}. `
        + '`type` and `inputs` order by the count of their letters, and `released` by date. '
        + 'Models with `?` in the column come last. '
        + 'With no `sort`, the models come in provider order, and the models of a provider in the order of its list.',
      required: false,
    },
    {
      name: 'sort_dir',
      type: 'string',
      description: 'The direction of `sort`: `asc` (the default: A to Z, the fewest letters first, the oldest date first) or `desc`.',
      required: false,
    },
  ],
}

const COLUMNS = `(${LIST_COLUMNS.map((column) => column.title).join(' | ')})`
const LEGEND = `Letters: ${OUTPUT_LETTER_LEGEND}; ${UNKNOWN_TEXT} unknown, ${NO_TYPES_TEXT} none.`

// Text compares as a person reads it: `model 9` before `model 10`, and
// case does not count.
const LIST_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

// Compares two lists of numbers in order, as a dictionary compares words.
function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

// `rows` in the order of `column`. A row whose value is unknown comes last
// in both directions. Array sort is stable, so the rows of one value keep
// their order in `rows` (provider order, then cache order).
function sortedRows(rows: readonly ListedModel[], column: ListColumn, direction: SortDirection): ListedModel[] {
  const sign = direction === 'desc' ? -1 : 1
  const { order } = column
  const keyed = rows.map((row) => ({ row, text: column.text(row), numbers: order?.(row) }))
  keyed.sort((a, b) => {
    if (!order) return sign * LIST_COLLATOR.compare(a.text, b.text)
    if (a.numbers === undefined || b.numbers === undefined) return Number(a.numbers === undefined) - Number(b.numbers === undefined)
    return sign * compareNumbers(a.numbers, b.numbers)
  })
  return keyed.map(({ row }) => row)
}

function stringArgument(args: ToolArguments, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value : ''
}

// The error of a call that gives `parameter` the values `values`, which it
// does not take; `valid` tells what it takes.
function unknownValuesText(parameter: string, values: readonly string[], valid: string): string {
  const quoted = values.map((value) => JSON.stringify(value)).join(', ')
  return `Unknown value${values.length === 1 ? '' : 's'} ${quoted} in \`${parameter}\`. Use ${valid}.`
}

// The types of the `type` or the `inputs` argument; none for a call with no
// such argument, or one of only commas and white space.
function typesArgument(args: ToolArguments, parameter: string): ModelOutput[] {
  const parsed = parseOutputTypes(stringArgument(args, parameter))
  if (!parsed.ok) throw new ToolError(unknownValuesText(parameter, parsed.unknown, `a comma list of: ${TYPE_VALUES}`))
  return parsed.types
}

// The column and direction of the `sort` and `sort_dir` arguments; none for
// a call with no `sort` (or a blank one). A `sort_dir` with no `sort` is an
// error, as the call would get a list in another order than it asked for.
function sortArgument(args: ToolArguments): { column: ListColumn, direction: SortDirection } | undefined {
  const key = stringArgument(args, 'sort').trim()
  const direction = stringArgument(args, 'sort_dir').trim()
  const directionKey = SORT_DIRECTIONS.find((candidate) => candidate === direction.toLowerCase())
  if (direction !== '' && !directionKey) throw new ToolError(unknownValuesText('sort_dir', [direction], `one of: ${SORT_DIRECTIONS.join(', ')}`))
  const sortKeys = SORT_KEYS.join(', ')
  if (key === '') {
    if (directionKey) throw new ToolError(`\`sort_dir\` is the direction of \`sort\`. Call model_list again with \`sort\` too (one of: ${sortKeys}), or with no \`sort_dir\`.`)
    return undefined
  }
  const column = LIST_COLUMNS.find((candidate) => candidate.key === key.toLowerCase())
  if (!column) throw new ToolError(unknownValuesText('sort', [key], `one of: ${sortKeys}`))
  return { column, direction: directionKey ?? 'asc' }
}

/** The `model_list` result when the user can use no model at all. */
export const NO_MODELS_TEXT = 'The user has no models that Dez can use: no provider is set up, or the model lists of the providers did not load. '
  + 'Tell the user to add an API key in Settings › Providers, or to look there for a provider with an error.'

/** The `model_list` result for the arguments of a call: the models that the
 *  user can pick (as the model picker shows them, with no Favorites group)
 *  that match `filter`, `type` (what they make, any of them), and `inputs`
 *  (what Dez can send them, `modelInputs`, all of them). They come in
 *  provider order, then model cache order, or in the order of the `sort`
 *  column, and the cap of `MODEL_LIST_LIMIT` lines comes after the sort. A
 *  first line gives the count, the columns (`LIST_COLUMNS`), the sort, and
 *  the letter legend; then each model has one line with every column. A
 *  `filter` with no letters or digits selects every model, as in the
 *  picker, and so does a `type` or `inputs` of only commas and white space.
 *
 *  Throws for an argument value that the tool does not take, before it
 *  looks at the models; the error names the valid values, for the model to
 *  read. With no model, or no match, the result says why and what the model
 *  can do. */
export function modelListText(cache: ModelCache, providers: readonly ProviderInfo[], args: ToolArguments = {}): string {
  const filter = stringArgument(args, 'filter')
  const outputs = typesArgument(args, 'type')
  const inputs = typesArgument(args, 'inputs')
  const sort = sortArgument(args)

  const models = availableModels(cache, providers)
  if (models.length === 0) return NO_MODELS_TEXT

  const terms = searchTerms(filter)
  // The arguments that narrow the list: the name of each one, how the
  // result tells its match, and the fix of a call that matches nothing.
  const narrowing = [
    ...(terms.length > 0 ? [{ name: '`filter`', text: JSON.stringify(filter), fix: 'fewer words in `filter`' }] : []),
    ...(outputs.length > 0 ? [{ name: '`type`', text: `type ${outputs.join(',')}`, fix: 'other values in `type`' }] : []),
    ...(inputs.length > 0 ? [{ name: '`inputs`', text: `inputs ${inputs.join(',')}`, fix: 'fewer values in `inputs`' }] : []),
  ]
  const criteria = narrowing.map((argument) => argument.text).join(' and ')
  const rows = matchingModelsByProvider(providers, models, { terms, outputs, inputs }).flatMap(({ provider, models: matches }) =>
    matches.map((model) => ({ provider, model, inputs: modelInputs(model) })))
  const count = rows.length
  // A `filter` word matches only names and ids, so a word such as "video"
  // next to `type: video` leaves out every video model whose name does not
  // hold it (in a paid test, the cheapest one). The count of the models of
  // the types alone tells the calling model that it missed some.
  const typeCriteria = narrowing.filter((argument) => argument.name !== '`filter`').map((argument) => argument.text).join(' and ')
  const typeCount = terms.length > 0 && typeCriteria !== ''
    ? matchingModelsByProvider(providers, models, { terms: [], outputs, inputs }).reduce((sum, group) => sum + group.models.length, 0)
    : count
  const filterNote = typeCount > count
    ? ` Without \`filter\`, ${typeCount} ${typeCount === 1 ? 'model matches' : 'models match'} ${typeCriteria}: a \`filter\` word matches only names and ids, not types.`
    : ''
  if (count === 0) {
    const fixes = narrowing.map((argument) => argument.fix).join(' or ')
    const given = narrowing.map((argument) => argument.name).join(' and no ')
    return `No models match ${criteria}. Call model_list again with ${fixes}, or with no ${given} to list every model.${filterNote}`
  }

  const counted = `${count} ${count === 1 ? 'model' : 'models'}`
  const matched = criteria === '' ? counted : `${counted} ${count === 1 ? 'matches' : 'match'} ${criteria}`
  const sorted = sort ? `, sorted by ${sort.column.key} ${sort.direction}` : ''
  const shown = (sort ? sortedRows(rows, sort.column, sort.direction) : rows).slice(0, MODEL_LIST_LIMIT)
    .map((row) => LIST_COLUMNS.map((column) => column.text(row)).join(' | '))
  if (count > MODEL_LIST_LIMIT) shown.push(`… and ${count - MODEL_LIST_LIMIT} more. Use a narrower filter.`)
  return [`${matched} ${COLUMNS}${sorted}. ${LEGEND}${filterNote}`, ...shown].join('\n')
}
