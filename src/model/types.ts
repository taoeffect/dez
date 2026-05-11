import type { ActiveModel, ContentNode } from './chat/types'
import type { Prompt } from '../stores/promptsStore'
import type { DefaultModel, Theme } from '../stores/settingsStore'
import type { ModelInfo, ProviderInfo } from './providers'

export type PromptData = Prompt
export type { ModelInfo, ProviderInfo }

export interface LatestRelease {
  version: string
  url: string
}

export interface CopilotDeviceFlowResponse {
  user_code: string
  verification_uri: string
  device_code: string
}

export interface CopilotChatToken {
  token: string
  expires_at: number
}

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

export interface ModelSnapshot {
  tabs: {
    id: string
    title: string
    conversationId: string
    activeModel: ActiveModel | null
    sections: {
      id: string
      role: 'user' | 'agent'
      content: ContentNode[]
    }[]
    createdAt: number
  }[]
  activeTabId: string
  activeModel: ActiveModel | null
  settings: {
    showPillSeparators: boolean
    theme: Theme
    defaultModels: Record<string, string>
    defaultNewTabModel: DefaultModel | null
    lastUsedModel: DefaultModel | null
    favorites: DefaultModel[]
    checkForUpdates: boolean
    lastUpdateCheckAt: number | null
    settingsOpen: boolean
    settingsSection: string
    historyOpen: boolean
  }
  prompts: Prompt[]
}
