import type { ActiveModel } from '../chat/types'
import type { Prompt } from '../../stores/promptsStore'
import type { DefaultModel, Theme } from '../../stores/settingsStore'

export type PromptData = Prompt

export type ContentNodeData =
  | { kind: 'text'; text: string }
  | {
      kind: 'prompt'
      id: string
      promptId: string | null
      name: string
      body: string
      expanded?: boolean
    }

export interface SectionData {
  role: 'user' | 'agent'
  nodes: ContentNodeData[]
}

export interface ConversationData {
  id: string
  title: string
  sections: SectionData[]
  activeModel: ActiveModel | null
  created_at: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string | null
  messageCount: number
  preview: string
}

export interface ConversationFile {
  id: string
  content: string
  updatedAt: number
}

export interface AppStatePayload {
  tabs?: unknown[]
  activeTabId?: string | null
  showPillSeparators?: boolean
  theme?: Theme
  defaultModels?: Record<string, string>
  defaultNewTabModel?: DefaultModel | null
  lastUsedModel?: DefaultModel | null
  favorites?: DefaultModel[]
  checkForUpdates?: boolean
  lastUpdateCheckAt?: number | null
}
