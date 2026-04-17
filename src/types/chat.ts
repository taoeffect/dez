export type Role = 'user' | 'agent'

export interface Section {
  id: string
  role: Role
  content: string
}

export interface ActiveModel {
  providerId: string
  modelId: string
  modelName: string
}

export interface Tab {
  id: string
  title: string
  conversationId: string
  sections: Section[]
  activeModel: ActiveModel | null
  createdAt: number
}

export type StreamEvent =
  | { kind: 'Token'; data: { content: string } }
  | { kind: 'Done'; data: null }
  | { kind: 'Error'; data: { message: string } }
