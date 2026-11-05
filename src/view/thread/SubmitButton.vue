<script setup lang="ts">
import { computed } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { isMacPlatform } from '../../utils/platform'

const { activeTabId, activeTabStreaming } = useModelState()

// The keycap names the key that does the same as a click: Cmd/Ctrl+Enter
// submits, and Esc stops the active tab's stream.
const face = computed(() => activeTabStreaming.value
  ? { label: 'Stop', keycap: 'Esc', shortcut: 'Esc' }
  : isMacPlatform
    ? { label: 'Submit', keycap: '⌘↩', shortcut: 'Cmd+Enter' }
    : { label: 'Submit', keycap: 'Ctrl+↩', shortcut: 'Ctrl+Enter' })

function onClick (event: MouseEvent): void {
  // The face changes as soon as a request starts or stops, so the second
  // click of a double-click would undo the first one (Submit then Stop, or
  // Stop then a new request). Only the first click of a series acts;
  // `detail` is 0 for a keyboard press and for `el.click()`.
  if (event.detail > 1) return
  if (activeTabStreaming.value) {
    void sbp('dez.stream/stop', activeTabId.value)
    return
  }
  // The same path as the key and Conversation › Send: the editor keymap
  // writes the doc to the store before it submits.
  sbp('dez.editor/runKeyBinding', 'Mod-Enter')
}
</script>

<template>
  <!-- `mousedown.prevent` keeps the focus and the caret where they are. -->
  <button
    class="submit-button"
    :title="`${face.label} (${face.shortcut})`"
    :aria-label="`${face.label} (${face.shortcut})`"
    @mousedown.prevent
    @click="onClick"
  >
    <span class="submit-button-label">{{ face.label }}</span>
    <kbd class="submit-button-keycap">{{ face.keycap }}</kbd>
  </button>
</template>

<style scoped>
.submit-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: border-color 0.15s;
}

.submit-button:hover {
  border-color: var(--color-muted);
}

.submit-button-keycap {
  font-family: inherit;
  font-size: 11px;
  opacity: 0.65;
}
</style>
