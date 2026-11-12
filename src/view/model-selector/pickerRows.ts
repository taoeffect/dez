import { matchingModelsByProvider, modelMatchesQuery, type ModelQuery } from '../../model/modelSearch'
import type { ModelInfo, ProviderInfo } from '../../model/providers'
import type { DefaultModel } from '../modelState'
import { modelTooltipName } from '../modelLabel'

// The rows of the model picker's list. The picker draws them with a virtual
// list (`ModelPicker.vue`), which takes one flat array and draws only the
// rows in view. So a group is not a nested list here: it is a header row
// and the model rows after it.

// The id of the Favorites group in row keys. No provider can have it
// (`RESERVED_PROVIDER_IDS` in providers/config.ts).
const FAVORITES_GROUP_ID = '__favorites__'

/** One row of the picker's list. `key` is unique in the list, and a row
 *  keeps its key when the list changes, so the virtual list can follow it.
 *  A model row's `title` is the tooltip of its name. */
export type PickerRow =
  | { kind: 'none', key: string }
  | { kind: 'header', key: string, label: string }
  | { kind: 'model', key: string, model: ModelInfo, providerName: string, title: string }

export interface PickerRowsInput {
  /** The providers, in the order of their groups. */
  providers: readonly ProviderInfo[]
  /** The models that the user can pick (`availableModels`). */
  models: readonly ModelInfo[]
  /** The search terms and the output filter. They apply to every group,
   *  Favorites too. */
  query: ModelQuery
  /** The favorites, in the order of the Favorites group; null for a picker
   *  with no such group. */
  favorites: readonly DefaultModel[] | null
  /** Whether the list starts with the None row. */
  none: boolean
}

/** The picker's rows, top to bottom: the None row, the Favorites group, then
 *  one group per provider that has a match. A group with no model has no
 *  header. */
export function pickerRows({ providers, models, query, favorites, none }: PickerRowsInput): PickerRow[] {
  const rows: PickerRow[] = []
  // A group lists a model once. A second copy (a hand-edited favorites list,
  // a provider that lists an id twice) would get the key of the first, and
  // the virtual list draws rows wrong when two of them share a key.
  const keys = new Set<string>()

  function addGroup(groupId: string, label: string, groupModels: ReadonlyArray<{ model: ModelInfo, provider: ProviderInfo }>) {
    let hasHeader = false
    for (const { model, provider } of groupModels) {
      // Provider ids hold no `:`, so the model id, which can hold one, cannot
      // make two keys equal. The Favorites group holds models of more than
      // one provider, and two providers can have the same model id: the key
      // needs the model's provider too.
      const key = `model:${groupId}:${model.provider}:${model.id}`
      if (keys.has(key)) continue
      keys.add(key)
      if (!hasHeader) {
        rows.push({ kind: 'header', key: `header:${groupId}`, label })
        hasHeader = true
      }
      rows.push({ kind: 'model', key, model, providerName: provider.name, title: modelTooltipName(model.name, model.readableName) })
    }
  }

  if (none) rows.push({ kind: 'none', key: 'none' })

  if (favorites) {
    const favoriteModels: Array<{ model: ModelInfo, provider: ProviderInfo }> = []
    for (const favorite of favorites) {
      const provider = providers.find((candidate) => candidate.id === favorite.providerId)
      const model = models.find((candidate) => candidate.provider === favorite.providerId && candidate.id === favorite.modelId)
      if (provider && model && modelMatchesQuery(provider, model, query)) favoriteModels.push({ model, provider })
    }
    addGroup(FAVORITES_GROUP_ID, 'Favorites', favoriteModels)
  }

  for (const group of matchingModelsByProvider(providers, models, query)) {
    addGroup(group.provider.id, group.provider.name, group.models.map((model) => ({ model, provider: group.provider })))
  }
  return rows
}
