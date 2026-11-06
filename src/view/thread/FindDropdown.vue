<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { createFindQuery } from '../editor/find'
import { findHistory } from '../editor/findHistory'
import { findState } from '../editor/findState'
import { isModalOpen } from '../composables/useKeyboardShortcuts'
import { currentShortcutPlatform, matchShortcut, resolveShortcuts } from '../../model/shortcuts'

const findFieldShortcuts = resolveShortcuts(currentShortcutPlatform).filter((shortcut) => shortcut.scope === 'findField')

const searchRef = ref<HTMLTextAreaElement | null>(null)
const replaceRef = ref<HTMLTextAreaElement | null>(null)

const query = computed(() => createFindQuery(findState))
const invalidRegex = computed(() => query.value.search !== '' && !query.value.valid)

const statusText = computed(() => {
  if (invalidRegex.value) return 'Invalid regex'
  const status = findState.status
  if (!query.value.valid || !status) return ''
  if (status.total === 0) return 'No results'
  const total = `${status.total}${status.capped ? '+' : ''}`
  if (status.current !== null) return `${status.current} of ${total}`
  return status.total === 1 ? '1 result' : `${total} results`
})

// Each field shows one row per query line, up to 3 rows; more lines scroll
// inside the field.
const MAX_FIELD_ROWS = 3
function fieldRows(text: string): number {
  return Math.min(text.split('\n').length, MAX_FIELD_ROWS)
}

function focusSearch() {
  searchRef.value?.focus()
  searchRef.value?.select()
}

// Expanding moves focus to the replace field. Collapsing while that field
// has focus moves focus to the search field, so focus is not lost to
// <body> when the field is removed.
async function toggleReplace() {
  const replaceHadFocus = replaceRef.value !== null && document.activeElement === replaceRef.value
  findState.replaceOpen = !findState.replaceOpen
  if (findState.replaceOpen) {
    await nextTick()
    replaceRef.value?.focus()
  } else if (replaceHadFocus) {
    searchRef.value?.focus()
  }
}

// Keys typed here never reach the CodeMirror keymaps (they listen on the
// editor's contentDOM only), but they do bubble to the global shortcut
// handler on `window`. Stop Esc/Enter here so they act once; Mod-f/Mod-g
// are left to the global handler. Shift+Enter keeps the native newline.
// While a modal is open, Esc bubbles on so the global handler closes only
// the modal.
function handleFieldKeydown(e: KeyboardEvent, onEnter: () => void) {
  // WebKit on macOS fires the IME-confirming Enter after compositionend,
  // with isComposing false but keyCode 229.
  // https://bugs.webkit.org/show_bug.cgi?id=165004
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') {
    if (isModalOpen()) return
    e.preventDefault()
    e.stopPropagation()
    sbp('dez.editor/closeFind')
  } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    e.stopPropagation()
    onEnter()
  }
}

let measureContext: CanvasRenderingContext2D | null = null

// WebKit does not scroll a text field to a caret that script placed (only
// typing does), so scroll to the end of the text by hand: down to the last
// line, and right to the end of that line, measured with the field's font.
function scrollFieldToEnd(field: HTMLTextAreaElement) {
  field.scrollTop = field.scrollHeight
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) return
  const style = getComputedStyle(field)
  measureContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const lastLine = field.value.slice(field.value.lastIndexOf('\n') + 1)
  const caretX = parseFloat(style.paddingLeft) + measureContext.measureText(lastLine).width
  field.scrollLeft = caretX + parseFloat(style.paddingRight) - field.clientWidth
}

// Older search and Newer search load an older or a newer search. A bare
// ArrowUp (the default key) acts only on the first line, and a bare
// ArrowDown only on the last line; elsewhere in a multi-line search they
// move the caret. The search watcher in ThreadEditor.vue searches the
// recalled text.
async function recallHistory(e: KeyboardEvent, direction: 'older' | 'newer') {
  const field = searchRef.value
  if (!field) return
  const { value, selectionStart, selectionEnd } = field
  const bare = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  if (bare && e.key === 'ArrowUp' && value.slice(0, selectionStart).includes('\n')) return
  if (bare && e.key === 'ArrowDown' && value.slice(selectionEnd).includes('\n')) return
  const entry = direction === 'older' ? findHistory.older(value) : findHistory.newer()
  if (entry === null) return
  e.preventDefault()
  findState.search = entry
  // The caret goes to the end once v-model has written the new value and
  // the rows have grown.
  await nextTick()
  field.setSelectionRange(entry.length, entry.length)
  scrollFieldToEnd(field)
}

function onSearchKeydown(e: KeyboardEvent) {
  const shortcut = e.isComposing ? null : matchShortcut(findFieldShortcuts, e)
  if (shortcut) {
    void recallHistory(e, shortcut.id === 'olderSearch' ? 'older' : 'newer')
    return
  }
  handleFieldKeydown(e, () => sbp('dez.editor/selectFindMatch', 'next'))
}

function onReplaceKeydown(e: KeyboardEvent) {
  handleFieldKeydown(e, () => sbp('dez.editor/replaceFindMatches', 'current'))
}

onMounted(focusSearch)
// 'post' so a prefilled search is in the field before it is selected.
watch(() => findState.focusRequest, focusSearch, { flush: 'post' })
</script>

<template>
  <div class="find-dropdown" role="search">
    <button
      class="find-btn find-btn--chevron"
      :class="{ 'find-btn--expanded': findState.replaceOpen }"
      title="Toggle replace"
      :aria-expanded="findState.replaceOpen"
      @mousedown.prevent
      @click="toggleReplace"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <textarea
      ref="searchRef"
      v-model="findState.search"
      class="find-field"
      :class="{ 'find-field--invalid': invalidRegex }"
      :rows="fieldRows(findState.search)"
      wrap="off"
      placeholder="Find"
      aria-label="Find"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      @keydown="onSearchKeydown"
      @input="findHistory.resetBrowse()"
    />
    <div class="find-controls">
      <button
        class="find-btn find-btn--case"
        :class="{ 'find-btn--active': findState.caseSensitive }"
        aria-label="Case-sensitive search"
        :title="findState.caseSensitive ? 'Disable case-sensitive search' : 'Enable case-sensitive search'"
        :aria-pressed="findState.caseSensitive"
        @mousedown.prevent
        @click="findState.caseSensitive = !findState.caseSensitive"
      >
        <span aria-hidden="true">Aa</span>
      </button>
      <button
        class="find-btn find-btn--regex"
        :class="{ 'find-btn--active': findState.regexp }"
        aria-label="Regex search"
        :title="findState.regexp ? 'Disable regex' : 'Enable regex'"
        :aria-pressed="findState.regexp"
        @mousedown.prevent
        @click="findState.regexp = !findState.regexp"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="3.5" cy="10.5" r="1.3" fill="currentColor"/>
          <path d="M9.5 2v6M6.9 3.5l5.2 3M6.9 6.5l5.2-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
      <span class="find-status" aria-live="polite">{{ statusText }}</span>
      <button
        class="find-btn"
        title="Previous match (Shift+Cmd/Ctrl+G)"
        @mousedown.prevent
        @click="sbp('dez.editor/selectFindMatch', 'previous')"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 11.5v-9M3.5 6L7 2.5 10.5 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button
        class="find-btn"
        title="Next match (Enter, Cmd/Ctrl+G)"
        @mousedown.prevent
        @click="sbp('dez.editor/selectFindMatch', 'next')"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 2.5v9M3.5 8L7 11.5 10.5 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button
        class="find-btn"
        title="Close (Esc)"
        @mousedown.prevent
        @click="sbp('dez.editor/closeFind')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <template v-if="findState.replaceOpen">
      <textarea
        ref="replaceRef"
        v-model="findState.replace"
        class="find-field"
        :rows="fieldRows(findState.replace)"
        wrap="off"
        placeholder="Replace"
        aria-label="Replace"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        @keydown="onReplaceKeydown"
      />
      <div class="find-controls">
        <button
          class="find-btn find-btn--text"
          title="Replace (Enter)"
          @mousedown.prevent
          @click="sbp('dez.editor/replaceFindMatches', 'current')"
        >
          Replace
        </button>
        <button
          class="find-btn find-btn--text"
          @mousedown.prevent
          @click="sbp('dez.editor/replaceFindMatches', 'all')"
        >
          Replace all
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Anchored to `.editor-container`, which does not scroll, so the dropdown
   stays put while `.cm-scroller` scrolls under it. `right` leaves room for
   the scroller's scrollbar. A 3-column grid (chevron | field | controls)
   keeps the search and replace fields the same width. */
.find-dropdown {
  position: absolute;
  top: 8px;
  right: 24px;
  width: min(440px, calc(100% - 48px));
  padding: 6px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 2px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 50;
}

/* Top-aligned at the height of a one-row field (30px), so the controls stay
   level with the first line while a multi-line field grows. */
.find-controls {
  align-self: start;
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* `wrap="off"` with hidden horizontal overflow: a newline is part of the
   query, so a soft-wrapped long line must not look like one. Long lines
   scroll sideways like an <input> (the caret keeps itself in view). It
   also keeps rows equal to query lines, which the history's first/last
   line check relies on. */
.find-field {
  grid-column: 2;
  min-width: 0;
  margin-right: 4px;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  line-height: 18px;
  font-family: inherit;
  outline: none;
  resize: none;
  overflow-x: hidden;
  overflow-y: auto;
}

.find-field:focus {
  border-color: var(--color-text);
}

.find-field--invalid,
.find-field--invalid:focus {
  border-color: #e55;
}

.find-status {
  min-width: 84px;
  padding: 0 4px;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
  opacity: 0.7;
  user-select: none;
  -webkit-user-select: none;
}

.find-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.5;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s, background-color 0.15s;
}

.find-btn:hover {
  opacity: 0.9;
  background: var(--color-border);
}

.find-btn--active,
.find-btn--active:hover {
  opacity: 1;
  color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

/* Spans both rows when the replace row is shown, so it reads as the toggle
   for the whole dropdown. */
.find-btn--chevron {
  width: 18px;
  align-self: stretch;
  height: auto;
  min-height: 26px;
}

.find-btn--chevron.find-btn--expanded {
  grid-row: span 2;
}

.find-btn--chevron svg {
  transition: transform 0.15s;
}

.find-btn--expanded svg {
  transform: rotate(90deg);
}

.find-btn--case {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: -0.02em;
}

.find-btn--text {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
  opacity: 0.7;
}
</style>
