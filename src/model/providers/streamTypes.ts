import type { MessagePart, ThinkingReplay } from '../chat/types'
import type { ChatMessage, ProviderId } from './types'

// A message as dez.provider/streamChat takes it: an image part holds the
// path of a stored image, and streamChat reads its bytes before it builds
// the request.
export interface ProviderChatInputMessage extends Omit<ChatMessage, 'content'> {
  content: string | MessagePart[]
}

export interface ProviderStreamChatInput {
  providerId: ProviderId
  modelId: string
  messages: ProviderChatInputMessage[]
  requestId?: string
  // The conversation of the request; see ProviderConfig.promptCacheKey.
  conversationId?: string
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
