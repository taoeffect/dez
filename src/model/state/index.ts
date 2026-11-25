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
import { clampVolumePercent } from '../volumePercent'
import type { ClipVolume, ClipVolumes } from '../clipVolume'
import type { MediaTagKind } from '../chat/mediaTags'
import { clampModelPickerSize, type ModelPickerSize } from '../modelPickerSize'
import { currentShortcutPlatform, findShortcut, normalizeShortcutKey, validateShortcutKey, type Shortcut, type ShortcutId, type ShortcutOverrides } from '../shortcuts'
import { MAX_CLOSED_TABS, NEW_TAB_TITLE, useTabStore, type ReplyEnd } from './tabs'
import type { AppStatePayload, CachedProvider, ContentNodeData, ConversationData, ConversationSearchOutcome, ModelCache } from '../persistence/types'
import { emptyModelCache } from '../persistence/modelCache'
import type { ModelOutputsConfig, ProviderConfig, ProviderThinkingConfig, TokenPricePaths } from '../providers/config'
import { withKeptClipData } from '../providers/keptClipData'
import { modelEntriesFingerprint, withKeptImageLimits } from '../providers/learnedImageLimit'
import type { ParameterValue, ParameterValues } from '../providers/modelParameters'
import { freshQuote, freshQuotes, withKeptLoadedPrices, withQuote, type LoadedModelPrice, type PriceQuote, type QuoteRequest } from '../providers/modelPrices'
import { DEFAULT_FAMILY, modelFamily } from '../providers/modelFamilies'
import { isToolsEnabled, toolsApply } from '../providers/modelToggles'
import { getProvider } from '../providers/registry'
import { effectiveRequest, providerModel, type ModelInfo, type ProviderId, type ProviderModelsResult } from '../providers/types'
import type { ActiveModel, ContentNode, ModelRef, Section, SectionThinking, Tab, ThinkingReplay, ThinkingRound } from '../chat/types'
import {
  appendStreamingText,
  emptyContent,
  normalizeContent,
  replaceStreamingTail,
  sectionIsEmpty,
  sectionVisibleText,
} from '../chat/content'
import { compactionsField, sectionCompactionBlock, type Compactions } from '../chat/compaction'
import { notesMessages, withAssetLabels } from '../chat/compactionNotes'
import { contextField, contextSize, type ContextSize } from '../chat/contextSize'
import { agentTextEditedField, costField, withRequestCost, withRestoredCost, type ConversationCost, type TabCostNumbers } from '../chat/conversationCost'
import { canTurnOnIncognito, incognitoField, requestParts, requestSentField } from '../chat/incognito'
import { moneyLimitField, type MoneyLimit } from '../chat/moneyLimit'
import { durationField } from '../chat/duration'
import { modelRefField, modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import { cloneJsonObject } from '../../utils/json'
import { estimatedRequestTokens } from '../streams/contextEstimate'
import { imageOptionsOf, sectionsToStreamMessages } from '../streams/messages'
import { BUILT_IN_SYSTEM_PROMPT, buildSystemPrompt, systemPromptProblem, systemPromptTemplate } from '../systemPrompt'
import { TOOL_DEFINITIONS } from '../tools/registry'
import type { StreamedToolCall } from '../tools/types'
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
  modelPickerSize: ModelPickerSize
  providerSettings: Record<string, Record<string, boolean>>
  modelParameters: Record<string, ParameterValues>
  checkForUpdates: boolean
  lastUpdateCheckAt: number | null
  doneSound: boolean
  doneSoundVolume: number
  doneNotification: boolean
  clipVolumes: ClipVolumes
  shortcutOverrides: ShortcutOverrides
  systemPrompt: string | null
  incognitoOption: boolean
  settingsOpen: boolean
  settingsSection: SettingsSection
  historyOpen: boolean
  helpOpen: boolean
}

// A tab's reply activity in the tab bar: `busy` while its reply streams;
// after a reply ended while the tab was in the background, until the tab is
// active again, `error` when the reply ended with a reply error toast, else
// `done`.
export type TabActivity = 'busy' | ReplyEnd

interface TabData {
  id: string
  title: string
  conversationId: string
  activeModel: ActiveModel | null
  createdAt: number
  incognito?: true
  requestSent?: true
  moneyLimit?: MoneyLimit
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

// `section` as a tab stores it: a copy with normalized content, and with
// the agent fields only when they are set.
function storedSection(section: Section): Section {
  return {
    id: section.id,
    role: section.role,
    content: normalizeContent(section.content),
    ...modelRefField(section.model),
    ...thinkingField(section.thinking),
    ...durationField(section.durationMs),
  }
}

function cloneTab(tab: Tab): ModelSnapshot['tabs'][number] {
  return {
    id: tab.id,
    title: tab.title,
    conversationId: tab.conversationId,
    activeModel: cloneActiveModel(tab.activeModel),
    sections: cloneSections(tab.sections),
    createdAt: tab.createdAt,
    ...costField(tab.cost),
    ...agentTextEditedField(tab.agentTextEdited),
    ...contextField(tab.context),
    ...compactionsField(tab.compactions),
    ...incognitoField(tab.incognito),
    ...requestSentField(tab.requestSent),
    ...moneyLimitField(tab.moneyLimit),
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

function cloneTokenPricePaths(paths: TokenPricePaths): TokenPricePaths {
  const { cacheWrite, variableRateBy, ...rest } = paths
  return {
    ...rest,
    ...(cacheWrite !== undefined && { cacheWrite: typeof cacheWrite === 'string' ? cacheWrite : [...cacheWrite] }),
    ...(variableRateBy && { variableRateBy: { path: variableRateBy.path, values: [...variableRateBy.values] } }),
  }
}

// Copies only the known ProviderConfig fields, so a stray field of a caller's
// object (such as a hand-added `apiKey`) never enters the store or
// app_state.json.
function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  const {
    id, name, baseUrl, apiFormat, models, fetchModels, modelListQuery, modelImageInput, modelAudioInput, modelVideoInput, modelToolCalling,
    modelThinking, modelOutputs, modelReadableName, modelReleased, modelTokenPrices, tokenPrices, modelPriceRequest, modelContextWindow, modelImageLimit, modelMessageImageLimit, auth, headers, imageRequestHeaders,
    maxOutputTokens, cacheBreakpoints, toolMessageCacheMark, promptCacheKey, prefixCacheMark, requestBody, providerSystemPrompt, chatClips, imageOutputBody,
    audioOutputs, mediaApi, settings, thinking,
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
  if (modelAudioInput) clone.modelAudioInput = { ...modelAudioInput }
  if (modelVideoInput) clone.modelVideoInput = { ...modelVideoInput }
  if (modelToolCalling) clone.modelToolCalling = { ...modelToolCalling }
  if (modelThinking) clone.modelThinking = { ...modelThinking }
  if (modelOutputs) clone.modelOutputs = cloneModelOutputsConfig(modelOutputs)
  if (modelReadableName) clone.modelReadableName = { ...modelReadableName }
  if (modelReleased) clone.modelReleased = { ...modelReleased }
  if (modelTokenPrices) clone.modelTokenPrices = cloneTokenPricePaths(modelTokenPrices)
  if (tokenPrices) clone.tokenPrices = tokenPrices.map((row) => ({ ...row }))
  if (modelPriceRequest) {
    const { prices, contextWindow, ...rest } = modelPriceRequest
    clone.modelPriceRequest = {
      ...rest,
      prices: cloneTokenPricePaths(prices),
      ...(contextWindow && { contextWindow: { paths: [...contextWindow.paths] } }),
    }
  }
  if (modelContextWindow) clone.modelContextWindow = { paths: [...modelContextWindow.paths] }
  if (modelImageLimit) clone.modelImageLimit = { paths: [...modelImageLimit.paths] }
  if (modelMessageImageLimit) clone.modelMessageImageLimit = { paths: [...modelMessageImageLimit.paths] }
  if (headers) clone.headers = { ...headers }
  if (imageRequestHeaders) clone.imageRequestHeaders = { ...imageRequestHeaders }
  if (maxOutputTokens !== undefined) clone.maxOutputTokens = maxOutputTokens
  if (cacheBreakpoints !== undefined) clone.cacheBreakpoints = cacheBreakpoints
  if (toolMessageCacheMark) clone.toolMessageCacheMark = toolMessageCacheMark
  if (promptCacheKey !== undefined) clone.promptCacheKey = promptCacheKey
  if (prefixCacheMark !== undefined) clone.prefixCacheMark = prefixCacheMark
  if (requestBody) clone.requestBody = cloneJsonObject(requestBody)
  if (providerSystemPrompt) clone.providerSystemPrompt = { ...providerSystemPrompt }
  if (chatClips) {
    const { audioFormats, videoTypes, ...rest } = chatClips
    clone.chatClips = {
      ...rest,
      ...(audioFormats && { audioFormats: [...audioFormats] }),
      ...(videoTypes && { videoTypes: [...videoTypes] }),
    }
  }
  if (imageOutputBody) clone.imageOutputBody = cloneJsonObject(imageOutputBody)
  if (audioOutputs) clone.audioOutputs = audioOutputs.map((entry) => ({ ...entry, body: cloneJsonObject(entry.body) }))
  if (mediaApi) {
    const { format, maxRequestsAtOnce, modelRequestBodies, modelEntryPaths, ...uncopiedMediaApi } = mediaApi
    // The same compile guard as above.
    uncopiedMediaApi satisfies Record<string, never>
    clone.mediaApi = {
      format,
      ...(maxRequestsAtOnce !== undefined && { maxRequestsAtOnce }),
      ...(modelRequestBodies && { modelRequestBodies: modelRequestBodies.map((part) => ({ ...part, body: cloneJsonObject(part.body) })) }),
      ...(modelEntryPaths && { modelEntryPaths: { ...modelEntryPaths } }),
    }
  }
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
    modelPickerSize: { ...settings.modelPickerSize },
    providerSettings: cloneRecords(settings.providerSettings),
    modelParameters: cloneRecords(settings.modelParameters),
    checkForUpdates: settings.checkForUpdates,
    lastUpdateCheckAt: settings.lastUpdateCheckAt,
    doneSound: settings.doneSound,
    doneSoundVolume: settings.doneSoundVolume,
    doneNotification: settings.doneNotification,
    clipVolumes: { audio: { ...settings.clipVolumes.audio }, video: { ...settings.clipVolumes.video } },
    shortcutOverrides: { ...settings.shortcutOverrides },
    systemPrompt: settings.systemPrompt,
    incognitoOption: settings.incognitoOption,
    settingsOpen: settings.settingsOpen,
    settingsSection: settings.settingsSection,
    historyOpen: settings.historyOpen,
    helpOpen: settings.helpOpen,
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
// reference shows as `[image]` and a clip tag as `[audio]` or `[video]`, never
// as a path. The label is not empty, so the section that the `find` picks
// still has a title. With no user text left (the user deleted it all, also an
// image-only first message), the title goes back to the new-tab title, so a
// deleted message never names the tab.
//
// A compaction keeps `current`, the title that the tab has: when the block
// of the first section holds a message part (compactionNotes.ts), the first
// message is in the notes, where the user cannot edit it. A title from the
// notes would not be the title from before: a message part holds the body
// of each prompt pill as text, and the title text has none. A block with no
// message part is of an older layout, which keeps the first message in a
// user section.
function tabTitle(sections: Section[], current: string): string {
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  if (block !== null && notesMessages(block.notes).length > 0) return current
  const firstContent = sections.find((section) => section.role === 'user' && sectionVisibleText(section).trim())
  if (!firstContent) return NEW_TAB_TITLE
  const text = withAssetLabels(sectionVisibleText(firstContent), firstContent.role).trim()
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
    ...costField(conv.cost),
    ...agentTextEditedField(conv.agentTextEdited),
    ...contextField(conv.context),
    ...compactionsField(conv.compactions),
    // A restored tab has the marks in its tab entry too (app_state.json);
    // either place that has a mark sets it, as nothing clears one.
    ...incognitoField(overrides.incognito || conv.incognito),
    ...requestSentField(overrides.requestSent || conv.requestSent),
    // A restored tab has it in its tab entry too, which a set saves at
    // the same time; a tab entry of an older Dez has none.
    ...moneyLimitField(overrides.moneyLimit ?? conv.moneyLimit),
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
  tab.title = tabTitle(tab.sections, tab.title)
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

// Dez's estimate of the tokens of a chat request of `tab` to `model` as the
// tab and the settings are now (`estimatedRequestTokens`): the request
// messages of the sections, and the system prompt and the tools that the
// request sends (`requestParts`). `answerCalls` are the tool calls of an
// answer whose blocks the tab does not hold yet.
//
// The context size of a tab is the difference of two of these numbers on
// top of a provider's count (`contextSize`), so both must come from here.
// The requests hold the pictures of the `asset_view` calls of the
// conversation until its next compaction, so the estimate holds them too,
// each by the size of its saved copy.
//
// A tab with no model counts by the default family, with no system prompt
// and no tools.
function tabContextEstimate(tab: Tab, model: ModelRef | null, answerCalls: readonly StreamedToolCall[] = []): number {
  if (!model) {
    // With no tools, the calls go as text, so no picture goes.
    const { messages } = sectionsToStreamMessages(tab.sections, { providerId: '', modelId: '' }, { sendImages: true, sendTools: false })
    return estimatedRequestTokens({ tools: [], messages, answerCalls }, DEFAULT_FAMILY)
  }

  const { messages, sendTools } = sbp('dez.model/streamMessagesForTab', tab.id, model) as RequestMessages
  const tools = sendTools ? TOOL_DEFINITIONS : []
  // Only a chat request has a system prompt, and only a normal tab sends
  // Dez's. A template with a problem sends no request, and
  // `buildSystemPrompt` throws for it.
  const template = systemPromptTemplate(useSettingsStore().systemPrompt)
  const system = requestParts(tab).dezSystemPrompt && effectiveRequest(cachedModel(model) ?? {}) === 'chat' && systemPromptProblem(template) === null
    ? buildSystemPrompt(template, model, getProvider(model.providerId)?.name ?? model.providerId, tools)
    : undefined
  return estimatedRequestTokens({ system, tools, messages, answerCalls }, modelFamily(model.modelId))
}

// A copy of the cache that shares nothing with the store. It holds only
// the quotes that are fresh now, so a save drops the old ones.
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
  const quotes = freshQuotes(cache.quotes ?? [], Date.now()).map((quote) => ({ ...quote, values: { ...quote.values } }))
  return { providers, ...(quotes.length > 0 && { quotes }), version: cache.version }
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

  // The ids of the open tabs, in tab bar order: a light reactive read for a
  // view that needs no tab data (`tabs/list` copies every section).
  'dez.model/tabs/ids' (): string[] {
    return useTabStore().tabs.map((tab) => tab.id)
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

  // Closes the tab `tabId`; the last tab stays open. A tab with text goes
  // to the closed tabs, and the file of an empty tab is deleted. Gives the
  // id of the conversation whose file it deleted, else null, so that the
  // controller deletes the work folder of that conversation too.
  'dez.model/tabs/close' (tabId: string): string | null {
    const tabStore = useTabStore()
    if (tabStore.tabs.length <= 1) return null
    const index = tabStore.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return null
    const tab = tabStore.tabs[index]
    tabStore.tabs.splice(index, 1)
    tabStore.replyEnds.delete(tabId)
    if (tabStore.activeTabId === tabId) {
      const newIndex = Math.min(index, tabStore.tabs.length - 1)
      tabStore.activeTabId = tabStore.tabs[newIndex].id
    }
    // At most one entry per conversation, the newest copy.
    forgetClosedConversation(tab.conversationId)
    if (tab.sections.some((section) => !sectionIsEmpty(section))) {
      tabStore.closedTabs.push({ tab: cloneTab(tab) as Tab, index })
      if (tabStore.closedTabs.length > MAX_CLOSED_TABS) tabStore.closedTabs.shift()
      return null
    }
    void sbp('dez.persistence/deleteConversation', tab.conversationId).catch(() => {})
    return tab.conversationId
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

  // A reply that ends while its tab is in the background marks how it ended
  // (`ReplyEnd`). A reply that ends in the active tab needs no mark: the user
  // sees it end. An error mark stays until the tab is active: a later `done`
  // does not hide the error, whose toast waits for the tab. The tabs store
  // clears the mark when the tab becomes active.
  'dez.model/tabs/markReplyEnded' (tabId: string, end: ReplyEnd): void {
    const tabStore = useTabStore()
    if (tabId === tabStore.activeTabId || !tabStore.tabs.some((tab) => tab.id === tabId)) return
    if (tabStore.replyEnds.get(tabId) !== 'error') tabStore.replyEnds.set(tabId, end)
  },

  // The activity of each tab that has one. Busy wins over an end mark,
  // though both never meet: a new reply starts only in the active tab, which
  // has no mark.
  'dez.model/tabs/activity' (): Record<string, TabActivity> {
    const tabStore = useTabStore()
    const activity: Record<string, TabActivity> = {}
    for (const tab of tabStore.tabs) {
      const end = tabStore.replyEnds.get(tab.id)
      if (streamIsStreaming(tab.id)) activity[tab.id] = 'busy'
      else if (end) activity[tab.id] = end
    }
    return activity
  },

  // Adds one request of a reply to the cost of its tab (`withRequestCost`):
  // its price in USD, or null when it is not known. A tab that was closed
  // meanwhile gets nothing.
  'dez.model/tabs/countRequestCost' (tabId: string, usd: number | null): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (tab) tab.cost = withRequestCost(tab.cost, usd)
  },

  // What the requests of the tab's conversation cost (a copy); undefined
  // before its first counted request, after a reset (`resetCost`), and for
  // a missing tab.
  'dez.model/tabs/cost' (tabId: string): ConversationCost | undefined {
    return costField(useTabStore().tabs.find((candidate) => candidate.id === tabId)?.cost).cost
  },

  // Keeps the tokens of a chat request of a reply as the counted context
  // of its tab: `tokens` is the input and the output of the request, as
  // the provider counted them, so the size of the conversation with the
  // answer. `model` is the model of the request, and `answerCalls` the
  // tool calls of the answer that the tab does not hold yet. The estimate
  // of the tab at this moment goes with the count (`contextSize`). A tab
  // that was closed meanwhile gets nothing.
  //
  // A compacted tab has no counted context from its newest compaction
  // (`compact`) until its first count, so that count is the size that the
  // compaction left (`Compactions.left`).
  'dez.model/tabs/countRequestContext' (tabId: string, model: ModelRef, tokens: number, answerCalls: readonly StreamedToolCall[] = []): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    if (tab.compactions && !tab.context) tab.compactions.left = Math.round(tokens)
    tab.context = { tokens: Math.round(tokens), estimate: tabContextEstimate(tab, model, answerCalls) }
  },

  // About how many tokens the next chat request of the tab holds, for
  // `model` (by default the active model of the tab), and whether that is
  // an estimate; undefined for a missing tab. The count of the provider is
  // the base, so a tab whose reply came from another model than `model`,
  // or with other settings, shows an estimate. It reads the text of the
  // whole tab: a view must not read it for each token of a stream. So a
  // view reads it only through `useActiveContextSize`, never in a `computed`.
  'dez.model/tabs/contextSize' (tabId: string, model?: ModelRef): ContextSize | undefined {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    return tab && contextSize(tab.context, tabContextEstimate(tab, model ?? tab.activeModel))
  },

  // Puts the result of a compaction (controller/compaction.ts) into the
  // tab, in one step, as the sections and the numbers must change together.
  // `sections` are the sections that the compaction gave. Their part up to
  // the section of the reply that runs (`replySectionId`) takes the place
  // of the tab's sections up to that section. The sections of the tab
  // after it stay as the tab has them now: the user can type in them while
  // the compaction request runs. `tokens` is the context size that the
  // compaction replaced, and `model` the model of the reply.
  //
  // The counted context of the tab goes: it is a count of the text that is
  // gone, and the size of the new, small text would be near 0 with it. So
  // the size that the compaction left (`Compactions.left`) is Dez's
  // estimate, until a request counts it. The cost of the tab now becomes
  // the cost at this compaction (`Compactions.cost`), also when the tab
  // counted no request yet.
  //
  // False, with no change, for a missing tab, and for a tab that no longer
  // holds the reply's section (the user merged it into the one before).
  'dez.model/tabs/compact' (tabId: string, { sections, replySectionId, tokens, model }: { sections: readonly Section[], replySectionId: string, tokens: number, model: ModelRef }): boolean {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const isReply = (section: Section) => section.id === replySectionId
    const newEnd = sections.findIndex(isReply) + 1
    const oldEnd = (tab?.sections.findIndex(isReply) ?? -1) + 1
    if (!tab || newEnd === 0 || oldEnd === 0) return false
    tab.sections.splice(0, oldEnd, ...sections.slice(0, newEnd).map(storedSection))
    tab.title = tabTitle(tab.sections, tab.title)
    tab.compactions = {
      count: (tab.compactions?.count ?? 0) + 1,
      tokens: (tab.compactions?.tokens ?? 0) + Math.round(tokens),
      cost: costField(tab.cost).cost ?? { usd: 0, requests: 0, unpriced: 0 },
      left: tabContextEstimate(tab, model),
    }
    delete tab.context
    return true
  },

  // The numbers of the compactions of the tab's conversation (a copy);
  // undefined before its first compaction, and for a missing tab. With
  // them, the cost and the context size of the tab give the numbers of the
  // buffer and of the whole conversation (`Compactions`).
  'dez.model/tabs/compactions' (tabId: string): Compactions | undefined {
    return compactionsField(useTabStore().tabs.find((candidate) => candidate.id === tabId)?.compactions).compactions
  },

  // The user changed or removed the text of a reply in the tab, so its
  // cost can belong to text that is gone. Only a reset (`resetCost`) clears
  // the mark.
  'dez.model/tabs/markAgentTextEdited' (tabId: string): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (tab) tab.agentTextEdited = true
  },

  'dez.model/tabs/agentTextEdited' (tabId: string): boolean {
    return useTabStore().tabs.find((candidate) => candidate.id === tabId)?.agentTextEdited === true
  },

  // The cost numbers of the tab (a copy): its cost, its edited mark, and
  // the numbers of its compactions; `{}` for a missing tab. The thread
  // editor reads them to keep what a reset removes (view/editor/costReset.ts).
  'dez.model/tabs/costNumbers' (tabId: string): TabCostNumbers {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return {}
    return { ...costField(tab.cost), ...agentTextEditedField(tab.agentTextEdited), ...compactionsField(tab.compactions) }
  },

  // Removes the cost numbers of the tab (`costNumbers`), so that its cost
  // starts again from $0, as in a new tab: the user deleted all the text of
  // the tab. Only the thread editor calls it, for that delete and for its
  // redo; no tool and no write of the program resets the cost. The counted
  // context, the money limit, and the incognito marks stay. No save: the
  // editor saves the tab after it (an empty conversation has no file).
  'dez.model/tabs/resetCost' (tabId: string): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    delete tab.cost
    delete tab.agentTextEdited
    delete tab.compactions
  },

  // Puts back the cost numbers that a reset removed (`removed`), added to
  // what the tab counted since (`withRestoredCost`). Only the thread editor
  // calls it, for an undo of the user's delete of all the text. No save:
  // the editor saves the tab after it.
  'dez.model/tabs/restoreCost' (tabId: string, removed: TabCostNumbers): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const { cost, agentTextEdited, compactions } = withRestoredCost(tab, removed)
    if (cost) tab.cost = cost
    if (agentTextEdited) tab.agentTextEdited = agentTextEdited
    if (compactions) tab.compactions = compactions
  },

  // Turns incognito on in the tab when `canTurnOnIncognito` allows it, and
  // saves the conversation file and the tab entry, which both keep the flag
  // (an incognito tab with no text has no file). False, with no change,
  // when the rule says no or the tab is missing. Nothing turns it off.
  'dez.model/tabs/turnOnIncognito' (tabId: string): boolean {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !canTurnOnIncognito(tab)) return false
    tab.incognito = true
    void sbp('dez.model/tabs/save', tabId)
    void sbp('dez.model/appState/save')
    return true
  },

  'dez.model/tabs/incognito' (tabId: string): boolean {
    return useTabStore().tabs.find((candidate) => candidate.id === tabId)?.incognito === true
  },

  // The money limit of the tab (a copy); undefined with no limit, and for
  // a missing tab.
  'dez.model/tabs/moneyLimit' (tabId: string): MoneyLimit | undefined {
    return moneyLimitField(useTabStore().tabs.find((candidate) => candidate.id === tabId)?.moneyLimit).moneyLimit
  },

  // Sets the money limit of the tab, or removes it (null), and saves the
  // conversation file and the tab entry, which both keep it (a tab with no
  // text has no file). Only the user sets it: no tool calls this.
  'dez.model/tabs/setMoneyLimit' (tabId: string, limit: MoneyLimit | null): void {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    if (limit) tab.moneyLimit = { usd: limit.usd, unknownPrices: limit.unknownPrices }
    else delete tab.moneyLimit
    void sbp('dez.model/tabs/save', tabId)
    void sbp('dez.model/appState/save')
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
      ...costField(tab.cost),
      ...agentTextEditedField(tab.agentTextEdited),
      ...contextField(tab.context),
      ...compactionsField(tab.compactions),
      ...incognitoField(tab.incognito),
      ...requestSentField(tab.requestSent),
      ...moneyLimitField(tab.moneyLimit),
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

  // Deletes the file of the conversation `id`, and closes its tabs. Gives
  // false, and changes no tab, when the file could not go.
  async 'dez.model/tabs/deleteConversation' (id: string): Promise<boolean> {
    const tabStore = useTabStore()
    try {
      await sbp('dez.persistence/deleteConversation', id)
    } catch (error) {
      console.error('Failed to delete conversation', error)
      return false
    }
    forgetClosedConversation(id)

    const matchingTabs = tabStore.tabs.filter((tab) => tab.conversationId === id)
    for (const tab of matchingTabs) tabStore.replyEnds.delete(tab.id)
    if (!matchingTabs.length) {
      await sbp('dez.model/appState/save')
      return true
    }

    if (matchingTabs.length === tabStore.tabs.length) {
      const replacement = createDefaultTab()
      const model = defaultActiveModel()
      if (model) replacement.activeModel = model
      tabStore.tabs = [replacement]
      tabStore.activeTabId = replacement.id
      await sbp('dez.model/appState/save')
      return true
    }

    const deletedActive = matchingTabs.some((tab) => tab.id === tabStore.activeTabId)
    tabStore.tabs = tabStore.tabs.filter((tab) => tab.conversationId !== id)
    if (deletedActive) tabStore.activeTabId = tabStore.tabs[0].id
    await sbp('dez.model/appState/save')
    return true
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
      ...incognitoField(tab.incognito),
      ...requestSentField(tab.requestSent),
      ...moneyLimitField(tab.moneyLimit),
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
        modelPickerSize: settings.modelPickerSize,
        providerSettings: settings.providerSettings,
        modelParameters: settings.modelParameters,
        checkForUpdates: settings.checkForUpdates,
        lastUpdateCheckAt: settings.lastUpdateCheckAt,
        doneSound: settings.doneSound,
        doneSoundVolume: settings.doneSoundVolume,
        doneNotification: settings.doneNotification,
        clipVolumes: settings.clipVolumes,
        shortcuts: settings.shortcutOverrides,
        systemPrompt: settings.systemPrompt,
        // Not in the watch list of startPersistence (only a hand edit sets
        // it), but written back, or the first save would drop it.
        incognitoOption: settings.incognitoOption,
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
          ...incognitoField(tabData.incognito),
          ...requestSentField(tabData.requestSent),
          ...moneyLimitField(tabData.moneyLimit),
        }))
      } catch {
        restored.push({
          id: tabData.id,
          title: tabData.title || NEW_TAB_TITLE,
          conversationId: tabData.conversationId,
          sections: [{ id: crypto.randomUUID(), role: 'user', content: emptyContent() }],
          activeModel: tabData.activeModel ?? null,
          createdAt: tabData.createdAt || Date.now(),
          ...incognitoField(tabData.incognito),
          ...requestSentField(tabData.requestSent),
          ...moneyLimitField(tabData.moneyLimit),
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
    tab.sections.splice(0, tab.sections.length, ...sections.map(storedSection))
    tab.title = tabTitle(tab.sections, tab.title)
    return true
  },

  // `model`: the model the request goes to. It decides what earlier thinking
  // goes back, whether the images and the pictures go and how many of
  // them (`imageOptionsOf`), and whether the tools go
  // (`dez.model/requestSendsTools`, which also reads whether the tab is
  // incognito). A model that the model cache knows not to read images gets
  // only the text of each reference, with no path. An unknown model (no
  // flag, or not in the cache yet) gets the images.
  'dez.model/streamMessagesForTab' (tabId: string, model: ModelRef): RequestMessages {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return { messages: [], imagesLeftOut: 0, imagesOverLimit: 0, newestUserMessage: '', sendTools: false }

    const sendTools = sbp('dez.model/requestSendsTools', model, tabId) as boolean
    const options = { ...imageOptionsOf(cachedModel(model) ?? { id: model.modelId }), sendTools }
    return { ...sectionsToStreamMessages(tab.sections, model, options), sendTools }
  },

  // Whether a chat request to `model` offers the Dez tools now: only in a
  // tab whose requests send them (`requestParts`: not an incognito tab),
  // only to a model that the Tools toggle applies to (`toolsApply`: not one
  // that is known not to call tools, and no media model), and only while
  // that toggle of its provider is on. An unknown model (not in the cache
  // yet) gets the tools. With no `tabId`, the request of a normal tab:
  // Settings › System Prompt fills `{{tools_list}}` of its preview with it,
  // and the compaction request (`earlierReplyWriter`) is one.
  'dez.model/requestSendsTools' (model: ModelRef, tabId?: string): boolean {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    return requestParts(tab ?? {}).dezTools
      && toolsApply(cachedModel(model) ?? {})
      && isToolsEnabled(useSettingsStore().providerSettings[model.providerId])
  },

  // Starts a reply in the tab: stamps the agent section with the model of
  // the request that will fill it, and marks the tab `requestSent`. The
  // mark stays when the section goes again (`endStreamSection`), as the
  // request went (`canTurnOnIncognito`). Call it only when a request goes
  // (`submitTab`): the mark stops incognito in the tab for good.
  'dez.model/tabs/startReply' (tabId: string, model: ModelRef): Section | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return null
    tab.requestSent = true
    return cloneSections([ensureTrailingAgentSection(tab.sections, model)])[0] as Section
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
      if (state.modelPickerSize) settings.modelPickerSize = state.modelPickerSize
      if (state.providerSettings) settings.providerSettings = state.providerSettings
      if (state.modelParameters) settings.modelParameters = state.modelParameters
      if (typeof state.checkForUpdates === 'boolean') settings.checkForUpdates = state.checkForUpdates
      if (typeof state.lastUpdateCheckAt === 'number') settings.lastUpdateCheckAt = state.lastUpdateCheckAt
      if (typeof state.doneSound === 'boolean') settings.doneSound = state.doneSound
      if (typeof state.doneSoundVolume === 'number') settings.doneSoundVolume = state.doneSoundVolume
      if (typeof state.doneNotification === 'boolean') settings.doneNotification = state.doneNotification
      if (state.clipVolumes) settings.clipVolumes = state.clipVolumes
      if (state.shortcuts) settings.shortcutOverrides = state.shortcuts
      if (state.systemPrompt !== undefined) settings.systemPrompt = state.systemPrompt
      if (typeof state.incognitoOption === 'boolean') settings.incognitoOption = state.incognitoOption
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
        () => settings.modelPickerSize,
        () => settings.providerSettings,
        () => settings.modelParameters,
        () => settings.checkForUpdates,
        () => settings.lastUpdateCheckAt,
        () => settings.doneSound,
        () => settings.doneSoundVolume,
        () => settings.doneNotification,
        () => settings.clipVolumes,
        () => settings.shortcutOverrides,
        () => settings.systemPrompt,
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

  'dez.model/settings/isHelpOpen' (): boolean {
    return useSettingsStore().helpOpen
  },

  'dez.model/settings/open' (section: SettingsSection = 'general'): void {
    const settings = useSettingsStore()
    settings.settingsSection = section
    settings.historyOpen = false
    settings.helpOpen = false
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
    settings.helpOpen = false
    settings.historyOpen = true
  },

  'dez.model/settings/historyClose' (): void {
    useSettingsStore().historyOpen = false
  },

  'dez.model/settings/historyToggle' (): void {
    if (useSettingsStore().historyOpen) sbp('dez.model/settings/historyClose')
    else sbp('dez.model/settings/historyOpen')
  },

  // The Help panel (Help › Dez Help, the `?` button of the bottom bar). It
  // opens on its General page (`HelpView.vue`).
  'dez.model/settings/helpOpen' (): void {
    const settings = useSettingsStore()
    settings.settingsOpen = false
    settings.historyOpen = false
    settings.helpOpen = true
  },

  'dez.model/settings/helpClose' (): void {
    useSettingsStore().helpOpen = false
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
    useSettingsStore().doneSoundVolume = clampVolumePercent(percent)
  },

  'dez.model/settings/setDoneNotification' (enabled: boolean): void {
    useSettingsStore().doneNotification = enabled
  },

  // The remembered volume of the clip players of `kind`. A read inside a
  // computed or watch tracks its changes.
  'dez.model/settings/clipVolume' (kind: MediaTagKind): ClipVolume {
    return { ...useSettingsStore().clipVolumes[kind] }
  },

  // The volume slider or the mute button of a clip player: every player of
  // `kind` takes the value. Sets the fields given; the volume is rounded
  // and kept in 0-100. A value that is already the remembered one changes
  // nothing, so it saves nothing (a drag of the slider sets many).
  'dez.model/settings/setClipVolume' (kind: MediaTagKind, change: Partial<ClipVolume>): void {
    const volumes = useSettingsStore().clipVolumes
    const current = volumes[kind]
    const next = {
      volume: change.volume === undefined ? current.volume : clampVolumePercent(change.volume),
      muted: change.muted ?? current.muted,
    }
    if (next.volume !== current.volume || next.muted !== current.muted) volumes[kind] = next
  },

  // Settings › System Prompt: the user's template, or null for Dez's own.
  // Only the exact text of Dez's template is stored as null, so a later
  // release's template reaches the user who never changed it; a trim here
  // would change the text in the field while the user types.
  'dez.model/settings/setSystemPrompt' (template: string | null): void {
    useSettingsStore().systemPrompt = template === BUILT_IN_SYSTEM_PROMPT ? null : template
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

  // The drag of an edge of the bottom bar's model picker calls it once, at
  // the end of the drag. An unchanged size is not assigned, so a press on a
  // handle with no move writes no app_state.json.
  'dez.model/settings/setModelPickerSize' (size: ModelPickerSize): void {
    const settings = useSettingsStore()
    const next = clampModelPickerSize(size)
    const current = settings.modelPickerSize
    if (current.width === next.width && current.maxHeight === next.maxHeight) return
    settings.modelPickerSize = next
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
    if (store.cache.quotes) store.cache.quotes = store.cache.quotes.filter((quote) => quote.providerId !== providerId)
  },

  // Keeps the provider's price of one media request (modelPrices.ts) in
  // place of an older one of the same request, and drops the quotes that
  // are no longer fresh. The model cache watch saves it.
  'dez.model/modelCache/keepQuote' (quote: PriceQuote): void {
    const store = useModelCacheStore()
    store.cache.quotes = withQuote(store.cache.quotes ?? [], { ...quote, values: { ...quote.values } }, Date.now())
  },

  // A copy of the newest fresh quote of `request` (a model, its request
  // kind, and the values of the request), or null when the cache has none.
  'dez.model/modelCache/quote' (request: QuoteRequest): PriceQuote | null {
    const quote = freshQuote(useModelCacheStore().cache.quotes ?? [], request, Date.now())
    return quote ? { ...quote, values: { ...quote.values } } : null
  },

  // A copy of the raw entry of a model, for the `model_info` tool and the
  // price of a clip: its entry in the provider's model list (the store's
  // `rawModels`), or with `list` `media`, in the list that only the
  // provider's media API has (`rawMediaModels`). Undefined when Dez has
  // none in memory: after a start, until the provider's next successful
  // model check. So a fact of a model that a request or the UI must have is
  // a field of `ModelInfo`, which model_cache.json keeps; each reader of
  // this selector must work with no entry.
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

  // Keeps the image count that the provider's refusal of a request to the
  // model told (learnedImageLimit.ts), with the fingerprint of the model's
  // raw entries. Nothing without a raw entry in memory (after a start,
  // until the provider's next good model check): with no fingerprint, the
  // next check could not tell whether the model changed. The model cache
  // watch saves it.
  'dez.model/modelCache/learnImageLimit' (providerId: ProviderId, modelId: string, maxImages: number): void {
    const store = useModelCacheStore()
    const model = cachedModel({ providerId, modelId })
    const entry = modelEntriesFingerprint(store.rawModels.get(providerId)?.get(modelId), store.rawMediaModels.get(providerId)?.get(modelId))
    if (model && entry !== undefined) model.learnedImageLimit = { maxImages, entry }
  },

  // Keeps what the price request of the provider told of its chat model
  // `modelId` at the time `at` (`dez.controller/modelCache/loadPrice`): the
  // price, or that the provider has none, and the context window when the
  // answer tells one. Nothing for a model that the cache does not have
  // (now). The model cache watch saves it.
  'dez.model/modelCache/keepLoadedPrice' (providerId: ProviderId, modelId: string, { price, contextWindow }: LoadedModelPrice, at: number): void {
    const model = cachedModel({ providerId, modelId })
    if (!model) return
    if (price) model.price = { ...price }
    else delete model.price
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    model.priceLoadedAt = at
  },

  // Reconciliation primitive: on success replace models and raw entries,
  // mark working, bump both timestamps, and clear the error; on failure keep
  // the last-known models and raw entries but mark the provider not-working,
  // bump only the attempt timestamp, and record the error.
  //
  // A success of which a media list did not load (`mediaListFailed`) is
  // between the two: the new models keep the last-known data of the media
  // lists (`withKeptClipData`), so model_cache.json is the cache of it.
  // The raw media entries are only those of the lists that loaded: they
  // hold prices, and `model_info` must not show old ones as the provider's
  // answer. On every success, a model keeps its learned image limit only
  // while its new raw entries are the same (`withKeptImageLimits`), and a
  // chat model of a provider with a price request keeps what that request
  // told (`withKeptLoadedPrices`).
  'dez.model/modelCache/applyProviderResult' (providerId: ProviderId, result: ProviderModelsResult): void {
    const store = useModelCacheStore()
    const now = Date.now()
    const existing = store.cache.providers[providerId]
    if (result.ok) {
      const withClipData = result.mediaListFailed && existing ? withKeptClipData(result.models, existing.models) : result.models
      const listed = existing && getProvider(providerId)?.config.modelPriceRequest ? withKeptLoadedPrices(withClipData, existing.models) : withClipData
      const models = withKeptImageLimits(listed, existing?.models ?? [], result.entries, result.mediaEntries)
      store.cache.providers[providerId] = {
        models: models.map(cloneModelInfo),
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
    store.errors[providerId] = result.error ?? 'The model check failed. Try again.'
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

  // Every text in memory that can name a stored file (an image, a saved
  // clip): the text and the prompt bodies of each section of the open tabs
  // and of the closed tabs that can come back (`reopenClosed`), the saved
  // prompts, and the user's system prompt template. Some of it is not on
  // disk: text that is not saved yet, a closed tab's unsent text. So the
  // cleanup of unused stored files (src/controller/unusedFiles.ts) reads it
  // together with the conversation files. Each node is a text of its own: in
  // a joined text, the start of a node would make another name out of a file
  // name that ends the node before it.
  'dez.model/heldTexts' (): string[] {
    const tabStore = useTabStore()
    const tabs = [...tabStore.tabs, ...tabStore.closedTabs.map((closed) => closed.tab)]
    const nodes = tabs.flatMap((tab) => tab.sections.flatMap((section) => section.content))
    const { systemPrompt } = useSettingsStore()
    return [
      ...nodes.map((node) => (node.kind === 'text' ? node.text : node.body)),
      ...usePromptsStore().prompts.map((prompt) => prompt.content),
      ...(systemPrompt === null ? [] : [systemPrompt]),
    ]
  },

  // The ids of the conversations of the open tabs and of the closed tabs
  // that can come back (`reopenClosed`): such a conversation can have no
  // file yet. The cleanup of the files (src/controller/unusedFiles.ts)
  // keeps the work folder of each one.
  'dez.model/heldConversationIds' (): string[] {
    const tabStore = useTabStore()
    return [...tabStore.tabs, ...tabStore.closedTabs.map((closed) => closed.tab)].map((tab) => tab.conversationId)
  },

})
