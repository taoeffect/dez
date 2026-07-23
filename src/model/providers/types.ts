import type { Secret } from '../../utils/secret'
import type { Role } from '../chat/types'

export interface HttpFetchOptions extends RequestInit {
  providerId?: string
}

export type ProviderId =
  | 'openrouter'
  | 'zai'
  | 'venice'
  | 'charm_hyper'
  | 'minimax'
  | 'copilot'

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  configured: boolean
}

// Result of an explicit provider model fetch that surfaces success/failure
// instead of masking errors with fallbackModels. `ok` is the basis for a
// provider's "working" status: a configured provider whose fetch fails
// (expired/invalid key, network) yields `ok = false`. A provider that needs no
// network (buildModelListRequest returns null) yields `ok = true` with its
// fallback models.
export interface ProviderModelsResult {
  ok: boolean
  models: ModelInfo[]
  error?: string
}

export interface ChatMessage {
  role: Role
  content: string
}

// One user-adjustable provider setting rendered by the provider-settings
// popup. `key` addresses the value inside the provider's stored settings
// record; only booleans exist today but `type` leaves room for future kinds.
export interface ProviderSettingDef {
  key: string
  label: string
  type: 'boolean'
  default: boolean
  // Optional per-model visibility gate: the popup hides the setting row when
  // this returns false for the active model id. Absent = always visible.
  // Never serialized — only value overrides are persisted, keyed by `key`.
  visibleForModel?: (modelId: string) => boolean
}

export interface ProviderSpec {
  id: ProviderId
  name: string
  modelsUrl: string
  chatUrl: string
  fallbackModels?: ModelInfo[]
  // Declarative per-provider settings; providers without settings leave this
  // undefined, which drives the popup's "No Settings for X" empty state.
  settings?: ProviderSettingDef[]
  buildModelListRequest(secret: Secret<string> | null): HttpFetchOptions | null
  parseModels(data: unknown): ModelInfo[]
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

export function providerModel(provider: ProviderId, id: string, name: string): ModelInfo {
  return { id, name, provider }
}

export function isProviderId(value: string): value is ProviderId {
  return ['openrouter', 'zai', 'venice', 'charm_hyper', 'minimax', 'copilot'].includes(value)
}
