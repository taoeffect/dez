// The Pinia stores in this folder are internal to the model. Other layers
// change and read them through the dez.model/* selectors (and the plain
// functions exported here and from streams.ts); views read reactive state
// through src/view/modelState.ts.
import sbp from '@sbp/sbp'
import { watch, type WatchStopHandle } from 'vue'
import { debounce } from 'turtledash'
import { streamIsStreaming } from './streams'
import { useModelCacheStore } from './modelCache'
import { usePromptsStore, type Prompt } from './prompts'
import { useSettingsStore, type DefaultModel, type SettingsSection, type Theme, type WindowGeometry } from './settings'
import { clampEditorFontSize } from '../editorFontSize'
import { normalizeOutputs, type ModelOutput } from '../modelOutputs'
import { clampDoneSoundVolume } from '../doneSoundVolume'
import { currentShortcutPlatform, findShortcut, normalizeShortcutKey, validateShortcutKey, type Shortcut, type ShortcutId, type ShortcutOverrides } from '../shortcuts'
import { MAX_CLOSED_TABS, NEW_TAB_TITLE, useTabStore } from './tabs'
import type { AppStatePayload, CachedProvider, ConversationSearchOutcome, ModelCache } from '../persistence/types'
import { emptyModelCache } from '../persistence/modelCache'
import type { ModelOutputsConfig, ProviderConfig, ProviderThinkingConfig } from '../providers/config'
import type { ParameterValue, ParameterValues } from '../providers/modelParameters'
import { toolsApply } from '../providers/modelToggles'
import { providerModel, type ModelInfo, type ProviderId, type ProviderModelsResult } from '../providers/types'
import { isToolsEnabled } from '../providers/toolsSetting'
import type { ActiveModel, ContentNode, ModelRef, Section, SectionThinking, Tab, ThinkingReplay, ThinkingRound } from '../chat/types'
import {
  appendStreamingText,
  emptyContent,
  normalizeContent,
  replaceStreamingTail,
  sectionIsEmpty,
  sectionVisibleText,
} from '../chat/content'
import { durationField } from '../chat/duration'
import { labelImageReferences } from '../chat/images'
import { modelRefField, modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import { cloneJsonObject } from '../../utils/json'
import { sectionsToStreamMessages } from '../streams/messages'
import {
  endStreamSection,
  ensureTrailingAgentSection,
} from '../streams/sections'
import type { EndedStreamSession, RequestMessages } from '../streams/types'
import type { ModelSnapshot } from '../snapshot'

export interface SettingsSnapshot {
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
  settingsOpen: boolean
  settingsSection: SettingsSection
  historyOpen: boolean
}

// A tab's reply activity in the tab bar: `busy` while its reply streams,
// `done` after a reply ended while the tab was in the background, until the
// tab is active again.
export type TabActivity = 'busy' | 'done'

type ContentNodeData =
  | { kind: 'text'; text: string }
  | {
      kind: 'prompt'
      id: string
      promptId: string | null
      name: string
      body: string
      expanded?: boolean
    }

interface SectionData {
  role: 'user' | 'agent'
  nodes: ContentNodeData[]
  model?: ModelRef
  thinking?: SectionThinking
  durationMs?: number
}

interface ConversationData {
  id: string
  title: string
  sections: SectionData[]
  activeModel: ActiveModel | null
  created_at: number
}

interface TabData {
  id: string
  title: string
  conversationId: string
  activeModel: ActiveModel | null
  createdAt: number
}

let settingsPersistenceReady = false
let stopSettingsPersistWatch: WatchStopHandle | null = null
let stopThemeWatch: WatchStopHandle | null = null
let stopEditorFontSizeWatch: WatchStopHandle | null = null
let promptsPersistenceReady = false
let stopPromptsPersistWatch: WatchStopHandle | null = null
let modelCachePersistenceReady = false
let stopModelCachePersistWatch: WatchStopHandle | null = null

const persistSettings = debounce(() => {
  if (settingsPersistenceReady) void sbp('dez.model/appState/save')
}, 1000)

const persistPrompts = debounce(() => {
  if (promptsPersistenceReady) void savePrompts()
}, 1000)

const persistModelCache = debounce(() => {
  if (modelCachePersistenceReady) void saveModelCache()
}, 1000)

function cloneContentNode(node: ContentNode): ContentNode {
  return { ...node }
}

function cloneSections(sections: Section[]): ModelSnapshot['tabs'][number]['sections'] {
  return sections.map((section) => ({
    id: section.id,
    role: section.role,
    content: section.content.map(cloneContentNode),
    ...modelRefField(section.model),
    ...thinkingField(section.thinking),
    ...durationField(section.durationMs),
  }))
}

function cloneTab(tab: Tab): ModelSnapshot['tabs'][number] {
  return {
    id: tab.id,
    title: tab.title,
    conversationId: tab.conversationId,
    activeModel: cloneActiveModel(tab.activeModel),
    sections: cloneSections(tab.sections),
    createdAt: tab.createdAt,
  }
}

function cloneTabs(tabs: Tab[]): ModelSnapshot['tabs'] {
  return tabs.map(cloneTab)
}

function cloneActiveModel(model: ActiveModel | null): ActiveModel | null {
  return model ? { ...model } : null
}

function cloneDefaultModel(model: DefaultModel | null): DefaultModel | null {
  return model ? { ...model } : null
}

function clonePrompt(prompt: Prompt): Prompt {
  return { ...prompt }
}

// A copy of a settings table of records (`providerSettings`,
// `modelParameters`) that shares no record with it.
function cloneRecords<Value>(records: Record<string, Record<string, Value>>): Record<string, Record<string, Value>> {
  const output: Record<string, Record<string, Value>> = {}
  for (const [key, record] of Object.entries(records)) {
    output[key] = { ...record }
  }
  return output
}

// Copies only the known ProviderConfig fields, so a stray field of a caller's
// object (such as a hand-added `apiKey`) never enters the store or
// app_state.json.
function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  const {
    id, name, baseUrl, apiFormat, models, fetchModels, modelListQuery, modelImageInput, modelToolCalling,
    modelThinking, modelOutputs, auth, headers, imageRequestHeaders, maxOutputTokens, cacheBreakpoints,
    toolMessageCacheMark, promptCacheKey, requestBody, imageOutputBody, mediaApi, settings, thinking,
    ...uncopied
  } = config
  // A compile error when ProviderConfig gets a field that this clone does not
  // copy; without it, the next app-state save would silently drop the field.
  uncopied satisfies Record<string, never>
  const clone: ProviderConfig = {
    id,
    name,
    baseUrl,
    apiFormat,
    models: models.map((model) => model.outputs ? { ...model, outputs: [...model.outputs] } : { ...model }),
    fetchModels,
    auth,
  }
  if (modelListQuery) clone.modelListQuery = { ...modelListQuery }
  if (modelImageInput) clone.modelImageInput = { ...modelImageInput }
  if (modelToolCalling) clone.modelToolCalling = { ...modelToolCalling }
  if (modelThinking) clone.modelThinking = { ...modelThinking }
  if (modelOutputs) clone.modelOutputs = cloneModelOutputsConfig(modelOutputs)
  if (headers) clone.headers = { ...headers }
  if (imageRequestHeaders) clone.imageRequestHeaders = { ...imageRequestHeaders }
  if (maxOutputTokens !== undefined) clone.maxOutputTokens = maxOutputTokens
  if (cacheBreakpoints !== undefined) clone.cacheBreakpoints = cacheBreakpoints
  if (toolMessageCacheMark) clone.toolMessageCacheMark = toolMessageCacheMark
  if (promptCacheKey !== undefined) clone.promptCacheKey = promptCacheKey
  if (requestBody) clone.requestBody = cloneJsonObject(requestBody)
  if (imageOutputBody) clone.imageOutputBody = cloneJsonObject(imageOutputBody)
  if (mediaApi) clone.mediaApi = { ...mediaApi }
  if (settings) {
    clone.settings = settings.map(({ modelSupport, ...setting }) => ({ ...setting, ...(modelSupport && { modelSupport: { ...modelSupport } }) }))
  }
  // Last: dez.controller/providers/save compares configs as JSON text and
  // relies on this key order.
  if (thinking) clone.thinking = cloneThinkingConfig(thinking)
  return clone
}

function cloneModelOutputsConfig({ path, values }: ModelOutputsConfig): ModelOutputsConfig {
  return {
    path,
    values: Object.fromEntries(Object.entries(values).map(([type, { requestBy, ...value }]) => [type, {
      ...value,
      outputs: [...value.outputs],
      ...(requestBy && { requestBy: { path: requestBy.path, values: { ...requestBy.values } } }),
    }])),
  }
}

// An empty object is kept: it means "supports thinking, with the default
// requests".
function cloneThinkingConfig(thinking: ProviderThinkingConfig): ProviderThinkingConfig {
  const { enabledBody, disabledBody, ...uncopied } = thinking
  // The same compile guard as in cloneProviderConfig.
  uncopied satisfies Record<string, never>
  const clone: ProviderThinkingConfig = {}
  if (enabledBody) clone.enabledBody = cloneJsonObject(enabledBody)
  if (disabledBody) clone.disabledBody = cloneJsonObject(disabledBody)
  return clone
}

function cloneSettings(settings = useSettingsStore()): SettingsSnapshot {
  return {
    theme: settings.theme,
    editorFontSize: settings.editorFontSize,
    windowGeometry: settings.windowGeometry ? { ...settings.windowGeometry } : null,
    customProviders: settings.customProviders.map(cloneProviderConfig),
    defaultNewTabModel: cloneDefaultModel(settings.defaultNewTabModel),
    lastUsedModel: cloneDefaultModel(settings.lastUsedModel),
    favorites: settings.favorites.map((favorite) => ({ ...favorite })),
    modelOutputFilter: [...settings.modelOutputFilter],
    providerSettings: cloneRecords(settings.providerSettings),
    modelParameters: cloneRecords(settings.modelParameters),
    checkForUpdates: settings.checkForUpdates,
    lastUpdateCheckAt: settings.lastUpdateCheckAt,
    doneSound: settings.doneSound,
    doneSoundVolume: settings.doneSoundVolume,
    doneNotification: settings.doneNotification,
    shortcutOverrides: { ...settings.shortcutOverrides },
    settingsOpen: settings.settingsOpen,
    settingsSection: settings.settingsSection,
    historyOpen: settings.historyOpen,
  }
}

function contentNodeToData(node: ContentNode): ContentNodeData {
  if (node.kind === 'text') return { kind: 'text', text: node.text }
  return {
    kind: 'prompt',
    id: node.id,
    promptId: node.promptId,
    name: node.name,
    body: node.body,
    expanded: node.expanded,
  }
}

function dataToContentNode(node: ContentNodeData): ContentNode {
  if (node.kind === 'text') return { kind: 'text', text: node.text }
  return {
    kind: 'prompt',
    id: node.id,
    promptId: node.promptId,
    name: node.name,
    body: node.body,
    expanded: false,
  }
}

function defaultActiveModel(settings = useSettingsStore()): ActiveModel | null {
  if (settings.defaultNewTabModel) {
    return {
      providerId: settings.defaultNewTabModel.providerId,
      modelId: settings.defaultNewTabModel.modelId,
      modelName: settings.defaultNewTabModel.modelId,
    }
  }
  if (settings.lastUsedModel) {
    return {
      providerId: settings.lastUsedModel.providerId,
      modelId: settings.lastUsedModel.modelId,
      modelName: settings.lastUsedModel.modelId,
    }
  }
  return null
}

function createDefaultTab(): Tab {
  return {
    id: crypto.randomUUID(),
    title: NEW_TAB_TITLE,
    conversationId: crypto.randomUUID(),
    sections: [{ id: crypto.randomUUID(), role: 'user', content: emptyContent() }],
    activeModel: null,
    createdAt: Date.now(),
  }
}

// The tab title: the start of the first user message that has text. An image
// reference shows as `[image]`, never as its path. The label is not empty, so
// the section that the `find` picks still has a title. With no user text left
// (the user deleted it all, also an image-only first message), the title goes
// back to the new-tab title, so a deleted message never names the tab.
function tabTitle(sections: Section[]): string {
  const firstContent = sections.find((section) => section.role === 'user' && sectionVisibleText(section).trim())
  if (!firstContent) return NEW_TAB_TITLE
  const text = labelImageReferences(sectionVisibleText(firstContent)).trim()
  return text.length > 30 ? text.slice(0, 30) + '…' : text
}

function tabFromConversation(conv: ConversationData, overrides: Partial<Tab> = {}): Tab {
  const sections: Section[] = conv.sections.map((section) => ({
    id: crypto.randomUUID(),
    role: section.role,
    content: normalizeContent(section.nodes.map((node) => dataToContentNode(node))),
    ...modelRefField(section.model),
    ...thinkingField(section.thinking),
    ...durationField(section.durationMs),
  }))
  if (sections.length === 0) {
    sections.push({ id: crypto.randomUUID(), role: 'user', content: emptyContent() })
  }
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? (conv.title || NEW_TAB_TITLE),
    conversationId: overrides.conversationId ?? conv.id,
    sections,
    activeModel: overrides.activeModel ?? conv.activeModel ?? null,
    createdAt: overrides.createdAt ?? (conv.created_at || Date.now()),
  }
}

function findTabSection(tabId: string, sectionId: string): { tab: Tab; section: Section } | null {
  const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
  const section = tab?.sections.find((candidate) => candidate.id === sectionId)
  return tab && section ? { tab, section } : null
}

// Drops every closed-tab entry of a conversation, so that an old copy never
// comes back over newer edits or over a deleted conversation file.
function forgetClosedConversation(conversationId: string): void {
  const tabStore = useTabStore()
  tabStore.closedTabs = tabStore.closedTabs.filter((entry) => entry.tab.conversationId !== conversationId)
}

export function appendTokenToTabSection(tabId: string, sectionId: string, token: string): boolean {
  const section = findTabSection(tabId, sectionId)?.section
  if (!section) return false
  appendStreamingText(section, token)
  return true
}

// Replaces the running tool blocks that the stream appended
// (replaceStreamingTail). Returns false when the tab, the section, or the
// blocks are gone.
export function replaceStreamTailInTabSection(tabId: string, sectionId: string, tail: string, text: string): boolean {
  const section = findTabSection(tabId, sectionId)?.section
  return !!section && replaceStreamingTail(section, tail, text)
}

// The entry of the later request round after the tool call `afterToolCall`.
// It is made when the round's first thinking token or its replay comes, at
// the end of the text so far, so a round with neither gets none. Rounds
// stream one after another: only the last entry can be the current round's.
// `thinking` is the store's reactive object, and the entry is read back
// through it, so a later write to the entry notifies watchers. The list is
// set in one write, so a sync watcher never sees an empty list.
function thinkingRoundAfter(thinking: SectionThinking, afterToolCall: string): ThinkingRound {
  const last = thinking.rounds?.at(-1)
  if (last?.afterToolCall === afterToolCall) return last
  thinking.rounds = [...(thinking.rounds ?? []), { afterToolCall, from: thinking.text.length }]
  return thinking.rounds[thinking.rounds.length - 1]
}

// Returns the section's thinking after the append, or null when the tab or
// the section is gone. The editor makes its own copy of it. A token of a
// later request round passes `afterToolCall`: the id of the first tool call
// of the group that ended the round before it.
export function appendThinkingToTabSection(tabId: string, sectionId: string, token: string, afterToolCall?: string): SectionThinking | null {
  const section = findTabSection(tabId, sectionId)?.section
  if (!section) return null
  if (!section.thinking) section.thinking = { text: '' }
  if (afterToolCall !== undefined) thinkingRoundAfter(section.thinking, afterToolCall)
  section.thinking.text += token
  return section.thinking
}

// A reply can have a replay without shown text (encrypted reasoning only),
// so this makes the thinking when there is none. `afterToolCall` names a
// later request round, as in appendThinkingToTabSection.
export function setThinkingReplayForTabSection(tabId: string, sectionId: string, replay: ThinkingReplay, afterToolCall?: string): SectionThinking | null {
  const section = findTabSection(tabId, sectionId)?.section
  if (!section) return null
  if (!section.thinking) section.thinking = { text: '' }
  if (afterToolCall === undefined) section.thinking.replay = replay
  else thinkingRoundAfter(section.thinking, afterToolCall).replay = replay
  return section.thinking
}

// Ends the section that the ended stream `session` wrote. A section that
// stays gets the time from the stream start (the request went out) to its
// end; `Date.now()` steps back when the system clock is set back, so the
// time never goes below 0.
export function finalizeStreamSectionForTab(session: EndedStreamSession): void {
  const found = findTabSection(session.tabId, session.sectionId)
  if (!found) return
  const { tab, section } = found
  endStreamSection(tab.sections, section, session.status, Math.max(0, session.finishedAt - session.startedAt))
  tab.title = tabTitle(tab.sections)
}

export function settingsCheckForUpdates(): boolean {
  return useSettingsStore().checkForUpdates
}

export function settingsLastUpdateCheckAt(): number | null {
  return useSettingsStore().lastUpdateCheckAt
}

export function setSettingsLastUpdateCheckAt(timestamp: number | null): void {
  useSettingsStore().lastUpdateCheckAt = timestamp
}

export async function savePrompts(): Promise<void> {
  try {
    await sbp('dez.persistence/savePrompts', usePromptsStore().prompts.map(clonePrompt))
  } catch (error) {
    console.error('Failed to save prompts:', error)
  }
}

// A copy of a cached model that shares no array with it, so a snapshot
// never holds a reactive array of the store.
function cloneModelInfo(model: ModelInfo): ModelInfo {
  return providerModel(model.provider, model.id, model.name, model)
}

// The model cache's entry of a model: the store's object, not a copy.
function cachedModel(model: ModelRef): ModelInfo | undefined {
  return useModelCacheStore().cache.providers[model.providerId]?.models
    .find((candidate) => candidate.id === model.modelId)
}

function cloneModelCache(cache: ModelCache): ModelCache {
  const providers: Partial<Record<ProviderId, CachedProvider>> = {}
  for (const [key, entry] of Object.entries(cache.providers)) {
    if (!entry) continue
    providers[key] = {
      models: entry.models.map(cloneModelInfo),
      working: entry.working,
      updatedAt: entry.updatedAt,
      lastCheckedAt: entry.lastCheckedAt,
    }
  }
  return { providers, version: cache.version }
}

export async function saveModelCache(): Promise<void> {
  try {
    await sbp('dez.persistence/saveModelCache', cloneModelCache(useModelCacheStore().cache))
  } catch (error) {
    console.error('Failed to save model cache:', error)
  }
}

export default sbp('sbp/selectors/register', {
  'dez.model/snapshot' (): ModelSnapshot {
    const tabStore = useTabStore()
    const prompts = usePromptsStore()

    return {
      tabs: cloneTabs(tabStore.tabs),
      activeTabId: tabStore.activeTabId,
      activeModel: cloneActiveModel(tabStore.activeTab.activeModel),
      settings: cloneSettings(),
      prompts: prompts.prompts.map(clonePrompt),
    }
  },

  'dez.model/tabs/list' (): ModelSnapshot['tabs'] {
    return cloneTabs(useTabStore().tabs)
  },

  'dez.model/tabs/activeId' (): string {
    return useTabStore().activeTabId
  },

  'dez.model/tabs/activeConversationId' (): string {
    return useTabStore().activeTab.conversationId
  },

  'dez.model/tab' (tabId: string): Tab | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId) ?? null
    return tab ? cloneTab(tab) as Tab : null
  },

  'dez.model/tabs/create' (): Tab {
    const tabStore = useTabStore()
    const tab = createDefaultTab()
    const model = defaultActiveModel()
    if (model) tab.activeModel = model
    tabStore.tabs.push(tab)
    tabStore.activeTabId = tab.id
    return cloneTab(tab) as Tab
  },

  'dez.model/tabs/close' (tabId: string): void {
    const tabStore = useTabStore()
    if (tabStore.tabs.length <= 1) return
    const index = tabStore.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const tab = tabStore.tabs[index]
    tabStore.tabs.splice(index, 1)
    tabStore.replyDoneTabIds.delete(tabId)
    if (tabStore.activeTabId === tabId) {
      const newIndex = Math.min(index, tabStore.tabs.length - 1)
      tabStore.activeTabId = tabStore.tabs[newIndex].id
    }
    // At most one entry per conversation, the newest copy.
    forgetClosedConversation(tab.conversationId)
    if (tab.sections.some((section) => !sectionIsEmpty(section))) {
      tabStore.closedTabs.push({ tab: cloneTab(tab) as Tab, index })
      if (tabStore.closedTabs.length > MAX_CLOSED_TABS) tabStore.closedTabs.shift()
    } else {
      void sbp('dez.persistence/deleteConversation', tab.conversationId).catch(() => {})
    }
  },

  // Brings back the newest closed tab at its old place and activates it.
  // When a tab of that conversation is open again (from History), it only
  // switches to that tab: two tabs of one conversation overwrite each
  // other's file (see openConversation). The tab gets a new id, so a stream
  // session of the old id never attaches to it. False when no closed tab is
  // left. The app state watcher (controller/app.ts) saves the new tab list.
  'dez.model/tabs/reopenClosed' (): boolean {
    const tabStore = useTabStore()
    const entry = tabStore.closedTabs.pop()
    if (!entry) return false
    const openTab = tabStore.tabs.find((tab) => tab.conversationId === entry.tab.conversationId)
    if (openTab) {
      tabStore.activeTabId = openTab.id
      return true
    }
    const tab: Tab = { ...entry.tab, id: crypto.randomUUID() }
    tabStore.tabs.splice(Math.min(entry.index, tabStore.tabs.length), 0, tab)
    tabStore.activeTabId = tab.id
    return true
  },

  'dez.model/tabs/switch' (tabId: string): void {
    const tabStore = useTabStore()
    if (tabStore.tabs.some((tab) => tab.id === tabId)) tabStore.activeTabId = tabId
  },

  // Moves a tab so that `toIndex` (clamped to the list) is its index after
  // the move. The active tab stays the same. The app state watcher
  // (controller/app.ts) saves the new order, once per call.
  'dez.model/tabs/move' (tabId: string, toIndex: number): void {
    const tabStore = useTabStore()
    const fromIndex = tabStore.tabs.findIndex((tab) => tab.id === tabId)
    if (fromIndex === -1) return
    const index = Math.max(0, Math.min(toIndex, tabStore.tabs.length - 1))
    if (index === fromIndex) return
    const [tab] = tabStore.tabs.splice(fromIndex, 1)
    tabStore.tabs.splice(index, 0, tab)
  },

  'dez.model/tabs/switchToIndex' (index: number): void {
    const tabStore = useTabStore()
    if (index >= 0 && index < tabStore.tabs.length) tabStore.activeTabId = tabStore.tabs[index].id
  },

  'dez.model/tabs/cycle' (direction: 1 | -1): void {
    const tabStore = useTabStore()
    const currentIndex = tabStore.tabs.findIndex((tab) => tab.id === tabStore.activeTabId)
    const nextIndex = (currentIndex + direction + tabStore.tabs.length) % tabStore.tabs.length
    tabStore.activeTabId = tabStore.tabs[nextIndex].id
  },

  // A reply that ends while its tab is in the background marks the tab
  // `done`. A reply that ends in the active tab needs no mark: the user sees
  // it end. The tabs store clears the mark when the tab becomes active.
  'dez.model/tabs/markReplyDone' (tabId: string): void {
    const tabStore = useTabStore()
    if (tabId === tabStore.activeTabId || !tabStore.tabs.some((tab) => tab.id === tabId)) return
    tabStore.replyDoneTabIds.add(tabId)
  },

  // The activity of each tab that has one. Busy wins over done, though both
  // never meet: a new reply starts only in the active tab, which has no
  // mark.
  'dez.model/tabs/activity' (): Record<string, TabActivity> {
    const tabStore = useTabStore()
    const activity: Record<string, TabActivity> = {}
    for (const tab of tabStore.tabs) {
      if (streamIsStreaming(tab.id)) activity[tab.id] = 'busy'
      else if (tabStore.replyDoneTabIds.has(tab.id)) activity[tab.id] = 'done'
    }
    return activity
  },

  // The persisted form of a tab. Null when the tab is missing or every
  // section is empty: an empty conversation is neither saved nor exported.
  'dez.model/tabs/conversationData' (tabId: string): ConversationData | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !tab.sections.some((section) => !sectionIsEmpty(section))) return null
    return {
      id: tab.conversationId,
      title: tab.title,
      sections: tab.sections.map((section) => ({
        role: section.role,
        nodes: section.content.map((node) => contentNodeToData(node)),
        ...modelRefField(section.model),
        ...thinkingField(section.thinking),
        ...durationField(section.durationMs),
      })),
      activeModel: cloneActiveModel(tab.activeModel),
      created_at: tab.createdAt,
    }
  },

  async 'dez.model/tabs/save' (tabId: string): Promise<void> {
    const data = sbp('dez.model/tabs/conversationData', tabId) as ConversationData | null
    if (!data) return
    try {
      await sbp('dez.persistence/saveConversation', data)
    } catch (error) {
      console.error('Failed to save conversation', error)
    }
  },

  // An open tab is the newest copy of its conversation, and two tabs with one
  // conversation id save to the same file and overwrite each other's edits.
  // So this switches to an open tab instead of loading the file again.
  // App state saved before this check existed can hold several such tabs:
  // they stay open, and the active one wins, else the first one.
  async 'dez.model/tabs/openConversation' (id: string): Promise<Tab | null> {
    const tabStore = useTabStore()
    const findOpenTab = (): Tab | undefined => {
      const openTabs = tabStore.tabs.filter((tab) => tab.conversationId === id)
      return openTabs.find((tab) => tab.id === tabStore.activeTabId) ?? openTabs[0]
    }
    let tab = findOpenTab()
    if (!tab) {
      let conversation: ConversationData
      try {
        conversation = await sbp('dez.persistence/loadConversation', id) as ConversationData
      } catch (error) {
        console.error('Failed to open conversation', error)
        return null
      }
      // Look again: another call for the same id (a double click on a
      // History row) can add the tab while this call waits for the disk.
      tab = findOpenTab()
      if (!tab) {
        tab = tabFromConversation(conversation)
        tabStore.tabs.push(tab)
      }
    }
    tabStore.activeTabId = tab.id
    await sbp('dez.model/appState/save')
    return cloneTab(tab) as Tab
  },

  async 'dez.model/tabs/deleteConversation' (id: string): Promise<void> {
    const tabStore = useTabStore()
    try {
      await sbp('dez.persistence/deleteConversation', id)
    } catch (error) {
      console.error('Failed to delete conversation', error)
      return
    }
    forgetClosedConversation(id)

    const matchingTabs = tabStore.tabs.filter((tab) => tab.conversationId === id)
    for (const tab of matchingTabs) tabStore.replyDoneTabIds.delete(tab.id)
    if (!matchingTabs.length) {
      await sbp('dez.model/appState/save')
      return
    }

    if (matchingTabs.length === tabStore.tabs.length) {
      const replacement = createDefaultTab()
      const model = defaultActiveModel()
      if (model) replacement.activeModel = model
      tabStore.tabs = [replacement]
      tabStore.activeTabId = replacement.id
      await sbp('dez.model/appState/save')
      return
    }

    const deletedActive = matchingTabs.some((tab) => tab.id === tabStore.activeTabId)
    tabStore.tabs = tabStore.tabs.filter((tab) => tab.conversationId !== id)
    if (deletedActive) tabStore.activeTabId = tabStore.tabs[0].id
    await sbp('dez.model/appState/save')
  },

  async 'dez.model/appState/save' (): Promise<void> {
    const tabStore = useTabStore()
    const settings = useSettingsStore()
    const tabsData: TabData[] = tabStore.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      conversationId: tab.conversationId,
      activeModel: tab.activeModel,
      createdAt: tab.createdAt,
    }))
    try {
      await sbp('dez.persistence/saveAppState', {
        tabs: tabsData,
        activeTabId: tabStore.activeTabId,
        theme: settings.theme,
        editorFontSize: settings.editorFontSize,
        window: settings.windowGeometry ?? undefined,
        customProviders: settings.customProviders,
        defaultNewTabModel: settings.defaultNewTabModel,
        lastUsedModel: settings.lastUsedModel,
        favorites: settings.favorites,
        modelOutputFilter: settings.modelOutputFilter,
        providerSettings: settings.providerSettings,
        modelParameters: settings.modelParameters,
        checkForUpdates: settings.checkForUpdates,
        lastUpdateCheckAt: settings.lastUpdateCheckAt,
        doneSound: settings.doneSound,
        doneSoundVolume: settings.doneSoundVolume,
        doneNotification: settings.doneNotification,
        shortcuts: settings.shortcutOverrides,
      })
    } catch (error) {
      console.error('Failed to save app state', error)
    }
  },

  async 'dez.model/appState/restore' (appState: unknown): Promise<void> {
    const state = appState as { tabs?: TabData[]; activeTabId?: string | null }
    if (!Array.isArray(state.tabs) || state.tabs.length === 0) return

    const restored: Tab[] = []
    for (const tabData of state.tabs) {
      try {
        const conversation = await sbp('dez.persistence/loadConversation', tabData.conversationId) as ConversationData
        restored.push(tabFromConversation(conversation, {
          id: tabData.id,
          title: tabData.title || conversation.title || NEW_TAB_TITLE,
          conversationId: tabData.conversationId,
          activeModel: tabData.activeModel ?? conversation.activeModel ?? null,
          createdAt: tabData.createdAt || conversation.created_at || Date.now(),
        }))
      } catch {
        restored.push({
          id: tabData.id,
          title: tabData.title || NEW_TAB_TITLE,
          conversationId: tabData.conversationId,
          sections: [{ id: crypto.randomUUID(), role: 'user', content: emptyContent() }],
          activeModel: tabData.activeModel ?? null,
          createdAt: tabData.createdAt || Date.now(),
        })
      }
    }

    if (restored.length > 0) {
      const tabStore = useTabStore()
      tabStore.tabs = restored
      const target = state.activeTabId && restored.find((tab) => tab.id === state.activeTabId)
      tabStore.activeTabId = target ? target.id : restored[0].id
    }
  },

  'dez.model/activeModel' (): ActiveModel | null {
    return cloneActiveModel(useTabStore().activeTab.activeModel)
  },

  'dez.model/activeModelForTab' (tabId: string): ActiveModel | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    return cloneActiveModel(tab?.activeModel ?? null)
  },

  'dez.model/setActiveModel' (providerId: string, modelId: string, modelName: string): void {
    useTabStore().activeTab.activeModel = { providerId, modelId, modelName }
    useSettingsStore().lastUsedModel = { providerId, modelId }
  },

  'dez.model/thread/initActiveModel' (): void {
    const tab = useTabStore().activeTab
    if (tab.activeModel) return
    tab.activeModel = defaultActiveModel()
  },

  'dez.model/thread/sections' (): Section[] {
    return cloneSections(useTabStore().activeTab.sections) as Section[]
  },

  // The editor watches this string and copies store section metadata into its
  // `sectionsField` when it changes. The model key is part of it, so a stamp
  // on a reused empty agent section (same id and role) still reaches the
  // editor before the first token; else the editor's write-back on every
  // token (`replaceSections`) would erase the stamp. For the same reason it
  // marks whether a section has thinking and a replay, and how many request
  // rounds its thinking has: a reused section loses its old thinking, and
  // the editor must lose it too. The thinking text is left out, so a
  // streamed thinking token does not trigger this sync. The duration is part
  // of it as well: it is stamped after the last token and dropped from a
  // reused section.
  'dez.model/thread/sectionsIdentity' (): string {
    return useTabStore().activeTab.sections
      .map((section) => {
        const thinking = section.thinking
          ? `${section.thinking.replay ? 'replay' : 'text'}${section.thinking.rounds?.length ?? ''}`
          : ''
        const model = section.model ? modelRefKey(section.model) : ''
        return `${section.id}:${section.role}:${model}:${thinking}:${section.durationMs ?? ''}`
      })
      .join('|')
  },

  // CodeMirror owns the focused document, so this selector is the model boundary
  // that replaces parsed editor sections and refreshes the tab title together.
  'dez.model/tabs/replaceSections' (tabId: string, sections: Section[]): boolean {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return false
    tab.sections.splice(0, tab.sections.length, ...sections.map((section) => ({
      id: section.id,
      role: section.role,
      content: normalizeContent(section.content),
      ...modelRefField(section.model),
      ...thinkingField(section.thinking),
      ...durationField(section.durationMs),
    })))
    tab.title = tabTitle(tab.sections)
    return true
  },

  // `model`: the model the request goes to. It decides what earlier thinking
  // goes back, whether the images go, and whether the tools go. A model that
  // the model cache knows not to read images gets only the text of each
  // reference, with no path. The tools go only to a model that the Tools
  // toggle applies to (`toolsApply`: not one that is known not to call
  // tools, and no media model), and only while that toggle of its provider
  // is on. An unknown model (no flag, or not in the cache yet) gets the
  // images and the tools.
  'dez.model/streamMessagesForTab' (tabId: string, model: ModelRef): RequestMessages {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return { messages: [], imagesLeftOut: 0, sendTools: false }

    const cached = cachedModel(model)
    const sendTools = toolsApply(cached ?? {}) && isToolsEnabled(useSettingsStore().providerSettings[model.providerId])
    const sendImages = cached?.imageInput !== false
    return { ...sectionsToStreamMessages(tab.sections, model, { sendImages, sendTools }), sendTools }
  },

  // Stamps the agent section with the model of the request that will fill it.
  'dez.model/ensureTrailingAgentSectionForTab' (tabId: string, model: ModelRef): Section | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const section = tab ? ensureTrailingAgentSection(tab.sections, model) : null
    return section ? cloneSections([section])[0] as Section : null
  },

  async 'dez.model/settings/init' (): Promise<AppStatePayload> {
    const settings = useSettingsStore()
    const state = (await sbp('dez.persistence/loadAppState').catch(() => ({}))) as AppStatePayload

    if (state) {
      if (state.theme) settings.theme = state.theme
      if (typeof state.editorFontSize === 'number') settings.editorFontSize = state.editorFontSize
      if (state.window) settings.windowGeometry = state.window
      if (Array.isArray(state.customProviders)) settings.customProviders = state.customProviders
      if (state.defaultNewTabModel !== undefined) settings.defaultNewTabModel = state.defaultNewTabModel
      if (state.lastUsedModel !== undefined) settings.lastUsedModel = state.lastUsedModel
      if (Array.isArray(state.favorites)) settings.favorites = state.favorites
      if (Array.isArray(state.modelOutputFilter)) settings.modelOutputFilter = state.modelOutputFilter
      if (state.providerSettings) settings.providerSettings = state.providerSettings
      if (state.modelParameters) settings.modelParameters = state.modelParameters
      if (typeof state.checkForUpdates === 'boolean') settings.checkForUpdates = state.checkForUpdates
      if (typeof state.lastUpdateCheckAt === 'number') settings.lastUpdateCheckAt = state.lastUpdateCheckAt
      if (typeof state.doneSound === 'boolean') settings.doneSound = state.doneSound
      if (typeof state.doneSoundVolume === 'number') settings.doneSoundVolume = state.doneSoundVolume
      if (typeof state.doneNotification === 'boolean') settings.doneNotification = state.doneNotification
      if (state.shortcuts) settings.shortcutOverrides = state.shortcuts
    }

    sbp('dez.ui/applyTheme', settings.theme)
    sbp('dez.ui/applyEditorFontSize', settings.editorFontSize)
    settingsPersistenceReady = true
    return state
  },

  // Settings persistence is model-owned so stores remain reactive state only; the
  // debounce preserves the old app-state write coalescing behavior.
  // dez.controller/app/init calls this only after settings/init has loaded
  // app_state.json. A settings mutation before then can be lost: the loaded
  // state can replace it, and no watcher saves it.
  'dez.model/settings/startPersistence' (): void {
    const settings = useSettingsStore()
    stopSettingsPersistWatch?.()
    stopThemeWatch?.()
    stopEditorFontSizeWatch?.()
    stopSettingsPersistWatch = watch(
      [
        () => settings.theme,
        () => settings.editorFontSize,
        () => settings.windowGeometry,
        () => settings.customProviders,
        () => settings.defaultNewTabModel,
        () => settings.lastUsedModel,
        () => settings.favorites,
        () => settings.modelOutputFilter,
        () => settings.providerSettings,
        () => settings.modelParameters,
        () => settings.checkForUpdates,
        () => settings.lastUpdateCheckAt,
        () => settings.doneSound,
        () => settings.doneSoundVolume,
        () => settings.doneNotification,
        () => settings.shortcutOverrides,
      ],
      () => {
        persistSettings()
      },
      { deep: true },
    )
    stopThemeWatch = watch(
      () => settings.theme,
      (theme) => {
        sbp('dez.ui/applyTheme', theme)
      },
    )
    stopEditorFontSizeWatch = watch(
      () => settings.editorFontSize,
      (px) => {
        sbp('dez.ui/applyEditorFontSize', px)
      },
    )
  },

  'dez.model/settings/stopPersistence' (): void {
    stopSettingsPersistWatch?.()
    stopSettingsPersistWatch = null
    stopThemeWatch?.()
    stopThemeWatch = null
    stopEditorFontSizeWatch?.()
    stopEditorFontSizeWatch = null
    settingsPersistenceReady = false
  },

  'dez.model/settings/snapshot' (): SettingsSnapshot {
    return cloneSettings()
  },

  'dez.model/settings/isOpen' (): boolean {
    return useSettingsStore().settingsOpen
  },

  'dez.model/settings/isHistoryOpen' (): boolean {
    return useSettingsStore().historyOpen
  },

  'dez.model/settings/open' (section: SettingsSection = 'general'): void {
    const settings = useSettingsStore()
    settings.settingsSection = section
    settings.historyOpen = false
    settings.settingsOpen = true
  },

  'dez.model/settings/close' (): void {
    useSettingsStore().settingsOpen = false
  },

  'dez.model/settings/toggle' (): void {
    if (useSettingsStore().settingsOpen) sbp('dez.model/settings/close')
    else sbp('dez.model/settings/open')
  },

  'dez.model/settings/setSection' (section: SettingsSection): void {
    useSettingsStore().settingsSection = section
  },

  'dez.model/settings/historyOpen' (): void {
    const settings = useSettingsStore()
    settings.settingsOpen = false
    settings.historyOpen = true
  },

  'dez.model/settings/historyClose' (): void {
    useSettingsStore().historyOpen = false
  },

  'dez.model/settings/historyToggle' (): void {
    if (useSettingsStore().historyOpen) sbp('dez.model/settings/historyClose')
    else sbp('dez.model/settings/historyOpen')
  },

  'dez.model/settings/setTheme' (theme: Theme): void {
    useSettingsStore().theme = theme
  },

  // Cmd/Ctrl+= and Cmd/Ctrl+- (keys and View menu items). One size for all
  // tabs; it stays in range, so a key at the limit does nothing.
  'dez.model/settings/changeEditorFontSize' (delta: number): void {
    const settings = useSettingsStore()
    settings.editorFontSize = clampEditorFontSize(settings.editorFontSize + delta)
  },

  // The window tracker (dez.controller/window/startTracking) calls it after
  // moves and resizes. An unchanged geometry is not assigned, so the first
  // save after an unchanged restore, and further events while the window
  // stays maximized, write no app_state.json.
  'dez.model/settings/setWindowGeometry' (geometry: WindowGeometry): void {
    const settings = useSettingsStore()
    const current = settings.windowGeometry
    const fields = ['width', 'height', 'x', 'y', 'maximized'] as const
    if (current && fields.every((field) => current[field] === geometry[field])) return
    settings.windowGeometry = { ...geometry }
  },

  // Records a sparse per-provider override; effective values merge these with
  // the provider descriptor defaults at read/request-build time.
  'dez.model/settings/setProviderSetting' (providerId: string, key: string, value: boolean): void {
    const providerSettings = useSettingsStore().providerSettings
    const existing = providerSettings[providerId]
    if (existing) {
      existing[key] = value
    } else {
      providerSettings[providerId] = { [key]: value }
    }
  },

  // Clears the stored overrides of the given toggles of a provider; their
  // effective values fall back to the defaults at read/request-build time.
  // The provider settings popup gives the toggles that it shows, so a toggle
  // that does not apply to the active model keeps its value. A provider
  // with no override left has no entry. With `modelId`, it also clears the
  // parameter values of that model.
  'dez.model/settings/resetProviderSettings' (providerId: string, keys: readonly string[], modelId?: string): void {
    const settings = useSettingsStore()
    const stored = settings.providerSettings[providerId]
    if (stored) {
      for (const key of keys) delete stored[key]
      if (Object.keys(stored).length === 0) delete settings.providerSettings[providerId]
    }
    if (modelId !== undefined) delete settings.modelParameters[modelRefKey({ providerId, modelId })]
  },

  // Records the user's value for a parameter of a media model
  // (`ModelInfo.parameters`); null removes it, so that the parameter has its
  // default again. The value is not checked here: a value that the model
  // does not take counts as none at request time
  // (`effectiveParameterValues`).
  'dez.model/settings/setModelParameter' (model: ModelRef, name: string, value: ParameterValue | null): void {
    const modelParameters = useSettingsStore().modelParameters
    const key = modelRefKey(model)
    const values = { ...modelParameters[key] }
    if (value === null) delete values[name]
    else values[name] = value
    if (Object.keys(values).length > 0) modelParameters[key] = values
    else delete modelParameters[key]
  },

  // Every shortcut of this platform with its effective key (the user's key,
  // else the default), in display order. The same array until a key
  // changes; a read inside a computed or watch tracks key changes.
  'dez.model/settings/shortcuts' (): readonly Shortcut[] {
    return useSettingsStore().shortcuts
  },

  // Gives action `id` a new key (any key name), or its default key for
  // null. Returns why the key is refused, as text for Settings › Shortcuts,
  // or null when the action now has it. Only keys that differ from the
  // default are stored.
  'dez.model/settings/setShortcut' (id: ShortcutId, key: string | null): string | null {
    const settings = useSettingsStore()
    const shortcut = findShortcut(settings.shortcuts, id)
    const requested = key ?? shortcut.defaultKey
    const error = validateShortcutKey(currentShortcutPlatform, id, requested, settings.shortcutOverrides)
    if (error) return error
    // Never null here: a key that passed validation is a key name.
    const newKey = normalizeShortcutKey(requested, currentShortcutPlatform) ?? shortcut.key
    if (newKey === shortcut.key) return null
    const overrides: Partial<Record<ShortcutId, string>> = { ...settings.shortcutOverrides }
    if (newKey === shortcut.defaultKey) delete overrides[id]
    else overrides[id] = newKey
    settings.shortcutOverrides = overrides
    return null
  },

  // Reset All: every action gets its default key back. The defaults never
  // clash (shortcuts.test.ts checks both platforms).
  'dez.model/settings/resetShortcuts' (): void {
    useSettingsStore().shortcutOverrides = {}
  },

  'dez.model/settings/setDefaultNewTabModel' (model: DefaultModel | null): void {
    useSettingsStore().defaultNewTabModel = model ? { ...model } : null
  },

  'dez.model/settings/setCheckForUpdates' (enabled: boolean): void {
    useSettingsStore().checkForUpdates = enabled
  },

  'dez.model/settings/setDoneSound' (enabled: boolean): void {
    useSettingsStore().doneSound = enabled
  },

  // The Settings › Notifications volume slider; any number is rounded and
  // kept in 0-100.
  'dez.model/settings/setDoneSoundVolume' (percent: number): void {
    useSettingsStore().doneSoundVolume = clampDoneSoundVolume(percent)
  },

  'dez.model/settings/setDoneNotification' (enabled: boolean): void {
    useSettingsStore().doneNotification = enabled
  },

  'dez.model/settings/toggleFavorite' (providerId: string, modelId: string): void {
    const favorites = useSettingsStore().favorites
    const index = favorites.findIndex(
      (favorite) => favorite.providerId === providerId && favorite.modelId === modelId,
    )
    if (index >= 0) {
      favorites.splice(index, 1)
    } else {
      favorites.push({ providerId, modelId })
    }
  },

  // The output filter of both model pickers: the output types to show;
  // empty shows every model. Unknown types are dropped.
  'dez.model/settings/setModelOutputFilter' (outputs: readonly ModelOutput[]): void {
    useSettingsStore().modelOutputFilter = normalizeOutputs(outputs)
  },

  'dez.model/customProviders/list' (): ProviderConfig[] {
    return useSettingsStore().customProviders.map(cloneProviderConfig)
  },

  // Adds a custom provider, or replaces the one with the same id in place.
  // The caller validates the config first with customProviderConfigSchema.
  'dez.model/customProviders/save' (config: ProviderConfig): void {
    const customProviders = useSettingsStore().customProviders
    const index = customProviders.findIndex((existing) => existing.id === config.id)
    if (index >= 0) customProviders.splice(index, 1, cloneProviderConfig(config))
    else customProviders.push(cloneProviderConfig(config))
  },

  // Removes a custom provider and, in the same step, every setting that names
  // it, so no favorite or default model points at a provider that is gone.
  // Returns false and changes nothing when no custom provider has this id,
  // so a built-in id never clears the built-in's settings.
  'dez.model/customProviders/remove' (providerId: ProviderId): boolean {
    const settings = useSettingsStore()
    const index = settings.customProviders.findIndex((config) => config.id === providerId)
    if (index < 0) return false
    settings.customProviders.splice(index, 1)
    settings.favorites = settings.favorites.filter((favorite) => favorite.providerId !== providerId)
    if (settings.defaultNewTabModel?.providerId === providerId) settings.defaultNewTabModel = null
    if (settings.lastUsedModel?.providerId === providerId) settings.lastUsedModel = null
    delete settings.providerSettings[providerId]
    for (const key of Object.keys(settings.modelParameters)) {
      if (parseModelRefKey(key)?.providerId === providerId) delete settings.modelParameters[key]
    }
    return true
  },

  async 'dez.model/prompts/init' (): Promise<void> {
    const prompts = usePromptsStore()
    try {
      const loaded = await sbp('dez.persistence/loadPrompts') as Prompt[]
      prompts.prompts = Array.isArray(loaded) ? loaded.map(clonePrompt) : []
    } catch (error) {
      console.error('Failed to load prompts:', error)
      prompts.prompts = []
    }
    promptsPersistenceReady = true
  },

  // Prompt templates persist separately from conversations; the model watcher
  // keeps that persistence boundary out of the Pinia store implementation.
  'dez.model/prompts/startPersistence' (): void {
    stopPromptsPersistWatch?.()
    stopPromptsPersistWatch = watch(
      () => usePromptsStore().prompts,
      () => {
        persistPrompts()
      },
      { deep: true },
    )
  },

  'dez.model/prompts/stopPersistence' (): void {
    stopPromptsPersistWatch?.()
    stopPromptsPersistWatch = null
    promptsPersistenceReady = false
  },

  'dez.model/prompts/list' (): Prompt[] {
    return usePromptsStore().prompts.map(clonePrompt)
  },

  'dez.model/prompts/getByName' (name: string): Prompt | undefined {
    const prompt = usePromptsStore().prompts.find((candidate) => candidate.name === name)
    return prompt ? clonePrompt(prompt) : undefined
  },

  'dez.model/prompts/add' (name: string, content: string): Prompt {
    const prompt: Prompt = {
      id: crypto.randomUUID(),
      name,
      content,
    }
    usePromptsStore().prompts.push(prompt)
    return clonePrompt(prompt)
  },

  'dez.model/prompts/update' (id: string, patch: Partial<Omit<Prompt, 'id'>>): boolean {
    const prompt = usePromptsStore().prompts.find((candidate) => candidate.id === id)
    if (!prompt) return false
    if (patch.name !== undefined) prompt.name = patch.name
    if (patch.content !== undefined) prompt.content = patch.content
    return true
  },

  'dez.model/prompts/remove' (id: string): boolean {
    const prompts = usePromptsStore().prompts
    const index = prompts.findIndex((prompt) => prompt.id === id)
    if (index < 0) return false
    prompts.splice(index, 1)
    return true
  },

  async 'dez.model/modelCache/init' (): Promise<void> {
    const store = useModelCacheStore()
    try {
      store.cache = await sbp('dez.persistence/loadModelCache') as ModelCache
    } catch (error) {
      console.error('Failed to load model cache:', error)
      store.cache = emptyModelCache()
    }
    modelCachePersistenceReady = true
  },

  // The model cache persists separately from app-state/prompts; the model-owned
  // watcher keeps the persistence boundary out of the Pinia store.
  'dez.model/modelCache/startPersistence' (): void {
    stopModelCachePersistWatch?.()
    stopModelCachePersistWatch = watch(
      () => useModelCacheStore().cache,
      () => {
        persistModelCache()
      },
      { deep: true },
    )
  },

  'dez.model/modelCache/stopPersistence' (): void {
    stopModelCachePersistWatch?.()
    stopModelCachePersistWatch = null
    modelCachePersistenceReady = false
  },

  'dez.model/modelCache/snapshot' (): ModelCache {
    return cloneModelCache(useModelCacheStore().cache)
  },

  // Drives the popup refresh spinner; true while any refresh run is active and
  // false when the last one finishes (see dez.controller/modelCache/refresh).
  'dez.model/modelCache/setRefreshing' (value: boolean): void {
    useModelCacheStore().refreshing = value
  },

  // Reactive read of the refresh flag. The view computed wraps this so reading
  // the store ref keeps Vue dependency tracking live.
  'dez.model/modelCache/refreshing' (): boolean {
    return useModelCacheStore().refreshing
  },

  // The last model-list error of each provider whose last check failed.
  'dez.model/modelCache/errors' (): Record<ProviderId, string> {
    return { ...useModelCacheStore().errors }
  },

  'dez.model/modelCache/setChecking' (providerId: ProviderId, value: boolean): void {
    const checking = useModelCacheStore().checking
    if (value) checking[providerId] = true
    else delete checking[providerId]
  },

  // Ids of the providers whose newest model check is still running (see
  // dez.controller/modelCache/refresh).
  'dez.model/modelCache/checking' (): ProviderId[] {
    return Object.keys(useModelCacheStore().checking)
  },

  'dez.model/modelCache/removeProvider' (providerId: ProviderId): void {
    const store = useModelCacheStore()
    delete store.cache.providers[providerId]
    delete store.errors[providerId]
    store.rawModels.delete(providerId)
    store.rawMediaModels.delete(providerId)
  },

  // A copy of the raw entry of a model, for the `model_info` tool and the
  // price of a clip: its entry in the provider's model list (the store's
  // `rawModels`), or with `list` `media`, in the list that only the
  // provider's media API has (`rawMediaModels`). Undefined when Dez has
  // none in memory: after a start, until the provider's next successful
  // model check.
  'dez.model/modelCache/rawModel' (providerId: ProviderId, modelId: string, list: 'provider' | 'media' = 'provider'): unknown {
    const store = useModelCacheStore()
    const entry = (list === 'media' ? store.rawMediaModels : store.rawModels).get(providerId)?.get(modelId)
    return entry === undefined ? undefined : structuredClone(entry)
  },

  // A copy of the cached model `modelId` of the provider, or null when the
  // model cache does not have it (yet).
  'dez.model/modelCache/model' (providerId: ProviderId, modelId: string): ModelInfo | null {
    const model = cachedModel({ providerId, modelId })
    return model ? cloneModelInfo(model) : null
  },

  // Reconciliation primitive: on success replace models and raw entries,
  // mark working, bump both timestamps, and clear the error; on failure keep
  // the last-known models and raw entries but mark the provider not-working,
  // bump only the attempt timestamp, and record the error.
  'dez.model/modelCache/applyProviderResult' (providerId: ProviderId, result: ProviderModelsResult): void {
    const store = useModelCacheStore()
    const now = Date.now()
    const existing = store.cache.providers[providerId]
    if (result.ok) {
      store.cache.providers[providerId] = {
        models: result.models.map(cloneModelInfo),
        working: true,
        updatedAt: now,
        lastCheckedAt: now,
      }
      delete store.errors[providerId]
      if (result.entries) store.rawModels.set(providerId, result.entries)
      else store.rawModels.delete(providerId)
      if (result.mediaEntries) store.rawMediaModels.set(providerId, result.mediaEntries)
      else store.rawMediaModels.delete(providerId)
      return
    }
    store.cache.providers[providerId] = {
      models: existing ? existing.models.map(cloneModelInfo) : [],
      working: false,
      updatedAt: existing ? existing.updatedAt : 0,
      lastCheckedAt: now,
    }
    store.errors[providerId] = result.error ?? 'The model list request failed'
  },

  // Error-handling boundary for the history panel: full-text search (empty
  // query lists everything) that degrades to an empty listing on failure.
  // Searches are serialized through an event queue because concurrent runs
  // race on the shared parse cache in search.ts — e.g. a keystroke search
  // overlapping the slow mount search would also see an empty cache and
  // duplicate the cold-start full-content listing. Queued, it reuses the
  // first run's warm cache and loads only what changed.
  async 'dez.model/conversations/search' (query: string): Promise<ConversationSearchOutcome> {
    try {
      return await sbp('okTurtles.eventQueue/queueEvent', 'dez.persistence/conversationSearch',
        ['dez.persistence/searchConversations', query]) as ConversationSearchOutcome
    } catch (error) {
      console.error('Failed to search conversations', error)
      return { total: 0, results: [] }
    }
  },

})
