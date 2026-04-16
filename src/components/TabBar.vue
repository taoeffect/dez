<script setup lang="ts">
import { useTabStore } from '../stores/tabStore'

const tabStore = useTabStore()

function onMiddleClick(e: MouseEvent, tabId: string) {
  if (e.button === 1) {
    e.preventDefault()
    tabStore.closeTab(tabId)
  }
}
</script>

<template>
  <div class="tab-bar-tabs">
    <div
      v-for="tab in tabStore.tabs"
      :key="tab.id"
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
        @click.stop="tabStore.closeTab(tab.id)"
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
