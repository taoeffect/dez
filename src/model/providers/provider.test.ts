import { describe, expect, it } from 'vitest'
import type { AnthropicThinkingBlock, ThinkingReplay } from '../chat/types'
import type { ToolCall, ToolDefinition } from '../tools/types'
import type { NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { secret } from '../../utils/secret'
import { BUILT_IN_PROVIDER_CONFIGS } from './builtins'
import { customProviderConfigSchema } from './config'
import { Provider } from './provider'
import { providerModel, type ChatMessage, type ChatPart, type ChatRequestContext, type ModelInfo } from './types'

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

// A call of the model list tool, and its wire forms.
const toolCall = (id: string, filter: string): ToolCall => ({ id, name: 'model_list', arguments: { filter } })
const openAiToolCall = (id: string, filter: string) => ({ id, type: 'function', function: { name: 'model_list', arguments: `{"filter":"${filter}"}` } })
const anthropicToolUse = (id: string, filter: string) => ({ type: 'tool_use', id, name: 'model_list', input: { filter } })

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

// The wire messages of the chat request that sends `sent`.
function sentMessages(provider: Provider, sent: ChatMessage[], overrides: Record<string, boolean> = {}): Array<Record<string, unknown>> {
  return requestBody(provider.chatRequest(sent, { id: 'm' }, key, overrides).request).messages as Array<Record<string, unknown>>
}

describe('OpenAI format requests', () => {
  it('sends a Bearer key, JSON content type, and assistant roles', () => {
    const { request } = customProvider({}).chatRequest(messages, { id: 'llama3' }, key)

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

    expect(provider.chatRequest(messages, { id: 'llama3' }, null).request.headers).toEqual({ 'Content-Type': 'application/json' })
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

      expect(provider.chatRequest(messages, { id: 'claude' }, key).request.url).toBe('https://api.anthropic.com/v1/messages')
      expect(provider.modelListRequest(key)?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    }
  })

  it('sends x-api-key and anthropic-version, never Authorization', () => {
    const provider = customProvider({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' })

    expect(provider.chatRequest(messages, { id: 'claude' }, key).request.headers).toEqual({
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
    const defaultBody = requestBody(customProvider({ apiFormat: 'anthropic' }).chatRequest(messages, { id: 'claude' }, key).request)
    const minimaxRequest = builtInProvider('minimax').chatRequest(messages, { id: 'MiniMax-M2.7' }, key).request

    expect(defaultBody).toEqual({ model: 'claude', messages: markedApiMessages, stream: true, max_tokens: 32000 })
    expect(minimaxRequest.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(requestBody(minimaxRequest).max_tokens).toBe(65536)
  })

  it('sends Kimi chat and model-list requests under the /coding path', () => {
    const kimi = builtInProvider('kimi')

    expect(kimi.chatRequest(messages, { id: 'k3' }, key).request.url).toBe('https://api.kimi.com/coding/v1/messages')
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

    expect(copilot.chatRequest(messages, { id: 'gpt-4o' }, key).request.headers).toMatchObject(editorHeaders)
    expect(copilot.modelListRequest(key)?.headers).toMatchObject(editorHeaders)
  })

  it('lets a stored key replace a static Authorization header of any case', () => {
    const provider = customProvider({ headers: { authorization: 'Bearer static', 'content-type': 'text/plain' } })

    expect(provider.chatRequest(messages, { id: 'm' }, key).request.headers).toEqual({
      'content-type': 'text/plain',
      Authorization: 'Bearer sk-test',
    })
    expect(provider.chatRequest(messages, { id: 'm' }, null).request.headers).toEqual({
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
    expect(sentMessages(customProvider({}), imageMessages)).toEqual([
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

    expect(sentMessages(provider, imageMessages)).toEqual([
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

    expect(copilot.chatRequest(imageMessages, { id: 'gpt-4o' }, key).request.headers).toMatchObject({ 'Copilot-Vision-Request': 'true' })
    expect(copilot.chatRequest(messages, { id: 'gpt-4o' }, key).request.headers).not.toHaveProperty('Copilot-Vision-Request')
    expect(provider.chatRequest(imageMessages, { id: 'm' }, key).request.headers).toEqual({
      'Content-Type': 'application/json',
      'x-vision': 'on',
      Authorization: 'Bearer sk-test',
    })
    expect(provider.chatRequest(messages, { id: 'm' }, key).request.headers).toEqual({
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
  // The prompt that the server caches: every message field and block
  // without its mark, a string being one text block.
  const prompt = (wire: Array<Record<string, unknown>>) => wire.map(({ cache_control: _messageMark, content, ...fields }) => ({
    ...fields,
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

  it('marks the last tool message of a tool round in the OpenAI format', () => {
    const sent = sentMessages(openAi, [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: '', toolCalls: [toolCall('call_1', 'a'), toolCall('call_2', 'b')] },
      { role: 'tool', results: [{ callId: 'call_1', content: 'R1', isError: false }, { callId: 'call_2', content: 'R2', isError: false }] },
    ])

    expect(sent.map(({ role, content }) => ({ role, content }))).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'R1' },
      { role: 'tool', content: [{ type: 'text', text: 'R2', cache_control: CACHE }] },
    ])
  })

  it('marks the last tool message itself, keeping its string content, for a config with toolMessageCacheMark "message"', () => {
    const sent = sentMessages(customProvider({ cacheBreakpoints: true, toolMessageCacheMark: 'message' }), [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: '', toolCalls: [toolCall('call_1', 'a'), toolCall('call_2', 'b')] },
      { role: 'tool', results: [{ callId: 'call_1', content: 'R1', isError: false }, { callId: 'call_2', content: 'R2', isError: false }] },
    ])

    expect(sent).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: '', tool_calls: [openAiToolCall('call_1', 'a'), openAiToolCall('call_2', 'b')] },
      { role: 'tool', tool_call_id: 'call_1', content: 'R1' },
      { role: 'tool', tool_call_id: 'call_2', content: 'R2', cache_control: CACHE },
    ])
  })

  it('sends the prompt of each request again and marks where that request stored it, also after a turn of more than 20 blocks and in tool rounds', () => {
    // Turn 2 adds 25 blocks: more than a cache read looks back.
    const manyImages = Array.from({ length: 12 }, (_, n) => [text(`Picture ${n}:`), image(`I${n}`)]).flat()
    const modelList = (id: string): ChatMessage[] => [
      { role: 'agent', content: '', toolCalls: [toolCall(id, id)] },
      { role: 'tool', results: [{ callId: id, content: `${id} models`, isError: false }] },
    ]
    const turns: ChatMessage[][] = [[{ role: 'user', content: [text('Q1'), image('AA')] }]]
    turns.push([...turns[0], { role: 'agent', content: 'A1' }, { role: 'user', content: [...manyImages, text('Q2')] }])
    turns.push([...turns[1], { role: 'agent', content: 'A2' }, { role: 'user', content: [image('BB')] }])
    turns.push([...turns[2], { role: 'agent', content: 'A3' }, { role: 'user', content: 'Q4' }])
    // Two tool rounds of one reply, then the next turn.
    turns.push([...turns[3], ...modelList('call_1')])
    turns.push([...turns[4], ...modelList('call_2')])
    turns.push([...turns[5], { role: 'agent', content: 'A4' }, { role: 'user', content: 'Q5' }])

    for (const provider of [anthropic, openAi, customProvider({ cacheBreakpoints: true, toolMessageCacheMark: 'message' })]) {
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

    expect(requestBody(keyed.chatRequest(messages, { id: 'm' }, key, {}, { conversationId: 'conv-1' }).request).prompt_cache_key).toBe('conv-1')
    expect(requestBody(keyed.chatRequest(messages, { id: 'm' }, key).request)).not.toHaveProperty('prompt_cache_key')
    expect(requestBody(openAi.chatRequest(messages, { id: 'm' }, key, {}, { conversationId: 'conv-1' }).request)).not.toHaveProperty('prompt_cache_key')
    expect(requestBody(keyedAnthropic.chatRequest(messages, { id: 'm' }, key, {}, { conversationId: 'conv-1' }).request)).not.toHaveProperty('prompt_cache_key')
  })
})

describe('system prompt and tools', () => {
  const SEARCH: ToolDefinition = {
    name: 'search',
    description: 'Search the notes.',
    parameters: [{ name: 'query', type: 'string', description: 'The words to find.', required: true }],
  }
  const searchSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'The words to find.' } },
    required: ['query'],
  }
  const context = { system: 'You are m.', tools: [SEARCH] }

  it('sends the OpenAI-format system prompt as the first message and the tools as functions', () => {
    expect(requestBody(customProvider({}).chatRequest(messages, { id: 'm' }, key, {}, context).request)).toEqual({
      model: 'm',
      messages: [{ role: 'system', content: 'You are m.' }, ...apiMessages],
      stream: true,
      tools: [{ type: 'function', function: { name: 'search', description: 'Search the notes.', parameters: searchSchema } }],
    })
  })

  it('sends the Anthropic-format system prompt as the top-level system field and the tools with input_schema', () => {
    expect(requestBody(customProvider({ apiFormat: 'anthropic' }).chatRequest(messages, { id: 'm' }, key, {}, context).request)).toEqual({
      model: 'm',
      system: 'You are m.',
      messages: markedApiMessages,
      stream: true,
      tools: [{ name: 'search', description: 'Search the notes.', input_schema: searchSchema }],
      max_tokens: 32000,
    })
  })

  it('puts no cache mark on the OpenAI-format system message', () => {
    const sent = requestBody(customProvider({ cacheBreakpoints: true }).chatRequest(messages, { id: 'm' }, key, {}, context).request).messages

    expect(sent).toEqual([{ role: 'system', content: 'You are m.' }, ...markedApiMessages])
  })

  it('sends no tools field for an empty tool list', () => {
    for (const apiFormat of ['openai', 'anthropic']) {
      const body = requestBody(customProvider({ apiFormat }).chatRequest(messages, { id: 'm' }, key, {}, { system: 'S', tools: [] }).request)

      expect(body, apiFormat).not.toHaveProperty('tools')
    }
  })

  it('sends a signed replay only with the system prompt and the tools that its request had', () => {
    const q1: ChatMessage = { role: 'user', content: 'Q1' }
    const q2: ChatMessage = { role: 'user', content: 'Q2' }
    const plainReply = { role: 'assistant', content: 'A1' }
    const otherTools = [{ ...SEARCH, description: 'Search the files.' }]
    const contexts: ChatRequestContext[] = [{}, { system: context.system }, context, { ...context, system: 'You are n.' }, { ...context, tools: otherTools }]
    const cases: Array<[Provider, (prefixHash: string) => ThinkingReplay]> = [
      [customProvider({ thinking: {} }), (prefixHash) => ({ kind: 'copilot', opaque: 'op', prefixHash })],
      [
        customProvider({ apiFormat: 'anthropic', thinking: {} }),
        (prefixHash) => ({ kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking: 'Plan', signature: 'sig' }], prefixHash }),
      ],
    ]

    for (const [provider, replay] of cases) {
      for (const made of contexts) {
        const prefixHash = provider.chatRequest([q1], { id: 'm' }, key, {}, made).thinking?.prefixHash ?? ''
        const a1: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: replay(prefixHash) } }
        for (const sent of contexts) {
          const wire = requestBody(provider.chatRequest([q1, a1, q2], { id: 'm' }, key, {}, sent).request).messages as unknown[]
          const reply = wire.find((message) => (message as Record<string, unknown>).role === 'assistant')

          expect(JSON.stringify(reply) !== JSON.stringify(plainReply), JSON.stringify({ made, sent })).toBe(made === sent)
        }
      }
    }
  })
})

describe('declarative provider settings', () => {
  it('writes every Venice parameter from the defaults, for a model that every toggle applies to', () => {
    const body = requestBody(venice.chatRequest(messages, { id: 'grok-4-20' }, key).request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_x_search: true,
      enable_web_scraping: true,
    })
    expect(body).toMatchObject({ model: 'grok-4-20', messages: markedApiMessages, stream: true })
  })

  it('applies sparse overrides, including the web search string values', () => {
    const body = requestBody(venice.chatRequest(messages, { id: 'grok-4-20' }, key, { webSearch: false }).request)

    expect(body.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'off',
      enable_x_search: true,
      enable_web_scraping: true,
    })
  })

  it('maps every toggle flipped away from its default, and always turns the Venice system prompt off', () => {
    // An app_state.json from before the toggle was removed can still hold
    // `veniceSystemPrompt: true`.
    const flipped = {
      ...Object.fromEntries((venice.config.settings ?? []).map((setting) => [setting.key, !setting.default])),
      veniceSystemPrompt: true,
    }

    expect(requestBody(venice.chatRequest(messages, { id: 'grok-4-20' }, key, flipped).request).venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
  })

  it('merges a config requestBody before the settings and the thinking body, and never changes the config', () => {
    const provider = customProvider({
      requestBody: { extra: { fixed: 1, flag: 'base', thinkingOff: false }, top: 'kept' },
      settings: [{ key: 'flag', label: 'Flag', type: 'boolean', default: true, bodyPath: 'extra.flag' }],
      thinking: { disabledBody: { extra: { thinkingOff: true } } },
    })
    const original = structuredClone(provider.config.requestBody)

    expect(requestBody(provider.chatRequest(messages, { id: 'm' }, key, { thinking: false }).request)).toMatchObject({
      top: 'kept',
      extra: { fixed: 1, flag: true, thinkingOff: true },
    })
    expect(requestBody(provider.chatRequest(messages, { id: 'm' }, key, { flag: false }).request).extra).toEqual({ fixed: 1, flag: false, thinkingOff: false })
    expect(provider.config.requestBody).toEqual(original)
  })

  it('merges the imageOutputBody after the requestBody, only into a request that asks for image output', () => {
    const provider = customProvider({
      requestBody: { modalities: ['text'], top: 'kept' },
      imageOutputBody: { modalities: ['image', 'text'] },
    })
    const body = (sender: Provider, context?: ChatRequestContext) => requestBody(sender.chatRequest(messages, { id: 'm' }, key, {}, context).request)

    expect(body(provider, { imageOutput: true })).toMatchObject({ modalities: ['image', 'text'], top: 'kept' })
    expect(body(provider, { imageOutput: false }).modalities).toEqual(['text'])
    expect(body(provider).modalities).toEqual(['text'])
    expect(body(customProvider({}), { imageOutput: true })).not.toHaveProperty('modalities')
    // OpenRouter refuses `modalities` for a model that cannot make images.
    expect(body(builtInProvider('openrouter'), { imageOutput: true }).modalities).toEqual(['image', 'text'])
    expect(body(builtInProvider('openrouter'))).not.toHaveProperty('modalities')
  })

  it('adds no venice_parameters to a provider without settings', () => {
    const body = requestBody(builtInProvider('openrouter').chatRequest(messages, { id: 'm' }, key, { webSearch: false }).request)

    expect(body).not.toHaveProperty('venice_parameters')
  })

  // The rule of which toggles apply is tested in modelToggles.test.ts; these
  // check that the request follows it.
  it('writes a prefix-gated setting only for a matching model id', () => {
    expect(requestBody(venice.chatRequest(messages, { id: 'grok-4-20' }, key).request).venice_parameters).toHaveProperty('enable_x_search', true)
    expect(requestBody(venice.chatRequest(messages, { id: 'llama-3.3-70b' }, key).request).venice_parameters).toStrictEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'on',
      enable_web_scraping: true,
    })
  })

  it('writes no field of a setting that the model is known not to take, whatever its stored value', () => {
    const model = { id: 'grok-build-0-1', unsupportedSettings: ['webSearch', 'xSearch'] }
    const stored: Array<Record<string, boolean>> = [{}, { webSearch: true, xSearch: true }, { webSearch: false, xSearch: false }]

    for (const overrides of stored) {
      expect(requestBody(venice.chatRequest(messages, model, key, overrides).request).venice_parameters).toStrictEqual({
        include_venice_system_prompt: false,
        enable_web_scraping: true,
      })
    }
  })
})

describe('thinking request bodies', () => {
  const bodyWith = (provider: Provider, overrides: Record<string, boolean> = {}) =>
    requestBody(provider.chatRequest(messages, { id: 'm' }, key, overrides).request)
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

  it('sends no thinking body to a model that is known not to think, whatever the toggle, and keeps no reply thinking', () => {
    const provider = customProvider({
      thinking: { enabledBody: { reasoning: { enabled: true } }, disabledBody: { reasoning: { enabled: false } } },
    })
    const toggles: Array<Record<string, boolean>> = [{}, { thinking: true }, { thinking: false }]

    for (const overrides of toggles) {
      const { request, thinking } = provider.chatRequest(messages, { id: 'm', thinking: false }, key, overrides)

      expect(requestBody(request)).toStrictEqual(base)
      expect(thinking).toBeUndefined()
    }
    // A model that thinks, and one that the list tells nothing of.
    for (const model of [{ id: 'm', thinking: true }, { id: 'm' }]) {
      expect(requestBody(provider.chatRequest(messages, model, key).request)).toStrictEqual({ ...base, reasoning: { enabled: true } })
    }
  })

  it('deep-merges an enabledBody into an object that a setting wrote', () => {
    const provider = customProvider({
      thinking: { enabledBody: { options: { think: true, stop: ['</s>'] } } },
      settings: [{ key: 'raw', label: 'Raw', type: 'boolean', bodyPath: 'options.raw', default: true }],
    })

    expect(bodyWith(provider).options).toEqual({ raw: true, think: true, stop: ['</s>'] })
  })

  it('returns a prefix hash only when it asks for thinking', () => {
    const provider = customProvider({ thinking: {} })

    expect(provider.chatRequest(messages, { id: 'm' }, key).thinking).toEqual({ prefixHash: expect.any(String) })
    expect(provider.chatRequest(messages, { id: 'm' }, key, { thinking: false })).not.toHaveProperty('thinking')
    expect(customProvider({}).chatRequest(messages, { id: 'm' }, key)).not.toHaveProperty('thinking')
  })

  it('gives a different prefix hash when an earlier message changes', () => {
    const provider = builtInProvider('openrouter')
    const edited: ChatMessage[] = [{ role: 'user', content: 'Search the web for older info.' }, messages[1]]

    expect(provider.chatRequest(edited, { id: 'm' }, key).thinking?.prefixHash)
      .not.toBe(provider.chatRequest(messages, { id: 'm' }, key).thinking?.prefixHash)
  })
})

describe('thinking send-back', () => {
  const openAiThinker = customProvider({ thinking: {} })
  const anthropicThinker = customProvider({ apiFormat: 'anthropic', thinking: {} })
  const user = (content: string): ChatMessage => ({ role: 'user', content })
  // The prefix hash that the request which sent `sent` gives its reply.
  const prefixHash = (provider: Provider, sent: ChatMessage[]) => provider.chatRequest(sent, { id: 'm' }, key).thinking?.prefixHash ?? ''

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

    expect(sentMessages(openAiThinker, [...beforeA3, a3, user('Q4')])).toEqual([
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

    expect(sentMessages(anthropicThinker, [user('Q1'), a1, user('Q2')])).toEqual([
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
      const sent = sentMessages(provider, [user('Q1'), a1, user('Q2'), { role: 'agent', content: 'A2' }, user('Q3')])

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

    expect(sentMessages(anthropicThinker, [user('Q1'), fieldReply])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: 'A1' },
    ])
    expect(sentMessages(openAiThinker, [user('Q1'), blocksReply])).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }])
  })

  it('sends thinking only in a request that asks for thinking', () => {
    const reply: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: { kind: 'field', field: 'reasoning_content' } } }
    const textOnly = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }]

    expect(sentMessages(openAiThinker, [user('Q1'), reply], { thinking: false })).toEqual(textOnly)
    expect(sentMessages(customProvider({}), [user('Q1'), reply])).toEqual(textOnly)
  })

  it('sends no earlier thinking to a model that is known not to think', () => {
    const reply: ChatMessage = { role: 'agent', content: 'A1', thinking: { text: 'Plan', replay: { kind: 'field', field: 'reasoning_content' } } }
    const cases = [
      { model: { id: 'm', thinking: false }, sentReply: { role: 'assistant', content: 'A1' } },
      { model: { id: 'm' }, sentReply: { role: 'assistant', content: 'A1', reasoning_content: 'Plan' } },
    ]

    for (const { model, sentReply } of cases) {
      expect(requestBody(openAiThinker.chatRequest([user('Q1'), reply], model, key).request).messages)
        .toEqual([{ role: 'user', content: 'Q1' }, sentReply])
    }
  })

  describe('signed replay prefixes', () => {
    // A reply with a signed replay, made by the request that sent `sent`.
    const reply = (sent: ChatMessage[], content: string): ChatMessage => ({
      role: 'agent',
      content,
      thinking: { text: `${content} plan`, replay: { kind: 'copilot', opaque: `${content} opaque`, prefixHash: prefixHash(openAiThinker, sent) } },
    })
    // The opaque value that each assistant message sends, or null.
    const sentOpaques = (sent: ChatMessage[]) => sentMessages(openAiThinker, sent)
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

  describe('tool rounds', () => {
    const thinkingBlocks = (plan: string): AnthropicThinkingBlock[] => [{ type: 'thinking', thinking: plan, signature: `${plan} signature` }]
    const details = (plan: string) => [{ type: 'reasoning.text', text: plan, signature: `${plan} signature`, index: 0 }]
    const openAiReplay = (plan: string, prefixHash: string): ThinkingReplay => ({ kind: 'reasoningDetails', details: details(plan), prefixHash })
    // The requests of one reply with two tool rounds, and of the next turn.
    // The replay of each round was made by the request before it.
    function requests(provider: Provider, replay: (plan: string, prefixHash: string) => ThinkingReplay) {
      const withRound = (before: ChatMessage[], plan: string, content: string, filter: string): ChatMessage[] => [
        ...before,
        { role: 'agent', content, thinking: { text: plan, replay: replay(plan, prefixHash(provider, before)) }, toolCalls: [toolCall(`call_${filter}`, filter)] },
        { role: 'tool', results: [{ callId: `call_${filter}`, content: `${filter} models`, isError: false }] },
      ]
      const round2 = withRound([user('Q1')], 'Plan 1', 'Let me look.', 'gemini')
      const round3 = withRound(round2, 'Plan 2', '', 'mistral')
      const nextTurn: ChatMessage[] = [...round3, { role: 'agent', content: 'A1' }, user('Q2')]
      return { round2, round3, nextTurn }
    }
    // The OpenAI-format messages of `nextTurn`, with the replay fields that
    // each tool round adds.
    const openAiNextTurn = (round1Replay: Record<string, unknown>, round2Replay: Record<string, unknown>) => [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'Let me look.', tool_calls: [openAiToolCall('call_gemini', 'gemini')], ...round1Replay },
      { role: 'tool', tool_call_id: 'call_gemini', content: 'gemini models' },
      { role: 'assistant', content: '', tool_calls: [openAiToolCall('call_mistral', 'mistral')], ...round2Replay },
      { role: 'tool', tool_call_id: 'call_mistral', content: 'mistral models' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]

    it('sends the OpenAI replay fields with the tool calls of each round, and each request starts with the bytes of the request before it', () => {
      const { round2, round3, nextTurn } = requests(openAiThinker, openAiReplay)
      const sent = [round2, round3, nextTurn].map((messages) => JSON.stringify(sentMessages(openAiThinker, messages)))

      expect(JSON.parse(sent[2])).toStrictEqual(openAiNextTurn({ reasoning_details: details('Plan 1') }, { reasoning_details: details('Plan 2') }))
      expect(sent[1].startsWith(sent[0].slice(0, -1))).toBe(true)
      expect(sent[2].startsWith(sent[1].slice(0, -1))).toBe(true)
    })

    it('sends the Anthropic thinking blocks of each round before its text and tool_use blocks, in every later request', () => {
      const { round3, nextTurn } = requests(anthropicThinker, (plan, prefixHash) => ({ kind: 'anthropicBlocks', blocks: thinkingBlocks(plan), prefixHash }))

      for (const messages of [round3, nextTurn]) {
        const sent = sentMessages(anthropicThinker, messages)

        expect([sent[1], sent[3]]).toStrictEqual([
          { role: 'assistant', content: [...thinkingBlocks('Plan 1'), { type: 'text', text: 'Let me look.' }, anthropicToolUse('call_gemini', 'gemini')] },
          { role: 'assistant', content: [...thinkingBlocks('Plan 2'), anthropicToolUse('call_mistral', 'mistral')] },
        ])
      }
    })

    it('keeps the tool calls and results in a request that asks for no thinking', () => {
      const { nextTurn } = requests(openAiThinker, openAiReplay)

      expect(sentMessages(openAiThinker, nextTurn, { thinking: false })).toStrictEqual(openAiNextTurn({}, {}))
    })
  })
})

describe('tool calls and results', () => {
  const twoResults: ChatMessage = {
    role: 'tool',
    results: [{ callId: 'call_1', content: '1 model', isError: false }, { callId: 'call_2', content: 'Bad filter.', isError: true }],
  }

  it('sends OpenAI tool calls with JSON arguments and empty text, and one tool message per result', () => {
    expect(sentMessages(customProvider({}), [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: '', toolCalls: [toolCall('call_1', 'gemini'), toolCall('call_2', 'mistral')] },
      twoResults,
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])).toStrictEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: '', tool_calls: [openAiToolCall('call_1', 'gemini'), openAiToolCall('call_2', 'mistral')] },
      { role: 'tool', tool_call_id: 'call_1', content: '1 model' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Bad filter.' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])
  })

  it('sends Anthropic tool_use blocks and one tool_result message, with an error flag only on errors and a marked last result', () => {
    expect(sentMessages(customProvider({ apiFormat: 'anthropic' }), [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'Let me look.', toolCalls: [toolCall('call_1', 'gemini'), toolCall('call_2', 'mistral')] },
      twoResults,
      { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])).toStrictEqual([
      { role: 'user', content: 'Q1' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me look.' }, anthropicToolUse('call_1', 'gemini'), anthropicToolUse('call_2', 'mistral')],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '1 model' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'Bad filter.', is_error: true, cache_control: CACHE },
        ],
      },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: [{ type: 'text', text: 'Q2', cache_control: CACHE }] },
    ])
  })

  it('sends an OpenAI-format call id to Anthropic with each invalid char as _, in the call and its result', () => {
    const id = 'functions.model_list:0'
    const sent = sentMessages(customProvider({ apiFormat: 'anthropic' }), [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'Let me look.', toolCalls: [toolCall(id, 'gemini')] },
      { role: 'tool', results: [{ callId: id, content: '1 model', isError: false }] },
    ]) as Array<{ content: Array<Record<string, unknown>> }>

    expect(sent[1].content[1].id).toBe('functions_model_list_0')
    expect(sent[2].content[0].tool_use_id).toBe('functions_model_list_0')
  })

  it('sends no blank Anthropic text block, and puts a user message right after the results in the results message', () => {
    expect(sentMessages(customProvider({ apiFormat: 'anthropic' }), [
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: '\n', toolCalls: [toolCall('call_1', 'gemini')] },
      { role: 'tool', results: [{ callId: 'call_1', content: '1 model', isError: false }] },
      { role: 'user', content: 'Q2' },
    ])).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1', cache_control: CACHE }] },
      { role: 'assistant', content: [anthropicToolUse('call_1', 'gemini')] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1 model' }, { type: 'text', text: 'Q2', cache_control: CACHE }],
      },
    ])
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

  // The image, tool, and thinking flags share one reader; each has its own
  // config path and list value.
  const capabilities = [
    { pathField: 'modelImageInput', flag: 'imageInput', listValue: 'image', otherListValue: 'tools' },
    { pathField: 'modelToolCalling', flag: 'toolCalling', listValue: 'tools', otherListValue: 'image' },
    { pathField: 'modelThinking', flag: 'thinking', listValue: 'reasoning', otherListValue: 'tools' },
  ] as const

  it.each(capabilities)('reads $flag at the config path: a boolean, or a list that holds "$listValue"', ({ pathField, flag, listValue, otherListValue }) => {
    const provider = customProvider({ [pathField]: { path: 'caps.input' } })
    const models = provider.parseModels({
      data: [
        { id: 'yes', caps: { input: true } },
        { id: 'no', caps: { input: false } },
        { id: 'list-yes', caps: { input: ['text', listValue] } },
        { id: 'list-no', caps: { input: ['text', otherListValue] } },
        { id: 'string', caps: { input: listValue } },
        { id: 'number', caps: { input: 1 } },
        { id: 'null', caps: { input: null } },
        { id: 'missing', caps: {} },
        { id: 'not-object', caps: listValue },
        { id: 'no-caps' },
      ],
    })

    // toStrictEqual: an unknown flag leaves the key out.
    expect(models).toStrictEqual([
      { id: 'yes', name: 'yes', provider: 'local', [flag]: true },
      { id: 'no', name: 'no', provider: 'local', [flag]: false },
      { id: 'list-yes', name: 'list-yes', provider: 'local', [flag]: true },
      { id: 'list-no', name: 'list-no', provider: 'local', [flag]: false },
      ...['string', 'number', 'null', 'missing', 'not-object', 'no-caps']
        .map((id) => ({ id, name: id, provider: 'local' })),
    ])
  })

  it.each(capabilities)('gives $flag the config\'s `missing` flag only when the entry has no value at the path', ({ pathField, flag, listValue }) => {
    const flags = (missing: boolean) => customProvider({ [pathField]: { path: 'caps.input', missing } })
      .parseModels({
        data: [
          { id: 'missing', caps: {} },
          { id: 'no-caps' },
          { id: 'not-object', caps: listValue },
          { id: 'reported', caps: { input: !missing } },
          { id: 'list', caps: { input: [listValue] } },
          { id: 'null', caps: { input: null } },
        ],
      })
      .map((model) => model[flag])

    expect(flags(false)).toEqual([false, false, false, true, true, undefined])
    expect(flags(true)).toEqual([true, true, true, false, true, undefined])
  })

  it('reads no capability flag when the config has no path', () => {
    const entry = {
      id: 'm',
      vision: true,
      architecture: { input_modalities: ['image'] },
      supported_parameters: ['tools', 'reasoning'],
      capabilities: { supports: { vision: true, tool_calls: true } },
    }

    expect(customProvider({}).parseModels({ data: [entry] })).toStrictEqual([{ id: 'm', name: 'm', provider: 'local' }])
  })

  it.each(capabilities)('lets a config $flag win over the fetched one, and keeps unknown flags out', ({ pathField, flag }) => {
    const provider = customProvider({
      [pathField]: { path: 'flag' },
      models: [{ id: 'off', [flag]: false }, { id: 'fetched' }, { id: 'on', [flag]: true }, { id: 'unknown' }],
    })
    const fetched = provider.parseModels({
      data: [{ id: 'off', flag: true }, { id: 'fetched', flag: true }, { id: 'unknown' }, { id: 'extra', flag: false }],
    })

    expect(provider.mergeModels(fetched)).toStrictEqual([
      { id: 'off', name: 'off', provider: 'local', [flag]: false },
      { id: 'fetched', name: 'fetched', provider: 'local', [flag]: true },
      { id: 'on', name: 'on', provider: 'local', [flag]: true },
      { id: 'unknown', name: 'unknown', provider: 'local' },
      { id: 'extra', name: 'extra', provider: 'local', [flag]: false },
    ])
  })

  it('merges the image and tool flags of one model separately', () => {
    const provider = customProvider({
      modelImageInput: { path: 'vision' },
      modelToolCalling: { path: 'tools' },
      models: [{ id: 'm', toolCalling: false }],
    })
    const fetched = provider.parseModels({ data: [{ id: 'm', vision: true, tools: true }] })

    expect(provider.mergeModels(fetched)).toStrictEqual([
      { id: 'm', name: 'm', provider: 'local', imageInput: true, toolCalling: false },
    ])
  })

  it('lists the toggles that the entry says the model does not take: a false flag, or a list without the first name of the body path', () => {
    const toggle = (key: string, bodyPath: string, path?: string) =>
      ({ key, label: key, type: 'boolean', default: true, bodyPath, ...(path && { modelSupport: { path } }) })
    const provider = customProvider({
      settings: [toggle('flagged', 'extra.flagged', 'caps.flagged'), toggle('listed', 'search.depth', 'fields'), toggle('free', 'free')],
    })
    const models = provider.parseModels({
      data: [
        { id: 'takes-both', caps: { flagged: true }, fields: ['search', 'free'] },
        { id: 'takes-none', caps: { flagged: false }, fields: ['depth', 'search.depth'] },
        { id: 'no-flag', fields: ['search'] },
        { id: 'empty-list', caps: { flagged: true }, fields: [] },
        { id: 'unknown' },
      ],
    })

    // toStrictEqual: a model with no such toggle has no `unsupportedSettings`.
    expect(models).toStrictEqual([
      { id: 'takes-both', name: 'takes-both', provider: 'local' },
      { id: 'takes-none', name: 'takes-none', provider: 'local', unsupportedSettings: ['flagged', 'listed'] },
      { id: 'no-flag', name: 'no-flag', provider: 'local' },
      { id: 'empty-list', name: 'empty-list', provider: 'local', unsupportedSettings: ['listed'] },
      { id: 'unknown', name: 'unknown', provider: 'local' },
    ])
  })

  it('gives a config model the unsupported toggles of its fetched entry, in an array of its own', () => {
    const provider = customProvider({
      settings: [{ key: 'search', label: 'Search', type: 'boolean', default: true, bodyPath: 'search', modelSupport: { path: 'search' } }],
      models: [{ id: 'm', name: 'Config' }, { id: 'config-only' }],
    })
    const fetched = provider.parseModels({ data: [{ id: 'm', search: false }] })
    const merged = provider.mergeModels(fetched)

    expect(merged).toStrictEqual([
      { id: 'm', name: 'Config', provider: 'local', unsupportedSettings: ['search'] },
      { id: 'config-only', name: 'config-only', provider: 'local' },
    ])
    expect(merged[0].unsupportedSettings).not.toBe(fetched[0].unsupportedSettings)
  })

  it('lets a config outputs list and request kind win over the fetched ones, and keeps unknown ones out', () => {
    const provider = customProvider({
      models: [
        { id: 'config', outputs: ['video', 'image'], request: 'none' },
        { id: 'fetched' },
        { id: 'request-only', request: 'imageEdit' },
        { id: 'unknown' },
      ],
    })
    const fetched = [
      providerModel('local', 'config', 'config', { outputs: ['text'], request: 'chat' }),
      providerModel('local', 'fetched', 'fetched', { outputs: ['image'], request: 'image' }),
      providerModel('local', 'request-only', 'request-only', { outputs: ['image'], request: 'image' }),
      providerModel('local', 'unknown', 'unknown'),
      providerModel('local', 'extra', 'extra', { outputs: ['audio', 'text'] }),
    ]

    // Outputs come in table order, whatever order the config lists them in.
    expect(provider.mergeModels(fetched)).toStrictEqual([
      { id: 'config', name: 'config', provider: 'local', outputs: ['image', 'video'], request: 'none' },
      { id: 'fetched', name: 'fetched', provider: 'local', outputs: ['image'], request: 'image' },
      { id: 'request-only', name: 'request-only', provider: 'local', outputs: ['image'], request: 'imageEdit' },
      { id: 'unknown', name: 'unknown', provider: 'local' },
      { id: 'extra', name: 'extra', provider: 'local', outputs: ['text', 'audio'] },
    ])
  })

  const listed = (id: string, fields: Record<string, unknown> = {}) => ({ id, name: id, provider: 'local', ...fields })

  it('reads the outputs and request kind from the types at the modelOutputs path', () => {
    const provider = customProvider({
      modelOutputs: {
        path: 'arch.out',
        values: {
          text: { outputs: ['text'], request: 'chat' },
          image: { outputs: ['image'] },
          gen: { outputs: ['image'], request: 'image' },
          edit: { outputs: ['image'], request: 'imageEdit' },
          video: { outputs: ['video'] },
          // The request kind comes from a second value of the entry.
          film: { outputs: ['video'], requestBy: { path: 'spec.kind', values: { fromText: 'video' } } },
          sound: { outputs: ['audio'], request: 'tts', requestBy: { path: 'spec.kind', values: { song: 'music' } } },
          // A JSON key is a text: `true` names the boolean value.
          voice: { outputs: ['audio'], request: 'music', requestBy: { path: 'spec.changer', values: { true: 'none' } } },
          priced: { outputs: ['image'], requiredPath: 'price.image' },
          embed: { outputs: [] },
        },
      },
    })
    const models = provider.parseModels({
      data: [
        { id: 'string', arch: { out: 'video' } },
        { id: 'chat-wins', arch: { out: ['image', 'text'] } },
        { id: 'first-kind', arch: { out: ['video', 'edit', 'gen'] } },
        { id: 'union', arch: { out: ['video', 'image', 'video'] } },
        { id: 'skips-unknown', arch: { out: ['speech', 7, 'gen'] } },
        { id: 'makes-nothing', arch: { out: ['embed'] } },
        { id: 'unknown-only', arch: { out: ['speech'] } },
        { id: 'empty-list', arch: { out: [] } },
        { id: 'inherited', arch: { out: 'constructor' } },
        { id: 'number', arch: { out: 1 } },
        { id: 'missing', arch: {} },
        { id: 'required-value', arch: { out: ['text', 'priced'] }, price: { image: '0.00003' } },
        { id: 'required-missing', arch: { out: ['text', 'priced'] }, price: {} },
        { id: 'required-null', arch: { out: ['priced'] }, price: { image: null } },
        { id: 'by-value', arch: { out: 'film' }, spec: { kind: 'fromText' } },
        { id: 'by-other-value', arch: { out: 'film' }, spec: { kind: 'fromImage' } },
        { id: 'by-no-value', arch: { out: 'film' } },
        { id: 'value-beats-request', arch: { out: 'sound' }, spec: { kind: 'song' } },
        { id: 'request-for-other-value', arch: { out: 'sound' }, spec: { kind: 'constructor' } },
        { id: 'by-true', arch: { out: 'voice' }, spec: { changer: true } },
        { id: 'by-false', arch: { out: 'voice' }, spec: { changer: false } },
      ],
    })

    // toStrictEqual: with no known type, both keys stay out (a chat model).
    expect(models).toStrictEqual([
      listed('string', { outputs: ['video'], request: 'none' }),
      listed('chat-wins', { outputs: ['text', 'image'], request: 'chat' }),
      listed('first-kind', { outputs: ['image', 'video'], request: 'imageEdit' }),
      listed('union', { outputs: ['image', 'video'], request: 'none' }),
      listed('skips-unknown', { outputs: ['image'], request: 'image' }),
      // Still in the parsed list, so the diagnostics report shows it.
      listed('makes-nothing', { outputs: [], request: 'none' }),
      ...['unknown-only', 'empty-list', 'inherited', 'number', 'missing'].map((id) => listed(id)),
      // A type counts only with a value at its `requiredPath`.
      listed('required-value', { outputs: ['text', 'image'], request: 'chat' }),
      listed('required-missing', { outputs: ['text'], request: 'chat' }),
      listed('required-null'),
      // `requestBy` names the kind by the entry's value at its path; any
      // other value gets the type's `request`, else `none`.
      listed('by-value', { outputs: ['video'], request: 'video' }),
      listed('by-other-value', { outputs: ['video'], request: 'none' }),
      listed('by-no-value', { outputs: ['video'], request: 'none' }),
      listed('value-beats-request', { outputs: ['audio'], request: 'music' }),
      listed('request-for-other-value', { outputs: ['audio'], request: 'tts' }),
      listed('by-true', { outputs: ['audio'], request: 'none' }),
      listed('by-false', { outputs: ['audio'], request: 'music' }),
    ])
  })

  // The clip tells why a model has no request, so it comes from the same
  // config data as the request kind.
  it('reads the clip that a model with no request needs, from its type or from a second value of the entry', () => {
    const provider = customProvider({
      modelOutputs: {
        path: 'type',
        values: {
          text: { outputs: ['text'], request: 'chat' },
          asr: { outputs: ['text'], clipInput: 'audio' },
          film: { outputs: ['video'], requestBy: { path: 'kind', values: { fromText: 'video' }, clipInputs: { fromVideo: 'video' } } },
          sound: { outputs: ['audio'], clipInput: 'audio', requestBy: { path: 'kind', values: { song: 'music' }, clipInputs: { film: 'video', true: 'audio' } } },
        },
      },
    })
    const models = provider.parseModels({
      data: [
        { id: 'by-type', type: 'asr' },
        { id: 'by-value', type: 'film', kind: 'fromVideo' },
        { id: 'by-other-value', type: 'film', kind: 'constructor' },
        { id: 'by-no-value', type: 'film' },
        { id: 'value-beats-type', type: 'sound', kind: 'film' },
        { id: 'type-for-other-value', type: 'sound', kind: 'other' },
        { id: 'by-true', type: 'film', kind: true },
        { id: 'by-true-of-sound', type: 'sound', kind: true },
        { id: 'with-request', type: 'sound', kind: 'song' },
        { id: 'chat-wins', type: ['asr', 'text'] },
        { id: 'first-clip', type: ['film', 'asr'], kind: 'fromVideo' },
      ],
    })

    expect(models).toStrictEqual([
      listed('by-type', { outputs: ['text'], request: 'none', clipInput: 'audio' }),
      listed('by-value', { outputs: ['video'], request: 'none', clipInput: 'video' }),
      listed('by-other-value', { outputs: ['video'], request: 'none' }),
      listed('by-no-value', { outputs: ['video'], request: 'none' }),
      listed('value-beats-type', { outputs: ['audio'], request: 'none', clipInput: 'video' }),
      listed('type-for-other-value', { outputs: ['audio'], request: 'none', clipInput: 'audio' }),
      // `film` names no clip for `true`.
      listed('by-true', { outputs: ['video'], request: 'none' }),
      listed('by-true-of-sound', { outputs: ['audio'], request: 'none', clipInput: 'audio' }),
      // A model that gets requests needs no clip that Dez cannot send.
      listed('with-request', { outputs: ['audio'], request: 'music' }),
      listed('chat-wins', { outputs: ['text'], request: 'chat' }),
      listed('first-clip', { outputs: ['text', 'video'], request: 'none', clipInput: 'video' }),
    ])
  })

  it('lets a config clip input win over the fetched one, and drops it when the config gives the model a request', () => {
    const provider = customProvider({
      models: [
        { id: 'config', request: 'none', clipInput: 'video' },
        { id: 'fetched' },
        { id: 'config-wins', clipInput: 'video' },
        { id: 'gets-request', request: 'tts' },
        { id: 'clip-with-request', request: 'chat', clipInput: 'audio' },
      ],
    })
    const transcriber = (id: string) => providerModel('local', id, id, { outputs: ['text'], request: 'none', clipInput: 'audio' })

    expect(provider.mergeModels(['fetched', 'config-wins', 'gets-request', 'extra'].map(transcriber))).toStrictEqual([
      listed('config', { request: 'none', clipInput: 'video' }),
      listed('fetched', { outputs: ['text'], request: 'none', clipInput: 'audio' }),
      listed('config-wins', { outputs: ['text'], request: 'none', clipInput: 'video' }),
      listed('gets-request', { outputs: ['text'], request: 'tts' }),
      listed('clip-with-request', { request: 'chat' }),
      listed('extra', { outputs: ['text'], request: 'none', clipInput: 'audio' }),
    ])
  })

  it('leaves out the fetched models that make nothing, but always lists config models', () => {
    const provider = customProvider({
      modelOutputs: { path: 'type', values: { text: { outputs: ['text'], request: 'chat' }, embed: { outputs: [] } } },
      models: [{ id: 'config-embed' }, { id: 'config-says-text', outputs: ['text'], request: 'chat' }],
    })
    const fetched = provider.parseModels({
      data: [
        { id: 'chat', type: 'text' },
        { id: 'embed', type: 'embed' },
        { id: 'config-embed', type: 'embed' },
        { id: 'config-says-text', type: 'embed' },
        { id: 'unknown' },
      ],
    })

    expect(provider.mergeModels(fetched)).toStrictEqual([
      listed('config-embed', { outputs: [], request: 'none' }),
      listed('config-says-text', { outputs: ['text'], request: 'chat' }),
      listed('chat', { outputs: ['text'], request: 'chat' }),
      listed('unknown'),
    ])
  })

  it('gives each listed model its first /models entry, else its config entry, and no entry to a model it left out', () => {
    const provider = customProvider({
      modelOutputs: { path: 'type', values: { text: { outputs: ['text'], request: 'chat' }, embed: { outputs: [] } } },
      models: [{ id: 'both', name: 'Config Both' }, { id: 'config-only', outputs: ['image'], request: 'image' }, { id: 'config-only', name: 'Duplicate' }],
    })
    const data = {
      data: [
        { id: 'both', type: 'text', pricing: { input: 1 } },
        { id: 'fetched', type: 'text', context_length: 8192 },
        { id: 'fetched', type: 'text', context_length: 1 },
        { id: 'embed', type: 'embed' },
        { name: 'no id' },
      ],
    }
    const models = provider.mergeModels(provider.parseModels(data))

    expect([...provider.modelEntries(models, data)]).toStrictEqual([
      ['both', { id: 'both', type: 'text', pricing: { input: 1 } }],
      ['config-only', { id: 'config-only', outputs: ['image'], request: 'image' }],
      ['fetched', { id: 'fetched', type: 'text', context_length: 8192 }],
    ])
    // A provider that does not fetch models lists its config models only.
    expect([...provider.modelEntries(provider.configModels())]).toStrictEqual([
      ['both', { id: 'both', name: 'Config Both' }],
      ['config-only', { id: 'config-only', outputs: ['image'], request: 'image' }],
    ])
  })

  // Entry shapes as each API reports them: Venice and OpenRouter /models
  // (checked live 2026-11-07, 2026-11-08, and 2026-11-10), Copilot from VS
  // Code's Copilot Chat types and a logged Copilot /models entry.
  it('reads the image, tool, and thinking flags and the unsupported toggles of the built-ins from their /models entry shapes', () => {
    const flags = (id: string, data: unknown[]) =>
      builtInProvider(id).parseModels({ data })
        .map(({ imageInput, toolCalling, thinking, unsupportedSettings }) => [imageInput, toolCalling, thinking, unsupportedSettings])

    expect(flags('venice', [
      {
        id: 'grok-4-20',
        model_spec: { capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsReasoning: true, supportsWebSearch: true, supportsXSearch: true } },
      },
      {
        id: 'grok-build-0-1',
        model_spec: { capabilities: { supportsVision: false, supportsFunctionCalling: false, supportsReasoning: false, supportsWebSearch: true, supportsXSearch: false } },
      },
      // A media entry has no `capabilities`: nothing is known.
      { id: 'wan-video', type: 'video', model_spec: {} },
    ])).toEqual([[true, true, true, undefined], [false, false, false, ['xSearch']], [undefined, undefined, undefined, undefined]])
    expect(flags('openrouter', [
      { id: 'o1', architecture: { input_modalities: ['text', 'image', 'file'] }, supported_parameters: ['max_tokens', 'reasoning', 'tool_choice', 'tools'] },
      { id: 'o2', architecture: { input_modalities: ['text'] }, supported_parameters: ['max_tokens', 'temperature'] },
      // Some router models report an empty list.
      { id: 'o3', architecture: { input_modalities: ['text'] }, supported_parameters: [] },
    ])).toEqual([[true, true, true, undefined], [false, false, false, undefined], [false, false, false, undefined]])
    // As in VS Code, a Copilot model without `tool_calls` cannot call tools.
    // The list does not tell which models think.
    expect(flags('copilot', [
      { id: 'c1', capabilities: { supports: { vision: true, tool_calls: true, streaming: true } } },
      { id: 'c2', capabilities: { supports: { streaming: true } } },
    ])).toEqual([[true, true, undefined, undefined], [undefined, false, undefined, undefined]])
  })

  // Type values as each API reports them: Venice and OpenRouter /models
  // (checked live 2026-11-09), Copilot from VS Code's Copilot Chat and a
  // third-party client that logs the live API.
  it('reads the outputs and request kinds of the built-ins from their /models entry shapes', () => {
    const kinds = (id: string, data: unknown[]) => {
      const provider = builtInProvider(id)
      return provider.mergeModels(provider.parseModels({ data })).map((model) => [model.id, model.outputs, model.request])
    }

    expect(kinds('venice', [
      { id: 'text', type: 'text' },
      { id: 'gen', type: 'image' },
      { id: 'edit', type: 'inpaint' },
      { id: 'video', type: 'video' },
      { id: 'speech', type: 'tts' },
      { id: 'song', type: 'music' },
      { id: 'voice-changer', type: 'music', model_spec: { voice_changer: true } },
      { id: 'text-to-video', type: 'video', model_spec: { constraints: { model_type: 'text-to-video' } } },
      { id: 'image-to-video', type: 'video', model_spec: { constraints: { model_type: 'image-to-video' } } },
      { id: 'video-to-video', type: 'video', model_spec: { constraints: { model_type: 'video' } } },
      { id: 'embed', type: 'embedding' },
    ])).toEqual([
      ['text', ['text'], 'chat'],
      ['gen', ['image'], 'image'],
      ['edit', ['image'], 'imageEdit'],
      ['video', ['video'], 'none'],
      ['speech', ['audio'], 'tts'],
      ['song', ['audio'], 'music'],
      // It needs a recording, which Dez does not send.
      ['voice-changer', ['audio'], 'none'],
      // A video model gets requests when it needs only a text, or an
      // image; Dez sends no video.
      ['text-to-video', ['video'], 'video'],
      ['image-to-video', ['video'], 'imageToVideo'],
      ['video-to-video', ['video'], 'none'],
    ])
    // OpenRouter: an image+text model is a chat model that also makes
    // images; an image-only model gets no request (its API is not chat); a
    // router lists "image" but has no image price, so it is a text model;
    // speech and video models take the media API; a model that writes text
    // and audio answers through chat.
    expect(kinds('openrouter', [
      { id: 'text', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'text-image', architecture: { output_modalities: ['image', 'text'] }, pricing: { image_output: '0.00003' } },
      { id: 'image', architecture: { output_modalities: ['image'] }, pricing: { image_output: '0.00003' } },
      { id: 'router', architecture: { output_modalities: ['text', 'image'] }, pricing: { prompt: '-1', completion: '-1' } },
      { id: 'speech', architecture: { output_modalities: ['speech'] } },
      { id: 'video', architecture: { output_modalities: ['video'] } },
      { id: 'text-audio', architecture: { output_modalities: ['text', 'audio'] } },
      { id: 'rerank', architecture: { output_modalities: ['rerank'] } },
    ])).toEqual([
      ['text', ['text'], 'chat'],
      ['text-image', ['text', 'image'], 'chat'],
      ['image', ['image'], 'none'],
      ['router', ['text'], 'chat'],
      ['speech', ['audio'], 'tts'],
      ['video', ['video'], 'video'],
      ['text-audio', ['text', 'audio'], 'chat'],
    ])
    expect(kinds('copilot', [
      { id: 'chat', capabilities: { type: 'chat' } },
      { id: 'completion', capabilities: { type: 'completion' } },
      { id: 'image', capabilities: { type: 'image' } },
      { id: 'new-type', capabilities: { type: 'new-type' } },
    ])).toEqual([
      ['chat', ['text'], 'chat'],
      ['image', ['image'], 'none'],
      ['new-type', undefined, undefined],
    ])
  })

  // Entry shapes of the live Venice and OpenRouter lists (2026-11-11). The
  // refusal of a submit names the clip (unusableModel.ts).
  it('reads the clip that a built-in\'s model with no request needs from its /models entry shape', () => {
    const clipInputs = (id: string, data: unknown[]) => {
      const provider = builtInProvider(id)
      return provider.mergeModels(provider.parseModels({ data })).map((model) => [model.id, model.request, model.clipInput])
    }

    expect(clipInputs('venice', [
      { id: 'speech-to-text', type: 'asr' },
      { id: 'voice-changer', type: 'music', model_spec: { voice_changer: true } },
      { id: 'video-to-video', type: 'video', model_spec: { constraints: { model_type: 'video' } } },
      // It needs an image, not a clip.
      { id: 'upscaler', type: 'upscale' },
      { id: 'song', type: 'music', model_spec: { voice_changer: false } },
      { id: 'image-to-video', type: 'video', model_spec: { constraints: { model_type: 'image-to-video' } } },
    ])).toEqual([
      ['speech-to-text', 'none', 'audio'],
      ['voice-changer', 'none', 'audio'],
      ['video-to-video', 'none', 'video'],
      ['upscaler', 'none', undefined],
      ['song', 'music', undefined],
      ['image-to-video', 'imageToVideo', undefined],
    ])
    expect(clipInputs('openrouter', [
      { id: 'speech-to-text', architecture: { output_modalities: ['transcription'] } },
      // An image-only model needs a text, through an API that Dez does not
      // speak.
      { id: 'image', architecture: { output_modalities: ['image'] }, pricing: { image_output: '0.00003' } },
    ])).toEqual([
      ['speech-to-text', 'none', 'audio'],
      ['image', 'none', undefined],
    ])
  })

  it('builds no model-list request when fetchModels is off', () => {
    expect(customProvider({ fetchModels: false }).modelListRequest(key)).toBeNull()
  })

  it('adds the model list query to the format\'s list URL, after its own query', () => {
    const modelListQuery = { type: 'all', 'a b': 'c&d' }

    expect(customProvider({ modelListQuery }).modelListRequest(null)?.url)
      .toBe('http://localhost:8080/v1/models?type=all&a+b=c%26d')
    expect(customProvider({ modelListQuery, apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' }).modelListRequest(null)?.url)
      .toBe('https://api.anthropic.com/v1/models?limit=1000&type=all&a+b=c%26d')
    expect(customProvider({ modelListQuery: {} }).modelListRequest(null)?.url).toBe('http://localhost:8080/v1/models')
  })
})

describe('media model data', () => {
  const openRouterLike = customProvider({ mediaApi: { format: 'openrouter' }, headers: { 'X-Title': 'Dez' } })
  const veniceLike = customProvider({ mediaApi: { format: 'venice' } })

  it('asks for the model list of the media API, with the key and the time limit of a model list', () => {
    expect(openRouterLike.mediaModelListRequest(key)).toStrictEqual({
      method: 'GET',
      url: 'http://localhost:8080/v1/videos/models',
      headers: { 'X-Title': 'Dez', Authorization: 'Bearer sk-test' },
      timeoutMs: 20_000,
    })
  })

  it('asks for no media model list when the media API has none, or there is no media API', () => {
    expect([veniceLike, customProvider({})].map((provider) => provider.mediaModelListRequest(key))).toStrictEqual([null, null])
  })

  it('keeps the first entry of each id of the media model list', () => {
    const first = { id: 'a', supported_durations: [1] }

    expect(openRouterLike.mediaModelEntries({ data: [first, { id: 'b' }, { id: 'a', supported_durations: [9] }, { name: 'no id' }] }))
      .toStrictEqual(new Map<string, unknown>([['a', first], ['b', { id: 'b' }]]))
    expect(openRouterLike.mediaModelEntries('Not found')).toStrictEqual(new Map())
  })

  it('gives each clip model its parameters from its two entries, and leaves other models as they are', () => {
    const chat = providerModel('local', 'chat', 'Chat', { request: 'chat' })
    const image = providerModel('local', 'image', 'Image', { request: 'image' })
    const speech = providerModel('local', 'speech', 'Speech', { request: 'tts' })
    const video = providerModel('local', 'video', 'Video', { request: 'video' })
    const unlisted = providerModel('local', 'unlisted', 'Unlisted', { request: 'video' })
    const entries = new Map<string, unknown>([
      // A chat model with voices takes no voice: Dez sends it chat requests.
      ['chat', { id: 'chat', supported_voices: ['af_alloy'] }],
      ['speech', { id: 'speech', supported_voices: ['af_alloy', 'af_bella'] }],
      ['video', { id: 'video' }],
    ])
    const mediaEntries = new Map<string, unknown>([['video', { id: 'video', supported_durations: [4, 1] }]])

    expect(openRouterLike.withClipData([chat, image, speech, video, unlisted], entries, mediaEntries)).toStrictEqual([
      chat,
      image,
      { ...speech, parameters: [{ name: 'voice', label: 'Voice', options: ['af_alloy', 'af_bella'], default: 'af_alloy' }] },
      { ...video, parameters: [{ name: 'duration', label: 'Length (seconds)', options: [1, 4], default: 1 }] },
      // A model that the lists do not have gets no `parameters` field.
      unlisted,
    ])
  })

  it('gives no parameters for a provider with no media API', () => {
    const speech = providerModel('local', 'speech', 'Speech', { request: 'tts' })

    expect(customProvider({}).withClipData([speech], new Map([['speech', { id: 'speech', supported_voices: ['af_alloy'] }]]), new Map()))
      .toStrictEqual([speech])
  })

  it('gives each clip model the rules of its text from its entry, also a model with no parameters', () => {
    const chat = providerModel('local', 'chat', 'Chat', { request: 'chat' })
    const song = providerModel('local', 'song', 'Song', { request: 'music' })
    const sound = providerModel('local', 'sound', 'Sound', { request: 'music' })
    const lyrics = { supports_lyrics: true, lyrics_required: true, min_prompt_length: 10, prompt_character_limit: 300 }
    const entries = new Map<string, unknown>([
      // A chat model takes no clip text: Dez sends it chat requests.
      ['chat', { id: 'chat', model_spec: lyrics }],
      ['song', { id: 'song', model_spec: lyrics }],
      ['sound', { id: 'sound', model_spec: { supports_loop: true } }],
    ])

    expect(veniceLike.withClipData([chat, song, sound], entries, new Map())).toStrictEqual([
      chat,
      { ...song, text: { minPromptLength: 10, maxPromptLength: 300, lyrics: { required: true } } },
      // An entry that tells nothing of the text gives no `text` field.
      { ...sound, parameters: [{ name: 'loop', label: 'Loop' }] },
    ])
  })

  it('gives each video model the rules of its input images from its entries, and no `images` field to a model that takes none', () => {
    const speech = providerModel('local', 'speech', 'Speech', { request: 'tts' })
    const fromText = providerModel('local', 'from-text', 'From Text', { request: 'video' })
    const fromImage = providerModel('local', 'from-image', 'From Image', { request: 'imageToVideo' })
    const frames = providerModel('local', 'frames', 'Frames', { request: 'video' })
    const mediaEntries = new Map<string, unknown>([
      ['from-text', { id: 'from-text', supported_frame_images: null }],
      ['frames', { id: 'frames', supported_frame_images: ['first_frame', 'last_frame'] }],
    ])

    const imageRules = (models: ModelInfo[]) => models.map((model) => [model.id, 'images' in model ? model.images : 'no field'])

    expect([
      imageRules(veniceLike.withClipData([speech, fromText, fromImage], new Map(), new Map())),
      imageRules(openRouterLike.withClipData([speech, fromText, frames], new Map(), mediaEntries)),
    ]).toStrictEqual([
      [['speech', 'no field'], ['from-text', 'no field'], ['from-image', { maxFrames: 2 }]],
      [['speech', 'no field'], ['from-text', 'no field'], ['frames', { maxFrames: 2 }]],
    ])
  })

  it('gives the size rules of the input images of a request: of the model for a video, of the edit request for an edit', () => {
    const size = { minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 }
    const model = { images: { maxFrames: 2, size } }

    expect([
      veniceLike.inputImageSize('imageToVideo', model),
      veniceLike.inputImageSize('video', model),
      veniceLike.inputImageSize('imageEdit', model),
      // An image request with no input image, and a clip of a model that
      // the model cache does not know or that tells no rules.
      veniceLike.inputImageSize('image', model),
      veniceLike.inputImageSize('imageToVideo', null),
      veniceLike.inputImageSize('imageToVideo', { images: { maxFrames: 2 } }),
      // The OpenRouter docs tell no rule, and a provider with no media
      // API has none.
      openRouterLike.inputImageSize('imageEdit', null),
      customProvider({}).inputImageSize('imageEdit', null),
    ]).toStrictEqual([size, size, { minShortSide: 256, maxPixels: 33_177_600 }, undefined, undefined, undefined, undefined, undefined])
  })

  it('merges the body parts of the config into the media requests of the kind and the models that they name, in list order', () => {
    const provider = customProvider({
      mediaApi: {
        format: 'openrouter',
        modelRequestBodies: [
          { request: 'tts', modelIdPrefix: 'heygen/', body: { response_format: 'pcm' } },
          { request: 'tts', modelIdPrefix: 'heygen/heygen-voice-2', body: { response_format: 'wav', provider: { sort: 'price' } } },
          { request: 'video', modelIdPrefix: 'heygen/', body: { resolution: '480p' } },
        ],
      },
    })
    const speech = (modelId: string) => provider.clipRequest('tts', modelId, { prompt: 'Hi', images: [], values: { voice: 'nadine' } }).body

    expect([speech('heygen/heygen-voice-1'), speech('heygen/heygen-voice-2'), speech('hexgrad/kokoro-82m'), speech('other/heygen/voice')]).toStrictEqual([
      { voice: 'nadine', model: 'heygen/heygen-voice-1', input: 'Hi', response_format: 'pcm' },
      { voice: 'nadine', model: 'heygen/heygen-voice-2', input: 'Hi', response_format: 'wav', provider: { sort: 'price' } },
      { voice: 'nadine', model: 'hexgrad/kokoro-82m', input: 'Hi', response_format: 'mp3' },
      { voice: 'nadine', model: 'other/heygen/voice', input: 'Hi', response_format: 'mp3' },
    ])
  })

  // The ids of the OpenRouter model list of 2026-11-10. Its guide names
  // the models that make only PCM; no field of an entry does.
  it('asks the OpenRouter speech models that make only raw PCM for PCM, and the others for mp3', () => {
    const format = (modelId: string) => builtInProvider('openrouter').clipRequest('tts', modelId, { prompt: 'Hi', images: [], values: {} }).body?.response_format
    const pcmOnly = [
      'heygen/heygen-voice-1',
      'heygen/heygen-voice-1-turbo',
      'heygen/heygen-voice-1-turbo:free',
      'google/gemini-3.8-flash-lite-tts',
      'google/gemini-3.8-flash-tts',
      'google/gemini-3.1-flash-tts-preview',
    ]
    const others = ['minimax/speech-2.8-hd', 'hexgrad/kokoro-82m', 'elevenlabs/eleven-v3', 'x-ai/grok-voice-tts-1.0']

    expect([pcmOnly.map(format), others.map(format)]).toStrictEqual([pcmOnly.map(() => 'pcm'), others.map(() => 'mp3')])
  })

  it('asks for the price of a clip with the headers and the time limit of a model list, and reads it', () => {
    const quote = veniceLike.clipQuote('video', 'wan', { duration: '5s', aspect_ratio: '16:9' }, undefined, key)

    expect(quote?.request).toStrictEqual({
      method: 'POST',
      url: 'http://localhost:8080/v1/video/quote',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body: JSON.stringify({ duration: '5s', aspect_ratio: '16:9', model: 'wan' }),
      timeoutMs: 20_000,
    })
    expect(quote?.usd({ quote: 0.07 })).toBe(0.07)
  })

  it('has no price request for a kind or a provider whose media API gives none', () => {
    expect([
      veniceLike.clipQuote('tts', 'tts-kokoro', {}, undefined, key),
      openRouterLike.clipQuote('video', 'm', { duration: 1 }, undefined, key),
      customProvider({}).clipQuote('video', 'm', { duration: 1 }, undefined, key),
    ]).toStrictEqual([null, null, null])
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
