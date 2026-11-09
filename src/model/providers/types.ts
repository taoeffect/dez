import type { ImageMediaType } from '../chat/images'
import type { Role, SectionThinking, ThinkingReplay } from '../chat/types'
import type { ToolDefinition } from '../tools/types'
import type { ApiFormatId, ProviderAuth, ProviderSettingDef } from './config'

// Any id that passes `isValidProviderId()` in `config.ts`: built-in ids plus
// user-defined custom provider ids.
export type ProviderId = string

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  // true: the model reads images; false: it does not. Missing: unknown, and
  // the request sends the images.
  imageInput?: boolean
}

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

export interface ChatMessage {
  role: Role
  // Parts only for a user message with images: both formats take images
  // only from the user. An agent message is always a string.
  content: string | ChatPart[]
  // The earlier thinking of an agent message, for a request to the model
  // that wrote it. The request sends it back only in the shape of its
  // replay, and only when the provider asks for thinking.
  thinking?: SectionThinking
}

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

// Leaves `imageInput` out when it is unknown, so the model cache file and
// whole-object comparisons hold no `undefined` field.
export function providerModel(provider: ProviderId, id: string, name: string, imageInput?: boolean): ModelInfo {
  return imageInput === undefined ? { id, name, provider } : { id, name, provider, imageInput }
}
