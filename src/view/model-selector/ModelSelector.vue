<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import type { ModelInfo } from '../../model/providers'
import ModelPicker from './ModelPicker.vue'
import ProviderSettingsPopup from './ProviderSettingsPopup.vue'

const { activeModel } = useModelState()

const isOpen = ref(false)
const settingsOpen = ref(false)
const dropdownEl = ref<HTMLElement | null>(null)
const picker = ref<InstanceType<typeof ModelPicker> | null>(null)

const displayName = computed(() => {
  if (activeModel.value) {
    return activeModel.value.modelName
  }
  return 'Select model'
})

function toggle() {
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

function open() {
  // The model dropdown and the provider-settings popup are mutually
  // exclusive; opening one closes the other.
  settingsOpen.value = false
  isOpen.value = true
  nextTick(() => picker.value?.focus())
}

function close() {
  isOpen.value = false
}

function selectModel(model: ModelInfo) {
  sbp('dez.model/setActiveModel', model.provider, model.id, model.name)
  close()
}

// Gear button: toggles the per-provider settings popup (not the Settings
// modal — API-key configuration stays reachable via ModelPicker's footer).
function toggleSettingsPopup() {
  close()
  settingsOpen.value = !settingsOpen.value
}

// ModelPicker footer "Configure Providers": opens the Settings modal on the
// providers section for API-key configuration.
function openProviderConfig() {
  close()
  settingsOpen.value = false
  sbp('dez.model/settings/open', 'providers')
}

function onClickOutside(e: MouseEvent) {
  if (dropdownEl.value && !dropdownEl.value.contains(e.target as Node)) {
    close()
    settingsOpen.value = false
  }
}

// This listener is on `document` in the capture phase (see onMounted), so an
// open dropdown or popup takes Esc before the editor and the global shortcut
// handler, which would else close find or stop the stream.
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && (isOpen.value || settingsOpen.value)) {
    e.stopPropagation()
    close()
    settingsOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside)
  document.addEventListener('keydown', onKeydown, true)
  sbp('dez.model/thread/initActiveModel')
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div ref="dropdownEl" class="model-selector">
    <button class="model-selector-btn" @click="toggle">
      <span class="model-selector-label">{{ displayName }}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="model-selector-chevron" :class="{ 'model-selector-chevron--open': isOpen }">
        <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <button class="model-selector-gear" title="Provider settings" @click="toggleSettingsPopup">
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
        <path d="M7 9a2 2 0 100-4 2 2 0 000 4z" fill="currentColor"/>
        <path d="M13 8.5l-1.3-.7a4.8 4.8 0 000-1.6L13 5.5l-1-1.7-1.4.4a4.7 4.7 0 00-1.4-.8L9 2H7l-.2 1.4a4.7 4.7 0 00-1.4.8L4 3.8 3 5.5l1.3.7a4.8 4.8 0 000 1.6L3 8.5l1 1.7 1.4-.4c.4.3.9.6 1.4.8L7 12h2l.2-1.4c.5-.2 1-.5 1.4-.8l1.4.4 1-1.7z" stroke="currentColor" stroke-width="1" fill="none"/>
      </svg>
    </button>

    <div v-if="isOpen" class="model-dropdown">
      <ModelPicker
        ref="picker"
        :selected-provider-id="activeModel?.providerId ?? null"
        :selected-model-id="activeModel?.modelId ?? null"
        show-favorites
        @select="selectModel"
        @configure="openProviderConfig"
      />
    </div>

    <ProviderSettingsPopup v-if="settingsOpen" />
  </div>
</template>

<style scoped>
/* The left part of the bottom bar (`AppLayout.vue`). It fills the bar's
   height, so the dropdown and the popup (`bottom: 100%`) open from the
   bar's top edge. */
.model-selector {
  position: relative;
  display: flex;
  align-items: center;
  align-self: stretch;
  gap: 4px;
  flex-shrink: 0;
}

.model-selector-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.model-selector-btn:hover {
  opacity: 1;
}

.model-selector-chevron {
  transition: transform 0.15s;
}

.model-selector-chevron--open {
  transform: rotate(180deg);
}

.model-selector-gear {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  opacity: 0.4;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}

.model-selector-gear:hover {
  opacity: 0.8;
}

.model-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 320px;
  max-height: 360px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  margin-bottom: 4px;
  z-index: 50;
}
</style>
