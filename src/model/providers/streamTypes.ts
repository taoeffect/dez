import type { ChatMessage, ProviderId } from './types'

export interface ProviderStreamChatInput {
  providerId: ProviderId
  modelId: string
  messages: ChatMessage[]
  requestId?: string
  onToken(token: string): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
}
