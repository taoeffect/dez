import type { ActiveModel, MessagePart, Role, SectionThinking } from '../chat/types'

export type StreamStatus = 'idle' | 'streaming' | 'finished' | 'error' | 'cancelled'

export type StreamEndStatus = Exclude<StreamStatus, 'idle' | 'streaming'>

export interface StreamMessage {
  role: Role
  // Parts only for a user message with image references
  // (sectionsToStreamMessages); a string otherwise.
  content: string | MessagePart[]
  // Set only on an agent message whose thinking can go back to the request
  // model (sectionsToStreamMessages).
  thinking?: SectionThinking
}

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
