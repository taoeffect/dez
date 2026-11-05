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
