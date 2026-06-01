import { defineStore } from 'pinia'
import { ref } from 'vue'
import { emptyModelCache } from '../persistence/modelCache'
import type { ModelCache } from '../persistence/types'

// Internal model implementation detail: holds the reactive model-selector cache.
// Mutations live in the dez.model/modelCache/* selectors, not here.
export const useModelCacheStore = defineStore('modelCache', () => {
  const cache = ref<ModelCache>(emptyModelCache())
  // Reactive flag for an in-progress background refresh; drives the popup
  // spinner. Set via dez.model/modelCache/setRefreshing.
  const refreshing = ref(false)

  return {
    cache,
    refreshing,
  }
})
