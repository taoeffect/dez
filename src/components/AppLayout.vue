<script setup lang="ts">
import { useKeyboardShortcuts } from "../composables/useKeyboardShortcuts";
import { useSettingsStore } from "../stores/settingsStore";
import ThreadEditor from "./ThreadEditor.vue";
import SettingsView from "./SettingsView.vue";
import ModelSelector from "./ModelSelector.vue";
import TabBar from "./TabBar.vue";
import HistoryPanel from "./HistoryPanel.vue";
import ToastContainer from "./toast/ToastContainer.vue";

useKeyboardShortcuts();
const settingsStore = useSettingsStore();
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <TabBar />
      <div class="tab-bar-actions">
        <button
          class="tab-bar-btn"
          title="History (Cmd/Ctrl+H)"
          @click="settingsStore.openHistory"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2a5 5 0 105 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M7 4.5V7l1.8 1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10.8 1.8V5H7.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="tab-bar-btn"
          title="Settings (Cmd/Ctrl+,)"
          @click="settingsStore.openSettings('general')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 9a2 2 0 100-4 2 2 0 000 4z" fill="currentColor"/>
            <path d="M13 8.5l-1.3-.7a4.8 4.8 0 000-1.6L13 5.5l-1-1.7-1.4.4a4.7 4.7 0 00-1.4-.8L9 2H7l-.2 1.4a4.7 4.7 0 00-1.4.8L4 3.8 3 5.5l1.3.7a4.8 4.8 0 000 1.6L3 8.5l1 1.7 1.4-.4c.4.3.9.6 1.4.8L7 12h2l.2-1.4c.5-.2 1-.5 1.4-.8l1.4.4 1-1.7z" stroke="currentColor" stroke-width="1" fill="none"/>
          </svg>
        </button>
      </div>
    </header>
    <main class="main-content">
      <ThreadEditor />
    </main>
    <ModelSelector />

    <HistoryPanel v-if="settingsStore.historyOpen" @close="settingsStore.closeHistory" />
    <SettingsView v-if="settingsStore.settingsOpen" />
    <ToastContainer area="app-global" />
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
