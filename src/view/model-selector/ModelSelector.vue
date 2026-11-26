<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { UNKNOWN_PROVIDER, modelFactLines, modelFacts } from '../modelLabel'
import type { ModelInfo } from '../../model/providers'
import { MODEL_PICKER_SIZE_DEFAULT } from '../../model/modelPickerSize'
import ModelPicker from './ModelPicker.vue'
import PickerHandles from './PickerHandles.vue'
import ProviderSettingsPopup from './ProviderSettingsPopup.vue'
import { usePickerResize } from './pickerResize'

const { activeModel, settings, modelDisplayNames } = useModelState()

const isOpen = ref(false)
const settingsOpen = ref(false)
const dropdownEl = ref<HTMLElement | null>(null)
const picker = ref<InstanceType<typeof ModelPicker> | null>(null)
const pickerBox = ref<HTMLElement | null>(null)
const { shownSize, startResize } = usePickerResize(pickerBox, {
  storedSize: () => settings.value.modelPickerSize,
  min: MODEL_PICKER_SIZE_DEFAULT,
  save: (size) => sbp('dez.model/settings/setBoxSize', 'modelPicker', size),
})

// What the model button shows: the provider in a tag, then the model name.
// A router names some models after the company that made them ("Z.ai: GLM
// 5.3 FlashX" of TrustedRouter), so a name alone can read as a model of
// that company's own provider; the tag gives the provider a shape of its
// own. The provider name has no fallback (`modelLabel`: never a provider
// id, as custom ids are UUIDs), so an unknown or deleted provider says so.
// The name is the snapshot of the tab (`ActiveModel.modelName`), as before;
// the title and the accessible name tell the facts of the agent pill
// (`modelFacts`, `addModelToPill`), so a cut provider name is there in full.
const shownModel = computed(() => {
  const model = activeModel.value
  if (!model) return null
  const facts = modelFacts(model, modelDisplayNames.value)
  const provider = facts.providerName ?? UNKNOWN_PROVIDER
  return {
    name: model.modelName,
    provider,
    providerKnown: facts.providerName !== null,
    title: modelFactLines(facts).join('\n'),
    ariaLabel: `Model: ${facts.tooltipName}, Provider: ${provider}`,
  }
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

// A pick also loads the price and the context window of the model when its
// provider tells them in a price request, so that the bottom bar and the
// money limit show them before the first send.
function selectModel(model: ModelInfo) {
  sbp('dez.model/setActiveModel', model.provider, model.id, model.name)
  void sbp('dez.controller/modelCache/loadPrice', { providerId: model.provider, modelId: model.id })
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
    <button
      class="model-selector-btn"
      :class="{ 'model-selector-btn--open': isOpen }"
      :title="shownModel?.title"
      :aria-label="shownModel?.ariaLabel"
      @click="toggle"
    >
      <span
        v-if="shownModel"
        class="model-selector-provider"
        :class="{ 'model-selector-provider--unknown': !shownModel.providerKnown }"
      >{{ shownModel.provider }}</span>
      <span class="model-selector-label">{{ shownModel?.name ?? 'Select model' }}</span>
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

    <div
      v-if="isOpen"
      ref="pickerBox"
      class="model-dropdown"
      :style="{ width: `${shownSize.width}px`, maxHeight: `${shownSize.maxHeight}px` }"
    >
      <ModelPicker
        ref="picker"
        :selected-provider-id="activeModel?.providerId ?? null"
        :selected-model-id="activeModel?.modelId ?? null"
        show-favorites
        @select="selectModel"
        @configure="openProviderConfig"
      />
      <PickerHandles @press="startResize" />
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

/* Full opacity while the picker is open too, so the button does not fade
   next to its own picker. */
.model-selector-btn:hover,
.model-selector-btn--open {
  opacity: 1;
}

/* The provider of the model, in a box with a soft fill before the model
   name, so it reads as its own thing and not as the start of the name.
   Smaller than the name, and medium weight, not bold, so the name stays
   the main text. A long custom provider name is cut; the title tells it in
   full. A block with a line height, not a flex box: an ellipsis cuts only
   the text of a block. */
.model-selector-provider {
  display: block;
  height: 18px;
  line-height: 18px;
  max-width: 14em;
  flex-shrink: 0;
  margin-right: 2px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-text) 9%, transparent);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* An unknown or deleted provider: an outline with no fill, a missing
   source rather than a name. The border takes 2px of the line. */
.model-selector-provider--unknown {
  line-height: 16px;
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--color-text) 35%, transparent);
  font-style: italic;
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

/* `width` and `max-height` are set inline: the user's size
   (`pickerResize.ts`). */
.model-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
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
