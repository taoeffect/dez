import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { emptyModelCache } from '../persistence/modelCache'
import type { ModelCache } from '../persistence/types'
import type { ProviderId } from '../providers/types'

// Internal model implementation detail: holds the reactive model-selector cache.
// Mutations live in the dez.model/modelCache/* selectors, not here.
export const useModelCacheStore = defineStore('modelCache', () => {
  const cache = ref<ModelCache>(emptyModelCache())
  // Reactive flag for an in-progress background refresh; drives the popup
  // spinner. Set via dez.model/modelCache/setRefreshing.
  const refreshing = ref(false)
  // Last model-list error per provider whose last check failed. Kept in
  // memory only, never in model_cache.json: server error text can echo
  // request details. Set by dez.model/modelCache/applyProviderResult.
  const errors = ref<Record<ProviderId, string>>({})
  // Providers whose newest model check is still running; drives the
  // "Checking…" status in Settings › Providers. Set via
  // dez.model/modelCache/setChecking.
  const checking = ref<Record<ProviderId, true>>({})
  // The raw model-list entry of each model, by provider id and then model id
  // (`ProviderModelsResult.entries`), for the `model_info` tool. Memory only,
  // never in model_cache.json or the snapshot: entries are large, and prices
  // change. Shallow, so Vue never makes the hundreds of entries reactive;
  // nothing renders them. Set by dez.model/modelCache/applyProviderResult.
  const rawModels = shallowRef(new Map<ProviderId, ReadonlyMap<string, unknown>>())
  // The same for the model list that only a provider's media API has
  // (`ProviderModelsResult.mediaEntries`): the lengths and prices of the
  // OpenRouter video models are only there.
  const rawMediaModels = shallowRef(new Map<ProviderId, ReadonlyMap<string, unknown>>())

  return {
    cache,
    refreshing,
    errors,
    checking,
    rawModels,
    rawMediaModels,
  }
})
