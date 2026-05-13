<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { useTabStore } from '../../model/state/tabs'

const tabStore = useTabStore()
const tabElements = ref(new Map<string, HTMLElement>())

function setTabElement(tabId: string, element: unknown) {
  if (element instanceof HTMLElement) {
    tabElements.value.set(tabId, element)
  } else {
    tabElements.value.delete(tabId)
  }
}

async function scrollActiveTabIntoView() {
  await nextTick()

  const activeTabId = tabStore.activeTabId
  if (!activeTabId) return

  tabElements.value.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onWheel(e: WheelEvent) {
  const target = e.currentTarget as HTMLElement
  const maxScrollLeft = target.scrollWidth - target.clientWidth

  if (maxScrollLeft <= 0) return

  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, target.scrollLeft + delta))

  if (nextScrollLeft === target.scrollLeft) return

  e.preventDefault()
  target.scrollLeft = nextScrollLeft
}

function closeTab(tabId: string) {
  void sbp('dez.controller/closeTab', tabId)
}

function onMiddleClick(e: MouseEvent, tabId: string) {
  if (e.button === 1) {
    e.preventDefault()
    closeTab(tabId)
  }
}

watch(
  () => [tabStore.activeTabId, tabStore.tabs.length],
  scrollActiveTabIntoView,
  { immediate: true },
)
</script>

<template>
  <div class="tab-bar-tabs" @wheel="onWheel">
    <div
      v-for="tab in tabStore.tabs"
      :key="tab.id"
      :ref="(element) => setTabElement(tab.id, element)"
      class="tab"
      :class="{ 'tab--active': tab.id === tabStore.activeTabId }"
      @click="tabStore.switchTab(tab.id)"
      @mousedown="onMiddleClick($event, tab.id)"
    >
      <span class="tab-title">{{ tab.title }}</span>
      <button
        v-if="tabStore.tabs.length > 1"
        class="tab-close"
        title="Close tab"
        @click.stop="closeTab(tab.id)"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <button class="tab-new" title="New tab (Cmd/Ctrl+T)" @click="tabStore.createTab()">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.tab-bar-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-bar-tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
  max-width: 160px;
}

.tab:hover {
  opacity: 0.8;
  background: rgba(128, 128, 128, 0.1);
}

.tab--active {
  opacity: 1;
  background: rgba(128, 128, 128, 0.15);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tab-close {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  opacity: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.1s, background 0.1s;
}

.tab:hover .tab-close {
  opacity: 0.5;
}

.tab-close:hover {
  opacity: 1 !important;
  background: rgba(128, 128, 128, 0.2);
}

.tab-new {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.tab-new:hover {
  opacity: 0.8;
}
</style>
