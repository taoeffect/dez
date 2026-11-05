import type { Role } from '../chat/types'
import type { ApiFormatId, ProviderAuth } from './config'

// Any id that passes `isValidProviderId()` in `config.ts`: built-in ids plus
// user-defined custom provider ids.
export type ProviderId = string

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
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
// cloned and shown without the Provider class.
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

export interface ChatMessage {
  role: Role
  content: string
}

// One parsed SSE `data:` payload yields zero or more of these, in either
// API format.
export type SseTokenEvent =
  | { kind: 'token', token: string }
  | { kind: 'done' }

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

export function providerModel(provider: ProviderId, id: string, name: string): ModelInfo {
  return { id, name, provider }
}
