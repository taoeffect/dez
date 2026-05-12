import type { ActiveModel, ContentNode } from './chat/types'
import type { Prompt } from './state/prompts'
import type { DefaultModel, Theme } from './state/settings'

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
