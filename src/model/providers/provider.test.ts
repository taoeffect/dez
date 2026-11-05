import { describe, expect, it } from 'vitest'
import type { AnthropicThinkingBlock } from '../chat/types'
import type { NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { secret } from '../../utils/secret'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { customProviderConfigSchema } from './config'
import { Provider } from './provider'
import { ThinkingPrefixHasher } from './thinking'
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
    const { request } = customProvider({}).chatRequest(messages, 'llama3', key)

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

    expect(provider.chatRequest(messages, 'llama3', null).request.headers).toEqual({ 'Content-Type': 'application/json' })
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

      expect(provider.chatRequest(messages, 'claude', key).request.url).toBe('https://api.anthropic.com/v1/messages')
      expect(provider.modelListRequest(key)?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    }
  })

  it('sends x-api-key and anthropic-version, never Authorization', () => {
    const provider = customProvider({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' })

    expect(provider.chatRequest(messages, 'claude', key).request.headers).toEqual({
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
    const defaultBody = requestBody(customProvider({ apiFormat: 'anthropic' }).chatRequest(messages, 'claude', key).request)
    const minimaxRequest = builtInProvider('minimax').chatRequest(messages, 'MiniMax-M2.7', key).request

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

    expect(copilot.chatRequest(messages, 'gpt-4o', key).request.headers).toMatchObject(editorHeaders)
    expect(copilot.modelListRequest(key)?.headers).toMatchObject(editorHeaders)
  })

  it('lets a stored key replace a static Authorization header of any case', () => {
    const provider = customProvider({ headers: { authorization: 'Bearer static', 'content-type': 'text/plain' } })

    expect(provider.chatRequest(messages, 'm', key).request.headers).toEqual({
      'content-type': 'text/plain',
      Authorization: 'Bearer sk-test',
    })
    expect(provider.chatRequest(messages, 'm', null).request.headers).toEqual({
      'content-type': 'text/plain',
      authorization: 'Bearer static',
    })
  })
})

describe('declarative provider settings', () => {
  it('writes every Venice parameter from the defaults', () => {
    const body = requestBody(venice.chatRequest(messages, 'venice-uncensored', key).request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_x_search: true,
      enable_web_scraping: true,
    })
    expect(body).toMatchObject({ model: 'venice-uncensored', messages: apiMessages, stream: true })
  })

  it('applies sparse overrides, including the web search string values', () => {
    const body = requestBody(venice.chatRequest(messages, 'grok-4-20', key, { webSearch: false, veniceSystemPrompt: true }).request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: true,
      enable_web_scraping: true,
    })
  })

  it('maps every toggle flipped away from its default', () => {
    const flipped = Object.fromEntries((venice.config.settings ?? []).map((setting) => [setting.key, !setting.default]))

    expect(requestBody(venice.chatRequest(messages, 'grok-4-20', key, flipped).request).venice_parameters).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
  })

  it('adds no venice_parameters to a provider without settings', () => {
    const body = requestBody(builtInProvider('openrouter').chatRequest(messages, 'm', key, { webSearch: false }).request)

    expect(body).not.toHaveProperty('venice_parameters')
  })

  it('shows prefix-gated settings only for matching model ids', () => {
    const visibleKeys = (modelId: string) => venice.visibleSettings(modelId).map((setting) => setting.key)

    expect(visibleKeys('grok-4-20')).toEqual(['webSearch', 'xSearch', 'webScraping', 'veniceSystemPrompt'])
    expect(visibleKeys('llama-3.3-70b')).toEqual(['webSearch', 'webScraping', 'veniceSystemPrompt'])
  })
})

describe('thinking request bodies', () => {
  const bodyWith = (provider: Provider, overrides: Record<string, boolean> = {}) =>
    requestBody(provider.chatRequest(messages, 'm', key, overrides).request)
  const base = { model: 'm', messages: apiMessages, stream: true }

  it('merges each built-in enabledBody when the toggle is on, the default', () => {
    expect(bodyWith(builtInProvider('openrouter'))).toEqual({ ...base, reasoning: { enabled: true } })
    expect(bodyWith(builtInProvider('zai'))).toEqual({ ...base, thinking: { type: 'enabled' } })
    expect(bodyWith(builtInProvider('minimax'))).toEqual({ ...base, max_tokens: 65536, thinking: { type: 'adaptive' } })
    expect(bodyWith(builtInProvider('venice')).reasoning).toEqual({ enabled: true })
  })

  it('adds nothing to the body of an OpenAI-format built-in with an empty thinking config', () => {
    expect(bodyWith(builtInProvider('charm_hyper'))).toEqual(base)
    expect(bodyWith(builtInProvider('copilot'))).toEqual(base)
  })

  it('sends no thinking fields when the toggle is off, except a disabledBody', () => {
    for (const id of ['openrouter', 'zai', 'charm_hyper', 'copilot']) {
      expect(bodyWith(builtInProvider(id), { thinking: false })).toEqual(base)
    }
    expect(bodyWith(builtInProvider('minimax'), { thinking: false })).toEqual({ ...base, max_tokens: 65536 })
  })

  it('merges the Venice disabledBody into the venice_parameters that the settings wrote', () => {
    const body = bodyWith(venice, { thinking: false })

    expect(body).not.toHaveProperty('reasoning')
    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_x_search: true,
      enable_web_scraping: true,
      disable_thinking: true,
    })
  })

  it('uses the format default when a custom config has no enabledBody', () => {
    expect(bodyWith(customProvider({ apiFormat: 'anthropic', thinking: {} }))).toEqual({
      ...base,
      max_tokens: 32000,
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    expect(bodyWith(customProvider({ thinking: {} }))).toEqual(base)
  })

  it('sends no thinking body for a provider without thinking, whatever the toggle', () => {
    const toggles: Array<Record<string, boolean>> = [{}, { thinking: true }, { thinking: false }]
    for (const overrides of toggles) {
      expect(bodyWith(customProvider({ apiFormat: 'anthropic' }), overrides)).not.toHaveProperty('thinking')
    }
  })

  it('deep-merges an enabledBody into an object that a setting wrote', () => {
    const provider = customProvider({
      thinking: { enabledBody: { options: { think: true, stop: ['</s>'] } } },
      settings: [{ key: 'raw', label: 'Raw', type: 'boolean', bodyPath: 'options.raw', default: true }],
    })

    expect(bodyWith(provider).options).toEqual({ raw: true, think: true, stop: ['</s>'] })
  })

  it('returns the prefix hash of the sent messages only when it asks for thinking', () => {
    const provider = builtInProvider('openrouter')
    const on = provider.chatRequest(messages, 'm', key)
    const sent = new ThinkingPrefixHasher()
    for (const message of requestBody(on.request).messages as unknown[]) sent.add(message)

    expect(on.thinking).toEqual({ prefixHash: sent.digest() })
    expect(provider.chatRequest(messages, 'm', key, { thinking: false })).not.toHaveProperty('thinking')
    expect(customProvider({}).chatRequest(messages, 'm', key)).not.toHaveProperty('thinking')
  })

  it('gives a different prefix hash when an earlier message changes', () => {
    const provider = builtInProvider('openrouter')
    const edited: ChatMessage[] = [{ role: 'user', content: 'Search the web for older info.' }, messages[1]]

    expect(provider.chatRequest(edited, 'm', key).thinking?.prefixHash)
      .not.toBe(provider.chatRequest(messages, 'm', key).thinking?.prefixHash)
  })
})

describe('thinking send-back', () => {
  const openAiThinker = customProvider({ thinking: {} })
  const anthropicThinker = customProvider({ apiFormat: 'anthropic', thinking: {} })
  const user = (content: string): ChatMessage => ({ role: 'user', content })
  // The prefix hash that the request which sent `sent` gives its reply.
  const prefixHash = (provider: Provider, sent: ChatMessage[]) => provider.chatRequest(sent, 'm', key).thinking?.prefixHash ?? ''
  const wireMessages = (provider: Provider, sent: ChatMessage[], overrides: Record<string, boolean> = {}) =>
    requestBody(provider.chatRequest(sent, 'm', key, overrides).request).messages

  it('sends each OpenAI replay kind in its assistant-message fields', () => {
    const details = [{ type: 'reasoning.text', text: 'Plan B', signature: 'sig', index: 0 }]
    const a1: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan A', replay: { kind: 'field', field: 'reasoning_content' } } }
    const beforeA2 = [user('Q1'), a1, user('Q2')]
    const a2: ChatMessage = {
      role: 'agent',
      content: 'A2',
      thinking: { text: 'Plan B', replay: { kind: 'reasoningDetails', details, prefixHash: prefixHash(openAiThinker, beforeA2) } },
    }
    const beforeA3 = [...beforeA2, a2, user('Q3')]
    const a3: ChatMessage = {
      role: 'agent',
      content: 'A3',
      thinking: { text: 'Plan C', replay: { kind: 'copilot', opaque: 'op', prefixHash: prefixHash(openAiThinker, beforeA3) } },
    }

    expect(wireMessages(openAiThinker, [...beforeA3, a3, user('Q4')])).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1', reasoning_content: 'Plan A' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2', reasoning_details: details },
      { role: 'user', content: 'Q3' },
      { role: 'assistant', content: 'A3', reasoning_text: 'Plan C', reasoning_opaque: 'op' },
      { role: 'user', content: 'Q4' },
    ])
  })

  it('sends Anthropic blocks unchanged, before the answer text', () => {
    const blocks: AnthropicThinkingBlock[] = [
      { type: 'thinking', thinking: 'Plan', signature: 'sig' },
      { type: 'redacted_thinking', data: 'hidden' },
    ]
    const a1: ChatMessage = {
      role: 'agent',
      content: 'A1',
      thinking: { text: 'Plan', replay: { kind: 'anthropicBlocks', blocks, prefixHash: prefixHash(anthropicThinker, [user('Q1')]) } },
    }

    expect(wireMessages(anthropicThinker, [user('Q1'), a1, user('Q2')])).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: [...blocks, { type: 'text', text: 'A1' }] },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('sends a replay of the other format as text only', () => {
    const fieldReply: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: { kind: 'field', field: 'reasoning' } } }
    const blocksReply: ChatMessage = {
      role: 'agent',
      content: 'A1',
      thinking: {
        text: 'Plan',
        replay: { kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'Plan', signature: 'sig' }], prefixHash: prefixHash(openAiThinker, [user('Q1')]) },
      },
    }

    expect(wireMessages(anthropicThinker, [user('Q1'), fieldReply])).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }])
    expect(wireMessages(openAiThinker, [user('Q1'), blocksReply])).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }])
  })

  it('sends thinking only in a request that asks for thinking', () => {
    const reply: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: { kind: 'field', field: 'reasoning_content' } } }
    const textOnly = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }]

    expect(wireMessages(openAiThinker, [user('Q1'), reply], { thinking: false })).toEqual(textOnly)
    expect(wireMessages(customProvider({}), [user('Q1'), reply])).toEqual(textOnly)
  })

  describe('signed replay prefixes', () => {
    // A reply with a signed replay, made by the request that sent `sent`.
    const reply = (sent: ChatMessage[], content: string): ChatMessage => ({
      role: 'agent',
      content,
      thinking: { text: `${content} plan`, replay: { kind: 'copilot', opaque: `${content} opaque`, prefixHash: prefixHash(openAiThinker, sent) } },
    })
    // The opaque value that each assistant message sends, or null.
    const sentOpaques = (sent: ChatMessage[]) => (wireMessages(openAiThinker, sent) as Record<string, unknown>[])
      .filter((message) => message.role === 'assistant')
      .map((message) => message.reasoning_opaque ?? null)

    it('drops a replay whose earlier messages changed, and sends the later ones made after the edit', () => {
      const a1 = reply([user('Q1')], 'A1')
      // Q1 was edited before A2 was made, so that request already left out A1's replay.
      const a2 = reply([user('Q1 edited'), a1, user('Q2')], 'A2')

      expect(sentOpaques([user('Q1'), a1, user('Q2'), a2, user('Q3')])).toEqual(['A1 opaque', null])
      expect(sentOpaques([user('Q1 edited'), a1, user('Q2'), a2, user('Q3')])).toEqual([null, 'A2 opaque'])
    })

    it('sends the replays made after an edit between two sent replays', () => {
      const a1 = reply([user('Q1')], 'A1')
      const a2 = reply([user('Q1'), a1, user('Q2')], 'A2')
      // Q2 was edited before A3 was made: that request sent A1's replay but not A2's.
      const a3 = reply([user('Q1'), a1, user('Q2 edited'), a2, user('Q3')], 'A3')
      const a4 = reply([user('Q1'), a1, user('Q2 edited'), a2, user('Q3'), a3, user('Q4')], 'A4')

      expect(sentOpaques([user('Q1'), a1, user('Q2 edited'), a2, user('Q3'), a3, user('Q4'), a4, user('Q5')]))
        .toEqual(['A1 opaque', null, 'A3 opaque', 'A4 opaque'])
    })

    it('sends the replays on both sides of a reply that has no replay', () => {
      const a1 = reply([user('Q1')], 'A1')
      // A2 was cancelled, made with Thinking off, or made by another model.
      const a2: ChatMessage = { role: 'agent', content: 'A2' }
      const a3 = reply([user('Q1'), a1, user('Q2'), a2, user('Q3')], 'A3')

      expect(sentOpaques([user('Q1'), a1, user('Q2'), a2, user('Q3'), a3, user('Q4')])).toEqual(['A1 opaque', null, 'A3 opaque'])
    })
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

  it('supports thinking when the config has a thinking object, even an empty one', () => {
    const noKeys = new Set<string>()

    expect(customProvider({}).info(noKeys).supportsThinking).toBe(false)
    expect(customProvider({ thinking: {} }).info(noKeys).supportsThinking).toBe(true)
  })
})
