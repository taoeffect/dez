import { modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { MODEL_OUTPUT_IDS } from '../modelOutputs'
import { availableModels } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import { MODEL_REQUESTS, type ModelInfo, type ProviderInfo } from '../providers/types'
import type { ToolArguments, ToolDefinition } from './types'

/** The most characters of a `model_info` result with the provider's entry;
 *  a longer result leaves the entry out. */
export const MODEL_INFO_SIZE_CAP = 50_000

// The description comes from static tables only (no counts, no dates): the
// tools array is in the provider's prompt cache.
export const MODEL_INFO_TOOL: ToolDefinition = {
  name: 'model_info',
  description: 'Give all that Dez and the provider know about one model that the user can use, as JSON. '
    + '`id` is its full id, `name` its name, and `provider` the `id` and `name` of its provider. '
    + `\`dez\` holds what Dez knows about it: \`outputs\` (what it makes: ${MODEL_OUTPUT_IDS.join(', ')}), `
    + `\`request\` (how Dez sends it a request: ${MODEL_REQUESTS.join(', ')}; none means that Dez cannot use it yet), `
    + '`imageInput` (whether it reads images), and `toolCalling` (whether it calls tools). '
    + 'A field that Dez does not know is left out: with no `outputs`, Dez counts the model as a text model; '
    + 'with no `request`, it sends chat requests; with no `imageInput` or `toolCalling`, it sends images and tools. '
    + '`providerEntry` is the model\'s entry in the provider\'s model list as the provider sent it, such as its prices and context length; '
    + 'for a model that only the Dez provider settings list, it is the model\'s entry there. '
    + `A result over ${MODEL_INFO_SIZE_CAP} characters leaves \`providerEntry\` out and says so in \`note\`.`,
  parameters: [
    {
      name: 'model',
      type: 'string',
      description: 'The full id of the model (`provider/model`), as `model_list` gives it.',
      required: true,
    },
  ],
}

/** The provider and the cached model that a `model_info` call names. */
export interface ModelInfoTarget {
  provider: ProviderInfo
  model: ModelInfo
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

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** The `model_info` result for a model: pretty JSON with its full id, name,
 *  provider, what Dez knows about it (`dez`), and `entry`, the raw entry of
 *  its provider's model list, as `providerEntry`. With no entry (undefined),
 *  or when the result would be over MODEL_INFO_SIZE_CAP characters, `note`
 *  takes the place of `providerEntry` and says why. */
export function modelInfoText(provider: ProviderInfo, model: ModelInfo, entry: unknown): string {
  const info = {
    id: modelRefKey({ providerId: provider.id, modelId: model.id }),
    name: model.name,
    provider: { id: provider.id, name: provider.name },
    // JSON.stringify leaves out the undefined fields, the ones that Dez does
    // not know, as the description says.
    dez: { outputs: model.outputs, request: model.request, imageInput: model.imageInput, toolCalling: model.toolCalling },
  }
  if (entry === undefined) return prettyJson({ ...info, note: 'Dez has no entry from the provider for this model now. Try again later.' })

  const full = prettyJson({ ...info, providerEntry: entry })
  if (full.length <= MODEL_INFO_SIZE_CAP) return full
  return prettyJson({ ...info, note: `providerEntry is left out: with it, the result has ${full.length} characters, over the limit of ${MODEL_INFO_SIZE_CAP}.` })
}
