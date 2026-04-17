<script setup lang="ts">
import type { Prompt } from '../stores/promptsStore'

defineProps<{
  prompts: Prompt[]
  selectedIndex: number
  x: number
  y: number
}>()

const emit = defineEmits<{
  (e: 'select', prompt: Prompt): void
  (e: 'hover', index: number): void
}>()

function onClick(prompt: Prompt) {
  emit('select', prompt)
}
</script>

<template>
  <div
    class="prompt-autocomplete"
    :style="{ left: x + 'px', top: y + 'px' }"
    contenteditable="false"
    @mousedown.prevent
  >
    <div
      v-for="(p, i) in prompts"
      :key="p.id"
      class="ac-item"
      :class="{ 'ac-item--selected': i === selectedIndex }"
      @mouseenter="emit('hover', i)"
      @click="onClick(p)"
    >
      <div class="ac-name">{{ p.name }}</div>
      <div class="ac-preview">{{ p.content.split('\n')[0].slice(0, 80) }}</div>
    </div>
  </div>
</template>

<style scoped>
.prompt-autocomplete {
  position: fixed;
  z-index: 1000;
  min-width: 240px;
  max-width: 360px;
  max-height: 240px;
  overflow-y: auto;
  background-color: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  user-select: none;
  -webkit-user-select: none;
}

.ac-item {
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border);
}

.ac-item:last-child {
  border-bottom: none;
}

.ac-item--selected {
  background-color: var(--color-border);
}

.ac-name {
  color: var(--color-text);
  font-weight: 500;
}

.ac-preview {
  color: var(--color-text);
  opacity: 0.55;
  font-size: 11px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
