export type Role = 'user' | 'agent'

export interface TextNode {
  kind: 'text'
  text: string
}

export interface PromptNode {
  kind: 'prompt'
  /** Per-insertion id (ephemeral; not stable across reload unless persisted). */
  id: string
  /** Original prompt template id, or null if the saved template no longer exists. */
  promptId: string | null
  /** Display name on the pill; also used for matching on load. */
  name: string
  /** Per-insertion copy of the template body; editable when expanded. */
  body: string
  /** UI state; true when the body is rendered inline and editable. */
  expanded: boolean
}

export type ContentNode = TextNode | PromptNode

export interface Section {
  id: string
  role: Role
  content: ContentNode[]
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
