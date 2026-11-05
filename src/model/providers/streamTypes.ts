import type { ThinkingReplay } from '../chat/types'
import type { ChatMessage, ProviderId } from './types'

export interface ProviderStreamChatInput {
  providerId: ProviderId
  modelId: string
  messages: ChatMessage[]
  requestId?: string
  // Sparse user overrides for this provider's settings
  // (ProviderConfig.settings) and its Thinking toggle; missing keys fall
  // back to the defaults.
  providerSettings?: Record<string, boolean>
  onToken(token: string): void | Promise<void>
  // Each piece of thinking text, in stream order. Called only when the
  // provider supports thinking and the Thinking toggle is on.
  onThinking(token: string): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
  // What the next request can send back of this reply's thinking. Absent
  // when there is none, or when the thinking is not complete.
  thinkingReplay?: ThinkingReplay
}
