import type { JsonObject } from '../../utils/json'
import type { NativeHttpHeaders, NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import type { Secret } from '../../utils/secret'
import { API_FORMATS, type ApiFormat } from './apiFormats'
import { FORBIDDEN_BODY_KEYS, type ProviderConfig, type ProviderSettingDef } from './config'
import { isRecord, modelCapability, modelData } from './modelParsing'
import { isThinkingEnabled } from './thinking'
import { providerModel, type ChatMessage, type ChatRequestContext, type ModelInfo, type ProviderInfo } from './types'

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
      url: this.format.modelsUrl(this.config.baseUrl),
      headers: this.requestHeaders(secret, {}),
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
    }
  }

  // Reads the `{ data: [...] }` model list both formats return. The name
  // falls back from `name` (OpenAI-style servers) to `display_name`
  // (Anthropic-style) to the id (servers that report only ids). The image
  // and tool flags are read only where the config's `modelImageInput` and
  // `modelToolCalling` point.
  parseModels(data: unknown): ModelInfo[] {
    const models: ModelInfo[] = []

    for (const model of modelData(data)) {
      if (typeof model.id !== 'string' || model.id.length === 0) continue

      const name = [model.name, model.display_name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      models.push(providerModel(this.id, model.id, name?.trim() ?? model.id, {
        imageInput: modelCapability(model, this.config.modelImageInput, 'image'),
        toolCalling: modelCapability(model, this.config.modelToolCalling, 'tools'),
      }))
    }

    return models
  }

  // Config models come first, in config order, then the fetched models the
  // config does not list. Each id appears once. A name, capability flag,
  // outputs list, or request kind set in the config wins over the fetched one
  // for the same id.
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
      if (!merged.has(id)) merged.set(id, providerModel(this.id, id, model.name, model))
    }

    return [...merged.values()]
  }

  configModels(): ModelInfo[] {
    return this.mergeModels([])
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

  visibleSettings(modelId: string): ProviderSettingDef[] {
    return (this.config.settings ?? []).filter((setting) =>
      setting.modelIdPrefix === undefined || modelId.startsWith(setting.modelIdPrefix))
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
