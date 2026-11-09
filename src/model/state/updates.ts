import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Release } from '../updates/releases'

// Where the update check is: `idle` until the first check of this session
// starts, then `checking`, then the outcome of the last check.
export type UpdateCheckStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'failed'

// Internal model implementation detail: the update check and the update
// window, for this session only (nothing here is saved). Mutations live in
// the dez.model/updates/* selectors; dez.controller/checkForUpdates drives
// them.
export const useUpdatesStore = defineStore('updates', () => {
  const status = ref<UpdateCheckStatus>('idle')
  // The message of the last failed check; null after a good one.
  const error = ref<string | null>(null)
  // The releases newer than the running one, newest first, from the last
  // check that succeeded.
  const releases = ref<Release[]>([])
  const windowOpen = ref(false)

  return {
    status,
    error,
    releases,
    windowOpen,
  }
})
