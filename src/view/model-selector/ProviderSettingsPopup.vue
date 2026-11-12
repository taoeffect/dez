<script setup lang="ts">
import { computed } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { modelRefKey } from '../../model/chat/modelRef'
import { effectiveRequest, type ModelInfo, type ProviderSettingsDescriptor } from '../../model/providers'
import { lyricsHowTo } from '../../model/providers/clipText'
import {
  effectiveParameterValues,
  nearestRangeValue,
  type OptionsParameter,
  type ParameterValue,
  type RangeParameter,
  type SwitchParameter,
} from '../../model/providers/modelParameters'
import { toggleRows, toggleValue } from '../../model/providers/modelToggles'
import ProviderSettingsSwitch from './ProviderSettingsSwitch.vue'

const { activeModel, settings } = useModelState()

// Display name + the toggles that apply to the active model, read through
// the provider selector boundary (handles unknown/invalid provider ids by
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

// The toggles that apply to the active model (`modelToggles` and
// `toggleRows` in model/providers/modelToggles.ts): a model that takes no
// chat request gets none. A toggle that does not show keeps its stored
// value, as the values are per provider. An unknown provider (no
// descriptor) gets no rows.
const settingDefs = computed(() => (descriptor.value ? toggleRows(descriptor.value) : []))

function settingValue(key: string, defaultValue: boolean): boolean {
  const providerId = activeModel.value?.providerId
  if (!providerId) return defaultValue
  return toggleValue({ key, default: defaultValue }, settings.value.providerSettings[providerId])
}

function toggleSetting(key: string, defaultValue: boolean) {
  const providerId = activeModel.value?.providerId
  if (!providerId) return
  sbp('dez.model/settings/setProviderSetting', providerId, key, !settingValue(key, defaultValue))
}

// What the model cache knows of the active model, so it changes with the
// provider's model list.
const cachedModel = computed(() => {
  const model = activeModel.value
  return model ? sbp('dez.model/modelCache/model', model.providerId, model.modelId) as ModelInfo | null : null
})

// What a request to the active model can set (the length of a clip, a
// voice): only media models have parameters.
const parameters = computed(() => cachedModel.value?.parameters ?? [])

// Whether the popup has a value to set: a toggle or a parameter. A model
// with only a hint has nothing to reset.
const hasValues = computed(() => settingDefs.value.length > 0 || parameters.value.length > 0)

// Lyrics are a part of the message and not a parameter (`clipText` in
// model/providers/clipText.ts), so no row sets them. For a model that
// takes lyrics, the popup tells how to write them.
const lyricsHint = computed(() => {
  const lyrics = cachedModel.value?.text?.lyrics
  return lyrics ? lyricsHowTo(lyrics) : null
})

// An upscale takes an image and no text (`upscale` in
// model/providers/types.ts), which a message does not show, so the popup
// tells it.
const inputHint = computed(() => {
  const model = cachedModel.value
  if (!model || effectiveRequest(model) !== 'upscale') return null
  return 'This model makes an image larger. It takes one image (pasted, or named with @id); the text of the message is not sent.'
})

// The value that a request sends for each parameter now: the user's value,
// else the parameter's default. A parameter with neither has no entry.
const parameterValues = computed(() => {
  const model = activeModel.value
  return effectiveParameterValues(parameters.value, model ? settings.value.modelParameters[modelRefKey(model)] : undefined)
})

// null removes the user's value.
function setParameter(name: string, value: ParameterValue | null) {
  const model = activeModel.value
  if (model) sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: model.modelId }, name, value)
}

// The option values of a <select> are the indexes into the parameter's
// options, so that a number option stays a number (a DOM value is text).
// -1 is the "Default" entry of a parameter with no default of its own.
function optionIndex(parameter: OptionsParameter): number {
  const value = parameterValues.value[parameter.name]
  return parameter.options.findIndex((option) => option === value)
}

function chooseOption(parameter: OptionsParameter, event: Event) {
  const index = Number((event.target as HTMLSelectElement).value)
  setParameter(parameter.name, index >= 0 ? parameter.options[index] : null)
}

function rangeText(parameter: RangeParameter): string {
  const value = parameterValues.value[parameter.name]
  return value === undefined ? '' : String(value)
}

// An empty field removes the user's value. Any other number becomes the
// nearest one that the range takes.
function chooseNumber(parameter: RangeParameter, event: Event) {
  const input = event.target as HTMLInputElement
  const typed = input.value.trim() === '' ? Number.NaN : Number(input.value)
  setParameter(parameter.name, Number.isFinite(typed) ? nearestRangeValue(parameter, typed) : null)
  // Vue writes the field only when the bound value changes. It does not
  // when the new value is the old one (a second number over the range), so
  // the typed text would stay.
  input.value = rangeText(parameter)
}

function switchIsOn(parameter: SwitchParameter): boolean {
  return parameterValues.value[parameter.name] === true
}

// Only a value that differs from the default is stored, as for the
// provider toggles. A switch with no default is off, and then the request
// has no field for it.
function toggleSwitch(parameter: SwitchParameter) {
  const on = !switchIsOn(parameter)
  setParameter(parameter.name, on === (parameter.default ?? false) ? null : on)
}

// Resets the toggles that show and the active model's parameters.
function resetToDefaults() {
  const model = activeModel.value
  if (!model) return
  sbp('dez.model/settings/resetProviderSettings', model.providerId, settingDefs.value.map((def) => def.key), model.modelId)
}
</script>

<template>
  <div class="provider-settings-popup">
    <template v-if="activeModel && (hasValues || lyricsHint || inputHint)">
      <template v-if="settingDefs.length > 0">
        <div class="provider-settings-header">{{ providerName }}</div>
        <div class="provider-settings-rows">
          <ProviderSettingsSwitch
            v-for="def in settingDefs"
            :key="def.key"
            :label="def.label"
            :on="settingValue(def.key, def.default)"
            @toggle="toggleSetting(def.key, def.default)"
          />
        </div>
      </template>
      <template v-if="parameters.length > 0">
        <div class="provider-settings-header">Model Parameters</div>
        <div class="provider-settings-rows">
          <template v-for="parameter in parameters" :key="parameter.name">
            <label
              v-if="'options' in parameter || 'min' in parameter"
              class="provider-settings-parameter"
              :data-parameter="parameter.name"
            >
              <span class="provider-settings-label">{{ parameter.label }}</span>
              <select
                v-if="'options' in parameter"
                class="provider-settings-value provider-settings-select"
                :value="optionIndex(parameter)"
                @change="chooseOption(parameter, $event)"
              >
                <option v-if="parameter.default === undefined" :value="-1">Default</option>
                <option v-for="(option, index) in parameter.options" :key="index" :value="index">{{ option }}</option>
              </select>
              <!-- An empty field stands for the provider's own default, as
                   the "Default" entry of a select does. -->
              <input
                v-else
                class="provider-settings-value"
                type="number"
                :step="parameter.step ?? 1"
                :min="parameter.min"
                :max="parameter.max"
                :value="rangeText(parameter)"
                :placeholder="parameter.default === undefined ? 'Default' : ''"
                :title="`${parameter.min} to ${parameter.max}`"
                @change="chooseNumber(parameter, $event)"
              >
            </label>
            <ProviderSettingsSwitch
              v-else
              :data-parameter="parameter.name"
              :label="parameter.label"
              :on="switchIsOn(parameter)"
              @toggle="toggleSwitch(parameter)"
            />
          </template>
        </div>
      </template>
      <template v-if="inputHint">
        <div class="provider-settings-header">Input</div>
        <div class="provider-settings-hint">{{ inputHint }}</div>
      </template>
      <template v-if="lyricsHint">
        <div class="provider-settings-header">Lyrics</div>
        <div class="provider-settings-hint">{{ lyricsHint }}</div>
      </template>
      <button
        v-if="hasValues"
        class="provider-settings-reset"
        type="button"
        @click="resetToDefaults"
      >
        Reset to defaults
      </button>
    </template>
    <!-- A known provider has settings, but none for this model (a media
         model with no parameters, a chat model that takes no toggle). -->
    <div v-else class="provider-settings-empty">
      {{ !activeModel ? 'No provider selected' : descriptor ? 'No Settings for this model' : `No Settings for ${providerName}` }}
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

/* Also the label of a switch row (ProviderSettingsSwitch.vue): a scoped
   rule of this file reaches the root of a child component, but not the
   elements in it. */
.provider-settings-rows :deep(.provider-settings-label) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A row of the "Model Parameters" section: the label, then a select or a
   number field. A switch parameter has the row of a provider toggle
   (ProviderSettingsSwitch.vue). */
.provider-settings-parameter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  font-size: 13px;
}

.provider-settings-value {
  flex-shrink: 0;
  width: 110px;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background-color: var(--color-bg);
  color: var(--color-text);
  color-scheme: dark light;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.provider-settings-value:focus {
  border-color: var(--color-text);
}

/* The same arrow as the sort select of the history panel. */
.provider-settings-select {
  padding-right: 24px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  text-overflow: ellipsis;
  -webkit-appearance: none;
  appearance: none;
}

.provider-settings-select option {
  background: var(--color-bg);
  color: var(--color-text);
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

.provider-settings-hint {
  padding: 4px 12px 10px;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.7;
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
