import type { ActiveModel, ContentNode, ModelRef, SectionThinking } from './chat/types'
import type { ProviderConfig } from './providers/config'
import type { Prompt } from './state/prompts'
import type { DefaultModel, Theme, WindowGeometry } from './state/settings'
import type { ShortcutOverrides } from './shortcuts'

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
      model?: ModelRef
      thinking?: SectionThinking
    }[]
    createdAt: number
  }[]
  activeTabId: string
  activeModel: ActiveModel | null
  settings: {
    theme: Theme
    editorFontSize: number
    windowGeometry: WindowGeometry | null
    customProviders: ProviderConfig[]
    defaultNewTabModel: DefaultModel | null
    lastUsedModel: DefaultModel | null
    favorites: DefaultModel[]
    providerSettings: Record<string, Record<string, boolean>>
    checkForUpdates: boolean
    lastUpdateCheckAt: number | null
    shortcutOverrides: ShortcutOverrides
    settingsOpen: boolean
    settingsSection: string
    historyOpen: boolean
  }
  prompts: Prompt[]
}
