<script setup lang="ts">
import { computed } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import type { ProviderSettingsDescriptor } from '../../model/providers'
import { THINKING_DEFAULT, THINKING_SETTING_KEY } from '../../model/providers/thinking'
import { TOOLS_DEFAULT, TOOLS_SETTING_KEY } from '../../model/providers/toolsSetting'

const { activeModel, settings } = useModelState()

// Display name + the toggles shown for the active model, read through the
// provider selector boundary (handles unknown/invalid provider ids by
// returning null) instead of importing the model registry into the view.
const descriptor = computed(() => {
  const providerId = activeModel.value?.providerId
  if (!providerId) return null
  return sbp('dez.provider/settingsDescriptor', providerId, activeModel.value?.modelId ?? '') as
    ProviderSettingsDescriptor | null
})

const providerName = computed(
  () => descriptor.value?.name ?? activeModel.value?.providerId ?? '',
)

// Dez's own toggles come first: Thinking (only for a provider with thinking),
// then Tools (every provider). They are stored with the config's toggles, so
// the rows share one code path, and "Reset to defaults" resets them too. An
// unknown provider (no descriptor) gets no rows.
const settingDefs = computed(() => {
  const current = descriptor.value
  if (!current) return []
  return [
    ...(current.supportsThinking ? [{ key: THINKING_SETTING_KEY, label: 'Thinking', default: THINKING_DEFAULT }] : []),
    { key: TOOLS_SETTING_KEY, label: 'Tools', default: TOOLS_DEFAULT },
    ...current.settings,
  ]
})

// Effective value: stored override if the user ever flipped the toggle,
// otherwise the descriptor default (stored settings are sparse).
function settingValue(key: string, defaultValue: boolean): boolean {
  const providerId = activeModel.value?.providerId
  if (!providerId) return defaultValue
  const stored = settings.value.providerSettings[providerId]?.[key]
  return typeof stored === 'boolean' ? stored : defaultValue
}

function toggleSetting(key: string, defaultValue: boolean) {
  const providerId = activeModel.value?.providerId
  if (!providerId) return
  sbp('dez.model/settings/setProviderSetting', providerId, key, !settingValue(key, defaultValue))
}

function resetToDefaults() {
  const providerId = activeModel.value?.providerId
  if (!providerId) return
  sbp('dez.model/settings/resetProviderSettings', providerId)
}
</script>

<template>
  <div class="provider-settings-popup">
    <template v-if="activeModel && settingDefs.length > 0">
      <div class="provider-settings-header">{{ providerName }}</div>
      <div class="provider-settings-rows">
        <button
          v-for="def in settingDefs"
          :key="def.key"
          class="provider-settings-row"
          type="button"
          role="switch"
          :aria-checked="settingValue(def.key, def.default)"
          @click="toggleSetting(def.key, def.default)"
        >
          <span class="provider-settings-label">{{ def.label }}</span>
          <span
            class="provider-settings-switch"
            :class="{ 'provider-settings-switch--on': settingValue(def.key, def.default) }"
          >
            <span class="provider-settings-knob"></span>
          </span>
        </button>
      </div>
      <button
        class="provider-settings-reset"
        type="button"
        @click="resetToDefaults"
      >
        Reset to defaults
      </button>
    </template>
    <div v-else class="provider-settings-empty">
      {{ activeModel ? `No Settings for ${providerName}` : 'No provider selected' }}
    </div>
  </div>
</template>

<style scoped>
.provider-settings-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 250px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  margin-bottom: 4px;
  z-index: 50;
}

.provider-settings-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text);
  opacity: 0.5;
  padding: 8px 12px 4px;
}

.provider-settings-rows {
  padding: 4px;
}

.provider-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.provider-settings-row:hover {
  background: var(--color-border);
}

.provider-settings-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-settings-switch {
  flex-shrink: 0;
  width: 28px;
  height: 16px;
  margin-left: 8px;
  border-radius: 8px;
  background: var(--color-border);
  display: inline-flex;
  align-items: center;
  padding: 2px;
  box-sizing: border-box;
  transition: background 0.15s;
}

.provider-settings-switch--on {
  background: var(--color-accent);
}

.provider-settings-knob {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-bg);
  transition: transform 0.15s;
}

.provider-settings-switch--on .provider-settings-knob {
  transform: translateX(12px);
}

.provider-settings-reset {
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-top: 1px solid var(--color-border);
  border-radius: 0 0 8px 8px;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  text-align: center;
  opacity: 0.6;
  cursor: pointer;
  transition: opacity 0.1s;
}

.provider-settings-reset:hover {
  opacity: 1;
}

.provider-settings-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-height: 72px;
  padding: 16px;
  font-size: 13px;
  opacity: 0.5;
}
</style>
