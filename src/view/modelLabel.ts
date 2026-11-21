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

/** The provider line of a model tooltip for an unknown or a deleted
 *  provider, which `modelLabel` gives no name. */
export const UNKNOWN_PROVIDER = 'Unknown provider'

/** The facts of a model that its tooltips tell: the agent pill
 *  (`addModelToPill`), the model button of the bottom bar
 *  (`ModelSelector.vue`), and the model label of an asset
 *  (`assetModelLabel.ts`). */
export interface ModelFacts {
  /** `modelRefKey` of the model: the only fact that holds the provider id
   *  (all that Dez knows of a deleted provider). */
  key: string
  /** The shown name: the model name, else the model id (`modelLabel`). */
  name: string
  /** The id with the pretty name (`modelTooltipName`). */
  tooltipName: string
  /** Null for an unknown or a deleted provider (`modelLabel`). */
  providerName: string | null
}

/** The facts of the model `ref` with the names `names`. */
export function modelFacts(ref: ModelRef, names: ModelDisplayNames): ModelFacts {
  const key = modelRefKey(ref)
  const { modelName, providerName } = modelLabel(ref, names)
  return { key, name: modelName, tooltipName: modelTooltipName(ref.modelId, modelName, names.readableNames.get(key)), providerName }
}

/** Whether `a` and `b` are the same facts. A widget that shows facts
 *  compares them with this, or it keeps stale DOM. */
export function sameModelFacts(a: ModelFacts | null, b: ModelFacts | null): boolean {
  if (!a || !b) return !a && !b
  return a.key === b.key && a.name === b.name && a.tooltipName === b.tooltipName && a.providerName === b.providerName
}

/** The lines of a model tooltip: the id with the pretty name, the provider,
 *  and the key. */
export function modelFactLines(facts: ModelFacts): string[] {
  return [facts.tooltipName, facts.providerName ?? UNKNOWN_PROVIDER, facts.key]
}
