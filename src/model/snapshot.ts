import type { ActiveModel, ContentNode, ModelRef, SectionThinking } from './chat/types'
import type { ModelOutput } from './modelOutputs'
import type { ProviderConfig } from './providers/config'
import type { ParameterValues } from './providers/modelParameters'
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
      durationMs?: number
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
    modelOutputFilter: ModelOutput[]
    providerSettings: Record<string, Record<string, boolean>>
    modelParameters: Record<string, ParameterValues>
    checkForUpdates: boolean
    lastUpdateCheckAt: number | null
    doneSound: boolean
    doneSoundVolume: number
    doneNotification: boolean
    shortcutOverrides: ShortcutOverrides
    systemPrompt: string | null
    settingsOpen: boolean
    settingsSection: string
    historyOpen: boolean
    helpOpen: boolean
  }
  prompts: Prompt[]
}
