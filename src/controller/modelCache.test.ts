import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCache } from '../model/persistence/types'
import type { ProviderConfig } from '../model/providers/config'
import { PRICE_LIFETIME_MS, type LoadedModelPrice } from '../model/providers/modelPrices'
import { listProviders } from '../model/providers/registry'
import type { ModelInfo, ProviderInfo, ProviderModelsResult } from '../model/providers/types'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './modelCache'

// The real dez.provider/* selectors read native keys and send HTTP requests.
// The stubs below replace them.
vi.mock('../model/providers/selectors', () => ({}))

interface PendingCheck {
  providerId: string
  finish (result: ProviderModelsResult): void
}

interface PendingPrice {
  modelId: string
  finish (loaded: LoadedModelPrice | null): void
  fail (error: Error): void
}

// Model-list requests that the stub has not answered yet, in start order.
let pendingChecks: PendingCheck[] = []
// Price requests that the stub has not answered yet, in start order.
let pendingPrices: PendingPrice[] = []

sbp('sbp/selectors/register', {
  // No keys are stored: built-ins are not configured, custom providers are.
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return listProviders().map((provider) => provider.info(new Set()))
  },
  'dez.provider/listModelsResult' (providerId: string): Promise<ProviderModelsResult> {
    return new Promise((resolve) => {
      pendingChecks.push({ providerId, finish: resolve })
    })
  },
  'dez.provider/modelPrice' (_providerId: string, modelId: string): Promise<LoadedModelPrice | null> {
    return new Promise((resolve, reject) => {
      pendingPrices.push({ modelId, finish: resolve, fail: reject })
    })
  },
})

function config (id: string): ProviderConfig {
  return {
    id,
    name: id,
    baseUrl: 'http://localhost:8080/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
  }
}

function refresh (options?: { providerIds?: string[], force?: boolean }): Promise<void> {
  return sbp('dez.controller/modelCache/refresh', options) as Promise<void>
}

async function waitForChecks (count: number): Promise<void> {
  await vi.waitFor(() => expect(pendingChecks).toHaveLength(count))
}

beforeEach(() => {
  setActivePinia(createPinia())
  pendingChecks = []
  pendingPrices = []
})

describe('dez.controller/modelCache/refresh', () => {
  it('keeps the newest check of a provider when an older one lands later', async () => {
    sbp('dez.model/customProviders/save', config('local'))
    const plain = refresh()
    await waitForChecks(1)

    // The user changes the provider while the plain refresh still waits.
    const forced = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(2)
    const [older, newer] = pendingChecks
    newer.finish({ ok: true, models: [{ id: 'new', name: 'New', provider: 'local' }] })
    await forced
    expect(sbp('dez.model/modelCache/refreshing')).toBe(true)

    older.finish({ ok: false, models: [], error: 'connection refused' })
    await plain
    expect(sbp('dez.model/modelCache/refreshing')).toBe(false)
    expect((sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local)
      .toMatchObject({ working: true, models: [{ id: 'new' }] })
    expect(sbp('dez.model/modelCache/errors')).toEqual({})
  })

  it('shows a provider as checking until its newest check lands', async () => {
    sbp('dez.model/customProviders/save', config('local'))
    const first = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(1)
    const second = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(2)
    expect(sbp('dez.model/modelCache/checking')).toEqual(['local'])

    const [older, newer] = pendingChecks
    older.finish({ ok: true, models: [] })
    await first
    expect(sbp('dez.model/modelCache/checking')).toEqual(['local'])

    newer.finish({ ok: true, models: [] })
    await second
    expect(sbp('dez.model/modelCache/checking')).toEqual([])
  })

  it('checks only the given providers, and a forced check runs even within the TTL', async () => {
    sbp('dez.model/customProviders/save', config('local'))
    sbp('dez.model/customProviders/save', config('other'))
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, models: [] })
    sbp('dez.model/modelCache/applyProviderResult', 'other', { ok: true, models: [] })

    await refresh()
    expect(pendingChecks).toHaveLength(0)

    const forced = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(1)
    expect(pendingChecks.map((check) => check.providerId)).toEqual(['local'])
    pendingChecks[0].finish({ ok: true, models: [] })
    await forced
  })

  it('starts no plain check of a provider whose check is still running', async () => {
    sbp('dez.model/customProviders/save', config('local'))
    const forced = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(1)

    // The user opens the model picker before the forced check lands.
    await refresh()
    expect(pendingChecks).toHaveLength(1)

    pendingChecks[0].finish({ ok: true, models: [{ id: 'm', name: 'M', provider: 'local' }] })
    await forced
    expect((sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local)
      .toMatchObject({ working: true, models: [{ id: 'm' }] })
  })

  it('adds no cache entry for a provider removed during its check', async () => {
    sbp('dez.model/customProviders/save', config('local'))
    const forced = refresh({ providerIds: ['local'], force: true })
    await waitForChecks(1)

    sbp('dez.model/customProviders/remove', 'local')
    sbp('dez.model/modelCache/removeProvider', 'local')
    pendingChecks[0].finish({ ok: false, models: [], error: 'Unknown provider' })
    await forced

    expect((sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local).toBeUndefined()
    expect(sbp('dez.model/modelCache/errors')).toEqual({})
  })
})

describe('dez.controller/modelCache/loadPrice', () => {
  const START = 1_000_000
  const PRICE = { unit: 'token', input: 2, output: 10 } as const
  // The loads of the selector outlive a test, so each test loads its own
  // models.
  const loadPrice = (modelId: string) => sbp('dez.controller/modelCache/loadPrice', { providerId: 'priced', modelId }) as Promise<void>
  const cached = (modelId: string) => sbp('dez.model/modelCache/model', 'priced', modelId) as ModelInfo | null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    sbp('dez.model/customProviders/save', {
      ...config('priced'),
      modelPriceRequest: { url: 'http://localhost:8080/api/price', query: 'model', prices: { input: 'in', output: 'out', perTokens: 1_000_000 } },
    })
    sbp('dez.model/modelCache/applyProviderResult', 'priced', {
      ok: true,
      models: [
        ...['one', 'two'].map((id) => ({ id, name: id, provider: 'priced' })),
        { id: 'painter', name: 'Painter', provider: 'priced', outputs: ['image'], request: 'image' },
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the price of a chat model one time for all its callers, keeps it with its time, and loads it again when it is old', async () => {
    const first = loadPrice('one')
    const second = loadPrice('one')
    expect(pendingPrices).toHaveLength(1)
    pendingPrices[0].finish({ price: PRICE, contextWindow: 200_000 })
    await Promise.all([first, second])
    expect(cached('one')).toMatchObject({ price: PRICE, contextWindow: 200_000, priceLoadedAt: START })

    await loadPrice('one')
    expect(pendingPrices).toHaveLength(1)

    vi.setSystemTime(START + PRICE_LIFETIME_MS)
    const again = loadPrice('one')
    expect(pendingPrices).toHaveLength(2)
    // The provider has no price of the model now: the price is unknown.
    pendingPrices[1].finish({})
    await again
    expect(cached('one')).not.toHaveProperty('price')
    expect(cached('one')).toMatchObject({ contextWindow: 200_000, priceLoadedAt: START + PRICE_LIFETIME_MS })
  })

  it('loads nothing for a provider with no price request, a model that the cache does not have, or a model that is not a chat model', async () => {
    sbp('dez.model/customProviders/save', config('plain'))
    sbp('dez.model/modelCache/applyProviderResult', 'plain', { ok: true, models: [{ id: 'm', name: 'M', provider: 'plain' }] })

    await sbp('dez.controller/modelCache/loadPrice', { providerId: 'plain', modelId: 'm' })
    await loadPrice('missing')
    await loadPrice('painter')
    expect(pendingPrices).toStrictEqual([])
  })

  it('keeps the old price after a failed load, and loads it again only after a pause', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = loadPrice('two')
    expect(pendingPrices).toHaveLength(1)
    pendingPrices[0].finish({ price: PRICE })
    await first

    const failedAt = START + PRICE_LIFETIME_MS
    vi.setSystemTime(failedAt)
    const failing = loadPrice('two')
    expect(pendingPrices).toHaveLength(2)
    pendingPrices[1].fail(new Error('connection refused'))
    await failing
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(cached('two')).toMatchObject({ price: PRICE, priceLoadedAt: START })

    vi.setSystemTime(failedAt + 59_999)
    await loadPrice('two')
    expect(pendingPrices).toHaveLength(2)

    vi.setSystemTime(failedAt + 60_000)
    const retry = loadPrice('two')
    expect(pendingPrices).toHaveLength(3)
    pendingPrices[2].finish({ price: { ...PRICE, input: 3 } })
    await retry
    expect(cached('two')).toMatchObject({ price: { ...PRICE, input: 3 }, priceLoadedAt: failedAt + 60_000 })
    consoleError.mockRestore()
  })
})
