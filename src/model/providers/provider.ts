import type { JsonObject } from '../../utils/json'
import type { NativeHttpHeaders, NativeHttpRequest, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import type { Secret } from '../../utils/secret'
import { API_FORMATS, type ApiFormat } from './apiFormats'
import { FORBIDDEN_BODY_KEYS, type ProviderConfig, type ProviderSettingDef } from './config'
import { MEDIA_FORMATS, type ClipFormat, type ClipInput, type ClipJob, type ImageFormat, type MediaFormat, type MediaInput, type MediaWireRequest } from './mediaFormats'
import type { ParameterValues } from './modelParameters'
import { isRecord, modelCapability, modelData, modelOutputsAndRequest } from './modelParsing'
import { isThinkingEnabled } from './thinking'
import { ProviderError, effectiveRequest, isClipKind, providerModel, type ChatMessage, type ChatRequestContext, type ClipKind, type GeneratedMedia, type ImageKind, type ModelInfo, type ProviderInfo } from './types'

export interface ProviderOptions {
  builtIn: boolean
}

export interface ProviderChatRequest {
  request: NativeHttpRequest
  // Set only when the request asks for thinking: then the reply's thinking
  // is shown and kept. `prefixHash` (thinking.ts) goes into a signed replay
  // that the reply makes.
  thinking?: { prefixHash: string }
}

// A server that accepts the connection but never answers (a stuck local
// server, a dead SSH tunnel) would otherwise keep the provider "Checking…"
// and hold the shared model-cache refresh forever.
const MODEL_LIST_TIMEOUT_MS = 20_000

// One LLM provider, defined entirely by its ProviderConfig. Built-in and
// custom providers are the same class; `builtIn` only decides whether a key
// is required and (in the UI) whether the provider can be deleted.
export class Provider {
  readonly id: string
  readonly name: string
  readonly builtIn: boolean
  readonly format: ApiFormat

  constructor(readonly config: ProviderConfig, options: ProviderOptions) {
    this.id = config.id
    this.name = config.name
    this.builtIn = options.builtIn
    this.format = API_FORMATS[config.apiFormat]
  }

  // Custom providers often point at local servers that take no key; every
  // built-in (GitHub Copilot included) needs one.
  get requiresKey(): boolean {
    return this.builtIn
  }

  // An empty `thinking` object counts: it asks for the format's default
  // request.
  get supportsThinking(): boolean {
    return this.config.thinking !== undefined
  }

  // `keyIds`: the providers with a stored key, as dez.native/getConfiguredProviderIds
  // reports them (GitHub Copilot counts when the user is signed in).
  info(keyIds: ReadonlySet<string>): ProviderInfo {
    const hasKey = keyIds.has(this.id)

    return {
      id: this.id,
      name: this.name,
      builtIn: this.builtIn,
      auth: this.config.auth,
      apiFormat: this.config.apiFormat,
      baseUrl: this.config.baseUrl,
      hasKey,
      configured: hasKey || !this.requiresKey,
      supportsThinking: this.supportsThinking,
    }
  }

  modelListRequest(secret: Secret<string> | null): NativeHttpRequest | null {
    if (!this.config.fetchModels) return null

    return {
      method: 'GET',
      url: withQuery(this.format.modelsUrl(this.config.baseUrl), this.config.modelListQuery),
      headers: this.requestHeaders(secret, {}),
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
    }
  }

  // Reads the `{ data: [...] }` model list both formats return. The name
  // falls back from `name` (OpenAI-style servers) to `display_name`
  // (Anthropic-style) to the id (servers that report only ids). The image
  // and tool flags, the outputs, and the request kind are read only where
  // the config's `modelImageInput`, `modelToolCalling`, and `modelOutputs`
  // point. Models that make nothing stay in this list; `mergeModels` drops
  // them, so the diagnostics report shows what the server sent.
  parseModels(data: unknown): ModelInfo[] {
    const models: ModelInfo[] = []

    for (const model of modelData(data)) {
      const id = entryId(model)
      if (id === null) continue

      const name = [model.name, model.display_name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      models.push(providerModel(this.id, id, name?.trim() ?? id, {
        imageInput: modelCapability(model, this.config.modelImageInput, 'image'),
        toolCalling: modelCapability(model, this.config.modelToolCalling, 'tools'),
        ...modelOutputsAndRequest(model, this.config.modelOutputs),
      }))
    }

    return models
  }

  // Config models come first, in config order, then the fetched models the
  // config does not list. Each id appears once. A name, capability flag,
  // outputs list, or request kind set in the config wins over the fetched one
  // for the same id. A fetched model that is known to make none of the output
  // types (embeddings, rerank) is left out; a config model is always listed.
  mergeModels(fetched: ModelInfo[]): ModelInfo[] {
    const fetchedById = new Map<string, ModelInfo>()
    for (const model of fetched) {
      if (!fetchedById.has(model.id)) fetchedById.set(model.id, model)
    }

    const merged = new Map<string, ModelInfo>()
    for (const model of this.config.models) {
      if (merged.has(model.id)) continue

      const fetchedModel = fetchedById.get(model.id)
      const name = model.name ?? fetchedModel?.name ?? model.id
      merged.set(model.id, providerModel(this.id, model.id, name, {
        imageInput: model.imageInput ?? fetchedModel?.imageInput,
        toolCalling: model.toolCalling ?? fetchedModel?.toolCalling,
        outputs: model.outputs ?? fetchedModel?.outputs,
        request: model.request ?? fetchedModel?.request,
      }))
    }

    for (const [id, model] of fetchedById) {
      if (!merged.has(id) && model.outputs?.length !== 0) merged.set(id, providerModel(this.id, id, model.name, model))
    }

    return [...merged.values()]
  }

  configModels(): ModelInfo[] {
    return this.mergeModels([])
  }

  // The raw entry of each model of `models` (a `mergeModels` list), by model
  // id, for the `model_info` tool: the first entry of its id in the
  // `/models` response `data` (the one that `parseModels` and `mergeModels`
  // read), else the model's config entry (a model that only the config
  // lists, also when there is no response).
  modelEntries(models: readonly ModelInfo[], data?: unknown): Map<string, unknown> {
    const fetched = new Map<string, Record<string, unknown>>()
    for (const entry of modelData(data)) {
      const id = entryId(entry)
      if (id !== null && !fetched.has(id)) fetched.set(id, entry)
    }

    const entries = new Map<string, unknown>()
    for (const model of models) {
      const entry = fetched.get(model.id) ?? this.config.models.find((configModel) => configModel.id === model.id)
      if (entry !== undefined) entries.set(model.id, entry)
    }
    return entries
  }

  // The request for the model list that only the media API has
  // (`ClipFormat.modelList`), or null when it has none. It ends like a
  // model list request (`MODEL_LIST_TIMEOUT_MS`).
  mediaModelListRequest(secret: Secret<string> | null): NativeHttpRequest | null {
    const list = this.clipFormatOrNone()?.modelList?.(this.config.baseUrl)
    return list ? { ...this.mediaApiRequest(list, secret), timeoutMs: MODEL_LIST_TIMEOUT_MS } : null
  }

  // The raw entries of the response `data` to `mediaModelListRequest`, by
  // model id (the first entry of an id).
  mediaModelEntries(data: unknown): Map<string, unknown> {
    const entries = new Map<string, unknown>()
    for (const entry of modelData(data)) {
      const id = entryId(entry)
      if (id !== null && !entries.has(id)) entries.set(id, entry)
    }
    return entries
  }

  // `models` (a `mergeModels` list), each model of a clip request kind with
  // its parameters (`ClipFormat.parameters`), read from its raw entries
  // (`modelEntries`, `mediaModelEntries`). This comes after the merge,
  // because a config model can set the request kind.
  withParameters(models: readonly ModelInfo[], entries: ReadonlyMap<string, unknown>, mediaEntries: ReadonlyMap<string, unknown>): ModelInfo[] {
    const clips = this.clipFormatOrNone()
    return models.map((model) => {
      const kind = effectiveRequest(model)
      if (!clips || !isClipKind(kind)) return model
      const parameters = clips.parameters(kind, entries.get(model.id), mediaEntries.get(model.id))
      return parameters.length > 0 ? { ...model, parameters } : model
    })
  }

  // `overrides` are the user's stored toggle values for this provider
  // (settings.providerSettings[id]); missing keys use the setting default.
  // The Thinking toggle is one of them (thinking.ts).
  chatRequest(
    messages: ChatMessage[],
    modelId: string,
    secret: Secret<string> | null,
    overrides: Record<string, boolean> = {},
    context: ChatRequestContext = {},
  ): ProviderChatRequest {
    const thinking = this.config.thinking
    const thinkingOn = thinking !== undefined && isThinkingEnabled(overrides)
    // Earlier thinking goes back only in a request that asks for thinking.
    const sentMessages = thinkingOn ? messages : messages.map(withoutThinking)
    const { body, prefixHash } = this.format.chatBody(sentMessages, modelId, this.config, context)
    if (this.config.requestBody) mergeBodyPart(body, this.config.requestBody)
    // A fixed part for a model, so the body stays the same in every request
    // of a conversation with that model (the prompt cache).
    if (context.imageOutput && this.config.imageOutputBody) mergeBodyPart(body, this.config.imageOutputBody)

    // Every setting is written, also the ones hidden for this model, so the
    // body does not depend on which toggles the popup shows.
    for (const setting of this.config.settings ?? []) {
      const override = overrides[setting.key]
      const enabled = typeof override === 'boolean' ? override : setting.default
      writeBodyPath(body, setting.bodyPath, enabled ? (setting.onValue ?? true) : (setting.offValue ?? false))
    }

    // After the settings, so a thinking body can add to an object that a
    // setting made, such as Venice's `venice_parameters`.
    const thinkingBody = thinkingOn ? (thinking.enabledBody ?? this.format.thinkingBody) : thinking?.disabledBody
    if (thinkingBody) mergeBodyPart(body, thinkingBody)

    // Some providers need a header to accept images (GitHub Copilot).
    const hasImages = messages.some((message) =>
      message.role === 'user' && typeof message.content !== 'string' && message.content.some((part) => part.type === 'image'))

    return {
      request: {
        method: 'POST',
        url: this.format.chatUrl(this.config.baseUrl),
        headers: this.requestHeaders(secret, { 'Content-Type': 'application/json' }, hasImages ? this.config.imageRequestHeaders : undefined),
        body: JSON.stringify(body),
      },
      ...(thinkingOn && { thinking: { prefixHash } }),
    }
  }

  // A request to the provider's media API (`mediaApi`): a POST of the JSON
  // body, or a GET when it has none. It takes the headers of a chat
  // request, but no `requestBody`, settings, or thinking body: those are
  // chat fields.
  mediaApiRequest({ url, body }: MediaWireRequest, secret: Secret<string> | null): NativeHttpRequest {
    if (body === undefined) return { method: 'GET', url, headers: this.requestHeaders(secret, {}) }
    return {
      method: 'POST',
      url,
      headers: this.requestHeaders(secret, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }
  }

  // The request for a model of an image request kind.
  mediaRequest(kind: ImageKind, modelId: string, input: MediaInput, secret: Secret<string> | null): NativeHttpRequest {
    return this.mediaApiRequest(this.imageFormat().request(kind, this.config.baseUrl, modelId, input), secret)
  }

  // The images of a 2xx response to `mediaRequest`.
  mediaResult(kind: ImageKind, head: NativeHttpResponseHead, body: Uint8Array): GeneratedMedia[] {
    return this.imageFormat().parseResponse(kind, head, body)
  }

  // The parts of a clip request kind (`ClipFormat` in mediaFormats.ts), for
  // this provider's base URL. The selectors of the provider send their
  // requests through `mediaApiRequest`.

  clipRequest(kind: ClipKind, modelId: string, input: ClipInput): MediaWireRequest {
    return this.clipFormat().request(kind, this.config.baseUrl, modelId, input)
  }

  clipJob(kind: ClipKind, modelId: string, data: unknown): ClipJob {
    return this.clipFormat().job(kind, this.config.baseUrl, modelId, data)
  }

  // How to ask the provider for the price of the clip that `clipRequest`
  // with the same values asks for (`ClipQuoteFormat`): the request (it ends
  // like a model list request, `MODEL_LIST_TIMEOUT_MS`), and the reader of
  // the JSON of its 2xx response, which gives the price in USD. Null when
  // the provider tells no price this way. `entry`: the model's raw entry
  // (`modelEntries`).
  clipQuote(
    kind: ClipKind,
    modelId: string,
    values: ParameterValues,
    entry: unknown,
    secret: Secret<string> | null,
  ): { request: NativeHttpRequest, usd(data: unknown): number } | null {
    const quote = this.clipFormatOrNone()?.quote
    const wire = quote?.request(kind, this.config.baseUrl, modelId, values, entry)
    return quote && wire ? { request: { ...this.mediaApiRequest(wire, secret), timeoutMs: MODEL_LIST_TIMEOUT_MS }, usd: quote.usd } : null
  }

  visibleSettings(modelId: string): ProviderSettingDef[] {
    return (this.config.settings ?? []).filter((setting) =>
      setting.modelIdPrefix === undefined || modelId.startsWith(setting.modelIdPrefix))
  }

  // A config can give a model a media request kind (`models[].request`)
  // without a `mediaApi`, or with one that does not serve the kind; its
  // requests then fail with one of these errors.
  private mediaFormat(): MediaFormat {
    const mediaApi = this.config.mediaApi
    if (!mediaApi) throw new ProviderError(`${this.name} has no media API that Dez can use.`, this.id)
    return MEDIA_FORMATS[mediaApi.format]
  }

  private imageFormat(): ImageFormat {
    const { images } = this.mediaFormat()
    if (!images) throw new ProviderError(`${this.name} has no image API that Dez can use.`, this.id)
    return images
  }

  private clipFormat(): ClipFormat {
    const { clips } = this.mediaFormat()
    if (!clips) throw new ProviderError(`${this.name} has no audio or video API that Dez can use.`, this.id)
    return clips
  }

  // For the parts of a clip format that a provider can be without.
  private clipFormatOrNone(): ClipFormat | undefined {
    const mediaApi = this.config.mediaApi
    return mediaApi ? MEDIA_FORMATS[mediaApi.format].clips : undefined
  }

  // The native bridge appends every header entry and header names are
  // case-insensitive, so the layers merge by lower-cased name to never send
  // a name twice. Later layers win: request defaults, the format's fixed
  // headers, the config's static headers, the config's image headers (only
  // on a chat request with an image), then the stored key, so a static
  // header never replaces a key the user saved.
  private requestHeaders(
    secret: Secret<string> | null,
    requestDefaults: NativeHttpHeaders,
    imageHeaders: NativeHttpHeaders = {},
  ): NativeHttpHeaders {
    const layers = [
      requestDefaults,
      this.format.headers,
      this.config.headers ?? {},
      imageHeaders,
      secret ? this.format.authHeaders(secret) : {},
    ]
    const merged = new Map<string, [string, string]>()

    for (const layer of layers) {
      for (const [name, value] of Object.entries(layer)) {
        merged.set(name.toLowerCase(), [name, value])
      }
    }

    return Object.fromEntries(merged.values())
  }
}

// The model id of a `/models` entry; null when it has none, and the entry
// is not a model. `parseModels` and `modelEntries` must agree on it, so that
// every listed model has its entry.
function entryId(entry: Record<string, unknown>): string | null {
  return typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null
}

// The message without its thinking; its text and tool calls stay.
function withoutThinking(message: ChatMessage): ChatMessage {
  if (message.role !== 'agent' || !message.thinking) return message
  const { thinking: _dropped, ...rest } = message
  return rest
}

// Writes `value` at a dot path such as 'venice_parameters.enable_web_search',
// creating nested objects on the way. Only own properties count as existing,
// so a segment can never walk into an inherited object such as
// Object.prototype.
function writeBodyPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let target = body

  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(target, segment) ? target[segment] : undefined
    if (isRecord(existing)) {
      target = existing
    } else {
      const created: Record<string, unknown> = {}
      target[segment] = created
      target = created
    }
  }

  target[segments[segments.length - 1]] = value
}

// Deep-merges a config body part into the chat body: plain objects merge key
// by key, and other values (scalars, arrays) replace. Nested objects of the
// part are merged into new objects of the body, never put into it, so a
// later write cannot change the config. Arrays are put in as they are, as
// nothing writes into them before the body is serialized.
function mergeBodyPart(target: Record<string, unknown>, part: JsonObject): void {
  for (const [key, value] of Object.entries(part)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) continue

    if (isRecord(value)) {
      const existing = Object.hasOwn(target, key) ? target[key] : undefined
      const nested = isRecord(existing) ? existing : {}
      target[key] = nested
      mergeBodyPart(nested, value as JsonObject)
    } else {
      target[key] = value
    }
  }
}

// Adds query parameters to a model-list URL, after the format's own query if
// it has one (the Anthropic `?limit=1000`). No parameters: the URL as it is.
function withQuery(url: string, query: Record<string, string> | undefined): string {
  const search = new URLSearchParams(query).toString()
  if (!search) return url
  return `${url}${url.includes('?') ? '&' : '?'}${search}`
}
