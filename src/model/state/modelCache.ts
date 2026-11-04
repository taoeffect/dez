import { defineStore } from 'pinia'
import { ref } from 'vue'
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

  return {
    cache,
    refreshing,
    errors,
    checking,
  }
})
