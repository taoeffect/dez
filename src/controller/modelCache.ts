import sbp from '@sbp/sbp'
import { modelRefKey } from '../model/chat/modelRef'
import type { ModelRef } from '../model/chat/types'
import { effectiveRequest, getProvider, type ModelInfo, type ProviderId, type ProviderInfo, type ProviderModelsResult } from '../model/providers'
import { isFreshPrice, type LoadedModelPrice } from '../model/providers/modelPrices'
import type { ModelCache } from '../model/persistence/types'
import { explainedError } from '../utils/errorText'

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
// so unforced refreshes (popup open, startup, the price check of `model_list`)
// cap at 1 check per provider per minute (REVIEW-1 #2 User Decision) and the
// persisted lastCheckedAt timestamp is actually consumed. A forced refresh
// (key save, Copilot sign-in, "Check again", `model_info`) skips the gate.
const MODEL_CACHE_TTL_MS = 60_000

// The price loads that run (`loadPrice`), by model (`modelRefKey`): the
// callers of one model share one request.
const priceLoads = new Map<string, Promise<void>>()

// The time of the newest failed price load of each model. A price request
// that fails is not sent again for this long, so that each send to the
// model does not wait for one more failure (each can take up to the time
// limit of the request).
const failedPriceLoads = new Map<string, number>()
const PRICE_LOAD_RETRY_MS = 60_000

export default sbp('sbp/selectors/register', {
  // Reconcile the model cache to real availability: fetch every configured
  // provider concurrently and apply each result as soon as it lands so the
  // popup UI updates progressively rather than waiting for the slowest
  // provider. Plain calls (popup open, startup) share one in-flight run so
  // overlapping opens don't launch duplicate fetch storms. A call with
  // options runs on its own: waiting for or joining the shared run could
  // hide the change behind a check that started before it, or behind another
  // provider that never answers. A forced call (a provider the user just
  // changed, "Check again", `model_info`) fetches at once; a call with only
  // `providerIds` (`model_list`) still skips a provider that the gate skips.
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
      // result soon). So no unforced refresh exceeds one fetch per provider
      // per minute, whichever workflow triggered it.
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
            result = { ok: false, models: [], error: explainedError(error).message }
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

  // Loads the price of the chat model `model` from the price request of its
  // provider (`modelPriceRequest` in config.ts, `dez.provider/modelPrice`)
  // into the model cache (`ModelInfo.priceLoadedAt`), when Dez needs it:
  // before a chat request to the model and its money check, and when the
  // user picks the model. Nothing for a provider with no price request, a
  // model that the cache does not have or that is no chat model, a fresh
  // price (`isFreshPrice`), and a load that failed within
  // PRICE_LOAD_RETRY_MS. Calls for the same model share one request. Never
  // rejects: a failure is logged, and the model keeps the price that it
  // had, or none, so the rule of an unknown price applies to it
  // (moneyLimit.ts).
  async 'dez.controller/modelCache/loadPrice' (model: ModelRef): Promise<void> {
    if (!getProvider(model.providerId)?.config.modelPriceRequest) return
    const key = modelRefKey(model)
    const running = priceLoads.get(key)
    if (running) return running
    const cached = sbp('dez.model/modelCache/model', model.providerId, model.modelId) as ModelInfo | null
    const now = Date.now()
    if (!cached || effectiveRequest(cached) !== 'chat') return
    if (cached.priceLoadedAt !== undefined && isFreshPrice(cached.priceLoadedAt, now)) return
    const failedAt = failedPriceLoads.get(key)
    if (failedAt !== undefined && now >= failedAt && now - failedAt < PRICE_LOAD_RETRY_MS) return

    const load = (async () => {
      try {
        const loaded = await sbp('dez.provider/modelPrice', model.providerId, model.modelId) as LoadedModelPrice | null
        failedPriceLoads.delete(key)
        if (loaded) sbp('dez.model/modelCache/keepLoadedPrice', model.providerId, model.modelId, loaded, Date.now())
      } catch (error) {
        failedPriceLoads.set(key, Date.now())
        console.error(`Failed to load the price of model ${model.modelId} of provider ${model.providerId}:`, error)
      } finally {
        priceLoads.delete(key)
      }
    })()
    priceLoads.set(key, load)
    return load
  },
})
