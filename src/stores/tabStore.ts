import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Tab, Section, ActiveModel } from '../types/chat'
import { useSettingsStore } from './settingsStore'

interface SectionData {
  role: 'user' | 'agent'
  content: string
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

function createDefaultTab(): Tab {
  return {
    id: crypto.randomUUID(),
    title: 'New Tab',
    conversationId: crypto.randomUUID(),
    sections: [{ id: crypto.randomUUID(), role: 'user', content: '' }],
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
      const hasContent = tab.sections.some((s) => s.content.trim() !== '')
      if (!hasContent) {
        invoke('delete_conversation', { id: tab.conversationId }).catch(() => {})
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

  function updateTabTitle(tabId: string, title: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab) tab.title = title
  }

  function autoTitle(tabId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab) return
    const firstContent = tab.sections.find((s) => s.role === 'user' && s.content.trim())
    if (firstContent) {
      const text = firstContent.content.trim()
      tab.title = text.length > 30 ? text.slice(0, 30) + '…' : text
    }
  }

  async function saveTab(tabId: string): Promise<void> {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab) return
    const hasContent = tab.sections.some((s) => s.content.trim() !== '')
    if (!hasContent) return
    const data: ConversationData = {
      id: tab.conversationId,
      title: tab.title,
      sections: tab.sections.map((s) => ({ role: s.role, content: s.content })),
      activeModel: tab.activeModel,
      created_at: tab.createdAt,
    }
    try {
      await invoke('save_conversation', { data })
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
    }
  }

  async function saveAppState(): Promise<void> {
    try {
      await invoke('save_app_state', { state: serializeAppState() })
    } catch (e) {
      console.error('Failed to save app state', e)
    }
  }

  async function restoreFromState(appState: {
    tabs: TabData[]
    activeTabId: string | null
  }): Promise<void> {
    if (!appState.tabs || appState.tabs.length === 0) return

    const restored: Tab[] = []
    for (const td of appState.tabs) {
      try {
        const conv = await invoke<ConversationData>('load_conversation', {
          id: td.conversationId,
        })
        const sections: Section[] = conv.sections.map((s) => ({
          id: crypto.randomUUID(),
          role: s.role,
          content: s.content,
        }))
        if (sections.length === 0) {
          sections.push({ id: crypto.randomUUID(), role: 'user', content: '' })
        }
        restored.push({
          id: td.id,
          title: td.title || conv.title || 'New Tab',
          conversationId: td.conversationId,
          sections,
          activeModel: td.activeModel ?? conv.activeModel ?? null,
          createdAt: td.createdAt || conv.created_at || Date.now(),
        })
      } catch {
        // Conversation file missing: restore an empty tab with a new conversation id
        restored.push({
          id: td.id,
          title: td.title || 'New Tab',
          conversationId: td.conversationId,
          sections: [{ id: crypto.randomUUID(), role: 'user', content: '' }],
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
    switchTab,
    switchToIndex,
    cycleTab,
    updateTabTitle,
    autoTitle,
    saveTab,
    saveActiveTab,
    saveAppState,
    restoreFromState,
  }
})
