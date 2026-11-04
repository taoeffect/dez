import { describe, expect, it } from 'vitest'
import type { NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { secret } from '../../utils/secret'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { customProviderConfigSchema } from './config'
import { Provider } from './provider'
import type { ChatMessage } from './types'

const messages: ChatMessage[] = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'agent', content: 'I can help with that.' },
]

const apiMessages = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'assistant', content: 'I can help with that.' },
]

const key = secret('sk-test')

function customProvider(config: Record<string, unknown>): Provider {
  return new Provider(customProviderConfigSchema.parse({
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:8080/v1',
    ...config,
  }), { builtIn: false })
}

function builtInProvider(id: string): Provider {
  const config = BUILT_IN_PROVIDER_CONFIGS.find((candidate) => candidate.id === id)
  if (!config) throw new Error(`No built-in provider ${id}`)
  return new Provider(config, { builtIn: true })
}

const venice = builtInProvider('venice')

function requestBody(request: NativeHttpRequest): Record<string, unknown> {
  expect(typeof request.body).toBe('string')
  return JSON.parse(request.body as string) as Record<string, unknown>
}

describe('OpenAI format requests', () => {
  it('sends a Bearer key, JSON content type, and assistant roles', () => {
    const request = customProvider({}).chatRequest(messages, 'llama3', key)

    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://localhost:8080/v1/chat/completions')
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    })
    expect(requestBody(request)).toEqual({ model: 'llama3', messages: apiMessages, stream: true })
  })

  it('sends no Authorization header without a key', () => {
    const provider = customProvider({})

    expect(provider.chatRequest(messages, 'llama3', null).headers).toEqual({ 'Content-Type': 'application/json' })
    expect(provider.modelListRequest(null)).toEqual({
      method: 'GET',
      url: 'http://localhost:8080/v1/models',
      headers: {},
      timeoutMs: expect.any(Number),
    })
  })
})

describe('Anthropic format requests', () => {
  it('adds the versioned paths once, whether or not the base URL ends in /v1', () => {
    for (const baseUrl of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/']) {
      const provider = customProvider({ apiFormat: 'anthropic', baseUrl })

      expect(provider.chatRequest(messages, 'claude', key).url).toBe('https://api.anthropic.com/v1/messages')
      expect(provider.modelListRequest(key)?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    }
  })

  it('sends x-api-key and anthropic-version, never Authorization', () => {
    const provider = customProvider({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' })

    expect(provider.chatRequest(messages, 'claude', key).headers).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-test',
    })
    expect(provider.modelListRequest(key)?.headers).toEqual({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-test',
    })
    expect(provider.modelListRequest(null)?.headers).toEqual({ 'anthropic-version': '2023-06-01' })
  })

  it('always sends max_tokens, from maxOutputTokens when set', () => {
    const defaultBody = requestBody(customProvider({ apiFormat: 'anthropic' }).chatRequest(messages, 'claude', key))
    const minimaxRequest = builtInProvider('minimax').chatRequest(messages, 'MiniMax-M2.7', key)

    expect(defaultBody).toEqual({ model: 'claude', messages: apiMessages, stream: true, max_tokens: 32000 })
    expect(minimaxRequest.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(requestBody(minimaxRequest).max_tokens).toBe(65536)
  })
})

describe('static headers', () => {
  it('sends the GitHub Copilot editor headers on chat and model-list requests', () => {
    const copilot = builtInProvider('copilot')
    const editorHeaders = {
      'Editor-Version': 'vscode/1.97.2',
      'Copilot-Integration-Id': 'vscode-chat',
      Authorization: 'Bearer sk-test',
    }

    expect(copilot.chatRequest(messages, 'gpt-4o', key).headers).toMatchObject(editorHeaders)
    expect(copilot.modelListRequest(key)?.headers).toMatchObject(editorHeaders)
  })

  it('lets a stored key replace a static Authorization header of any case', () => {
    const provider = customProvider({ headers: { authorization: 'Bearer static', 'content-type': 'text/plain' } })

    expect(provider.chatRequest(messages, 'm', key).headers).toEqual({
      'content-type': 'text/plain',
      Authorization: 'Bearer sk-test',
    })
    expect(provider.chatRequest(messages, 'm', null).headers).toEqual({
      'content-type': 'text/plain',
      authorization: 'Bearer static',
    })
  })
})

describe('declarative provider settings', () => {
  it('writes every Venice parameter from the defaults', () => {
    const body = requestBody(venice.chatRequest(messages, 'venice-uncensored', key))

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_x_search: true,
      enable_web_scraping: true,
    })
    expect(body).toMatchObject({ model: 'venice-uncensored', messages: apiMessages, stream: true })
  })

  it('applies sparse overrides, including the web search string values', () => {
    const body = requestBody(venice.chatRequest(messages, 'grok-4-20', key, { webSearch: false, veniceSystemPrompt: true }))

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: true,
      enable_web_scraping: true,
    })
  })

  it('maps every toggle flipped away from its default', () => {
    const flipped = Object.fromEntries((venice.config.settings ?? []).map((setting) => [setting.key, !setting.default]))

    expect(requestBody(venice.chatRequest(messages, 'grok-4-20', key, flipped)).venice_parameters).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
  })

  it('adds no venice_parameters to a provider without settings', () => {
    const body = requestBody(builtInProvider('openrouter').chatRequest(messages, 'm', key, { webSearch: false }))

    expect(body).toEqual({ model: 'm', messages: apiMessages, stream: true })
  })

  it('shows prefix-gated settings only for matching model ids', () => {
    const visibleKeys = (modelId: string) => venice.visibleSettings(modelId).map((setting) => setting.key)

    expect(visibleKeys('grok-4-20')).toEqual(['webSearch', 'xSearch', 'webScraping', 'veniceSystemPrompt'])
    expect(visibleKeys('llama-3.3-70b')).toEqual(['webSearch', 'webScraping', 'veniceSystemPrompt'])
  })
})

describe('provider models', () => {
  it('names fetched models from name, then display_name, then the id', () => {
    const models = customProvider({}).parseModels({
      data: [
        { id: 'a', name: 'Model A', display_name: 'ignored' },
        { id: 'b', display_name: 'Model B' },
        { id: 'c' },
        { id: 'd', name: '  ', display_name: 'Model D' },
        { id: '' },
        { name: 'no id' },
        'not a model',
      ],
    })

    expect(models).toEqual([
      { id: 'a', name: 'Model A', provider: 'local' },
      { id: 'b', name: 'Model B', provider: 'local' },
      { id: 'c', name: 'c', provider: 'local' },
      { id: 'd', name: 'Model D', provider: 'local' },
    ])
    expect(customProvider({}).parseModels({ models: [{ id: 'a' }] })).toEqual([])
  })

  it('lists config models first, once each, with config names winning', () => {
    const provider = customProvider({
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2' }, { id: 'm1', name: 'Duplicate' }],
    })
    const fetched = provider.parseModels({
      data: [
        { id: 'm3', name: 'Model Three' },
        { id: 'm1', name: 'Server One' },
        { id: 'm2', name: 'Server Two' },
        { id: 'm3', name: 'Duplicate' },
      ],
    })

    expect(provider.mergeModels(fetched)).toEqual([
      { id: 'm1', name: 'Model One', provider: 'local' },
      { id: 'm2', name: 'Server Two', provider: 'local' },
      { id: 'm3', name: 'Model Three', provider: 'local' },
    ])
    expect(provider.configModels()).toEqual([
      { id: 'm1', name: 'Model One', provider: 'local' },
      { id: 'm2', name: 'm2', provider: 'local' },
    ])
  })

  it('builds no model-list request when fetchModels is off', () => {
    expect(customProvider({ fetchModels: false }).modelListRequest(key)).toBeNull()
  })
})

describe('provider info', () => {
  it('needs a stored key for built-ins but not for custom providers', () => {
    const noKeys = new Set<string>()

    expect(builtInProvider('openrouter').info(noKeys)).toMatchObject({ builtIn: true, hasKey: false, configured: false })
    expect(builtInProvider('openrouter').info(new Set(['openrouter']))).toMatchObject({ hasKey: true, configured: true })
    expect(customProvider({}).info(noKeys)).toMatchObject({ builtIn: false, hasKey: false, configured: true })
    expect(customProvider({}).info(new Set(['local']))).toMatchObject({ hasKey: true, configured: true })
  })
})
