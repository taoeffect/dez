import type { ActiveModel, MessagePart, RequestMessage } from '../chat/types'

export type StreamStatus = 'idle' | 'streaming' | 'finished' | 'error' | 'cancelled'

export type StreamEndStatus = Exclude<StreamStatus, 'idle' | 'streaming'>

// A request message before `dez.provider/streamChat` reads its image bytes
// (sectionsToStreamMessages).
export type StreamMessage = RequestMessage<MessagePart>

export interface RequestMessages {
  messages: StreamMessage[]
  // The image references of user sections that went as text only, because
  // the request model does not read images.
  imagesLeftOut: number
  // The request offers the Dez tools: the provider's Tools toggle is on, and
  // the model cache does not know the model as one that cannot call tools.
  sendTools: boolean
}

export interface StreamStartInput {
  tabId: string
  sectionId: string
  model: ActiveModel
  messages: StreamMessage[]
}

export interface StreamSessionState {
  tabId: string
  sectionId: string
  status: StreamStatus
  model: ActiveModel
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  tokenCount: number
}

/** A session after its stream ended (finished, failed, or stopped). */
export interface EndedStreamSession extends StreamSessionState {
  status: StreamEndStatus
  finishedAt: number
}

export interface StreamTerminalInput {
  tabId: string
  status: StreamEndStatus
}
