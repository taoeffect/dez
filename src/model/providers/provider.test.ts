import { describe, expect, it } from 'vitest'
import type { AnthropicThinkingBlock, ThinkingReplay } from '../chat/types'
import type { NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { secret } from '../../utils/secret'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { customProviderConfigSchema } from './config'
import { Provider } from './provider'
import { ThinkingPrefixHasher } from './thinking'
import type { ChatMessage, ChatPart } from './types'

const messages: ChatMessage[] = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'agent', content: 'I can help with that.' },
]

const apiMessages = [
  { role: 'user', content: 'Search the web for current info.' },
  { role: 'assistant', content: 'I can help with that.' },
]

// The Anthropic format, and an OpenAI-format config with `cacheBreakpoints`,
// mark the last two user messages as cache breakpoints; a marked string
// becomes one text block.
const CACHE = { type: 'ephemeral' }
const markedApiMessages = [
  { role: 'user', content: [{ type: 'text', text: 'Search the web for current info.', cache_control: CACHE }] },
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

    expect(defaultBody).toEqual({ model: 'claude', messages: markedApiMessages, stream: true, max_tokens: 32000 })
    expect(minimaxRequest.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(requestBody(minimaxRequest).max_tokens).toBe(65536)
  })

  it('sends Kimi chat and model-list requests under the /coding path', () => {
    const kimi = builtInProvider('kimi')

    expect(kimi.chatRequest(messages, 'k3', key).request.url).toBe('https://api.kimi.com/coding/v1/messages')
    expect(kimi.modelListRequest(key)?.url).toBe('https://api.kimi.com/coding/v1/models?limit=1000')
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

describe('image parts', () => {
  const imageMessages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Which color?' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0K' }] },
    { role: 'agent', content: 'Red.' },
  ]

  it('sends OpenAI text parts and image_url parts with a base64 data URL', () => {
    expect(requestBody(customProvider({}).chatRequest(imageMessages, 'm', key).request).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Which color?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
        ],
      },
      { role: 'assistant', content: 'Red.' },
    ])
  })

  it('sends Anthropic text blocks and base64 image blocks', () => {
    const provider = customProvider({ apiFormat: 'anthropic' })

    expect(requestBody(provider.chatRequest(imageMessages, 'm', key).request).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Which color?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' }, cache_control: CACHE },
        ],
      },
      { role: 'assistant', content: 'Red.' },
    ])
  })

  it('sends the image headers only on a request with an image, after the static headers and before the key', () => {
    const copilot = builtInProvider('copilot')
    const provider = customProvider({
      headers: { 'X-Vision': 'off' },
      imageRequestHeaders: { 'x-vision': 'on', Authorization: 'Bearer image' },
    })

    expect(copilot.chatRequest(imageMessages, 'gpt-4o', key).request.headers).toMatchObject({ 'Copilot-Vision-Request': 'true' })
    expect(copilot.chatRequest(messages, 'gpt-4o', key).request.headers).not.toHaveProperty('Copilot-Vision-Request')
    expect(provider.chatRequest(imageMessages, 'm', key).request.headers).toEqual({
      'Content-Type': 'application/json',
      'x-vision': 'on',
      Authorization: 'Bearer sk-test',
    })
    expect(provider.chatRequest(messages, 'm', key).request.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Vision': 'off',
      Authorization: 'Bearer sk-test',
    })
  })
})

describe('prompt cache', () => {
  const anthropic = customProvider({ apiFormat: 'anthropic' })
  const openAi = customProvider({ cacheBreakpoints: true })
  const image = (data: string): ChatPart => ({ type: 'image', mediaType: 'image/png', data })
  const text = (text: string): ChatPart => ({ type: 'text', text })
  const sentMessages = (provider: Provider, sent: ChatMessage[]) =>
    requestBody(provider.chatRequest(sent, 'm', key).request).messages as Array<Record<string, unknown>>
  // The prompt that the server caches: the blocks without their marks, a
  // string being one text block.
  const prompt = (wire: Array<Record<string, unknown>>) => wire.map(({ role, content }) => ({
    role,
    content: (typeof content === 'string' ? [{ type: 'text', text: content }] : content as Array<Record<string, unknown>>)
      .map(({ cache_control: _mark, ...block }) => block),
  }))

  it('marks the last block of the last two user messages in the Anthropic format', () => {
    const imageBlock = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

    expect(sentMessages(anthropic, [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: [image('AA'), text('Q2'), image('BB')] },
      { role: 'agent', content: 'A2' },
      { role: 'user', content: 'Q3' },
    ])).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: [imageBlock('AA'), { type: 'text', text: 'Q2' }, { ...imageBlock('BB'), cache_control: CACHE }] },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: [{ type: 'text', text: 'Q3', cache_control: CACHE }] },
    ])
  })

  it('marks the last text part of the last two user messages with text in the OpenAI format', () => {
    const imagePart = (data: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } })

    expect(sentMessages(openAi, [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user', content: [text('Q2'), image('AA')] },
      { role: 'agent', content: 'A2' },
      { role: 'user', content: [image('BB')] },
    ])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: [{ type: 'text', text: 'Q2', cache_control: CACHE }, imagePart('AA')] },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: [imagePart('BB')] },
    ])
  })

  it('sends the prompt of each request again and marks where that request stored it, also after a turn of more than 20 blocks', () => {
    // Turn 2 adds 25 blocks: more than a cache read looks back.
    const manyImages = Array.from({ length: 12 }, (_, n) => [text(`Picture ${n}:`), image(`I${n}`)]).flat()
    const turns: ChatMessage[][] = [[{ role: 'user', content: [text('Q1'), image('AA')] }]]
    turns.push([...turns[0], { role: 'agent', content: 'A1' }, { role: 'user', content: [...manyImages, text('Q2')] }])
    turns.push([...turns[1], { role: 'agent', content: 'A2' }, { role: 'user', content: [image('BB')] }])
    turns.push([...turns[2], { role: 'agent', content: 'A3' }, { role: 'user', content: 'Q4' }])

    for (const provider of [anthropic, openAi]) {
      for (let turn = 1; turn < turns.length; turn++) {
        const previous = sentMessages(provider, turns[turn - 1])
        const current = sentMessages(provider, turns[turn])
        const stored = previous.findLastIndex((message) => JSON.stringify(message).includes('cache_control'))

        expect(prompt(current.slice(0, previous.length))).toEqual(prompt(previous))
        expect(current[stored]).toEqual(previous[stored])
      }
    }
  })

  it('sends the conversation id as prompt_cache_key only for an OpenAI-format config with promptCacheKey', () => {
    const keyed = customProvider({ promptCacheKey: true })
    const keyedAnthropic = customProvider({ apiFormat: 'anthropic', promptCacheKey: true })

    expect(requestBody(keyed.chatRequest(messages, 'm', key, {}, 'conv-1').request).prompt_cache_key).toBe('conv-1')
    expect(requestBody(keyed.chatRequest(messages, 'm', key).request)).not.toHaveProperty('prompt_cache_key')
    expect(requestBody(openAi.chatRequest(messages, 'm', key, {}, 'conv-1').request)).not.toHaveProperty('prompt_cache_key')
    expect(requestBody(keyedAnthropic.chatRequest(messages, 'm', key, {}, 'conv-1').request)).not.toHaveProperty('prompt_cache_key')
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
    expect(body).toMatchObject({ model: 'venice-uncensored', messages: markedApiMessages, stream: true })
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
  const markedBase = { ...base, messages: markedApiMessages }

  it('merges each built-in enabledBody when the toggle is on, the default', () => {
    expect(bodyWith(builtInProvider('openrouter'))).toEqual({ ...markedBase, reasoning: { enabled: true } })
    expect(bodyWith(builtInProvider('zai'))).toEqual({ ...base, thinking: { type: 'enabled' } })
    expect(bodyWith(builtInProvider('minimax'))).toEqual({ ...markedBase, max_tokens: 65536, thinking: { type: 'adaptive' } })
    expect(bodyWith(builtInProvider('venice')).reasoning).toEqual({ enabled: true })
  })

  it('adds only the format default to a built-in with an empty thinking config', () => {
    expect(bodyWith(builtInProvider('charm_hyper'))).toEqual(base)
    expect(bodyWith(builtInProvider('copilot'))).toEqual(base)
    expect(bodyWith(builtInProvider('kimi'))).toEqual({
      ...markedBase,
      max_tokens: 32000,
      thinking: { type: 'adaptive', display: 'summarized' },
    })
  })

  it('sends no thinking fields when the toggle is off, except a disabledBody', () => {
    for (const id of ['zai', 'charm_hyper', 'copilot']) {
      expect(bodyWith(builtInProvider(id), { thinking: false })).toEqual(base)
    }
    expect(bodyWith(builtInProvider('openrouter'), { thinking: false })).toEqual(markedBase)
    expect(bodyWith(builtInProvider('minimax'), { thinking: false })).toEqual({ ...markedBase, max_tokens: 65536 })
    expect(bodyWith(builtInProvider('kimi'), { thinking: false })).toEqual({ ...markedBase, max_tokens: 32000 })
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
      ...markedBase,
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
    const provider = customProvider({ thinking: {} })
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
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: [...blocks, { type: 'text', text: 'A1' }] },
      { role: 'user', content: [{ type: 'text', text: 'Q2', cache_control: CACHE }] },
    ])
  })

  it('still sends a signed replay after its user message lost its cache breakpoint', () => {
    const blocks: AnthropicThinkingBlock[] = [{ type: 'thinking', thinking: 'Plan', signature: 'sig' }]
    const details = [{ type: 'reasoning.text', text: 'Plan', signature: 'sig', index: 0 }]
    const openAiMarker = customProvider({ cacheBreakpoints: true, thinking: {} })
    const cases: Array<[Provider, (prefixHash: string) => ThinkingReplay, unknown]> = [
      [anthropicThinker, (prefixHash) => ({ kind: 'anthropicBlocks', blocks, prefixHash }), { role: 'assistant', content: [...blocks, { type: 'text', text: 'A1' }] }],
      [openAiMarker, (prefixHash) => ({ kind: 'reasoningDetails', details, prefixHash }), { role: 'assistant', content: 'A1', reasoning_details: details }],
    ]

    for (const [provider, replay, sentReply] of cases) {
      // Made by the request that marked Q1 as a cache breakpoint.
      const a1: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: replay(prefixHash(provider, [user('Q1')])) } }
      const sent = wireMessages(provider, [user('Q1'), a1, user('Q2'), { role: 'agent', content: 'A2' }, user('Q3')]) as unknown[]

      expect(sent.slice(0, 2)).toEqual([{ role: 'user', content: 'Q1' }, sentReply])
    }
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

    expect(wireMessages(anthropicThinker, [user('Q1'), fieldReply])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: 'A1' },
    ])
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

    it('sends a replay made after a message with an image, until the image changes', () => {
      const withImage = (data: string): ChatMessage => ({
        role: 'user',
        content: [{ type: 'text', text: 'Q1' }, { type: 'image', mediaType: 'image/png', data }],
      })
      const a1 = reply([withImage('AAAA')], 'A1')

      expect(sentOpaques([withImage('AAAA'), a1, user('Q2')])).toEqual(['A1 opaque'])
      expect(sentOpaques([withImage('BBBB'), a1, user('Q2')])).toEqual([null])
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

  it('reads the image flag at the config path: a boolean, or a list that holds "image"', () => {
    const provider = customProvider({ modelImageInput: { path: 'caps.input' } })
    const models = provider.parseModels({
      data: [
        { id: 'yes', caps: { input: true } },
        { id: 'no', caps: { input: false } },
        { id: 'list-yes', caps: { input: ['text', 'image'] } },
        { id: 'list-no', caps: { input: ['text', 'file'] } },
        { id: 'string', caps: { input: 'image' } },
        { id: 'number', caps: { input: 1 } },
        { id: 'null', caps: { input: null } },
        { id: 'missing', caps: {} },
        { id: 'not-object', caps: 'image' },
        { id: 'no-caps' },
      ],
    })

    // toStrictEqual: an unknown flag leaves the key out.
    expect(models).toStrictEqual([
      { id: 'yes', name: 'yes', provider: 'local', imageInput: true },
      { id: 'no', name: 'no', provider: 'local', imageInput: false },
      { id: 'list-yes', name: 'list-yes', provider: 'local', imageInput: true },
      { id: 'list-no', name: 'list-no', provider: 'local', imageInput: false },
      ...['string', 'number', 'null', 'missing', 'not-object', 'no-caps']
        .map((id) => ({ id, name: id, provider: 'local' })),
    ])
  })

  it('reads no image flag when the config has no path', () => {
    const entry = { id: 'm', vision: true, architecture: { input_modalities: ['image'] } }

    expect(customProvider({}).parseModels({ data: [entry] })).toStrictEqual([{ id: 'm', name: 'm', provider: 'local' }])
  })

  it('lets a config image flag win over the fetched one, and keeps unknown flags out', () => {
    const provider = customProvider({
      modelImageInput: { path: 'vision' },
      models: [{ id: 'off', imageInput: false }, { id: 'fetched' }, { id: 'on', imageInput: true }, { id: 'unknown' }],
    })
    const fetched = provider.parseModels({
      data: [{ id: 'off', vision: true }, { id: 'fetched', vision: true }, { id: 'unknown' }, { id: 'extra', vision: false }],
    })

    expect(provider.mergeModels(fetched)).toStrictEqual([
      { id: 'off', name: 'off', provider: 'local', imageInput: false },
      { id: 'fetched', name: 'fetched', provider: 'local', imageInput: true },
      { id: 'on', name: 'on', provider: 'local', imageInput: true },
      { id: 'unknown', name: 'unknown', provider: 'local' },
      { id: 'extra', name: 'extra', provider: 'local', imageInput: false },
    ])
  })

  // Entry shapes as each API reports them: Venice and OpenRouter /models
  // (checked live 2026-11-07), Copilot from VS Code's Copilot Chat types.
  it('reads the image flag of the built-ins from their /models entry shapes', () => {
    const flags = (id: string, data: unknown[]) =>
      builtInProvider(id).parseModels({ data }).map((model) => model.imageInput)

    expect(flags('venice', [
      { id: 'v1', model_spec: { capabilities: { supportsVision: true } } },
      { id: 'v2', model_spec: { capabilities: { supportsVision: false } } },
    ])).toEqual([true, false])
    expect(flags('openrouter', [
      { id: 'o1', architecture: { input_modalities: ['text', 'image', 'file'] } },
      { id: 'o2', architecture: { input_modalities: ['text'] } },
    ])).toEqual([true, false])
    expect(flags('copilot', [
      { id: 'c1', capabilities: { supports: { vision: true, streaming: true } } },
      { id: 'c2', capabilities: { supports: { streaming: true } } },
    ])).toEqual([true, undefined])
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
