import type { ChatMessage, ProviderId } from './types'

export interface ProviderStreamChatInput {
  providerId: ProviderId
  modelId: string
  messages: ChatMessage[]
  requestId?: string
  // Sparse user overrides for this provider's settings
  // (ProviderConfig.settings); missing keys fall back to the setting defaults.
  providerSettings?: Record<string, boolean>
  onToken(token: string): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
}
