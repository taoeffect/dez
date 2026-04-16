import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Tab } from '../types/chat'
import { useSettingsStore } from './settingsStore'

function createDefaultTab(): Tab {
  return {
    id: crypto.randomUUID(),
    title: 'New Tab',
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
    if (tabs.value.length <= 1) return
    const index = tabs.value.findIndex((t) => t.id === tabId)
    if (index === -1) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === tabId) {
      const newIndex = Math.min(index, tabs.value.length - 1)
      activeTabId.value = tabs.value[newIndex].id
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
  }
})
