import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeHttpRequest, NativeHttpResponse, NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import type { ProviderModelsResult } from './types'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../state/index'
import './selectors'

// The text Rust sends when provider_keys.json does not parse.
const KEY_STORE_ERROR = 'API error: Failed to parse provider_keys.json (line 1, column 2)'

// Requests the stubs below received, in order.
let httpRequests: NativeHttpRequest[] = []
let streamRequests: NativeHttpRequest[] = []

// Requests to this base URL get HTTP 404; every other server answers.
const FAILING_BASE_URL = 'http://localhost:9090/v1'

// Stand-ins for the native layer: the key store cannot be read.
sbp('sbp/selectors/register', {
  async 'dez.native/getProviderSecret' (): Promise<string | null> {
    throw KEY_STORE_ERROR
  },
  async 'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    httpRequests.push(request)
    if (request.url.startsWith(FAILING_BASE_URL)) {
      return { status: 404, headers: {}, body: Array.from(new TextEncoder().encode('Not found')) }
    }
    const body = new TextEncoder().encode(JSON.stringify({ data: [{ id: 'served-model' }] }))
    return { status: 200, headers: {}, body: Array.from(body) }
  },
  async 'dez.http/stream' (request: NativeHttpRequest, requestId: string): Promise<NativeHttpStreamResult> {
    streamRequests.push(request)
    const failing = request.url.startsWith(FAILING_BASE_URL)
    return {
      requestId,
      response: { status: failing ? 404 : 200, headers: {} },
      chunks: (async function * () {
        yield new TextEncoder().encode(failing
          ? 'Not found'
          : 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n')
      })(),
    }
  },
})

beforeEach(() => {
  setActivePinia(createPinia())
  httpRequests = []
  streamRequests = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sbp('dez.model/customProviders/save', {
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:8080/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
  })
})

describe('provider requests when provider_keys.json cannot be read', () => {
  it('still checks the models of a provider that needs no key, without a key', async () => {
    const result = await sbp('dez.provider/listModelsResult', 'local') as ProviderModelsResult

    expect(result).toEqual({ ok: true, models: [{ id: 'served-model', name: 'served-model', provider: 'local' }] })
    expect(httpRequests).toHaveLength(1)
    expect(httpRequests[0].url).toBe('http://localhost:8080/v1/models')
    expect(httpRequests[0].headers).not.toHaveProperty('Authorization')
  })

  it('still streams a chat with a provider that needs no key, without a key', async () => {
    const tokens: string[] = []
    await sbp('dez.provider/streamChat', {
      providerId: 'local',
      modelId: 'served-model',
      messages: [{ role: 'user', content: 'Hi' }],
      onToken: (token: string) => { tokens.push(token) },
    })

    expect(tokens).toEqual(['Hello'])
    expect(streamRequests).toHaveLength(1)
    expect(streamRequests[0].url).toBe('http://localhost:8080/v1/chat/completions')
    expect(streamRequests[0].headers).not.toHaveProperty('Authorization')
  })

  it('fails the model check of a provider that needs a key with the key store error', async () => {
    const result = await sbp('dez.provider/listModelsResult', 'openrouter') as ProviderModelsResult

    expect(result).toEqual({ ok: false, models: [], error: KEY_STORE_ERROR })
    expect(httpRequests).toEqual([])
  })
})

describe('provider error messages', () => {
  // Settings gives custom providers UUID ids, which the user never sees.
  const uuid = 'b7e3a1c2-5d4f-4e6a-9c8b-1a2b3c4d5e6f'

  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: uuid,
      name: 'Broken server',
      baseUrl: FAILING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
    })
  })

  const chatInput = {
    providerId: uuid,
    modelId: 'served-model',
    messages: [{ role: 'user', content: 'Hi' }],
    onToken: () => {},
  }

  it('name a custom provider whose server fails by its name, not its id', async () => {
    const result = await sbp('dez.provider/listModelsResult', uuid) as ProviderModelsResult
    const chatError = await sbp('dez.provider/streamChat', chatInput).catch((error: Error) => error)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Broken server')
    expect(result.error).not.toContain(uuid)
    expect(chatError).toBeInstanceOf(Error)
    expect((chatError as Error).message).toContain('Broken server')
    expect((chatError as Error).message).not.toContain(uuid)
  })

  it('do not show the id of a deleted provider that a tab still uses', async () => {
    sbp('dez.model/customProviders/remove', uuid)
    const chatError = await sbp('dez.provider/streamChat', chatInput).catch((error: Error) => error)

    expect(chatError).toBeInstanceOf(Error)
    expect((chatError as Error).message).not.toContain(uuid)
    expect(streamRequests).toEqual([])
  })
})
