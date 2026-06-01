import type { ActiveModel } from '../chat/types'
import type { ModelInfo, ProviderId } from '../providers/types'
import type { Prompt } from '../state/prompts'
import type { DefaultModel, Theme } from '../state/settings'

export type PromptData = Prompt

// Persisted model-selector cache entry for a single provider. `models` is the
// last successfully-fetched list, `working` reflects whether the last fetch
// succeeded (false hides the provider until it works again).
export interface CachedProvider {
  models: ModelInfo[]
  working: boolean
  updatedAt: number
  lastCheckedAt: number
}

// Whole persisted model cache (~/.config/dez/model_cache.json). Non-secret:
// only model ids/names, never keys.
export interface ModelCache {
  providers: Partial<Record<ProviderId, CachedProvider>>
  version: number
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
