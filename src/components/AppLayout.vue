<script setup lang="ts">
import { useKeyboardShortcuts } from "../composables/useKeyboardShortcuts";
import { useChatStore } from "../stores/chatStore";
import ChatThread from "./ChatThread.vue";
import ChatInput from "./ChatInput.vue";

useKeyboardShortcuts();
const chatStore = useChatStore();
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <div class="tab-bar-tabs"></div>
      <div class="tab-bar-actions">
        <button
          class="tab-bar-btn"
          :class="{ 'tab-bar-btn--active': chatStore.showPillSeparators }"
          title="Toggle role labels"
          @click="chatStore.togglePillSeparators"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="5" width="12" height="4" rx="2" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </header>
    <main class="main-content">
      <ChatThread />
      <ChatInput />
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 8px;
  background-color: var(--color-tab-bar);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
}

.tab-bar-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.tab-bar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tab-bar-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}

.tab-bar-btn:hover {
  opacity: 0.8;
}

.tab-bar-btn--active {
  opacity: 0.7;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--color-bg);
}
</style>
