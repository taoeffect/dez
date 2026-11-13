import { rawErrorText } from '../../utils/errorText'
import { parseModelRefKey } from '../chat/modelRef'
import type { ModelRef } from '../chat/types'
import { availableModels } from '../modelSearch'
import type { ModelCache } from '../persistence/types'
import { checkedParameterValues, type ParameterValues } from '../providers/modelParameters'
import type { ModelInfo, ProviderInfo } from '../providers/types'
import { ToolError, type ToolArguments } from './types'

// The arguments that the tools of one model share (`model_info`,
// `model_invoke`): the model that a call names by its full id, and the
// values of its parameters. One reader for each, so that both tools take
// the same ids and the same values, and answer a bad one with the same
// text.

/** Where a model finds the full id of a model. */
export const FIND_MODELS = 'Use model_list to find the full ids of the models that the user can use.'

/** The provider and the cached model of a call. */
export interface ModelTarget {
  provider: ProviderInfo
  model: ModelInfo
}

/** The provider of `ref`, and its model among the models that `model_list`
 *  lists (`availableModels`); each one is absent when there is none. */
export function listedModel(cache: ModelCache, providers: readonly ProviderInfo[], ref: ModelRef): Partial<ModelTarget> {
  const provider = providers.find((candidate) => candidate.id === ref.providerId)
  const model = provider && availableModels(cache, [provider]).find((candidate) => candidate.id === ref.modelId)
  return { ...(provider && { provider }), ...(model && { model }) }
}

/** The provider and the model that a call names with `named`, a full id
 *  (`provider/model`, split at the first `/`), among the models that
 *  `model_list` lists.
 *
 *  Throws for a text that is not a full id, an unknown provider, and a
 *  model that the user cannot use; the error points to `model_list`, for
 *  the model to read. `advice` is what the error of a text that is no full
 *  id adds: a tool whose `model` is optional tells there what a call with
 *  no `model` gets. */
export function namedModelTarget(cache: ModelCache, providers: readonly ProviderInfo[], named: string, advice = ''): ModelTarget {
  const ref = parseModelRefKey(named)
  if (!ref) throw new ToolError(`${JSON.stringify(named)} is not a full model id (provider/model). ${FIND_MODELS}${advice === '' ? '' : ` ${advice}`}`)
  const { provider, model } = listedModel(cache, providers, ref)
  if (provider && model) return { provider, model }
  if (!provider) throw new ToolError(`No provider has the id ${JSON.stringify(ref.providerId)}. ${FIND_MODELS}`)
  throw new ToolError(`The user cannot use the model ${JSON.stringify(named)}. ${FIND_MODELS}`)
}

/** The parameter values that the `parameters` argument of a call names (the
 *  text of a JSON object); none when the call has no such argument.
 *
 *  Throws for a text that is not a JSON object, a name that is not a
 *  parameter of the model, and a value that its parameter does not take
 *  (`checkedParameterValues`); the model reads the error. */
export function parameterValuesArgument(model: ModelInfo, args: ToolArguments): ParameterValues {
  if (typeof args.parameters !== 'string') return {}
  let chosen: unknown
  try {
    chosen = JSON.parse(args.parameters)
  } catch {
    chosen = undefined
  }
  if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) {
    throw new ToolError('`parameters` must be the text of a JSON object, for example {"duration": "5s"}.')
  }
  try {
    return checkedParameterValues(model.parameters ?? [], chosen as Record<string, unknown>)
  } catch (error) {
    // A provider module throws plain errors, but their texts tell the
    // calling model which names and values the media model takes.
    throw new ToolError(rawErrorText(error), '', { cause: error })
  }
}
