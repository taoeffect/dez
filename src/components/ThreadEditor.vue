<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { EditorSelection, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { useThreadStore } from '../stores/threadStore'
import { useTabStore } from '../stores/tabStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePromptsStore, type Prompt } from '../stores/promptsStore'
import { useStreaming, setStreamingCmView } from '../composables/useStreaming'
import { sectionIsEmpty } from '../types/content'
import PromptAutocomplete from './PromptAutocomplete.vue'
import {
  SECTION_SEP,
  buildInitialDoc,
  encodePrompt,
  dezLanguageSupport,
  dezTheme,
  docToSections,
  initialPillMetadata,
  initialSectionModels,
  pillsField,
  promptAtomicRanges,
  parseClipboardText,
  promptPillMouseHandler,
  promptPills,
  roleSeparatorMouseHandler,
  roleSeparators,
  sectionsField,
  serializeDocRangeForClipboard,
  setPillsEffect,
  setSectionsEffect,
  setShowSeparatorsEffect,
  showSeparatorsField,
  splitSectionEffect,
} from './cmEditor'

const store = useThreadStore()
const tabStore = useTabStore()
const settings = useSettingsStore()
const promptsStore = usePromptsStore()
const { isStreaming, streamingTabId, streamingError, startStreaming, stopStreaming } = useStreaming()

const hostRef = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let pendingPersist: ReturnType<typeof setTimeout> | null = null

const autocompleteOpen = ref(false)
const autocompleteQuery = ref('')
const autocompleteFrom = ref(0)
const autocompleteTo = ref(0)
const autocompleteX = ref(0)
const autocompleteY = ref(0)
const autocompleteSelectedIndex = ref(0)

const isActiveTabStreaming = computed(
  () => isStreaming.value && streamingTabId.value === tabStore.activeTabId,
)

const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const last = store.sections[store.sections.length - 1]
  return last?.role === 'agent' && sectionIsEmpty(last)
})

const matchingPrompts = computed(() => {
  const q = autocompleteQuery.value.trim().toLowerCase()
  const prompts = promptsStore.prompts.slice().sort((a, b) => a.name.localeCompare(b.name))
  if (!q) return prompts
  return prompts.filter((p) => p.name.toLowerCase().includes(q))
})

/** Count RS occurrences in [0, pos) so we know which section the cursor is in. */
function sectionIndexAtPos(doc: string, pos: number): number {
  let n = 0
  for (let i = 0; i < pos && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 0x1e) n++
  }
  return n
}

function previousEditableLineInSection(state: EditorState, lineNumber: number) {
  if (lineNumber <= 1) return null
  const previous = state.doc.line(lineNumber - 1)
  return previous.text === SECTION_SEP ? null : previous
}

function moveLineUpWithinSection(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) {
    v.dispatch({
      selection: EditorSelection.cursor(range.from),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }

  const currentLine = state.doc.lineAt(range.head)
  const previousLine = previousEditableLineInSection(state, currentLine.number)
  const moved = v.moveVertically(range, false)
  const movedLine = state.doc.lineAt(moved.head)
  if (moved.head < range.head) {
    if (movedLine.number === currentLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    if (previousLine && movedLine.number === previousLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
  }

  if (!previousLine) return true

  const column = range.head - currentLine.from
  const target = previousLine.from + Math.min(column, previousLine.length)
  v.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/** Flatten CM doc back into the given tab's `sections[]` using the live
 *  sectionsField for id + role preservation. */
function persistTab(tabId: string) {
  void tabStore.saveTab(tabId)
  void tabStore.saveAppState()
}

function schedulePersistTab(tabId: string) {
  if (pendingPersist) clearTimeout(pendingPersist)
  pendingPersist = setTimeout(() => {
    pendingPersist = null
    persistTab(tabId)
  }, 200)
}

function syncDocToTab(tabId: string, persist = false) {
  if (!view) return
  const tab = tabStore.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const models = view.state.field(sectionsField)
  const meta = view.state.field(pillsField)
  const sections = docToSections(view.state.doc.toString(), models, meta)
  tab.sections.splice(0, tab.sections.length, ...sections)
  tabStore.autoTitle(tabId)
  if (persist) schedulePersistTab(tabId)
}

function syncDocToStore(persist = false) {
  syncDocToTab(tabStore.activeTabId, persist)
}

function closeAutocomplete() {
  autocompleteOpen.value = false
  autocompleteQuery.value = ''
  autocompleteSelectedIndex.value = 0
}

function updatePromptAutocomplete(v: EditorView) {
  const range = v.state.selection.main
  if (!v.hasFocus || !range.empty) {
    closeAutocomplete()
    return
  }
  const line = v.state.doc.lineAt(range.head)
  const before = line.text.slice(0, range.head - line.from)
  const match = /(^|[\t ])\/prompt ([^\s]*)$/.exec(before)
  if (!match) {
    closeAutocomplete()
    return
  }
  autocompleteQuery.value = match[2]
  const from = line.from + before.length - match[0].length + match[1].length
  autocompleteFrom.value = from
  autocompleteTo.value = range.head
  const coords = v.coordsAtPos(range.head)
  autocompleteX.value = coords?.left ?? 0
  autocompleteY.value = (coords?.bottom ?? 0) + 4
  if (matchingPrompts.value.length === 0) {
    closeAutocomplete()
    return
  }
  if (autocompleteSelectedIndex.value >= matchingPrompts.value.length) {
    autocompleteSelectedIndex.value = 0
  }
  autocompleteOpen.value = true
}

function acceptPrompt(prompt?: Prompt): boolean {
  if (!view || !autocompleteOpen.value) return false
  const selected = prompt ?? matchingPrompts.value[autocompleteSelectedIndex.value]
  if (!selected) return false
  const id = crypto.randomUUID()
  const insert = encodePrompt(id, selected.content, true)
  const meta = new Map(view.state.field(pillsField))
  meta.set(id, { promptId: selected.id, name: selected.name, expanded: false })
  view.dispatch({
    changes: { from: autocompleteFrom.value, to: autocompleteTo.value, insert },
    selection: { anchor: autocompleteFrom.value + insert.length },
    effects: setPillsEffect.of(meta),
    scrollIntoView: true,
  })
  closeAutocomplete()
  syncDocToStore(true)
  return true
}

function setClipboardText(event: ClipboardEvent, text: string) {
  event.clipboardData?.setData('text/plain', text)
}

function writeSelectionToClipboard(event: ClipboardEvent, cut: boolean, v: EditorView): boolean {
  const range = v.state.selection.main
  if (range.empty) return false
  const text = serializeDocRangeForClipboard(
    v.state.doc.toString(),
    range.from,
    range.to,
    v.state.field(sectionsField),
    v.state.field(pillsField),
  )
  event.preventDefault()
  setClipboardText(event, text)
  if (cut) {
    v.dispatch({
      changes: { from: range.from, to: range.to, insert: '' },
      selection: { anchor: range.from },
      scrollIntoView: true,
    })
    syncDocToStore(true)
  }
  return true
}

function pasteClipboardText(event: ClipboardEvent, v: EditorView): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text) return false
  const parsed = parseClipboardText(text)
  const range = v.state.selection.main
  const meta = new Map(v.state.field(pillsField))
  for (const [id, pill] of parsed.pills) meta.set(id, pill)
  v.dispatch({
    changes: { from: range.from, to: range.to, insert: parsed.text },
    selection: { anchor: range.from + parsed.text.length },
    effects: setPillsEffect.of(meta),
    scrollIntoView: true,
  })
  syncDocToStore(true)
  event.preventDefault()
  return true
}

function buildState(): EditorState {
  const models = initialSectionModels(store.sections)
  const pillMeta = initialPillMetadata(store.sections)
  const autocompleteKeymap = Prec.highest(
    keymap.of([
      {
        key: 'ArrowDown',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          autocompleteSelectedIndex.value =
            (autocompleteSelectedIndex.value + 1) % matchingPrompts.value.length
          return true
        },
      },
      {
        key: 'ArrowUp',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          autocompleteSelectedIndex.value =
            (autocompleteSelectedIndex.value - 1 + matchingPrompts.value.length) %
            matchingPrompts.value.length
          return true
        },
      },
      {
        key: 'Tab',
        preventDefault: true,
        run: () => acceptPrompt(),
      },
      {
        key: 'Enter',
        preventDefault: true,
        run: () => acceptPrompt(),
      },
      {
        key: 'Escape',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          closeAutocomplete()
          return true
        },
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => autocompleteOpen.value,
      },
    ]),
  )
  const submitKeymap = Prec.high(
    keymap.of([
      {
        key: 'ArrowUp',
        preventDefault: true,
        run: moveLineUpWithinSection,
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          syncDocToStore(true)
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
      pillsField.init(() => pillMeta),
      roleSeparators,
      roleSeparatorMouseHandler,
      promptPills,
      promptAtomicRanges,
      promptPillMouseHandler,
      history(),
      autocompleteKeymap,
      submitKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      dezLanguageSupport(),
      dezTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          updatePromptAutocomplete(update.view)
        }
      }),
      EditorView.domEventHandlers({
        copy: (event, v) => writeSelectionToClipboard(event, false, v),
        cut: (event, v) => writeSelectionToClipboard(event, true, v),
        paste: pasteClipboardText,
        blur: () => {
          syncDocToStore(true)
          closeAutocomplete()
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
  if (pendingPersist) {
    clearTimeout(pendingPersist)
    pendingPersist = null
  }
  syncDocToStore()
  persistTab(tabStore.activeTabId)
  setStreamingCmView(null)
  view?.destroy()
  view = null
})

// Rebuild state when the active tab changes — the CM doc is per-tab.
watch(
  () => tabStore.activeTabId,
  (_newId, oldId) => {
    if (oldId) syncDocToTab(oldId, true)
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
    <PromptAutocomplete
      v-if="autocompleteOpen && matchingPrompts.length > 0"
      :prompts="matchingPrompts"
      :selected-index="autocompleteSelectedIndex"
      :x="autocompleteX"
      :y="autocompleteY"
      @select="acceptPrompt"
      @hover="autocompleteSelectedIndex = $event"
    />
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
