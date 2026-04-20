<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useStreaming, setStreamingCmView } from '../composables/useStreaming'
import { sectionIsEmpty } from '../types/content'
import {
  SECTION_SEP,
  buildInitialDoc,
  dezLanguageSupport,
  dezTheme,
  docToSections,
  initialSectionModels,
  roleSeparatorMouseHandler,
  roleSeparators,
  sectionsField,
  setSectionsEffect,
  setShowSeparatorsEffect,
  showSeparatorsField,
  splitSectionEffect,
} from './cmEditor'

const store = useThreadStore()
const tabStore = useTabStore()
const settings = useSettingsStore()
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

/** Count RS occurrences in [0, pos) so we know which section the cursor is in. */
function sectionIndexAtPos(doc: string, pos: number): number {
  let n = 0
  for (let i = 0; i < pos && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 0x1e) n++
  }
  return n
}

/** Flatten CM doc back into the given tab's `sections[]` using the live
 *  sectionsField for id + role preservation. */
function syncDocToTab(tabId: string) {
  if (!view) return
  const tab = tabStore.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const models = view.state.field(sectionsField)
  const sections = docToSections(view.state.doc.toString(), models)
  tab.sections.splice(0, tab.sections.length, ...sections)
  tabStore.autoTitle(tabId)
}

function syncDocToStore() {
  syncDocToTab(tabStore.activeTabId)
}

function buildState(): EditorState {
  const models = initialSectionModels(store.sections)
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
          const { from, to } = v.state.selection.main
          const doc = v.state.doc.toString()
          const afterIndex = sectionIndexAtPos(doc, from)
          const insert = `\n${SECTION_SEP}\n`
          v.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
            effects: splitSectionEffect.of({ afterIndex }),
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
      sectionsField.init(() => models),
      showSeparatorsField.init(() => settings.showPillSeparators),
      roleSeparators,
      roleSeparatorMouseHandler,
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

// External role toggles (from elsewhere) and separator-visibility toggle.
watch(
  () => settings.showPillSeparators,
  (v) => {
    if (view) view.dispatch({ effects: setShowSeparatorsEffect.of(v) })
  },
)

// If the active tab's sections change identity list from elsewhere (e.g.
// streaming appended a new agent section on this tab while mounted),
// mirror that into sectionsField so ids + roles stay aligned.
watch(
  () => store.sections.map((s) => `${s.id}:${s.role}`).join('|'),
  () => {
    if (!view) return
    const models = initialSectionModels(store.sections)
    // Only dispatch if the model list differs from the current one.
    const current = view.state.field(sectionsField)
    const same =
      current.length === models.length &&
      current.every((m, i) => m.id === models[i].id && m.role === models[i].role)
    if (same) return
    view.dispatch({ effects: setSectionsEffect.of(models) })
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
