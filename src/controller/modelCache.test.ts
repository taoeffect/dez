import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCache } from '../model/persistence/types'
import type { ProviderConfig } from '../model/providers/config'
import { listProviders } from '../model/providers/registry'
import type { ProviderInfo, ProviderModelsResult } from '../model/providers/types'
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

// Model-list requests that the stub has not answered yet, in start order.
let pendingChecks: PendingCheck[] = []

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
