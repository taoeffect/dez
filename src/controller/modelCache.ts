import sbp from '@sbp/sbp'
import { getProvider, type ProviderId, type ProviderInfo, type ProviderModelsResult } from '../model/providers'
import type { ModelCache } from '../model/persistence/types'

interface ModelCacheRefreshOptions {
  // Check only these providers.
  providerIds?: ProviderId[]
  // Check even providers checked within MODEL_CACHE_TTL_MS.
  force?: boolean
}

// The running plain refresh (no options), shared by every plain caller.
let sharedRefresh: Promise<void> | null = null
let activeRuns = 0

// Every provider check gets a number, and only the newest check of a provider
// may write its result. So a slow check that started before the user changed
// a provider (a base URL that hangs, say) cannot overwrite the result of the
// check that started after the change. An entry is deleted once its result is
// written; a late result then finds no entry and is dropped too. The model
// store's `checking` flag follows the same rule, so an older check that ends
// first does not clear the "Checking…" status of the newer one.
let lastCheckNumber = 0
const newestChecks = new Map<ProviderId, number>()

// Per-provider staleness gate: a provider checked within this window is skipped
// so refreshes (popup open, key save, Copilot sign-in) cap at 1 check per
// provider per minute (REVIEW-1 #2 User Decision) and the persisted
// lastCheckedAt timestamp is actually consumed.
const MODEL_CACHE_TTL_MS = 60_000

export default sbp('sbp/selectors/register', {
  // Reconcile the model cache to real availability: fetch every configured
  // provider concurrently and apply each result as soon as it lands so the
  // popup UI updates progressively rather than waiting for the slowest
  // provider. Plain calls (popup open, startup) share one in-flight run so
  // overlapping opens don't launch duplicate fetch storms. A call with
  // options (a provider the user just changed, "Check again") always runs its
  // own fetch at once: waiting for or joining the shared run could hide the
  // change behind a check that started before it, or behind another provider
  // that never answers.
  async 'dez.controller/modelCache/refresh' (options: ModelCacheRefreshOptions = {}): Promise<void> {
    const shared = !options.providerIds && !options.force
    if (shared && sharedRefresh) return sharedRefresh

    // True while any run is active (cleared in finally) to avoid spinner
    // flicker when runs overlap.
    activeRuns += 1
    sbp('dez.model/modelCache/setRefreshing', true)

    const run = (async () => {
      const providers = await sbp('dez.provider/infos') as ProviderInfo[]
      const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
      const now = Date.now()
      const requestedIds = options.providerIds ? new Set(options.providerIds) : null
      // Unless forced, skip providers checked within the TTL window, and
      // providers whose check is still running (every request of a check,
      // the model list and the Copilot token, times out, so it writes a
      // result soon). So we never exceed one fetch per provider per minute,
      // whichever workflow triggered the refresh.
      const due = providers.filter((provider) => {
        if (!provider.configured) return false
        if (requestedIds && !requestedIds.has(provider.id)) return false
        if (options.force) return true
        if (newestChecks.has(provider.id)) return false
        const cached = cache.providers[provider.id]
        return !cached || now - cached.lastCheckedAt >= MODEL_CACHE_TTL_MS
      })

      await Promise.allSettled(
        due.map(async (provider) => {
          const checkNumber = ++lastCheckNumber
          newestChecks.set(provider.id, checkNumber)
          sbp('dez.model/modelCache/setChecking', provider.id, true)
          let result: ProviderModelsResult
          try {
            result = await sbp('dez.provider/listModelsResult', provider.id) as ProviderModelsResult
          } catch (error) {
            // listModelsResult already maps failures to ok=false, but guard the
            // await so an unexpected throw still marks the provider not-working.
            console.error(`Model cache refresh failed for ${provider.id}`, error)
            result = { ok: false, models: [], error: String(error) }
          }
          if (newestChecks.get(provider.id) !== checkNumber) return
          newestChecks.delete(provider.id)
          sbp('dez.model/modelCache/setChecking', provider.id, false)
          // A provider removed during the check must not get a cache entry
          // back.
          if (!getProvider(provider.id)) return
          sbp('dez.model/modelCache/applyProviderResult', provider.id, result)
        }),
      )
    })()
    if (shared) sharedRefresh = run

    try {
      await run
    } finally {
      if (shared) sharedRefresh = null
      activeRuns -= 1
      if (activeRuns === 0) sbp('dez.model/modelCache/setRefreshing', false)
    }
  },
})
