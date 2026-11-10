import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRef, Section } from '../chat/types'
import { toolBlockText } from '../chat/toolBlocks'
import { sectionsToStreamMessages } from '../streams/messages'
import { bytesToBase64 } from '../../utils/base64'
import type { NativeHttpRequest, NativeHttpResponse, NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import type { ProviderGenerateMediaResult } from './streamTypes'
import type { ModelDisplayNames, ProviderModelsResult } from './types'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../state/index'
import './selectors'

// The text Rust sends when provider_keys.json does not parse.
const KEY_STORE_ERROR = 'API error: Failed to parse provider_keys.json (line 1, column 2)'

// Requests the stubs below received, in order.
let httpRequests: NativeHttpRequest[] = []
let streamRequests: NativeHttpRequest[] = []
let streamRequestIds: string[] = []
let imageReads: string[] = []

// The app folder and its one stored image.
const APP_DIR = '/home/u/.config/dez'
const STORED_IMAGE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])

// Requests to this base URL get HTTP 404; every other server answers.
const FAILING_BASE_URL = 'http://localhost:9090/v1'
// This server thinks before it answers, then calls a tool.
const REASONING_BASE_URL = 'http://localhost:7070/v1'

const REASONING_STREAM = [
  'data: {"choices":[{"delta":{"reasoning_content":"Plan"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":" it."}}]}',
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"model_list","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
].join('\n\n') + '\n\n'
const STREAMED_TOOL_CALLS = [{ id: 'call_1', name: 'model_list', argumentsText: '{}' }]

// This media server answers a generate request with JSON and an edit with the
// image's bytes, each in two chunks.
const MEDIA_BASE_URL = 'http://localhost:5050/api/v1'
const WEBP_IMAGE = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WEBPVP8 ')
const MEDIA_ANSWERS = new Map([
  [`${MEDIA_BASE_URL}/image/generate`, { contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ images: [bytesToBase64(WEBP_IMAGE)] })) }],
  [`${MEDIA_BASE_URL}/image/multi-edit`, { contentType: 'image/png', body: STORED_IMAGE }],
])

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
  async 'dez.native/getAppDir' (): Promise<string> {
    return APP_DIR
  },
  async 'dez.native/loadAppFileBytes' (path: string): Promise<Uint8Array> {
    imageReads.push(path)
    if (path === 'assets/images/red.png' || path === 'assets/generated/images/red.png') return STORED_IMAGE
    throw `Failed to read ${path}: No such file or directory (os error 2)`
  },
  async 'dez.http/stream' (request: NativeHttpRequest, requestId: string): Promise<NativeHttpStreamResult> {
    streamRequests.push(request)
    streamRequestIds.push(requestId)
    const media = MEDIA_ANSWERS.get(request.url)
    if (media) {
      const half = media.body.length >> 1
      return {
        requestId,
        response: { status: 200, headers: { 'content-type': media.contentType } },
        chunks: (async function * () {
          yield media.body.slice(0, half)
          yield media.body.slice(half)
        })(),
      }
    }
    const failing = request.url.startsWith(FAILING_BASE_URL)
    return {
      requestId,
      response: { status: failing ? 404 : 200, headers: {} },
      chunks: (async function * () {
        yield new TextEncoder().encode(failing
          ? 'Not found'
          : request.url.startsWith(REASONING_BASE_URL)
            ? REASONING_STREAM
            : 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n')
      })(),
    }
  },
})

beforeEach(() => {
  setActivePinia(createPinia())
  httpRequests = []
  streamRequests = []
  streamRequestIds = []
  imageReads = []
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

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'served-model', name: 'served-model', provider: 'local' }],
      entries: new Map([['served-model', { id: 'served-model' }]]),
    })
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

describe('thinking in chat streams', () => {
  async function streamThinker(providerSettings?: Record<string, boolean>) {
    sbp('dez.model/customProviders/save', {
      id: 'thinker',
      name: 'Thinker',
      baseUrl: REASONING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      thinking: {},
    })
    const calls: string[] = []
    const result = await sbp('dez.provider/streamChat', {
      providerId: 'thinker',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      requestId: 'request-1',
      ...(providerSettings && { providerSettings }),
      onToken: (token: string) => { calls.push(`token:${token}`) },
      onThinking: (token: string) => { calls.push(`thinking:${token}`) },
    })
    return { calls, result }
  }

  it('sends the thinking and the answer to their callbacks and returns the replay and the tool calls', async () => {
    const { calls, result } = await streamThinker()

    expect(calls).toEqual(['thinking:Plan', 'thinking: it.', 'token:Hello'])
    expect(result).toStrictEqual({
      requestId: 'request-1',
      thinkingReplay: { kind: 'field', field: 'reasoning_content' },
      toolCalls: STREAMED_TOOL_CALLS,
    })
  })

  it('drops the thinking and returns no replay, but the tool calls, when the toggle is off', async () => {
    const { calls, result } = await streamThinker({ thinking: false })

    expect(calls).toEqual(['token:Hello'])
    expect(result).toStrictEqual({ requestId: 'request-1', toolCalls: STREAMED_TOOL_CALLS })
  })

  it('shows no thinking for a provider without thinking support', async () => {
    const calls: string[] = []
    sbp('dez.model/customProviders/save', {
      id: 'plain',
      name: 'Plain',
      baseUrl: REASONING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
    })
    const result = await sbp('dez.provider/streamChat', {
      providerId: 'plain',
      modelId: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      requestId: 'request-2',
      onToken: (token: string) => { calls.push(`token:${token}`) },
      onThinking: (token: string) => { calls.push(`thinking:${token}`) },
    })

    expect(calls).toEqual(['token:Hello'])
    expect(result).toStrictEqual({ requestId: 'request-2', toolCalls: STREAMED_TOOL_CALLS })
  })
})

describe('images in chat streams', () => {
  function streamImage(path: string) {
    return sbp('dez.provider/streamChat', {
      providerId: 'local',
      modelId: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Which color?' }, { type: 'image', path }] }],
      onToken: () => {},
    })
  }

  it.each(['assets/images', 'assets/generated/images'])('sends the bytes of a stored image in %s as base64, read through the app folder', async (folder) => {
    await streamImage(`${APP_DIR}/${folder}/red.png`)

    expect(imageReads).toEqual([`${folder}/red.png`])
    expect(streamRequests).toHaveLength(1)
    expect(JSON.parse(streamRequests[0].body as string).messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${Buffer.from(STORED_IMAGE).toString('base64')}` },
    })
  })

  it('fails before the request when the image file is missing', async () => {
    await expect(streamImage(`${APP_DIR}/assets/images/gone.png`)).rejects.toThrow('Image not found: gone.png')

    expect(imageReads).toEqual(['assets/images/gone.png'])
    expect(streamRequests).toEqual([])
  })

  it('reads no file for an image of another Dez folder', async () => {
    await expect(streamImage('/home/other/.config/dez/assets/images/red.png')).rejects.toThrow('Image not found: red.png')

    expect(imageReads).toEqual([])
    expect(streamRequests).toEqual([])
  })

  it('sends the messages of an earlier turn again as the same bytes, with images and their ids', async () => {
    const model = { providerId: 'local', modelId: 'm' }
    const path = `${APP_DIR}/assets/images/red.png`
    const turn1: Section[] = [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: `Which color? ![${path}](id=a)` }] }]
    const turn2: Section[] = [
      ...turn1,
      { id: 'a1', role: 'agent', model, content: [{ kind: 'text', text: `Red, as here: ![${path}](id=b)` }] },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: `![${path}](id=c) And this one?` }] },
    ]
    for (const sections of [turn1, turn2]) {
      const { messages } = sectionsToStreamMessages(sections, model, { sendImages: true, sendTools: true })
      await sbp('dez.provider/streamChat', { providerId: 'local', modelId: 'm', messages, onToken: () => {} })
    }
    const [first, second] = streamRequests.map((request) => JSON.parse(request.body as string).messages as unknown[])

    expect(first).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'Which color? ![image](id=a)' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(STORED_IMAGE).toString('base64')}` } },
      ],
    }])
    // OpenAI-format providers reuse their prompt cache only for a prefix of
    // the same text.
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first))
  })
})

describe('chat streams with image paths', () => {
  const path = `${APP_DIR}/assets/images/red.png`
  // Every form of an image path in a conversation: valid references, broken
  // ones, a bare path, a path in metadata, in a prompt body, in agent text,
  // in a tool call's arguments and result, and in thinking that would go
  // back.
  const toolCall = toolBlockText({
    id: 'call_1',
    name: 'model_list',
    status: 'success',
    arguments: { filter: `![${path}](id=a)` },
    result: `Found ${path}.`,
  })
  const sections = (model: ModelRef): Section[] => [
    { id: 'u1', role: 'user', content: [{ kind: 'text', text: `Look: ![${path}](id=a) Why?` }] },
    {
      id: 'a1',
      role: 'agent',
      model,
      content: [{ kind: 'text', text: `This: ![${path}](id=a)\n${toolCall}\nDone.` }],
      thinking: { text: `The user sent ${path}.`, replay: { kind: 'field', field: 'reasoning_content' } },
    },
    {
      id: 'u2',
      role: 'user',
      content: [
        { kind: 'text', text: [`![${path}](id=b)`, `![${path}](id=a`, `[${path}](id=b)`, `see ${path} now`, `![${path}](id=b|desc=a /home/bob/.config/dez/assets/images/b.png)`, ''].join('\n') },
        { kind: 'prompt', id: 'p1', promptId: null, name: 'Ask', body: `Prompt: ![${path}](id=a)`, expanded: false },
        { kind: 'text', text: '' },
      ],
    },
  ]

  it.each([
    ['openai', true, true],
    ['openai', false, false],
    ['anthropic', true, false],
    ['anthropic', false, true],
  ] as const)('sends no path in the %s format (images sent: %s, tools sent: %s), and sends the ids', async (apiFormat, sendImages, sendTools) => {
    sbp('dez.model/customProviders/save', {
      id: apiFormat,
      name: apiFormat,
      baseUrl: `http://localhost:6060/${apiFormat}`,
      apiFormat,
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      thinking: {},
    })
    const model = { providerId: apiFormat, modelId: 'm' }
    const { messages } = sectionsToStreamMessages(sections(model), model, { sendImages, sendTools })

    await sbp('dez.provider/streamChat', { providerId: apiFormat, modelId: 'm', messages, onToken: () => {} })

    const body = streamRequests[0].body as string
    expect(body).not.toContain('assets/images')
    expect(body).not.toContain('/home/u')
    expect(body).toContain('id=a')
    expect(body).toContain('id=b')
    expect(body).toContain('model_list')
    expect(body.includes(Buffer.from(STORED_IMAGE).toString('base64'))).toBe(sendImages)
  })
})

describe('media requests', () => {
  // A media API in the Venice format, and chat fields (`requestBody`,
  // `settings`) that media requests must not take.
  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'media',
      name: 'Media server',
      baseUrl: MEDIA_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      headers: { 'X-Team': 'blue' },
      requestBody: { venice_parameters: { include_venice_system_prompt: false } },
      settings: [{ key: 'webSearch', label: 'Web search', type: 'boolean', default: true, bodyPath: 'venice_parameters.enable_web_search' }],
      mediaApi: { format: 'venice' },
    })
  })

  const generate = (input: Record<string, unknown>) =>
    sbp('dez.provider/generateMedia', { providerId: 'media', modelId: 'm', prompt: 'A red fox', ...input }) as Promise<ProviderGenerateMediaResult>

  it('makes an image through dez.http/stream with the request id and the config headers, and no chat fields', async () => {
    const result = await generate({ kind: 'image', requestId: 'reply-1' })

    expect(result).toStrictEqual({ media: [{ bytes: WEBP_IMAGE, mediaType: 'image/webp' }] })
    expect(streamRequestIds).toEqual(['reply-1'])
    expect(streamRequests).toStrictEqual([{
      method: 'POST',
      url: `${MEDIA_BASE_URL}/image/generate`,
      headers: { 'Content-Type': 'application/json', 'X-Team': 'blue' },
      body: JSON.stringify({ model: 'm', prompt: 'A red fox', format: 'webp', hide_watermark: true, safe_mode: false }),
    }])
    expect(imageReads).toEqual([])
  })

  it('edits stored images of both folders, sent as data URLs, and returns the whole image of a binary answer', async () => {
    const result = await generate({ kind: 'imageEdit', images: [`${APP_DIR}/assets/generated/images/red.png`, `${APP_DIR}/assets/images/red.png`] })

    const dataUrl = `data:image/png;base64,${bytesToBase64(STORED_IMAGE)}`
    expect(result).toStrictEqual({ media: [{ bytes: STORED_IMAGE, mediaType: 'image/png' }] })
    expect(imageReads).toEqual(['assets/generated/images/red.png', 'assets/images/red.png'])
    expect(streamRequests.map((request) => [request.url, JSON.parse(request.body as string)])).toStrictEqual([
      [`${MEDIA_BASE_URL}/image/multi-edit`, { modelId: 'm', prompt: 'A red fox', images: [dataUrl, dataUrl], safe_mode: false }],
    ])
  })

  it('refuses an edit with no image, before any request', async () => {
    await expect(generate({ kind: 'imageEdit' })).rejects.toThrow('No image to edit')
    await expect(generate({ kind: 'imageEdit', images: [] })).rejects.toThrow('No image to edit')

    expect(streamRequests).toEqual([])
  })

  it('reads no file of another Dez folder, and sends nothing', async () => {
    await expect(generate({ kind: 'imageEdit', images: ['/home/other/.config/dez/assets/images/red.png'] })).rejects.toThrow('Image not found: red.png')

    expect(imageReads).toEqual([])
    expect(streamRequests).toEqual([])
  })

  it('names the provider of a refused request, with the start of its answer', async () => {
    sbp('dez.model/customProviders/save', {
      id: 'broken',
      name: 'Broken server',
      baseUrl: FAILING_BASE_URL,
      apiFormat: 'openai',
      models: [],
      fetchModels: true,
      auth: 'apiKey',
      mediaApi: { format: 'venice' },
    })

    await expect(generate({ providerId: 'broken', kind: 'image' })).rejects.toThrow('Broken server returned HTTP 404: Not found')
  })

  it('fails before any request for a provider with no media API', async () => {
    await expect(generate({ providerId: 'local', kind: 'image' })).rejects.toThrow('Local has no media API that Dez can use.')

    expect(streamRequests).toEqual([])
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

describe('model display names', () => {
  beforeEach(() => {
    sbp('dez.model/customProviders/save', {
      id: 'named',
      name: 'Named server',
      baseUrl: 'http://localhost:8081/v1',
      apiFormat: 'openai',
      models: [{ id: 'alpha', name: 'Alpha One' }, { id: 'beta' }],
      fetchModels: true,
      auth: 'apiKey',
    })
    // As if the last fetch ran before the config named `alpha`.
    sbp('dez.model/modelCache/applyProviderResult', 'named', {
      ok: true,
      models: [
        { id: 'alpha', name: 'alpha (served)', provider: 'named' },
        { id: 'beta', name: 'Beta Two', provider: 'named' },
        { id: 'vendor/gamma', name: 'Gamma', provider: 'named' },
      ],
    })
    sbp('dez.model/modelCache/applyProviderResult', 'gone', {
      ok: true,
      models: [{ id: 'delta', name: 'Delta', provider: 'gone' }],
    })
  })

  const names = () => sbp('dez.provider/modelDisplayNames') as ModelDisplayNames

  it('prefer a name set in the provider config over the cached name', () => {
    expect(names().models.get('named/alpha')).toBe('Alpha One')
  })

  it('use the cached name when the config sets none', () => {
    expect(names().models.get('named/beta')).toBe('Beta Two')
    expect(names().models.get('named/vendor/gamma')).toBe('Gamma')
  })

  it('have no entry for a model that is neither configured nor cached', () => {
    expect(names().models.has('named/epsilon')).toBe(false)
  })

  it('name known providers and have no entry for an unknown provider', () => {
    expect(names().providers.get('named')).toBe('Named server')
    expect(names().providers.get('openrouter')).toBe('OpenRouter')
    expect(names().providers.has('gone')).toBe(false)
  })
})
