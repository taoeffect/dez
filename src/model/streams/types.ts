import type { ActiveModel, Role, SectionThinking } from '../chat/types'

export type StreamStatus = 'idle' | 'streaming' | 'finished' | 'error' | 'cancelled'

export type StreamEndStatus = Exclude<StreamStatus, 'idle' | 'streaming'>

export interface StreamMessage {
  role: Role
  content: string
  // Set only on an agent message whose thinking can go back to the request
  // model (sectionsToStreamMessages).
  thinking?: SectionThinking
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
