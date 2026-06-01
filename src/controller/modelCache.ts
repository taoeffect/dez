import sbp from '@sbp/sbp'
import type { ProviderInfo, ProviderModelsResult } from '../model/providers'
import type { ModelCache } from '../model/persistence/types'

let refreshInFlight: Promise<void> | null = null

// Per-provider staleness gate: a provider checked within this window is skipped
// so refreshes (popup open, key save, Copilot sign-in) cap at 1 check per
// provider per minute (REVIEW-1 #2 User Decision) and the persisted
// lastCheckedAt timestamp is actually consumed.
const MODEL_CACHE_TTL_MS = 60_000

export default sbp('sbp/selectors/register', {
  // Reconcile the model cache to real availability: fetch every configured
  // provider concurrently and apply each result as soon as it lands so the
  // popup UI updates progressively rather than waiting for the slowest
  // provider. A single in-flight refresh is shared so overlapping opens don't
  // launch duplicate fetch storms.
  async 'dez.controller/modelCache/refresh' (): Promise<void> {
    if (refreshInFlight) return refreshInFlight

    // Flag set true for the whole shared batch (dedup means overlapping callers
    // reuse refreshInFlight), cleared in finally to avoid spinner flicker.
    sbp('dez.model/modelCache/setRefreshing', true)

    refreshInFlight = (async () => {
      const providers = await sbp('dez.provider/infos') as ProviderInfo[]
      const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
      const now = Date.now()
      // Skip providers checked within the TTL window so we never exceed one
      // fetch per provider per minute, regardless of which workflow triggered
      // the refresh.
      const configured = providers.filter((provider) => {
        if (!provider.configured) return false
        const cached = cache.providers[provider.id]
        return !cached || now - cached.lastCheckedAt >= MODEL_CACHE_TTL_MS
      })

      await Promise.allSettled(
        configured.map(async (provider) => {
          let result: ProviderModelsResult
          try {
            result = await sbp('dez.provider/listModelsResult', provider.id) as ProviderModelsResult
          } catch (error) {
            // listModelsResult already maps failures to ok=false, but guard the
            // await so an unexpected throw still marks the provider not-working.
            console.error(`Model cache refresh failed for ${provider.id}`, error)
            result = { ok: false, models: [], error: String(error) }
          }
          sbp('dez.model/modelCache/applyProviderResult', provider.id, result)
        }),
      )
    })()

    try {
      await refreshInFlight
    } finally {
      refreshInFlight = null
      sbp('dez.model/modelCache/setRefreshing', false)
    }
  },
})
