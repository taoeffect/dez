import sbp from '@sbp/sbp'
import type { ProviderInfo, ProviderModelsResult } from '../model/providers'

let refreshInFlight: Promise<void> | null = null

export default sbp('sbp/selectors/register', {
  // Reconcile the model cache to real availability: fetch every configured
  // provider concurrently and apply each result as soon as it lands so the
  // popup UI updates progressively rather than waiting for the slowest
  // provider. A single in-flight refresh is shared so overlapping opens don't
  // launch duplicate fetch storms.
  async 'dez.controller/modelCache/refresh' (): Promise<void> {
    if (refreshInFlight) return refreshInFlight

    refreshInFlight = (async () => {
      const providers = await sbp('dez.provider/infos') as ProviderInfo[]
      const configured = providers.filter((provider) => provider.configured)

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
    }
  },
})
