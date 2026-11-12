<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";
import { useKeyboardShortcuts } from "../composables/useKeyboardShortcuts";
import { useModelState } from "../modelState";
import ThreadEditor from "../thread/ThreadEditor.vue";
import SettingsView from "../settings/SettingsView.vue";
import ModelSelector from "../model-selector/ModelSelector.vue";
import SubmitButton from "../thread/SubmitButton.vue";
import TabBar from "../tabs/TabBar.vue";
import HistoryPanel from "../history/HistoryPanel.vue";
import HelpView from "../help/HelpView.vue";
import ToastContainer from "../toast/ToastContainer.vue";
import ConfirmDialog from "../confirm/ConfirmDialog.vue";
import { shortcutKeyText } from "../../model/shortcuts";

useKeyboardShortcuts();
const { settings, shortcuts } = useModelState();

// Native file drops are off except on Linux (tauri.linux.conf.json; see run()
// in src-tauri/src/lib.rs), so on macOS a file dragged in from the desktop
// reaches the page as HTML5 drag events. The editor takes the ones over its
// text (`filePasteAndDrop`).
// Anywhere else the webview could open the dropped file in place of the
// app, so a file drag that no handler took is refused here.
function refuseFileDrag(event: DragEvent) {
  if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.type === "dragover") event.dataTransfer.dropEffect = "none";
}

onMounted(() => {
  window.addEventListener("dragover", refuseFileDrag);
  window.addEventListener("drop", refuseFileDrag);
});
onUnmounted(() => {
  window.removeEventListener("dragover", refuseFileDrag);
  window.removeEventListener("drop", refuseFileDrag);
});
</script>

<template>
  <div class="app-layout">
    <header class="tab-bar">
      <TabBar />
      <div class="tab-bar-actions">
        <button
          class="tab-bar-btn"
          :title="`History (${shortcutKeyText(shortcuts, 'history')})`"
          @click="sbp('dez.model/settings/historyOpen')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2a5 5 0 105 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M7 4.5V7l1.8 1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10.8 1.8V5H7.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="tab-bar-btn"
          :title="`Settings (${shortcutKeyText(shortcuts, 'settings')})`"
          @click="sbp('dez.model/settings/open', 'general')"
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
    <footer class="bottom-bar">
      <ModelSelector />
      <div class="bottom-bar-end">
        <SubmitButton />
        <!-- `mousedown.prevent` keeps the focus and the caret where they are. -->
        <button
          class="help-button"
          title="Help"
          aria-label="Help"
          @mousedown.prevent
          @click="sbp('dez.model/settings/helpOpen')"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M6.1 6.3a1.9 1.9 0 1 1 2.7 1.7c-.5.25-.8.6-.8 1.2v.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="8" cy="11.4" r=".8" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </footer>

    <HistoryPanel v-if="settings.historyOpen" @close="sbp('dez.model/settings/historyClose')" />
    <SettingsView v-if="settings.settingsOpen" />
    <HelpView v-if="settings.helpOpen" />
    <ConfirmDialog />
    <ToastContainer area="app-global" />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  --bottom-bar-height: 28px;
  /* ToastContainer keeps its toasts above this inset, so a sticky error
     toast never covers the bottom bar and its Submit/Stop button. */
  --toast-inset-bottom: var(--bottom-bar-height);
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

.bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: var(--bottom-bar-height);
  padding: 0 3px 0 8px;
  background-color: var(--color-tab-bar);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* Submit and Help at the right end of the bar. */
.bottom-bar-end {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* As the gear of ModelSelector.vue at the other end of the bar. */
.help-button {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
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

.help-button:hover {
  opacity: 0.8;
}
</style>
