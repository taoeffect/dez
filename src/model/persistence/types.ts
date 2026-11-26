import type { Compactions } from '../chat/compaction'
import type { CountedContext } from '../chat/contextSize'
import type { ConversationCost } from '../chat/conversationCost'
import type { MoneyLimit } from '../chat/moneyLimit'
import type { ActiveModel, ModelRef, SectionThinking } from '../chat/types'
import type { ClipVolumes } from '../clipVolume'
import type { ModelOutput } from '../modelOutputs'
import type { ModelPickerSize } from '../modelPickerSize'
import type { ModelSettingsSize } from '../modelSettingsSize'
import type { ProviderConfig } from '../providers/config'
import type { ParameterValues } from '../providers/modelParameters'
import type { PriceQuote } from '../providers/modelPrices'
import type { ClipKind, ImageKind, ModelInfo, ProviderId } from '../providers/types'
import type { Prompt } from '../state/prompts'
import type { DefaultModel, Theme, WindowGeometry } from '../state/settings'
import type { ShortcutOverrides } from '../shortcuts'
import type { JsonObject } from '../../utils/json'

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
// lists at once at startup; a background refresh then checks them. `quotes`
// are the fresh price quotes of media requests (modelPrices.ts), with no
// provider data but the price and its note; absent in a file of an older
// Dez, which has none.
export interface ModelCache {
  providers: Partial<Record<ProviderId, CachedProvider>>
  quotes?: PriceQuote[]
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
  durationMs?: number
}

export interface ConversationData {
  id: string
  title: string
  sections: SectionData[]
  activeModel: ActiveModel | null
  created_at: number
  /** `Tab.cost`; absent in files of an older Dez. */
  cost?: ConversationCost
  /** `Tab.agentTextEdited`. */
  agentTextEdited?: true
  /** `Tab.context`; absent in files of an older Dez. */
  context?: CountedContext
  /** `Tab.compactions`; absent in a conversation with no compaction. */
  compactions?: Compactions
  /** `Tab.incognito`. */
  incognito?: true
  /** `Tab.requestSent`. */
  requestSent?: true
  /** `Tab.moneyLimit`. A conversation that the user opens from History has
   *  no tab entry in app_state.json, so the file keeps it too. */
  moneyLimit?: MoneyLimit
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

/** A job of a provider (an image or a clip that the provider makes after
 *  its first answer) that Dez waits for, with what Dez needs to ask the
 *  provider for its result again after a restart
 *  (`ProviderGenerateMediaInput.resume`). `resume` is the first answer cut
 *  down to what the format's `job` reads (`MediaJob.resume`); it holds no
 *  API key and no text of the user. */
export interface StoredProviderJob {
  providerId: string
  modelId: string
  kind: ClipKind | ImageKind
  jobId: string
  resume: JsonObject
  /** The price in USD that Dez got before the request: the cost of the
   *  result when the provider tells none. Absent when it is unknown. */
  quote?: number
  /** The price of the paid uploads of the input images, which the cost
   *  of a `model_invoke` job holds too; null when unknown, absent for
   *  none. */
  uploadCost?: number | null
}

/** An open job of a conversation (controller/jobs.ts): it runs, or it
 *  ended with a result that no reader took. The fields are those of the
 *  job and its call. */
export interface StoredJob {
  id: string
  number: number
  tool: string
  label: string
  inputs: string[]
  hidesAssets: boolean
  model?: ModelRef
  timeoutMs: number
  /** The price that the job holds and counts at its end (`TabJobs`;
   *  null: no price is known). Absent when the job counted it already (it
   *  ended), or sent no paid request. */
  cost?: number | null
  /** The provider's job that the work waits for. Absent: the work cannot
   *  go on after a quit. */
  providerJob?: StoredProviderJob
}

/** The provider's job of the reply of a media model that runs
 *  (`runMediaRound`). Section ids are not saved, so the record names the
 *  reply's section by its index in the tab. */
export interface StoredMediaReply {
  sectionIndex: number
  model: ActiveModel
  providerJob: StoredProviderJob
}

/** What runs for one conversation and can go on after a restart of Dez:
 *  its open jobs, and the job of its media reply. */
export interface ConversationJobs {
  jobs?: StoredJob[]
  mediaReply?: StoredMediaReply
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
  // The model pickers' output filter; empty (or missing) shows every model.
  modelOutputFilter?: ModelOutput[]
  // The size of the model picker of the bottom bar (src/model/modelPickerSize.ts).
  modelPickerSize?: ModelPickerSize
  // The size of the settings panel of the gear next to it
  // (src/model/modelSettingsSize.ts).
  modelSettingsSize?: ModelSettingsSize
  providerSettings?: Record<string, Record<string, boolean>>
  // The parameter values that the user chose for media models: full model
  // id (`modelRefKey`) -> parameter name -> value. Only the choices; a
  // parameter with no entry has its default.
  modelParameters?: Record<string, ParameterValues>
  checkForUpdates?: boolean
  lastUpdateCheckAt?: number | null
  // The reply-end alerts; doneSoundVolume is an integer percent, 0-100.
  doneSound?: boolean
  doneSoundVolume?: number
  doneNotification?: boolean
  // The remembered volume of the clip players, one for each kind of clip
  // (src/model/clipVolume.ts).
  clipVolumes?: ClipVolumes
  // The user's shortcut keys that differ from the defaults
  // (src/model/shortcuts.ts).
  shortcuts?: ShortcutOverrides
  // The user's system prompt template (Settings › System Prompt); null (or
  // missing) for Dez's own template. An empty text sends no system prompt.
  systemPrompt?: string | null
  // Shows the incognito mask in the bottom bar. Only a hand edit of
  // app_state.json sets it; it does not change what a request sends.
  incognitoOption?: boolean
  // The open jobs of each conversation, by conversation id, so that a
  // restart picks them up (`dez.stream/restoreJobs`). A conversation with
  // none has no key, and the serializer writes no empty map.
  openJobs?: Record<string, ConversationJobs>
}
