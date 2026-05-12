import sbp from '@sbp/sbp'
import './streams'
import { usePromptsStore, type Prompt } from './prompts'
import { useSettingsStore, type DefaultModel, type SettingsSection, type Theme } from './settings'
import { useTabStore } from './tabs'
import type { ActiveModel, ContentNode, Role, Section, Tab } from '../chat/types'
import {
  appendStreamingText,
  contentEquals,
  emptyContent,
  normalizeContent,
  sectionIsEmpty,
  sectionPlainText,
  sectionVisibleText,
  setSectionPlainText,
  splitContentAt,
} from '../chat/content'
import { sectionsToStreamMessages } from '../streams/messages'
import {
  ensureTrailingAgentSection,
  ensureTrailingUserSection,
  fillEmptyAgentSectionOnError,
} from '../streams/sections'
import type { StreamMessage } from '../streams/types'
import type { ModelSnapshot } from '../snapshot'

interface SettingsSnapshot {
  showPillSeparators: boolean
  theme: Theme
  defaultModels: Record<string, string>
  defaultNewTabModel: DefaultModel | null
  lastUsedModel: DefaultModel | null
  favorites: DefaultModel[]
  checkForUpdates: boolean
  lastUpdateCheckAt: number | null
  settingsOpen: boolean
  settingsSection: SettingsSection
  historyOpen: boolean
}

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

function cloneContentNode(node: ContentNode): ContentNode {
  return { ...node }
}

function cloneSections(sections: Section[]): ModelSnapshot['tabs'][number]['sections'] {
  return sections.map((section) => ({
    id: section.id,
    role: section.role,
    content: section.content.map(cloneContentNode),
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

function cloneSettings(settings = useSettingsStore()): SettingsSnapshot {
  return {
    showPillSeparators: settings.showPillSeparators,
    theme: settings.theme,
    defaultModels: { ...settings.defaultModels },
    defaultNewTabModel: cloneDefaultModel(settings.defaultNewTabModel),
    lastUsedModel: cloneDefaultModel(settings.lastUsedModel),
    favorites: settings.favorites.map((favorite) => ({ ...favorite })),
    checkForUpdates: settings.checkForUpdates,
    lastUpdateCheckAt: settings.lastUpdateCheckAt,
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
    title: 'New Tab',
    conversationId: crypto.randomUUID(),
    sections: [{ id: crypto.randomUUID(), role: 'user', content: emptyContent() }],
    activeModel: null,
    createdAt: Date.now(),
  }
}

function firstUserTitle(sections: Section[]): string | null {
  const firstContent = sections.find((section) => section.role === 'user' && sectionVisibleText(section).trim())
  if (!firstContent) return null
  const text = sectionVisibleText(firstContent).trim()
  return text.length > 30 ? text.slice(0, 30) + '…' : text
}

function tabFromConversation(conv: ConversationData, overrides: Partial<Tab> = {}): Tab {
  const sections: Section[] = conv.sections.map((section) => ({
    id: crypto.randomUUID(),
    role: section.role,
    content: normalizeContent(section.nodes.map((node) => dataToContentNode(node))),
  }))
  if (sections.length === 0) {
    sections.push({ id: crypto.randomUUID(), role: 'user', content: emptyContent() })
  }
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? (conv.title || 'New Tab'),
    conversationId: overrides.conversationId ?? conv.id,
    sections,
    activeModel: overrides.activeModel ?? conv.activeModel ?? null,
    createdAt: overrides.createdAt ?? (conv.created_at || Date.now()),
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

  'dez.model/tabs/activeIndex' (): number {
    const tabStore = useTabStore()
    return tabStore.tabs.findIndex((tab) => tab.id === tabStore.activeTabId)
  },

  'dez.model/activeTab' (): Tab {
    return cloneTab(useTabStore().activeTab) as Tab
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
    if (tabStore.activeTabId === tabId) {
      const newIndex = Math.min(index, tabStore.tabs.length - 1)
      tabStore.activeTabId = tabStore.tabs[newIndex].id
    }
    if (!tab.sections.some((section) => !sectionIsEmpty(section))) {
      void sbp('dez.persistence/deleteConversation', tab.conversationId).catch(() => {})
    }
  },

  'dez.model/tabs/switch' (tabId: string): void {
    const tabStore = useTabStore()
    if (tabStore.tabs.some((tab) => tab.id === tabId)) tabStore.activeTabId = tabId
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

  async 'dez.model/tabs/save' (tabId: string): Promise<void> {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !tab.sections.some((section) => !sectionIsEmpty(section))) return
    const data: ConversationData = {
      id: tab.conversationId,
      title: tab.title,
      sections: tab.sections.map((section) => ({
        role: section.role,
        nodes: section.content.map((node) => contentNodeToData(node)),
      })),
      activeModel: tab.activeModel,
      created_at: tab.createdAt,
    }
    try {
      await sbp('dez.persistence/saveConversation', data)
    } catch (error) {
      console.error('Failed to save conversation', error)
    }
  },

  async 'dez.model/tabs/saveActive' (): Promise<void> {
    await sbp('dez.model/tabs/save', useTabStore().activeTabId)
  },

  async 'dez.model/tabs/openConversation' (id: string): Promise<Tab | null> {
    const tabStore = useTabStore()
    try {
      const conversation = await sbp('dez.persistence/loadConversation', id) as ConversationData
      const tab = tabFromConversation(conversation)
      tabStore.tabs.push(tab)
      tabStore.activeTabId = tab.id
      await sbp('dez.model/appState/save')
      return cloneTab(tab) as Tab
    } catch (error) {
      console.error('Failed to open conversation', error)
      return null
    }
  },

  async 'dez.model/tabs/deleteConversation' (id: string): Promise<void> {
    const tabStore = useTabStore()
    try {
      await sbp('dez.persistence/deleteConversation', id)
    } catch (error) {
      console.error('Failed to delete conversation', error)
      return
    }

    const matchingTabs = tabStore.tabs.filter((tab) => tab.conversationId === id)
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
        showPillSeparators: settings.showPillSeparators,
        theme: settings.theme,
        defaultModels: settings.defaultModels,
        defaultNewTabModel: settings.defaultNewTabModel,
        lastUsedModel: settings.lastUsedModel,
        favorites: settings.favorites,
        checkForUpdates: settings.checkForUpdates,
        lastUpdateCheckAt: settings.lastUpdateCheckAt,
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
          title: tabData.title || conversation.title || 'New Tab',
          conversationId: tabData.conversationId,
          activeModel: tabData.activeModel ?? conversation.activeModel ?? null,
          createdAt: tabData.createdAt || conversation.created_at || Date.now(),
        }))
      } catch {
        restored.push({
          id: tabData.id,
          title: tabData.title || 'New Tab',
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

  'dez.model/thread/sectionsIdentity' (): string {
    return useTabStore().activeTab.sections.map((section) => `${section.id}:${section.role}`).join('|')
  },

  'dez.model/thread/submission' (): { role: Role; content: string }[] {
    return useTabStore().activeTab.sections
      .filter((section) => !sectionIsEmpty(section))
      .map((section) => ({ role: section.role, content: sectionPlainText(section) }))
  },

  'dez.model/streamMessagesForTab' (tabId: string): StreamMessage[] {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    return tab ? sectionsToStreamMessages(tab.sections).map((message) => ({ ...message })) : []
  },

  'dez.model/ensureTrailingAgentSectionForTab' (tabId: string): Section | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const section = tab ? ensureTrailingAgentSection(tab.sections) : null
    return section ? cloneSections([section])[0] as Section : null
  },

  'dez.model/appendTokenToTabSection' (tabId: string, sectionId: string, token: string): boolean {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const section = tab?.sections.find((candidate) => candidate.id === sectionId)
    if (!tab || !section) return false
    appendStreamingText(section, token)
    return true
  },

  'dez.model/ensureTrailingUserSectionForTab' (tabId: string): Section | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const section = tab ? ensureTrailingUserSection(tab.sections) : null
    return section ? cloneSections([section])[0] as Section : null
  },

  'dez.model/finalizeStreamSectionForTab' (tabId: string, sectionId: string, error: string | null): Section | null {
    const tab = useTabStore().tabs.find((candidate) => candidate.id === tabId)
    const section = tab?.sections.find((candidate) => candidate.id === sectionId)
    if (!tab || !section) return null
    fillEmptyAgentSectionOnError(section, error)
    if (section.role === 'agent') ensureTrailingUserSection(tab.sections)
    const title = firstUserTitle(tab.sections)
    if (title) tab.title = title
    return cloneSections([section])[0] as Section
  },

  'dez.model/addSection' (role: Role): Section {
    const section: Section = {
      id: crypto.randomUUID(),
      role,
      content: emptyContent(),
    }
    useTabStore().activeTab.sections.push(section)
    return cloneSections([section])[0] as Section
  },

  'dez.model/updateSectionContent' (id: string, text: string): void {
    const tab = useTabStore().activeTab
    const section = tab.sections.find((candidate) => candidate.id === id)
    if (!section) return
    setSectionPlainText(section, text)
    const title = firstUserTitle(tab.sections)
    if (title) tab.title = title
  },

  'dez.model/setSectionContent' (id: string, nodes: ContentNode[]): void {
    const tab = useTabStore().activeTab
    const section = tab.sections.find((candidate) => candidate.id === id)
    if (!section) return
    const normalized = normalizeContent(nodes)
    if (contentEquals(section.content, normalized)) return
    section.content.splice(0, section.content.length, ...normalized)
    const title = firstUserTitle(tab.sections)
    if (title) tab.title = title
  },

  'dez.model/toggleSectionRole' (id: string): void {
    const section = useTabStore().activeTab.sections.find((candidate) => candidate.id === id)
    if (section) section.role = section.role === 'user' ? 'agent' : 'user'
  },

  'dez.model/togglePromptExpanded' (sectionId: string, nodeId: string): void {
    const section = useTabStore().activeTab.sections.find((candidate) => candidate.id === sectionId)
    if (!section) return
    const node = section.content.find((candidate) => candidate.kind === 'prompt' && candidate.id === nodeId)
    if (node?.kind === 'prompt') node.expanded = !node.expanded
  },

  'dez.model/thread/removeSectionIfEmpty' (id: string): void {
    const sections = useTabStore().activeTab.sections
    const index = sections.findIndex((section) => section.id === id)
    if (index !== -1 && sectionIsEmpty(sections[index]) && sections.length > 1) sections.splice(index, 1)
  },

  'dez.model/thread/splitSection' (id: string, cursorPosition: number): Section | null {
    const sections = useTabStore().activeTab.sections
    const index = sections.findIndex((section) => section.id === id)
    if (index === -1) return null
    const current = sections[index]
    const [before, after] = splitContentAt(current.content, cursorPosition)
    current.content = before
    const newSection: Section = {
      id: crypto.randomUUID(),
      role: 'user',
      content: after,
    }
    sections.splice(index + 1, 0, newSection)
    return cloneSections([newSection])[0] as Section
  },

  'dez.model/thread/appendTokenToSection' (id: string, token: string): void {
    const section = useTabStore().activeTab.sections.find((candidate) => candidate.id === id)
    if (section) appendStreamingText(section, token)
  },

  'dez.model/clearThread' (): void {
    useTabStore().activeTab.sections = [
      { id: crypto.randomUUID(), role: 'user', content: emptyContent() },
    ]
  },

  async 'dez.model/settings/init' (onPersist?: () => void): Promise<unknown> {
    return useSettingsStore().init(onPersist)
  },

  'dez.model/settings/snapshot' (): SettingsSnapshot {
    return cloneSettings()
  },

  'dez.model/settings/showPillSeparators' (): boolean {
    return useSettingsStore().showPillSeparators
  },

  'dez.model/settings/theme' (): Theme {
    return useSettingsStore().theme
  },

  'dez.model/settings/defaultModels' (): Record<string, string> {
    return { ...useSettingsStore().defaultModels }
  },

  'dez.model/settings/defaultNewTabModel' (): DefaultModel | null {
    return cloneDefaultModel(useSettingsStore().defaultNewTabModel)
  },

  'dez.model/settings/lastUsedModel' (): DefaultModel | null {
    return cloneDefaultModel(useSettingsStore().lastUsedModel)
  },

  'dez.model/settings/favorites' (): DefaultModel[] {
    return useSettingsStore().favorites.map((favorite) => ({ ...favorite }))
  },

  'dez.model/settings/checkForUpdates' (): boolean {
    return useSettingsStore().checkForUpdates
  },

  'dez.model/settings/lastUpdateCheckAt' (): number | null {
    return useSettingsStore().lastUpdateCheckAt
  },

  'dez.model/settings/isOpen' (): boolean {
    return useSettingsStore().settingsOpen
  },

  'dez.model/settings/section' (): SettingsSection {
    return useSettingsStore().settingsSection
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

  'dez.model/settings/togglePillSeparators' (): void {
    const settings = useSettingsStore()
    settings.showPillSeparators = !settings.showPillSeparators
  },

  'dez.model/settings/setTheme' (theme: Theme): void {
    useSettingsStore().theme = theme
  },

  'dez.model/settings/setDefaultModel' (providerId: string, modelId: string): void {
    useSettingsStore().defaultModels[providerId] = modelId
  },

  'dez.model/settings/setDefaultNewTabModel' (model: DefaultModel | null): void {
    useSettingsStore().defaultNewTabModel = model ? { ...model } : null
  },

  'dez.model/settings/setLastUsedModel' (model: DefaultModel | null): void {
    useSettingsStore().lastUsedModel = model ? { ...model } : null
  },

  'dez.model/settings/setCheckForUpdates' (enabled: boolean): void {
    useSettingsStore().checkForUpdates = enabled
  },

  'dez.model/settings/setLastUpdateCheckAt' (timestamp: number | null): void {
    useSettingsStore().lastUpdateCheckAt = timestamp
  },

  'dez.model/settings/isFavorite' (providerId: string, modelId: string): boolean {
    return useSettingsStore().favorites.some(
      (favorite) => favorite.providerId === providerId && favorite.modelId === modelId,
    )
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

  async 'dez.model/prompts/init' (): Promise<void> {
    await usePromptsStore().init()
  },

  'dez.model/prompts/list' (): Prompt[] {
    return usePromptsStore().prompts.map(clonePrompt)
  },

  'dez.model/prompts/sorted' (): Prompt[] {
    return usePromptsStore().prompts.map(clonePrompt).sort((a, b) => a.name.localeCompare(b.name))
  },

  'dez.model/prompts/getByName' (name: string): Prompt | undefined {
    const prompt = usePromptsStore().prompts.find((candidate) => candidate.name === name)
    return prompt ? clonePrompt(prompt) : undefined
  },

  'dez.model/prompts/getById' (id: string): Prompt | undefined {
    const prompt = usePromptsStore().prompts.find((candidate) => candidate.id === id)
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

})
