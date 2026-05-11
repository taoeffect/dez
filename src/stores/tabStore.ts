import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import sbp from '@sbp/sbp'
import type { Tab, Section, ActiveModel, ContentNode } from '../model/chat/types'
import { appendStreamingText, emptyContent, normalizeContent, sectionIsEmpty, sectionVisibleText } from '../model/chat/content'
import { sectionsToStreamMessages } from '../model/streams/messages'
import {
  ensureTrailingAgentSection,
  ensureTrailingUserSection,
  fillEmptyAgentSectionOnError,
} from '../model/streams/sections'
import type { StreamMessage } from '../model/streams/types'
import { useSettingsStore } from './settingsStore'

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

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string | null
  messageCount: number
  preview: string
}

interface TabData {
  id: string
  title: string
  conversationId: string
  activeModel: ActiveModel | null
  createdAt: number
}

function contentNodeToData(n: ContentNode): ContentNodeData {
  if (n.kind === 'text') return { kind: 'text', text: n.text }
  return {
    kind: 'prompt',
    id: n.id,
    promptId: n.promptId,
    name: n.name,
    body: n.body,
    expanded: n.expanded,
  }
}

function dataToContentNode(n: ContentNodeData): ContentNode {
  if (n.kind === 'text') return { kind: 'text', text: n.text }
  return {
    kind: 'prompt',
    id: n.id,
    promptId: n.promptId,
    name: n.name,
    body: n.body,
    expanded: false,
  }
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

export const useTabStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([createDefaultTab()])
  const activeTabId = ref<string>(tabs.value[0].id)

  const activeTab = computed<Tab>(() => {
    return tabs.value.find((t) => t.id === activeTabId.value) ?? tabs.value[0]
  })

  const activeTabIndex = computed(() => {
    return tabs.value.findIndex((t) => t.id === activeTabId.value)
  })

  function initActiveTabModel(tab: Tab) {
    const settings = useSettingsStore()
    if (settings.defaultNewTabModel) {
      tab.activeModel = {
        providerId: settings.defaultNewTabModel.providerId,
        modelId: settings.defaultNewTabModel.modelId,
        modelName: settings.defaultNewTabModel.modelId,
      }
    } else if (settings.lastUsedModel) {
      tab.activeModel = {
        providerId: settings.lastUsedModel.providerId,
        modelId: settings.lastUsedModel.modelId,
        modelName: settings.lastUsedModel.modelId,
      }
    }
  }

  function createTab(): Tab {
    const tab = createDefaultTab()
    initActiveTabModel(tab)
    tabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function closeTab(tabId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tabs.value.length <= 1) return
    const index = tabs.value.findIndex((t) => t.id === tabId)
    if (index === -1) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === tabId) {
      const newIndex = Math.min(index, tabs.value.length - 1)
      activeTabId.value = tabs.value[newIndex].id
    }
    // Delete empty conversation files; persist otherwise
    if (tab) {
      const hasContent = tab.sections.some((s) => !sectionIsEmpty(s))
      if (!hasContent) {
        sbp('dez.persistence/deleteConversation', tab.conversationId).catch(() => {})
      }
    }
  }

  function switchTab(tabId: string) {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId
    }
  }

  function switchToIndex(index: number) {
    if (index >= 0 && index < tabs.value.length) {
      activeTabId.value = tabs.value[index].id
    }
  }

  function cycleTab(direction: 1 | -1) {
    const idx = activeTabIndex.value
    const next = (idx + direction + tabs.value.length) % tabs.value.length
    activeTabId.value = tabs.value[next].id
  }

  function tabById(tabId: string): Tab | null {
    return tabs.value.find((t) => t.id === tabId) ?? null
  }

  function activeModelForTab(tabId: string): ActiveModel | null {
    return tabById(tabId)?.activeModel ?? null
  }

  function streamMessagesForTab(tabId: string): StreamMessage[] {
    const tab = tabById(tabId)
    return tab ? sectionsToStreamMessages(tab.sections) : []
  }

  function ensureTrailingAgentSectionForTab(tabId: string): Section | null {
    const tab = tabById(tabId)
    return tab ? ensureTrailingAgentSection(tab.sections) : null
  }

  function appendTokenToTabSection(tabId: string, sectionId: string, token: string): boolean {
    const tab = tabById(tabId)
    const section = tab?.sections.find((candidate) => candidate.id === sectionId)
    if (!tab || !section) return false
    appendStreamingText(section, token)
    return true
  }

  function ensureTrailingUserSectionForTab(tabId: string): Section | null {
    const tab = tabById(tabId)
    return tab ? ensureTrailingUserSection(tab.sections) : null
  }

  function finalizeStreamSectionForTab(tabId: string, sectionId: string, error: string | null): Section | null {
    const tab = tabById(tabId)
    const section = tab?.sections.find((candidate) => candidate.id === sectionId)
    if (!tab || !section) return null
    fillEmptyAgentSectionOnError(section, error)
    if (section.role === 'agent') ensureTrailingUserSection(tab.sections)
    autoTitle(tabId)
    return section
  }

  function updateTabTitle(tabId: string, title: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab) tab.title = title
  }

  function autoTitle(tabId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab) return
    const firstContent = tab.sections.find((s) => s.role === 'user' && sectionVisibleText(s).trim())
    if (firstContent) {
      const text = sectionVisibleText(firstContent).trim()
      tab.title = text.length > 30 ? text.slice(0, 30) + '…' : text
    }
  }

  async function saveTab(tabId: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab) return
    const hasContent = tab.sections.some((s) => !sectionIsEmpty(s))
    if (!hasContent) return
    const data: ConversationData = {
      id: tab.conversationId,
      title: tab.title,
      sections: tab.sections.map((s) => ({
        role: s.role,
        nodes: s.content.map((n) => contentNodeToData(n)),
      })),
      activeModel: tab.activeModel,
      created_at: tab.createdAt,
    }
    try {
      await sbp('dez.persistence/saveConversation', data)
    } catch (e) {
      console.error('Failed to save conversation', e)
    }
  }

  async function saveActiveTab(): Promise<void> {
    await saveTab(activeTabId.value)
  }

  function serializeAppState() {
    const settings = useSettingsStore()
    const tabsData: TabData[] = tabs.value.map((t) => ({
      id: t.id,
      title: t.title,
      conversationId: t.conversationId,
      activeModel: t.activeModel,
      createdAt: t.createdAt,
    }))
    return {
      tabs: tabsData,
      activeTabId: activeTabId.value,
      showPillSeparators: settings.showPillSeparators,
      theme: settings.theme,
      defaultModels: settings.defaultModels,
      defaultNewTabModel: settings.defaultNewTabModel,
      lastUsedModel: settings.lastUsedModel,
      favorites: settings.favorites,
      checkForUpdates: settings.checkForUpdates,
      lastUpdateCheckAt: settings.lastUpdateCheckAt,
    }
  }

  async function saveAppState(): Promise<void> {
    try {
      await sbp('dez.persistence/saveAppState', serializeAppState())
    } catch (e) {
      console.error('Failed to save app state', e)
    }
  }

  function tabFromConversation(conv: ConversationData, overrides: Partial<Tab> = {}): Tab {
    const sections: Section[] = conv.sections.map((s) => ({
      id: crypto.randomUUID(),
      role: s.role,
      content: normalizeContent(s.nodes.map((n) => dataToContentNode(n))),
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

  async function openConversationInNewTab(id: string): Promise<Tab | null> {
    try {
      const conv = await sbp('dez.persistence/loadConversation', id) as ConversationData
      const tab = tabFromConversation(conv)
      tabs.value.push(tab)
      activeTabId.value = tab.id
      await saveAppState()
      return tab
    } catch (e) {
      console.error('Failed to open conversation', e)
      return null
    }
  }

  async function deleteConversationById(id: string): Promise<void> {
    try {
      await sbp('dez.persistence/deleteConversation', id)
    } catch (e) {
      console.error('Failed to delete conversation', e)
      return
    }

    const matchingTabs = tabs.value.filter((t) => t.conversationId === id)
    if (!matchingTabs.length) {
      await saveAppState()
      return
    }

    if (matchingTabs.length === tabs.value.length) {
      const replacement = createDefaultTab()
      initActiveTabModel(replacement)
      tabs.value = [replacement]
      activeTabId.value = replacement.id
      await saveAppState()
      return
    }

    const deletedActive = matchingTabs.some((t) => t.id === activeTabId.value)
    tabs.value = tabs.value.filter((t) => t.conversationId !== id)
    if (deletedActive) {
      activeTabId.value = tabs.value[0].id
    }
    await saveAppState()
  }

  async function restoreFromState(appState: {
    tabs: TabData[]
    activeTabId: string | null
  }): Promise<void> {
    if (!appState.tabs || appState.tabs.length === 0) return

    const restored: Tab[] = []
    for (const td of appState.tabs) {
      try {
        const conv = await sbp('dez.persistence/loadConversation', td.conversationId) as ConversationData
        restored.push(tabFromConversation(conv, {
          id: td.id,
          title: td.title || conv.title || 'New Tab',
          conversationId: td.conversationId,
          activeModel: td.activeModel ?? conv.activeModel ?? null,
          createdAt: td.createdAt || conv.created_at || Date.now(),
        }))
      } catch {
        // Conversation file missing: restore an empty tab with a new conversation id
        restored.push({
          id: td.id,
          title: td.title || 'New Tab',
          conversationId: td.conversationId,
          sections: [{ id: crypto.randomUUID(), role: 'user', content: emptyContent() }],
          activeModel: td.activeModel ?? null,
          createdAt: td.createdAt || Date.now(),
        })
      }
    }

    if (restored.length > 0) {
      tabs.value = restored
      const target = appState.activeTabId && restored.find((t) => t.id === appState.activeTabId)
      activeTabId.value = target ? target.id : restored[0].id
    }
  }

  // Initialize model for the first default tab
  initActiveTabModel(tabs.value[0])

  return {
    tabs,
    activeTabId,
    activeTab,
    activeTabIndex,
    createTab,
    closeTab,
    tabById,
    activeModelForTab,
    streamMessagesForTab,
    ensureTrailingAgentSectionForTab,
    appendTokenToTabSection,
    ensureTrailingUserSectionForTab,
    finalizeStreamSectionForTab,
    switchTab,
    switchToIndex,
    cycleTab,
    updateTabTitle,
    autoTitle,
    saveTab,
    saveActiveTab,
    saveAppState,
    openConversationInNewTab,
    deleteConversationById,
    restoreFromState,
  }
})
