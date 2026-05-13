import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Tab } from '../chat/types'
import { emptyContent } from '../chat/content'

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
    return tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value[0]
  })

  const activeTabIndex = computed(() => {
    return tabs.value.findIndex((tab) => tab.id === activeTabId.value)
  })

  return {
    tabs,
    activeTabId,
    activeTab,
    activeTabIndex,
  }
})
