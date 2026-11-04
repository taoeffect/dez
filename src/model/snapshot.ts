import type { ActiveModel, ContentNode } from './chat/types'
import type { ProviderConfig } from './providers/config'
import type { Prompt } from './state/prompts'
import type { DefaultModel, Theme } from './state/settings'

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
    customProviders: ProviderConfig[]
    defaultNewTabModel: DefaultModel | null
    lastUsedModel: DefaultModel | null
    favorites: DefaultModel[]
    providerSettings: Record<string, Record<string, boolean>>
    checkForUpdates: boolean
    lastUpdateCheckAt: number | null
    settingsOpen: boolean
    settingsSection: string
    historyOpen: boolean
  }
  prompts: Prompt[]
}
