import type { ImageMediaType } from '../chat/images'
import type { RequestMessage, ThinkingReplay } from '../chat/types'
import { normalizeOutputs, type ModelOutput } from '../modelOutputs'
import type { StreamedToolCall, ToolDefinition } from '../tools/types'
import type { ApiFormatId, ProviderAuth, ProviderSettingDef } from './config'

// Any id that passes `isValidProviderId()` in `config.ts`: built-in ids plus
// user-defined custom provider ids.
export type ProviderId = string

// How Dez sends a request to a model. `chat`: the API format's chat request.
// `image`, `imageEdit`: the provider's media API makes or edits an image.
// `none`: Dez has no request for the model yet, so a submit is refused.
export const MODEL_REQUESTS = ['chat', 'image', 'imageEdit', 'none'] as const

export type ModelRequest = (typeof MODEL_REQUESTS)[number]

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  // true: the model reads images; false: it does not. Missing: unknown, and
  // the request sends the images.
  imageInput?: boolean
  // true: the model calls tools; false: it does not, and the request sends
  // no tools. Missing: unknown, and the request sends the tools.
  toolCalling?: boolean
  // What the model makes, each type once, in MODEL_OUTPUTS order. Missing:
  // the provider does not tell, and Dez counts it as a text model
  // (`effectiveOutputs` in modelOutputs.ts).
  outputs?: ModelOutput[]
  // How Dez sends the model a request. Missing: `chat`.
  request?: ModelRequest
}

export type ModelCapabilities = Pick<ModelInfo, 'imageInput' | 'toolCalling' | 'outputs' | 'request'>

// Display names for agent role pills and history rows: provider id ->
// provider name, and `modelRefKey` -> model name. Maps, not plain objects,
// because the ids come from files. A missing entry means the name is
// unknown.
export interface ModelDisplayNames {
  providers: Map<ProviderId, string>
  models: Map<string, string>
}

// What views and controllers know about a provider. Plain data, so it can be
// cloned and shown without the Provider class. Views learn about a provider
// (thinking support too) from this or ProviderSettingsDescriptor, never from
// registry imports.
export interface ProviderInfo {
  id: ProviderId
  name: string
  builtIn: boolean
  auth: ProviderAuth
  apiFormat: ApiFormatId
  baseUrl: string
  // A key is stored (for GitHub Copilot: the user is signed in).
  hasKey: boolean
  // The provider can be used: it has a key or does not need one.
  configured: boolean
  // The config has `thinking`, so the provider gets the Thinking toggle.
  supportsThinking: boolean
}

// What the provider settings popup shows for one model: the provider's name,
// its toggles for that model, and whether it adds the Thinking toggle.
export interface ProviderSettingsDescriptor {
  name: string
  settings: ProviderSettingDef[]
  supportsThinking: boolean
}

// Result of a provider model fetch. `ok` is the basis for a provider's
// "working" status: a fetch that fails (expired or invalid key, network)
// yields `ok = false` with no models. A provider that does not fetch models
// yields `ok = true` with its config models.
export interface ProviderModelsResult {
  ok: boolean
  models: ModelInfo[]
  error?: string
}

// One part of a user message, as both wire formats need it: text, or the
// bytes of a stored image in base64 (apiFormats.ts writes the wire block).
export type ChatPart =
  | { type: 'text', text: string }
  | { type: 'image', mediaType: ImageMediaType, data: string }

// A request message as the wire formats take it: an image part holds the
// image bytes.
export type ChatMessage = RequestMessage<ChatPart>

// What a chat request sends besides its messages. Every field is optional:
// a diagnostics probe sends none of them.
export interface ChatRequestContext {
  // The conversation of the request; see ProviderConfig.promptCacheKey.
  conversationId?: string
  // Dez's system prompt (src/model/systemPrompt).
  system?: string
  // The Dez tools that the model may call. None or an empty list sends no
  // `tools` field.
  tools?: readonly ToolDefinition[]
}

// One parsed SSE `data:` payload yields zero or more of these, in either
// API format. `token` is answer text and `thinking` is reasoning text.
export type SseTokenEvent =
  | { kind: 'token', token: string }
  | { kind: 'thinking', token: string }
  | { kind: 'done' }

// Omit from each member of a union, not from the union as a whole.
type OmitEach<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key> : never

// A replay as a stream parser builds it. Only the request knows the
// messages before the reply, so the signed kinds get `prefixHash` later.
export type StreamedThinkingReplay = OmitEach<ThinkingReplay, 'prefixHash'>

export interface SseStreamEnd {
  // Text that the parser held back because it could still be part of an
  // inline `<think>` tag.
  events: SseTokenEvent[]
  // Absent when there was no thinking to send back, or when it is not
  // complete (the stream ended early).
  replay?: StreamedThinkingReplay
  // The tool calls of the reply, in stream order. Absent when there are
  // none, or when the stream was cut off or reported a failure: the
  // arguments of a call could then be cut off too.
  toolCalls?: StreamedToolCall[]
}

// Reads the SSE payloads of one response, in order. Parsers keep state
// between payloads (thinking blocks, a partial tag), so every response
// needs a new one.
export interface SseStreamParser {
  parse(data: string): SseTokenEvent[]
  // Call once, after the last payload.
  finish(): SseStreamEnd
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: ProviderId,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(providerId: ProviderId) {
    super('Provider is not configured', providerId)
    this.name = 'ProviderNotConfiguredError'
  }
}

// Leaves each capability out when it is unknown, so the model cache file and
// whole-object comparisons hold no `undefined` field. `outputs` becomes a new
// array in table order, so two models never share one (a store copy and its
// snapshot, a config model and the cache).
export function providerModel(provider: ProviderId, id: string, name: string, capabilities: ModelCapabilities = {}): ModelInfo {
  const model: ModelInfo = { id, name, provider }
  if (capabilities.imageInput !== undefined) model.imageInput = capabilities.imageInput
  if (capabilities.toolCalling !== undefined) model.toolCalling = capabilities.toolCalling
  if (capabilities.outputs !== undefined) model.outputs = normalizeOutputs(capabilities.outputs)
  if (capabilities.request !== undefined) model.request = capabilities.request
  return model
}
