import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCache } from '../model/persistence/types'
import type { ProviderConfig } from '../model/providers/config'
// Side-effect imports: register the dez.model/* selectors and the selector
// under test.
import '../model/state/index'
import './providers'

// The real dez.provider/* selectors read native keys and send HTTP requests.
vi.mock('../model/providers/selectors', () => ({}))

// The forced model checks that a save starts, in call order.
let refreshes: unknown[] = []

sbp('sbp/selectors/register', {
  async 'dez.controller/modelCache/refresh' (options: unknown): Promise<void> {
    refreshes.push(options)
  },
})

const local: ProviderConfig = {
  id: 'local',
  name: 'Local',
  baseUrl: 'http://localhost:8080/v1',
  apiFormat: 'openai',
  models: [{ id: 'listed' }],
  fetchModels: true,
  auth: 'apiKey',
}

function cachedLocal () {
  return (sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local
}

beforeEach(() => {
  setActivePinia(createPinia())
  refreshes = []
  sbp('dez.model/customProviders/save', local)
  sbp('dez.model/modelCache/applyProviderResult', 'local', {
    ok: true,
    models: [{ id: 'fetched', name: 'Fetched', provider: 'local' }],
  })
})

describe('dez.controller/providers/save', () => {
  it('keeps the cached models and starts no check when only the name changes', () => {
    sbp('dez.controller/providers/save', { ...local, name: ' Renamed ' })

    expect(sbp('dez.model/customProviders/list')).toEqual([{ ...local, name: 'Renamed' }])
    expect(cachedLocal()).toMatchObject({ working: true, models: [{ id: 'fetched' }] })
    expect(refreshes).toEqual([])
  })

  it('checks a renamed provider that has no cached result yet', () => {
    sbp('dez.model/modelCache/removeProvider', 'local')

    sbp('dez.controller/providers/save', { ...local, name: 'Renamed' })

    expect(refreshes).toEqual([{ providerIds: ['local'], force: true }])
  })

  it('drops the cached models and checks again when a request field changes', () => {
    sbp('dez.controller/providers/save', { ...local, name: 'Renamed', baseUrl: 'http://localhost:9090/v1' })

    expect(cachedLocal()).toBeUndefined()
    expect(refreshes).toEqual([{ providerIds: ['local'], force: true }])
  })
})
