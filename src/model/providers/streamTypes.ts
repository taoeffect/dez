import type { MessagePart, RequestMessage, ThinkingReplay } from '../chat/types'
import type { StreamedToolCall } from '../tools/types'
import type { ChatRequestContext, GeneratedMedia, MediaKind, ProviderId } from './types'

// A message as dez.provider/streamChat takes it: an image part holds the
// path of a stored image, and streamChat reads its bytes before it builds
// the request.
export type ProviderChatInputMessage = RequestMessage<MessagePart>

// `conversationId`, `system`, `tools`, and `imageOutput` go into the request
// body (ChatRequestContext).
export interface ProviderStreamChatInput extends ChatRequestContext {
  providerId: ProviderId
  modelId: string
  messages: ProviderChatInputMessage[]
  requestId?: string
  // Sparse user overrides for this provider's settings
  // (ProviderConfig.settings) and its Thinking toggle; missing keys fall
  // back to the defaults.
  providerSettings?: Record<string, boolean>
  onToken(token: string): void | Promise<void>
  // Each piece of thinking text, in stream order. Called only when the
  // provider supports thinking and the Thinking toggle is on.
  onThinking(token: string): void | Promise<void>
  // Each image of the reply, as bytes, in stream order with the answer
  // text: the next `onToken` call comes after this one ends. A reply has
  // images only when the request asked for them (`imageOutput`).
  onImage(image: GeneratedMedia): void | Promise<void>
}

export interface ProviderStreamChatResult {
  requestId: string
  // What the next request can send back of this reply's thinking. Absent
  // when there is none, or when the thinking is not complete.
  thinkingReplay?: ThinkingReplay
  // The tool calls of the reply, in stream order (SseStreamEnd.toolCalls).
  // The tool loop runs them whatever the finish reason says: some servers
  // end a reply with tool calls with `stop`.
  toolCalls?: StreamedToolCall[]
}

// The input of dez.provider/generateMedia. `kind` is the model's request
// kind (ModelInfo.request).
export interface ProviderGenerateMediaInput {
  providerId: ProviderId
  modelId: string
  kind: MediaKind
  prompt: string
  // The absolute paths of stored images (`storedImageFile`): the inputs of
  // an `imageEdit` request, the first one the image to edit. A request of
  // another kind does not send them.
  images?: readonly string[]
  // dez.http/cancelStream with this id cancels the request.
  requestId?: string
}

export interface ProviderGenerateMediaResult {
  // The files that the model made, in the provider's order.
  media: GeneratedMedia[]
}
