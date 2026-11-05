import type { ActiveModel, ModelRef, SectionThinking } from '../chat/types'
import type { ProviderConfig } from '../providers/config'
import type { ModelInfo, ProviderId } from '../providers/types'
import type { Prompt } from '../state/prompts'
import type { DefaultModel, Theme, WindowGeometry } from '../state/settings'

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
// only model ids/names, never keys. The model picker shows these last-known
// lists at once at startup; a background refresh then checks them.
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
  model?: ModelRef
  thinking?: SectionThinking
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
  /** The header `model:`: the tab's last selected model. */
  model: ModelRef | null
  messageCount: number
  preview: string
}

// One row of the native conversation listing. `content` is null when the
// listing was requested metadata-only (the search cache already holds the
// parsed text for files whose updatedAt is unchanged).
export interface ConversationFile {
  id: string
  content: string | null
  updatedAt: number
}

// One piece of a search-result snippet; `match: true` segments are the query
// terms the view should highlight. Segments are ordered and concatenate back
// into the full snippet text.
export interface SnippetSegment {
  text: string
  match: boolean
}

// A conversation matched by full-text search. `snippet` is null when only the
// title/model matched (or the query was empty) — the view falls back to the
// plain `preview` in that case.
export interface ConversationSearchResult extends ConversationSummary {
  snippet: SnippetSegment[] | null
}

// What a conversation search returns. `total` counts every saved conversation
// regardless of the query (the listing is in hand before filtering, so it's
// free), letting the history header stay correct while results are filtered.
export interface ConversationSearchOutcome {
  total: number
  results: ConversationSearchResult[]
}

export interface AppStatePayload {
  tabs?: unknown[]
  activeTabId?: string | null
  theme?: Theme
  editorFontSize?: number
  window?: WindowGeometry
  customProviders?: ProviderConfig[]
  // Parse only: the hand-added `apiKey` of each kept customProviders entry,
  // by provider id. dez.controller/app/init moves them to provider_keys.json;
  // serializeAppStateJson never writes them.
  customProviderApiKeys?: Record<string, string>
  defaultNewTabModel?: DefaultModel | null
  lastUsedModel?: DefaultModel | null
  favorites?: DefaultModel[]
  providerSettings?: Record<string, Record<string, boolean>>
  checkForUpdates?: boolean
  lastUpdateCheckAt?: number | null
}
