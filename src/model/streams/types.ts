import type { ActiveModel, Role } from '../chat/types'

export type StreamStatus = 'idle' | 'streaming' | 'finished' | 'error' | 'cancelled'

export interface StreamMessage {
  role: Role
  content: string
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
  error: string | null
}

export interface StreamTerminalInput {
  tabId: string
  status: Exclude<StreamStatus, 'idle' | 'streaming'>
  error?: string | null
}
