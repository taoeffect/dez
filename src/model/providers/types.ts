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

export interface ChatMessage {
  role: Role
  content: string
}

export interface ProviderSpec {
  id: ProviderId
  name: string
  modelsUrl: string
  chatUrl: string
  fallbackModels?: ModelInfo[]
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
