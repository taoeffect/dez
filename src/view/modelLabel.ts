import type { ModelRef } from '../model/chat/types'
import { modelRefKey } from '../model/chat/modelRef'
import type { ModelDisplayNames } from '../model/providers/types'

/** The names that an agent role pill and a history row show for a model, from
 *  `dez.provider/modelDisplayNames`. The model name falls back to the model
 *  id. The provider name has no fallback: custom provider ids are UUIDs, so
 *  an unknown or deleted provider shows no provider name instead of its id. */
export function modelLabel(ref: ModelRef, names: ModelDisplayNames): { modelName: string; providerName: string | null } {
  return {
    modelName: names.models.get(modelRefKey(ref)) || ref.modelId,
    providerName: names.providers.get(ref.providerId) || null,
  }
}

/** The model name in a tooltip (the picker row, the agent pill), by one rule
 *  for every provider: the model id, then a pretty name, as `<id> (<pretty
 *  name>)`. The pretty name is the readable name that the provider gives a
 *  model that is named by its id (`ModelInfo.readableName`), else the shown
 *  name. A name that is blank or the same as the id is no pretty name; with
 *  none, the tooltip is only the id. So the tooltip always holds the id,
 *  which the row or the pill does not show for a provider that gives its
 *  models pretty names. */
export function modelTooltipName(id: string, name: string, readableName: string | null | undefined): string {
  const prettyName = [readableName, name].find((candidate) => candidate?.trim() && candidate !== id)
  return prettyName ? `${id} (${prettyName})` : id
}
