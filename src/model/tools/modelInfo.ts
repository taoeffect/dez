import { modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { MODEL_OUTPUT_IDS } from '../modelOutputs'
import { availableModels } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import { checkedParameterValues, type ParameterValues } from '../providers/modelParameters'
import { MODEL_REQUESTS, type ModelInfo, type ProviderInfo } from '../providers/types'
import { jsonWithoutLocalPaths } from './localPaths'
import type { ToolArguments, ToolDefinition } from './types'

/** The most characters of a `model_info` result with the provider's
 *  entries; a longer result leaves the entries out. */
export const MODEL_INFO_SIZE_CAP = 50_000

// The description comes from static tables only (no counts, no dates): the
// tools array is in the provider's prompt cache.
export const MODEL_INFO_TOOL: ToolDefinition = {
  name: 'model_info',
  description: 'Give all that Dez and the provider know about one model that the user can use, as JSON. '
    + '`id` is its full id, `name` its name, and `provider` the `id` and `name` of its provider. '
    + `\`dez\` holds what Dez knows about it: \`outputs\` (what it makes: ${MODEL_OUTPUT_IDS.join(', ')}), `
    + `\`request\` (how Dez sends it a request: ${MODEL_REQUESTS.join(', ')}; none means that Dez cannot use it yet), `
    + '`imageInput` (whether it reads images), `toolCalling` (whether it calls tools), '
    + '`parameters` (what a request to it can set, such as the length of a clip or a voice), '
    + 'and `cost` (the provider\'s price for one request). '
    + 'A field that Dez does not know is left out: with no `outputs`, Dez counts the model as a text model; '
    + 'with no `request`, it sends chat requests; with no `imageInput` or `toolCalling`, it sends images and tools. '
    + 'Each of the `parameters` has a `name`, a `label` (its name in the Dez settings), '
    + 'and `options` (the values that it takes), or `min` and `max` '
    + '(it takes each number from `min` to `max` in steps of `step`; with no `step`, in steps of 1). '
    + 'A parameter with none of these is a switch: it takes `true` or `false`. '
    + 'Its `default` is the value that Dez sends when no one chose a value, and its `value` is the value that Dez sends now: '
    + 'the one from the `parameters` argument of this call, else the one that the user chose in the Dez settings, else the default. '
    + 'With no `value`, Dez sends none and the provider\'s own default applies. '
    + '`cost` has `usd`, the price in US dollars of one request with those values, or `error` when the provider did not give the price. '
    + 'With no `cost`, the provider gives no price for one request; its prices are then in the entries below. '
    + '`providerEntry` is the model\'s entry in the provider\'s model list as the provider sent it, such as its prices and context length; '
    + 'for a model that only the Dez provider settings list, it is the model\'s entry there. '
    + '`mediaEntry` is its entry in the provider\'s list of media models, for a provider that has such a list. '
    + 'Dez hides the local file paths in the entries that can show a user name or a project name: '
    + 'such a path keeps only its start, and `…` stands for the rest (for example `/home/…`). The `id` at the top is never changed. '
    + `A result over ${MODEL_INFO_SIZE_CAP} characters leaves the entries out and says so in \`note\`.`,
  parameters: [
    {
      name: 'model',
      type: 'string',
      description: 'The full id of the model (`provider/model`), as `model_list` gives it.',
      required: true,
    },
    {
      name: 'parameters',
      type: 'string',
      description: 'Values for parameters of the model, as the text of a JSON object from parameter name to value '
        + '(for example `{"duration": "5s"}`). `value` and `cost` in the result are then for a request with these values. '
        + 'Use it to tell the user what a request costs. It changes no setting.',
      required: false,
    },
  ],
}

/** The provider and the cached model that a `model_info` call names. */
export interface ModelInfoTarget {
  provider: ProviderInfo
  model: ModelInfo
}

/** What a `model_info` result tells about a request to a media model. */
export interface ModelInfoRequest {
  /** The value that Dez sends for each parameter that gets one
   *  (`effectiveParameterValues`). */
  values: ParameterValues
  /** The provider's price of one request with `values`, or why there is
   *  none. Absent when the provider has no price for one request. */
  cost?: { usd: number } | { error: string }
  /** The model's raw entry in the model list of the provider's media API.
   *  Absent when the provider has no such list, or the list not the model. */
  mediaEntry?: unknown
}

const FIND_MODELS = 'Use model_list to find the full ids of the models that the user can use.'

/** The provider and the model that the `model` argument of a call names (a
 *  full id, `provider/model`), among the models that `model_list` lists
 *  (`availableModels`).
 *
 *  Throws for an id that is not a full id, an unknown provider, and a model
 *  that the user cannot use; the error points to `model_list`, for the model
 *  to read. */
export function modelInfoTarget(cache: ModelCache, providers: readonly ProviderInfo[], args: ToolArguments): ModelInfoTarget {
  const fullId = typeof args.model === 'string' ? args.model : ''
  const ref = parseModelRefKey(fullId)
  if (!ref) throw new Error(`${JSON.stringify(fullId)} is not a full model id (provider/model). ${FIND_MODELS}`)

  const provider = providers.find((candidate) => candidate.id === ref.providerId)
  if (!provider) throw new Error(`No provider has the id ${JSON.stringify(ref.providerId)}. ${FIND_MODELS}`)

  const model = availableModels(cache, [provider]).find((candidate) => candidate.id === ref.modelId)
  if (!model) throw new Error(`The user cannot use the model ${JSON.stringify(fullId)}. ${FIND_MODELS}`)

  return { provider, model }
}

/** The parameter values that the `parameters` argument of a call names (the
 *  text of a JSON object); none when the call has no such argument.
 *
 *  Throws for a text that is not a JSON object, a name that is not a
 *  parameter of the model, and a value that its parameter does not take
 *  (`checkedParameterValues`); the model reads the error. */
export function modelInfoParameterValues(model: ModelInfo, args: ToolArguments): ParameterValues {
  if (typeof args.parameters !== 'string') return {}
  let chosen: unknown
  try {
    chosen = JSON.parse(args.parameters)
  } catch {
    chosen = undefined
  }
  if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) {
    throw new Error('`parameters` must be the text of a JSON object, for example {"duration": "5s"}.')
  }
  return checkedParameterValues(model.parameters ?? [], chosen as Record<string, unknown>)
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** The `model_info` result for a model: pretty JSON with its full id, name,
 *  provider, what Dez knows about it (`dez`), and the raw entries of its
 *  provider: `entry`, the one of the model list, as `providerEntry`, and
 *  `request.mediaEntry` as `mediaEntry`. With no `entry` (undefined), or
 *  when the result would be over MODEL_INFO_SIZE_CAP characters, `note`
 *  takes the place of the entries and says why.
 *
 *  The local file paths in the entries go as stand-ins (localPaths.ts).
 *  This is done here, and not when a request is built, because the result
 *  is stored in its `<dez:tool>` block as it was sent, and the prompt cache
 *  needs the same bytes in each later request. The model's own id and name
 *  stay as they are, even when a local server uses a path as the id: Dez
 *  needs the id to call the model, and `model_list` gives both. */
export function modelInfoText(provider: ProviderInfo, model: ModelInfo, entry: unknown, request: ModelInfoRequest = { values: {} }): string {
  const { values, cost, mediaEntry } = request
  const info = {
    id: modelRefKey({ providerId: provider.id, modelId: model.id }),
    name: model.name,
    provider: { id: provider.id, name: provider.name },
    // JSON.stringify leaves out the undefined fields, the ones that Dez does
    // not know, as the description says.
    dez: {
      outputs: model.outputs,
      request: model.request,
      imageInput: model.imageInput,
      toolCalling: model.toolCalling,
      // The options come from the provider's entries, so they get the
      // same stand-ins.
      parameters: model.parameters?.map((parameter) => jsonWithoutLocalPaths({
        ...parameter,
        ...(Object.hasOwn(values, parameter.name) && { value: values[parameter.name] }),
      })),
      cost,
    },
  }
  if (entry === undefined) return prettyJson({ ...info, note: 'Dez has no entry from the provider for this model now. Try again later.' })

  const full = prettyJson({
    ...info,
    providerEntry: jsonWithoutLocalPaths(entry),
    ...(mediaEntry !== undefined && { mediaEntry: jsonWithoutLocalPaths(mediaEntry) }),
  })
  if (full.length <= MODEL_INFO_SIZE_CAP) return full
  return prettyJson({ ...info, note: `The provider's entries are left out: with them, the result has ${full.length} characters, over the limit of ${MODEL_INFO_SIZE_CAP}.` })
}
