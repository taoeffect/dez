<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState, type SettingsSection, type Theme } from '../modelState'
import type { ModelInfo } from '../../model/providers'
import PromptManager from '../prompts/PromptManager.vue'
import ProviderManager from './ProviderManager.vue'
import ModelPicker from '../model-selector/ModelPicker.vue'
import ShortcutManager from './ShortcutManager.vue'
import SystemPromptSettings from './SystemPromptSettings.vue'
import { CLEANUP_BUTTONS, deleteUnreferenced, runningCleanup } from './unusedFiles'

const { settings, modelCache } = useModelState()

// Searchable picker for the "Default model" setting of new tabs, replacing the
// old unsearchable native <select>. Reuses the same ModelPicker as the
// bottom-left model selector so the two stay DRY.
const defaultModelPickerOpen = ref(false)
const defaultModelPickerEl = ref<HTMLElement | null>(null)
const defaultModelPicker = ref<InstanceType<typeof ModelPicker> | null>(null)

const defaultNewTabModelLabel = computed(() => {
  const m = settings.value.defaultNewTabModel
  if (!m) return 'None (use last used)'
  // settingsDescriptor reads custom configs from the store, so a rename in
  // Settings › Providers shows here at once.
  const provider = sbp('dez.provider/settingsDescriptor', m.providerId, m.modelId) as { name: string } | null
  const model = modelCache.value.providers[m.providerId]?.models.find((x) => x.id === m.modelId)
  return `${provider?.name ?? m.providerId} — ${model?.name ?? m.modelId}`
})

function toggleDefaultModelPicker() {
  if (defaultModelPickerOpen.value) {
    closeDefaultModelPicker()
  } else {
    defaultModelPickerOpen.value = true
    nextTick(() => defaultModelPicker.value?.focus())
  }
}

function closeDefaultModelPicker() {
  defaultModelPickerOpen.value = false
}

function selectDefaultNewTabModel(model: ModelInfo) {
  sbp('dez.model/settings/setDefaultNewTabModel', { providerId: model.provider, modelId: model.id })
  closeDefaultModelPicker()
}

function clearDefaultNewTabModel() {
  sbp('dez.model/settings/setDefaultNewTabModel', null)
  closeDefaultModelPicker()
}

function onDefaultModelClickOutside(e: MouseEvent) {
  if (defaultModelPickerEl.value && !defaultModelPickerEl.value.contains(e.target as Node)) {
    closeDefaultModelPicker()
  }
}
const sectionLabels: Record<SettingsSection, string> = {
  general: 'General',
  providers: 'Providers',
  prompts: 'Prompts',
  systemPrompt: 'System Prompt',
  appearance: 'Appearance',
  notifications: 'Notifications',
  shortcuts: 'Shortcuts',
}
// The nav order is the key order of `sectionLabels`.
const sections = Object.keys(sectionLabels) as SettingsSection[]

// Providers and Prompts fill the content pane and scroll inside their own
// lists, so the pane itself never scrolls for them. Its scrollbar gutter
// would only add an empty strip next to theirs.
const contentScrolls = computed(() => settings.value.settingsSection !== 'providers' && settings.value.settingsSection !== 'prompts')

const checkingUpdates = ref(false)
// A Vite define: a template reaches only the names of its component.
const appVersion = __APP_VERSION__

const themes: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

onMounted(() => {
  document.addEventListener('mousedown', onDefaultModelClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDefaultModelClickOutside)
})

async function manuallyCheckForUpdates() {
  checkingUpdates.value = true
  try {
    await sbp('dez.controller/checkForUpdates')
  } finally {
    checkingUpdates.value = false
  }
}

// Each slider step saves the volume, so the label follows the thumb. The
// preview plays only when the user commits a value: `change` fires on the
// pointer release that ends a drag or a click on the track (and on each
// arrow key press), never on the steps of a drag.
function onDoneSoundVolumeInput(e: Event) {
  sbp('dez.model/settings/setDoneSoundVolume', Number((e.target as HTMLInputElement).value))
}

function onDoneSoundVolumeChange() {
  sbp('dez.ui/playDoneSound', settings.value.doneSoundVolume)
}

function onClose() {
  sbp('dez.model/settings/close')
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('settings-overlay')) {
    onClose()
  }
}
</script>

<template>
  <div class="settings-overlay" @click="onOverlayClick">
    <div class="settings-modal">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close" @click="onClose" title="Close (Esc)">×</button>
      </div>

      <div class="settings-body">
        <nav class="settings-nav">
          <button
            v-for="s in sections"
            :key="s"
            class="settings-nav-btn"
            :class="{ 'settings-nav-btn--active': settings.settingsSection === s }"
            @click="sbp('dez.model/settings/setSection', s)"
          >
            {{ sectionLabels[s] }}
          </button>
        </nav>

        <div class="settings-content" :class="{ 'settings-scroller': contentScrolls }">
          <!-- Providers -->
          <div v-if="settings.settingsSection === 'providers'" class="settings-section settings-section--fill">
            <ProviderManager />
          </div>

          <!-- Prompts -->
          <div v-if="settings.settingsSection === 'prompts'" class="settings-section settings-section--fill">
            <PromptManager />
          </div>

          <!-- System Prompt -->
          <SystemPromptSettings v-if="settings.settingsSection === 'systemPrompt'" />

          <!-- Appearance -->
          <div v-if="settings.settingsSection === 'appearance'" class="settings-section">
            <div class="settings-row">
              <label class="settings-label">Theme</label>
              <div class="settings-btn-group">
                <button
                  v-for="t in themes"
                  :key="t.value"
                  class="settings-btn"
                  :class="{ 'settings-btn--active': settings.theme === t.value }"
                  @click="sbp('dez.model/settings/setTheme', t.value)"
                >
                  {{ t.label }}
                </button>
              </div>
            </div>
          </div>

          <!-- Notifications -->
          <div v-if="settings.settingsSection === 'notifications'" class="settings-section">
            <div class="settings-group">
              <label class="settings-checkbox-row">
                <input
                  type="checkbox"
                  class="done-sound-checkbox"
                  :checked="settings.doneSound"
                  @change="sbp('dez.model/settings/setDoneSound', !settings.doneSound)"
                />
                Play a sound when a reply ends
              </label>
              <div class="notifications-indented notifications-volume" :class="{ 'notifications-volume--disabled': !settings.doneSound }">
                <label class="settings-label" for="done-sound-volume">Volume</label>
                <input
                  id="done-sound-volume"
                  type="range"
                  class="done-sound-volume"
                  min="0"
                  max="100"
                  step="1"
                  :value="settings.doneSoundVolume"
                  :disabled="!settings.doneSound"
                  :style="{ '--volume-fill': `${settings.doneSoundVolume}%` }"
                  @input="onDoneSoundVolumeInput"
                  @change="onDoneSoundVolumeChange"
                />
                <span class="done-sound-volume-value">{{ settings.doneSoundVolume }}%</span>
              </div>
            </div>

            <div class="settings-group">
              <label class="settings-checkbox-row">
                <input
                  type="checkbox"
                  class="done-notification-checkbox"
                  :checked="settings.doneNotification"
                  @change="sbp('dez.model/settings/setDoneNotification', !settings.doneNotification)"
                />
                Show a system notification when a reply ends
              </label>
              <p class="notifications-indented settings-hint">Click the notification to go to the tab of the reply.</p>
            </div>

            <p class="settings-hint">
              Alerts come only for a reply that finishes or fails while you are not looking at it:
              in another tab, while you use another window, or when you have been away from the
              computer for more than 1 minute.
            </p>
          </div>

          <!-- Shortcuts -->
          <div v-if="settings.settingsSection === 'shortcuts'" class="settings-section">
            <ShortcutManager />
          </div>

          <!-- General: titled groups of boxed rows (see the CSS of
               `.settings-card`). Each control is tied to its row: by
               `aria-labelledby` when it has no text of its own (the toggle)
               or its text is a value (the picker), and by
               `aria-describedby` to the hint of its row. -->
          <div v-if="settings.settingsSection === 'general'" class="settings-section">
            <div class="settings-card-group" role="group" aria-labelledby="general-new-tabs-title">
              <h3 id="general-new-tabs-title" class="settings-title settings-card-title">New tabs</h3>
              <div class="settings-card">
                <div class="settings-card-row">
                  <div class="settings-card-text">
                    <span id="general-default-model-label" class="settings-card-label">Default model</span>
                    <p id="general-default-model-hint" class="settings-hint">A new tab starts with this model.</p>
                  </div>
                  <div ref="defaultModelPickerEl" class="settings-model-picker">
                    <button
                      class="settings-model-trigger"
                      aria-labelledby="general-default-model-label general-default-model-value"
                      aria-describedby="general-default-model-hint"
                      @click="toggleDefaultModelPicker"
                    >
                      <span id="general-default-model-value" class="settings-model-trigger-label">{{ defaultNewTabModelLabel }}</span>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="settings-model-chevron" :class="{ 'settings-model-chevron--open': defaultModelPickerOpen }">
                        <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                    <div v-if="defaultModelPickerOpen" class="settings-model-dropdown">
                      <ModelPicker
                        ref="defaultModelPicker"
                        :selected-provider-id="settings.defaultNewTabModel?.providerId ?? null"
                        :selected-model-id="settings.defaultNewTabModel?.modelId ?? null"
                        none-label="None (use last used)"
                        :show-footer="false"
                        @select="selectDefaultNewTabModel"
                        @select-none="clearDefaultNewTabModel"
                        @configure="closeDefaultModelPicker"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card-group" role="group" aria-labelledby="general-updates-title">
              <h3 id="general-updates-title" class="settings-title settings-card-title">Updates</h3>
              <div class="settings-card">
                <div class="settings-card-row">
                  <div class="settings-card-text">
                    <span id="general-auto-update-label" class="settings-card-label">Check for updates automatically</span>
                    <p id="general-auto-update-hint" class="settings-hint">
                      Once a day, Dez asks GitHub for a newer version, and tells you when one is out.
                    </p>
                  </div>
                  <button
                    class="settings-toggle"
                    :class="{ 'settings-toggle--on': settings.checkForUpdates }"
                    role="switch"
                    :aria-checked="settings.checkForUpdates"
                    aria-labelledby="general-auto-update-label"
                    aria-describedby="general-auto-update-hint"
                    @click="sbp('dez.model/settings/setCheckForUpdates', !settings.checkForUpdates)"
                  >
                    <span class="settings-toggle-knob" />
                  </button>
                </div>
                <!-- The version is what the check compares, so the button
                     that checks now sits next to it. -->
                <div class="settings-card-row">
                  <div class="settings-card-text">
                    <span class="settings-card-label">Current version</span>
                    <p id="general-version-hint" class="settings-hint">Dez {{ appVersion }}</p>
                  </div>
                  <button
                    class="settings-btn settings-btn--sm"
                    :disabled="checkingUpdates"
                    aria-describedby="general-version-hint"
                    @click="manuallyCheckForUpdates()"
                  >
                    {{ checkingUpdates ? 'Checking…' : 'Check Now' }}
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-card-group" role="group" aria-labelledby="general-storage-title">
              <h3 id="general-storage-title" class="settings-title settings-card-title">Storage</h3>
              <div class="settings-card">
                <div class="settings-card-row">
                  <div class="settings-card-text">
                    <span class="settings-card-label">Dez folder</span>
                    <p id="general-folder-hint" class="settings-hint">Where Dez keeps your conversations, settings, and files.</p>
                  </div>
                  <button
                    class="settings-btn settings-btn--sm"
                    aria-describedby="general-folder-hint"
                    @click="sbp('dez.controller/openAppFolder')"
                  >
                    Open Dez Folder
                  </button>
                </div>
                <!-- One label and one hint for both cleanups: the label of
                     each button names its kind. The bar of a cleanup that
                     runs goes under the text and the buttons. -->
                <div class="settings-card-row">
                  <div class="settings-card-text">
                    <span id="general-unreferenced-label" class="settings-card-label">Unreferenced files and apps</span>
                    <p id="general-unreferenced-hint" class="settings-hint">
                      Removes old images, audio, video, and apps (with all their files) that no
                      conversation or prompt references.
                    </p>
                  </div>
                  <div class="unreferenced-buttons" role="group" aria-labelledby="general-unreferenced-label">
                    <button
                      class="settings-btn settings-btn--sm unused-files-btn"
                      :disabled="runningCleanup !== null"
                      aria-describedby="general-unreferenced-hint"
                      @click="deleteUnreferenced('files')"
                    >
                      {{ CLEANUP_BUTTONS.files }}…
                    </button>
                    <button
                      class="settings-btn settings-btn--sm unused-apps-btn"
                      :disabled="runningCleanup !== null"
                      aria-describedby="general-unreferenced-hint"
                      @click="deleteUnreferenced('apps')"
                    >
                      {{ CLEANUP_BUTTONS.apps }}…
                    </button>
                  </div>
                  <div
                    v-if="runningCleanup !== null"
                    class="settings-progress"
                    role="progressbar"
                    :aria-label="`Looking for unreferenced ${runningCleanup.kind}`"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="Math.round(runningCleanup.progress * 100)"
                  >
                    <div class="settings-progress-fill" :style="{ width: `${runningCleanup.progress * 100}%` }" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

/* One size for every section, so the centered modal does not move or
   resize when the user switches sections. It is the size of the largest
   sections: Providers and Prompts fill whatever space they get, and a
   longer section scrolls inside it. A narrow window shrinks the width, so
   the edges and the close button stay on screen. The 760px cap stops a
   tall window from stretching it into a tall, mostly empty sheet; 760px
   still shows a whole custom provider without a scrollbar. */
.settings-modal {
  width: min(820px, calc(100vw - 48px));
  height: min(80vh, 760px);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.settings-header h2 {
  font-size: 15px;
  font-weight: 600;
}

.settings-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.settings-close:hover {
  opacity: 1;
}

.settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  width: 140px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
}

.settings-nav-btn {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.settings-nav-btn:hover {
  opacity: 0.9;
  background: var(--color-border);
}

.settings-nav-btn--active {
  opacity: 1;
  background: var(--color-border);
  font-weight: 500;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-section--fill {
  flex: 1;
  min-height: 0;
  height: 100%;
}

/* Starts where the text of the checkbox above starts: the checkbox is 12px
   wide in WebKitGTK, and the gap after it is 8px. */
.notifications-indented {
  padding-left: 20px;
}

.notifications-volume {
  display: flex;
  align-items: center;
  gap: 10px;
}

.notifications-volume--disabled {
  opacity: 0.5;
}

/* A drawn slider, not the native one: WebKitGTK draws the native track in
   a dark gray that does not show on the dark theme's background. The track
   and knob follow `.settings-toggle`. The part left of the knob is filled up
   to `--volume-fill`, the value in percent. */
.done-sound-volume {
  -webkit-appearance: none;
  appearance: none;
  width: 200px;
  height: 16px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}

.done-sound-volume:disabled {
  cursor: default;
}

.done-sound-volume::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--color-accent) var(--volume-fill),
    var(--color-border) var(--volume-fill)
  );
}

.done-sound-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}

.done-sound-volume-value {
  min-width: 4ch;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

/* Settings › General: titled groups of boxed rows, as in the system
   settings of macOS and GNOME. In the wide pane a short label is far from
   its control; the box of a row and the line between two rows take the eye
   from the label to its control. All text starts at one left edge, and all
   controls end at one right edge. No card or row clips (`overflow`) or
   makes a stacking context (a z-index, a transform, an opacity): either
   would hide the dropdown of the default-model picker under the cards
   below it. */
.settings-card-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* The title starts at the text of the rows. */
.settings-card-title {
  padding: 0 14px;
  line-height: 16px;
}

.settings-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

/* The text column keeps room for a label in a narrow window. The control
   column takes the width of its control while there is room, and less in
   a narrow window, where the picker shrinks to it (`max-width: 100%`).
   (With `auto`, the fixed width of the picker would be the least width of
   the column, and the picker would run out of its row.) */
.settings-card-row {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(0, max-content);
  align-items: center;
  gap: 10px 24px;
  padding: 10px 14px;
}

.settings-card-row + .settings-card-row {
  border-top: 1px solid var(--color-border);
}

.settings-card-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.settings-card-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

/* The bar of a task that runs, drawn as the volume slider's track. In a
   row, it goes under the text and the control. */
.settings-progress {
  grid-column: 1 / -1;
  height: 4px;
  border-radius: 2px;
  background: var(--color-border);
  overflow: hidden;
}

.settings-progress-fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.15s;
}

/* The two cleanup buttons, one above the other, stretched to the width of
   the wider one. */
.unreferenced-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Searchable default-model picker (replaces the old native <select>). The
   dropdown is absolutely positioned under the trigger and reuses ModelPicker.
   A fixed width, so that its left edge does not follow the length of the
   model name; it shrinks only in a narrow window. */
.settings-model-picker {
  position: relative;
  width: 260px;
  max-width: 100%;
}

.settings-model-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.settings-model-trigger:hover {
  border-color: var(--color-text);
}

.settings-model-trigger-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-model-chevron {
  flex-shrink: 0;
  opacity: 0.6;
  transition: transform 0.15s;
}

.settings-model-chevron--open {
  transform: rotate(180deg);
}

.settings-model-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  width: 320px;
  max-height: 320px;
  margin-top: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  z-index: 50;
}
</style>

<!-- Rows and form controls shared by the Settings sections and the managers
     they mount (ProviderManager, PromptManager, ShortcutManager,
     SystemPromptSettings). Not scoped, because a parent's scoped styles do
     not reach elements inside a child component. -->
<style>
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-row--end {
  justify-content: flex-end;
}

.settings-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.8;
}

/* A setting and the rows that belong to it (a hint, a row under a
   checkbox), closer together than the section's rows. */
.settings-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-hint {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-muted);
}

/* The title of a group of settings (the groups of Settings › General and
   of Settings › Shortcuts): small muted capitals. */
.settings-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
}

.settings-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  outline: none;
}

.settings-input:focus {
  border-color: var(--color-text);
}

.settings-btn {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.settings-btn:hover:not(:disabled) {
  background: var(--color-border);
}

.settings-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.settings-btn--active {
  background: var(--color-border);
  font-weight: 500;
}

.settings-btn--sm {
  padding: 6px 10px;
  font-size: 12px;
  flex-shrink: 0;
}

.settings-btn-group {
  display: flex;
  gap: 4px;
}

.settings-toggle {
  width: 36px;
  height: 20px;
  border: none;
  border-radius: 10px;
  background: var(--color-border);
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
  padding: 0;
}

.settings-toggle--on {
  background: var(--color-accent);
}

.settings-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: transform 0.2s;
}

.settings-toggle--on .settings-toggle-knob {
  transform: translateX(16px);
}

/* A native checkbox with its text, inside a <label> so that a click on the
   text also toggles it. */
.settings-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.settings-checkbox-row input {
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.settings-error {
  font-size: 12px;
  color: #f44336;
  /* An error text can end with its details as a paragraph of their own. */
  white-space: pre-line;
}

/* A Settings pane that scrolls. A classic scrollbar (macOS with a mouse or
   "Show scroll bars: Always", Linux with overlay scrolling off) takes room
   from the content. When such a scrollbar comes or goes, WebKit can keep
   the content at its old width, so the scrollbar covers the right edge of
   the rows, or leaves a gap. A stable gutter keeps the room for the
   scrollbar at all times, so the content width never changes. An overlay
   scrollbar takes no room and gets no gutter. */
.settings-scroller {
  scrollbar-gutter: stable;
}

/* A row in the master-detail lists of ProviderManager (a <button>) and
   PromptManager (an <li>). The button resets change nothing on an <li>.
   Scoped row rules must not set these properties: their extra [data-v]
   attribute makes them win over the hover and active styles here. */
.settings-list-row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.settings-list-row:hover {
  background: var(--color-border);
}

.settings-list-row--active {
  background: var(--color-border);
  font-weight: 500;
}

/* The buttons of an inline delete confirm in a manager. */
.settings-confirm-btn {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 11px;
  cursor: pointer;
}

.settings-confirm-btn:hover {
  background: var(--color-border);
}

.settings-confirm-btn--danger {
  color: #f44336;
  border-color: #f44336;
}

.settings-confirm-btn--danger:hover {
  background: rgba(244, 67, 54, 0.15);
}
</style>
