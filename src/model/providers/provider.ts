import { bytesToBase64 } from '../../utils/base64'
import type { JsonObject } from '../../utils/json'
import type { NativeHttpHeaders, NativeHttpRequest, NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import type { Secret } from '../../utils/secret'
import type { ImageSize } from '../chat/imageDrawing'
import { API_FORMATS, type ApiFormat } from './apiFormats'
import { TooManyImagesError } from './clipImages'
import { FORBIDDEN_BODY_KEYS, type ProviderConfig } from './config'
import { ProviderHttpError } from './errors'
import type { ImageSizeRules, InputImageLimits } from './imageSize'
import { MEDIA_FORMATS, type ClipFormat, type ClipInput, type ClipJob, type ImageFormat, type ImageQuoteFormat, type MediaFormat, type MediaInput, type MediaWireRequest, type TextFormat } from './mediaFormats'
import type { ParameterValues } from './modelParameters'
import { isRecord, modelCapability, modelData, modelOutputsAndRequest, modelReadableName, unsupportedSettings } from './modelParsing'
import { isThinkingEnabled, modelToggles, toggleValue, type ToggleModel } from './modelToggles'
import { multipartBody, type MultipartField } from './multipart'
import { ProviderError, effectiveRequest, isClipKind, isTextKind, providerModel, type ChatMessage, type ChatRequestContext, type ClipKind, type GeneratedMedia, type ImageKind, type MediaKind, type ModelInfo, type ProviderInfo, type TextKind } from './types'

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
  // (Anthropic-style) to the id (servers that report only ids). The readable
  // name, the image, tool, and thinking flags, the toggles that the model
  // does not take, the outputs, and the request kind are read only where the
  // config's `modelReadableName`, `modelImageInput`, `modelToolCalling`,
  // `modelThinking`, `settings[].modelSupport`, and `modelOutputs` point.
  // Models that make nothing stay in this list; `mergeModels` drops them, so
  // the diagnostics report shows what the server sent.
  parseModels(data: unknown): ModelInfo[] {
    const models: ModelInfo[] = []

    for (const model of modelData(data)) {
      const id = entryId(model)
      if (id === null) continue

      const name = [model.name, model.display_name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      models.push(providerModel(this.id, id, name?.trim() ?? id, {
        readableName: modelReadableName(model, this.config.modelReadableName),
        imageInput: modelCapability(model, this.config.modelImageInput, 'image'),
        toolCalling: modelCapability(model, this.config.modelToolCalling, 'tools'),
        thinking: modelCapability(model, this.config.modelThinking, 'reasoning'),
        unsupportedSettings: unsupportedSettings(model, this.config.settings),
        ...modelOutputsAndRequest(model, this.config.modelOutputs),
      }))
    }

    return models
  }

  // Config models come first, in config order, then the fetched models the
  // config does not list. Each id appears once. A name, capability flag,
  // outputs list, or request kind set in the config wins over the fetched
  // one for the same id; the readable name is always the fetched one. A
  // fetched model that is known to make none of the output types
  // (embeddings, rerank) is left out; a config model is always listed.
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
        readableName: fetchedModel?.readableName,
        imageInput: model.imageInput ?? fetchedModel?.imageInput,
        toolCalling: model.toolCalling ?? fetchedModel?.toolCalling,
        thinking: model.thinking ?? fetchedModel?.thinking,
        unsupportedSettings: fetchedModel?.unsupportedSettings,
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

  // The requests for the model lists that only the media API has
  // (`MediaFormat.modelLists`); none when it has none. Each one ends like a
  // model list request (`MODEL_LIST_TIMEOUT_MS`).
  mediaModelListRequests(secret: Secret<string> | null): NativeHttpRequest[] {
    const lists = this.mediaFormatOrNone()?.modelLists?.(this.config.baseUrl) ?? []
    return lists.map((list) => ({ ...this.mediaApiRequest(list, secret), timeoutMs: MODEL_LIST_TIMEOUT_MS }))
  }

  // The raw entries of the responses `lists` to `mediaModelListRequests`
  // (the lists that loaded, in request order), by model id: the first
  // entry of an id.
  mediaModelEntries(lists: readonly unknown[]): Map<string, unknown> {
    const entries = new Map<string, unknown>()
    for (const entry of lists.flatMap((list) => modelData(list))) {
      const id = entryId(entry)
      if (id !== null && !entries.has(id)) entries.set(id, entry)
    }
    return entries
  }

  // `models` (a `mergeModels` list), each model of a media request kind
  // with its parameters (`ImageFormat.parameters`, `ClipFormat.parameters`)
  // and the rules of its input images and clips (`MediaFormat.imageRules`,
  // `MediaFormat.clipRules`), each one of a clip request kind also with the
  // rules of its text (`ClipFormat.textRules`), and each one of an image
  // request kind also with the file type that it makes when Dez cannot
  // store it (`ImageFormat.unstoredOutput`), read from its raw entries
  // (`modelEntries`, `mediaModelEntries`). This comes after the merge,
  // because a config model can set the request kind. A new field here
  // needs a line in `withKeptClipData` (keptClipData.ts), which keeps
  // these fields when a media list does not load.
  withClipData(models: readonly ModelInfo[], entries: ReadonlyMap<string, unknown>, mediaEntries: ReadonlyMap<string, unknown>): ModelInfo[] {
    const format = this.mediaFormatOrNone()
    if (!format) return [...models]
    const { images: imageFormat, clips, imageRules, clipRules } = format
    return models.map((model) => {
      const kind = effectiveRequest(model)
      if (kind === 'chat' || kind === 'none') return model
      const entry = entries.get(model.id)
      const mediaEntry = mediaEntries.get(model.id)
      const images = imageRules?.(kind, entry, mediaEntry)
      const inputClips = clipRules?.(kind, entry, mediaEntry)
      const parameters = (isClipKind(kind) ? clips?.parameters(kind, entry, mediaEntry) : isTextKind(kind) ? [] : imageFormat?.parameters?.(kind, entry, mediaEntry)) ?? []
      const text = isClipKind(kind) ? clips?.textRules?.(kind, entry, mediaEntry) : undefined
      const unstoredOutput = isClipKind(kind) || isTextKind(kind) ? undefined : imageFormat?.unstoredOutput?.(kind, entry, mediaEntry)
      return {
        ...model,
        ...(parameters.length > 0 && { parameters }),
        ...(text && { text }),
        ...(images && { images }),
        ...(inputClips && { clips: inputClips }),
        ...(unstoredOutput !== undefined && { unstoredOutput }),
      }
    })
  }

  // `model`: the model of the request, with what the model cache knows of
  // it; only its id for a model that the cache does not have, and for a
  // diagnostics probe. The toggles that apply to it (`modelToggles`) decide
  // the thinking and settings fields, so the body holds what the provider
  // settings popup shows for the model.
  //
  // `overrides` are the user's stored toggle values for this provider
  // (settings.providerSettings[id]); missing keys use the setting default.
  // The Thinking toggle is one of them (thinking.ts).
  chatRequest(
    messages: ChatMessage[],
    model: ToggleModel,
    secret: Secret<string> | null,
    overrides: Record<string, boolean> = {},
    context: ChatRequestContext = {},
  ): ProviderChatRequest {
    const toggles = modelToggles(this.config, model)
    // A model that is known not to think is like a provider with no
    // `thinking`: neither thinking body goes, and the reply keeps none.
    const thinking = toggles.thinking ? this.config.thinking : undefined
    const thinkingOn = thinking !== undefined && isThinkingEnabled(overrides)
    // Earlier thinking goes back only in a request that asks for thinking.
    const sentMessages = thinkingOn ? messages : messages.map(withoutThinking)
    const { body, prefixHash } = this.format.chatBody(sentMessages, model.id, this.config, context)
    if (this.config.requestBody) mergeBodyPart(body, this.config.requestBody)
    // A fixed part for a model, so the body stays the same in every request
    // of a conversation with that model (the prompt cache).
    if (context.imageOutput && this.config.imageOutputBody) mergeBodyPart(body, this.config.imageOutputBody)

    for (const setting of toggles.settings) {
      const enabled = toggleValue(setting, overrides)
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
  // body or of the form (multipart/form-data, as base64 bytes), or a GET
  // when it has neither. It takes the headers of a chat request, but no
  // `requestBody`, settings, or thinking body: those are chat fields.
  mediaApiRequest({ url, body, form }: MediaWireRequest, secret: Secret<string> | null): NativeHttpRequest {
    if (form !== undefined) {
      const multipart = multipartBody(form)
      return { method: 'POST', url, headers: this.requestHeaders(secret, { 'Content-Type': multipart.contentType }), body: { base64: bytesToBase64(multipart.body) } }
    }
    if (body === undefined) return { method: 'GET', url, headers: this.requestHeaders(secret, {}) }
    return {
      method: 'POST',
      url,
      headers: this.requestHeaders(secret, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }
  }

  // The request for a model of an image request kind.
  imageRequest(kind: ImageKind, modelId: string, input: MediaInput, secret: Secret<string> | null): NativeHttpRequest {
    return this.mediaApiRequest(this.withModelBody(kind, modelId, this.imageFormat().request(kind, this.config.baseUrl, modelId, input)), secret)
  }

  // The images of a 2xx response to `imageRequest`.
  imageResult(kind: ImageKind, head: NativeHttpResponseHead, body: Uint8Array): GeneratedMedia[] {
    return this.imageFormat().parseResponse(kind, head, body)
  }

  // The request for a model of a text request kind (a transcription).
  textRequest(kind: TextKind, modelId: string, input: MediaInput, secret: Secret<string> | null): NativeHttpRequest {
    return this.mediaApiRequest(this.withModelBody(kind, modelId, this.textFormat().request(kind, this.config.baseUrl, modelId, input)), secret)
  }

  // The text of the body of a 2xx response to `textRequest`.
  textResult(kind: TextKind, body: Uint8Array): string {
    return this.textFormat().parseResponse(kind, body)
  }

  // The size rules (imageSize.ts) of each input image of a request of
  // `kind`: for a video, the rules of the model (`model`: what the model
  // cache knows of it, or null); for an edit or an upscale, the rules of
  // the media API's request (`ImageFormat.inputImageSize`). Undefined when
  // the provider tells none.
  inputImageSize(kind: MediaKind, model: Pick<ModelInfo, 'images'> | null): ImageSizeRules | undefined {
    if (isClipKind(kind) || isTextKind(kind)) return model?.images?.size
    return this.mediaFormatOrNone()?.images?.inputImageSize?.[kind]
  }

  // The limits of each input image of a request of `kind` that no fit can
  // meet (`ImageFormat.inputImageLimits`); undefined when the provider
  // tells none.
  inputImageLimits(kind: MediaKind): InputImageLimits | undefined {
    if (isClipKind(kind) || isTextKind(kind)) return undefined
    return this.mediaFormatOrNone()?.images?.inputImageLimits?.[kind]
  }

  // Why the media API refuses an input image of a request of `kind` that
  // has the size `size` (null when not known) and a file of `byteLength`
  // bytes (`ImageFormat.inputImageProblem`); undefined when it takes it, as
  // far as Dez knows.
  inputImageProblem(kind: MediaKind, size: ImageSize | null, byteLength: number): string | undefined {
    if (isClipKind(kind) || isTextKind(kind)) return undefined
    return this.mediaFormatOrNone()?.images?.inputImageProblem?.(kind, size, byteLength)
  }

  // The parts of a clip request kind (`ClipFormat` in mediaFormats.ts), for
  // this provider's base URL. The selectors of the provider send their
  // requests through `mediaApiRequest`.

  clipRequest(kind: ClipKind, modelId: string, input: ClipInput): MediaWireRequest {
    return this.withModelBody(kind, modelId, this.clipFormat().request(kind, this.config.baseUrl, modelId, input))
  }

  // The size of a sample of the raw PCM audio that the media API can
  // answer with (`ClipFormat.pcmSampleBits`).
  pcmSampleBits(): number | undefined {
    return this.mediaFormatOrNone()?.clips?.pcmSampleBits
  }

  clipJob(kind: ClipKind, modelId: string, data: unknown): ClipJob {
    return this.clipFormat().job(kind, this.config.baseUrl, modelId, data)
  }

  // The refusal `error` of a first clip request with `imageCount` input
  // images, as the error that tells that the model takes fewer images
  // (`ClipFormat.refusedImages`). Null for any other error.
  imageCountRefusal(kind: ClipKind, error: unknown, imageCount: number): TooManyImagesError | null {
    if (!(error instanceof ProviderHttpError)) return null
    const maxImages = this.mediaFormatOrNone()?.clips?.refusedImages?.(kind, error.status, error.bodyJson)
    return maxImages !== undefined && maxImages < imageCount ? new TooManyImagesError(maxImages, imageCount, { cause: error }) : null
  }

  // `wire` (a first clip request) with the body fields that its refusal
  // `error` tells (`ClipFormat.refusalBody`), to send once more. Null when
  // the refusal tells none, or none that the body lacks.
  clipRequestAfterRefusal(kind: ClipKind, wire: MediaWireRequest, error: unknown): MediaWireRequest | null {
    if (!(error instanceof ProviderHttpError) || wire.body === undefined) return null
    const fields = this.mediaFormatOrNone()?.clips?.refusalBody?.(kind, error.status, error.bodyJson)
    if (!fields || Object.entries(fields).every(([name, value]) => wire.body?.[name] === value)) return null
    return { ...wire, body: { ...wire.body, ...fields } }
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
    const quote = this.mediaFormatOrNone()?.clips?.quote
    const wire = quote?.request(kind, this.config.baseUrl, modelId, values, entry)
    return quote && wire ? { request: { ...this.mediaApiRequest(wire, secret), timeoutMs: MODEL_LIST_TIMEOUT_MS }, usd: quote.usd } : null
  }

  // How to tell the price of one image request of `kind`
  // (`ImageQuoteFormat`): the request for the model's price records (it
  // ends like a model list request), null when the entries hold the
  // prices; and the reader of the price. Null when the provider tells no
  // price of an image request.
  imageQuote(
    kind: ImageKind,
    modelId: string,
    secret: Secret<string> | null,
  ): { request: NativeHttpRequest | null, usd: ImageQuoteFormat['usd'] } | null {
    const quote = this.mediaFormatOrNone()?.images?.quote
    if (!quote) return null
    const wire = quote.recordsRequest?.(kind, this.config.baseUrl, modelId) ?? null
    return { request: wire && { ...this.mediaApiRequest(wire, secret), timeoutMs: MODEL_LIST_TIMEOUT_MS }, usd: quote.usd }
  }

  // `wire`, the request of a media format for an image or a clip of `kind`,
  // with the fixed body parts that the config has for the model
  // (`mediaApi.modelRequestBodies`).
  private withModelBody(kind: MediaKind, modelId: string, wire: MediaWireRequest): MediaWireRequest {
    const parts = (this.config.mediaApi?.modelRequestBodies ?? [])
      .filter((part) => part.request === kind && modelId.startsWith(part.modelIdPrefix))
    if (parts.length === 0) return wire
    if (wire.form !== undefined) return { ...wire, form: withFormParts(wire.form, parts.map((part) => part.body)) }
    if (wire.body === undefined) return wire
    const body = { ...wire.body }
    for (const part of parts) mergeBodyPart(body, part.body)
    return { ...wire, body }
  }

  // A config can give a model a media request kind (`models[].request`)
  // without a `mediaApi`, or with one that does not serve the kind; its
  // requests then fail with one of these errors. The fix of the config is
  // the `mediaApi` row of the README.
  private mediaFormat(): MediaFormat {
    const format = this.mediaFormatOrNone()
    if (!format) throw new ProviderError(`${this.name} has no media API that Dez can use. Choose another model.`, this.id)
    return format
  }

  private imageFormat(): ImageFormat {
    const { images } = this.mediaFormat()
    if (!images) throw new ProviderError(`${this.name} has no image API that Dez can use. Choose another model.`, this.id)
    return images
  }

  private clipFormat(): ClipFormat {
    const { clips } = this.mediaFormat()
    if (!clips) throw new ProviderError(`${this.name} has no audio or video API that Dez can use. Choose another model.`, this.id)
    return clips
  }

  private textFormat(): TextFormat {
    const { texts } = this.mediaFormat()
    if (!texts) throw new ProviderError(`${this.name} has no transcription API that Dez can use. Choose another model.`, this.id)
    return texts
  }

  // The provider's media format; undefined when it has no `mediaApi`. For
  // the parts of a media format that a provider can be without.
  private mediaFormatOrNone(): MediaFormat | undefined {
    const mediaApi = this.config.mediaApi
    return mediaApi ? MEDIA_FORMATS[mediaApi.format] : undefined
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

// A form (`multipart/form-data`) with the config body parts of its request.
// A form has only text and file fields, so only the top-level text, number,
// and `true` values of a part go, as text fields; an object or an array does
// not. A value replaces a text field of the same name, and `false` or `null`
// leaves the field out, as a form sends a switch that is off as no field.
// File fields stay, and new fields go before the first one, as the media
// formats put their text fields first.
function withFormParts(form: readonly MultipartField[], parts: readonly JsonObject[]): MultipartField[] {
  const values = new Map<string, string | null>()
  for (const part of parts) {
    for (const [name, value] of Object.entries(part)) {
      if (value === false || value === null) values.set(name, null)
      else if (typeof value !== 'object') values.set(name, String(value))
    }
  }
  const kept = form.filter((field) => 'file' in field || !values.has(field.name))
  const added = [...values].flatMap(([name, value]) => (value === null ? [] : [{ name, value }]))
  const firstFile = kept.findIndex((field) => 'file' in field)
  const at = firstFile === -1 ? kept.length : firstFile
  return [...kept.slice(0, at), ...added, ...kept.slice(at)]
}

// Adds query parameters to a model-list URL, after the format's own query if
// it has one (the Anthropic `?limit=1000`). No parameters: the URL as it is.
function withQuery(url: string, query: Record<string, string> | undefined): string {
  const search = new URLSearchParams(query).toString()
  if (!search) return url
  return `${url}${url.includes('?') ? '&' : '?'}${search}`
}
