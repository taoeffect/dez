<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import { useStreaming, setStreamingCmView } from '../composables/useStreaming'
import { sectionIsEmpty, setSectionPlainText } from '../types/content'
import {
  buildInitialDoc,
  dezLanguageSupport,
  dezTheme,
} from './cmEditor'

const store = useThreadStore()
const tabStore = useTabStore()
const { isStreaming, streamingTabId, streamingError, startStreaming, stopStreaming } = useStreaming()

const hostRef = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

const isActiveTabStreaming = computed(
  () => isStreaming.value && streamingTabId.value === tabStore.activeTabId,
)

const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const last = store.sections[store.sections.length - 1]
  return last?.role === 'agent' && sectionIsEmpty(last)
})

/** Flatten CM doc back into a specific tab's `sections[0]` as plain text. */
function syncDocToTab(tabId: string) {
  if (!view) return
  const text = view.state.doc.toString()
  const tab = tabStore.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const first = tab.sections[0]
  if (!first) return
  setSectionPlainText(first, text)
  if (tab.sections.length > 1) {
    tab.sections.splice(1, tab.sections.length - 1)
  }
  tabStore.autoTitle(tabId)
}

function syncDocToStore() {
  syncDocToTab(tabStore.activeTabId)
}

function buildState(): EditorState {
  const submitKeymap = Prec.high(
    keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          syncDocToStore()
          void startStreaming()
          return true
        },
      },
      {
        key: 'Shift-Enter',
        preventDefault: true,
        run: (v) => {
          // Step 2 stub: plain newline. Real section split lands in step 3.
          const { from, to } = v.state.selection.main
          v.dispatch({
            changes: { from, to, insert: '\n' },
            selection: { anchor: from + 1 },
            scrollIntoView: true,
          })
          return true
        },
      },
    ]),
  )

  return EditorState.create({
    doc: buildInitialDoc(store.sections),
    extensions: [
      history(),
      submitKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      dezLanguageSupport(),
      dezTheme,
      EditorView.domEventHandlers({
        blur: () => {
          syncDocToStore()
          return false
        },
      }),
    ],
  })
}

function mountView() {
  if (!hostRef.value) return
  view = new EditorView({ state: buildState(), parent: hostRef.value })
  setStreamingCmView(view)
}

function resetViewToActiveTab() {
  if (!view) return
  view.setState(buildState())
}

onMounted(() => {
  mountView()
})

onBeforeUnmount(() => {
  syncDocToStore()
  setStreamingCmView(null)
  view?.destroy()
  view = null
})

// Rebuild state when the active tab changes — the CM doc is per-tab.
// Sync the previous tab's doc back to its sections BEFORE swapping so edits
// are not lost (the watcher fires after `activeTabId` has already updated,
// so we capture the previous id from the watcher args).
watch(
  () => tabStore.activeTabId,
  (_newId, oldId) => {
    if (oldId) syncDocToTab(oldId)
    nextTick(() => {
      resetViewToActiveTab()
    })
  },
)

// When streaming finishes on the active tab, the store gets a fresh empty
// user section. Rebuild CM state so the trailing sentinels/newlines line up.
watch(
  () => [isStreaming.value, streamingTabId.value] as const,
  ([streaming], [prevStreaming]) => {
    if (prevStreaming && !streaming) {
      nextTick(() => resetViewToActiveTab())
    }
  },
)
</script>

<template>
  <div class="editor-container">
    <div ref="hostRef" class="thread-editor" />
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
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.thread-editor :deep(.cm-editor) {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.thread-editor :deep(.cm-scroller) {
  overflow-y: auto;
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

.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

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

.stop-button:hover { opacity: 1; }
</style>
