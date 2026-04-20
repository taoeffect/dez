<script setup lang="ts">
import { computed } from 'vue'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import { useStreaming } from '../composables/useStreaming'
import { sectionIsEmpty } from '../types/content'

// Step 1 of the codemirror migration: the legacy contenteditable editor has
// been removed. The CodeMirror view will be wired up in step 2. Until then
// the editor area is intentionally non-functional — this is a pre-release
// app with no users and the plan explicitly accepts an intermediate broken
// state (see `.agents/tasks/codemirror/PLAN.md`).

const store = useThreadStore()
const tabStore = useTabStore()
const { isStreaming, streamingTabId, streamingError, stopStreaming } = useStreaming()

const isActiveTabStreaming = computed(
  () => isStreaming.value && streamingTabId.value === tabStore.activeTabId,
)

const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const last = store.sections[store.sections.length - 1]
  return last?.role === 'agent' && sectionIsEmpty(last)
})
</script>

<template>
  <div class="editor-container">
    <div class="thread-editor thread-editor--placeholder">
      <p>CodeMirror editor not yet mounted (migration step 2).</p>
    </div>
    <div v-if="showThinking" class="thinking-indicator">
      <span class="thinking-dot" />
      <span class="thinking-dot" />
      <span class="thinking-dot" />
    </div>
    <div v-if="streamingError && !isActiveTabStreaming" class="stream-error">
      {{ streamingError }}
    </div>
    <button
      v-if="isActiveTabStreaming"
      class="stop-button"
      @click="stopStreaming"
    >
      Stop
    </button>
  </div>
</template>

<style scoped>
.editor-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.thread-editor {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 15px;
  line-height: 1.6;
  min-height: 100%;
  cursor: text;
  position: relative;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.thread-editor--placeholder {
  opacity: 0.4;
  font-style: italic;
}

.thinking-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--color-text);
  opacity: 0.4;
  animation: thinking-pulse 1.4s ease-in-out infinite;
}

.thinking-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.thinking-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes thinking-pulse {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 0.6; transform: scale(1); }
}

.stream-error {
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  color: #e55;
  font-size: 13px;
}

.stop-button {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg, #1e1e1e);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s;
}

.stop-button:hover {
  opacity: 1;
}
</style>
