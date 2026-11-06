import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
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

  // Tabs whose reply ended while they were in the background, for the tab
  // bar. Session-only: never saved. The mark lasts until the tab is active
  // again; every path that activates a tab (switch, close, create, open,
  // delete, restore) sets `activeTabId`, so this one watch clears it. Sync,
  // so a read right after the switch already sees no mark.
  const replyDoneTabIds = ref(new Set<string>())
  watch(activeTabId, (tabId) => {
    replyDoneTabIds.value.delete(tabId)
  }, { flush: 'sync' })

  return {
    tabs,
    activeTabId,
    activeTab,
    activeTabIndex,
    replyDoneTabIds,
  }
})
