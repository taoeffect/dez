<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { createFindQuery } from '../editor/find'
import { findState } from '../editor/findState'

const searchRef = ref<HTMLTextAreaElement | null>(null)

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

function focusSearch() {
  searchRef.value?.focus()
  searchRef.value?.select()
}

// Keys typed here never reach the CodeMirror keymaps (they listen on the
// editor's contentDOM only), but they do bubble to the global shortcut
// handler on `window`. Stop Esc/Enter here so they act once; Mod-f/Mod-g
// are left to the global handler. Shift+Enter keeps the native newline.
function onSearchKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    sbp('dez.editor/closeFind')
  } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    e.stopPropagation()
    sbp('dez.editor/selectFindMatch', 'next')
  }
}

onMounted(focusSearch)
// 'post' so a prefilled search is in the field before it is selected.
watch(() => findState.focusRequest, focusSearch, { flush: 'post' })
</script>

<template>
  <div class="find-dropdown" role="search">
    <div class="find-row">
      <textarea
        ref="searchRef"
        v-model="findState.search"
        class="find-field"
        :class="{ 'find-field--invalid': invalidRegex }"
        rows="1"
        placeholder="Find"
        aria-label="Find"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        @keydown="onSearchKeydown"
      />
      <button
        class="find-btn find-btn--toggle"
        :class="{ 'find-btn--active': findState.regexp }"
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
  </div>
</template>

<style scoped>
/* Anchored to `.editor-container`, which does not scroll, so the dropdown
   stays put while `.cm-scroller` scrolls under it. `right` leaves room for
   the scroller's scrollbar. */
.find-dropdown {
  position: absolute;
  top: 8px;
  right: 24px;
  width: min(440px, calc(100% - 48px));
  padding: 6px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 50;
}

.find-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.find-field {
  flex: 1;
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
</style>
