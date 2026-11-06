<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState, type SettingsSection, type Theme } from '../modelState'
import type { ModelInfo } from '../../model/providers'
import PromptManager from '../prompts/PromptManager.vue'
import ProviderManager from './ProviderManager.vue'
import ModelPicker from '../model-selector/ModelPicker.vue'
import ShortcutManager from './ShortcutManager.vue'

const { settings, modelCache } = useModelState()

// Searchable picker for the "Default model for new tabs" setting, replacing the
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
const sections: SettingsSection[] = ['general', 'providers', 'prompts', 'appearance', 'notifications', 'shortcuts']

// Providers and Prompts fill the content pane and scroll inside their own
// lists, so the pane itself never scrolls for them. Its scrollbar gutter
// would only add an empty strip next to theirs.
const contentScrolls = computed(() => settings.value.settingsSection !== 'providers' && settings.value.settingsSection !== 'prompts')

const checkingUpdates = ref(false)

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
            {{ s.charAt(0).toUpperCase() + s.slice(1) }}
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
            <div class="notifications-group">
              <label class="settings-checkbox-row">
                <input
                  type="checkbox"
                  class="done-sound-checkbox"
                  :checked="settings.doneSound"
                  @change="sbp('dez.model/settings/setDoneSound', !settings.doneSound)"
                />
                Play a sound when a reply finishes
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

            <div class="notifications-group">
              <label class="settings-checkbox-row">
                <input
                  type="checkbox"
                  class="done-notification-checkbox"
                  :checked="settings.doneNotification"
                  @change="sbp('dez.model/settings/setDoneNotification', !settings.doneNotification)"
                />
                Show a system notification when a reply finishes
              </label>
              <p class="notifications-indented notifications-hint">Click the notification to go to the tab of the reply.</p>
            </div>

            <p class="notifications-hint">
              Alerts come only for a reply that finishes or fails while you are not looking at it:
              in another tab, or while you use another window.
            </p>
          </div>

          <!-- Shortcuts -->
          <div v-if="settings.settingsSection === 'shortcuts'" class="settings-section">
            <ShortcutManager />
          </div>

          <!-- General -->
          <div v-if="settings.settingsSection === 'general'" class="settings-section">
            <div class="settings-row">
              <label class="settings-label">Default model for new tabs</label>
              <div ref="defaultModelPickerEl" class="settings-model-picker">
                <button class="settings-model-trigger" @click="toggleDefaultModelPicker">
                  <span class="settings-model-trigger-label">{{ defaultNewTabModelLabel }}</span>
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

            <div class="settings-row">
              <label class="settings-label">Check for updates</label>
              <button
                class="settings-toggle"
                :class="{ 'settings-toggle--on': settings.checkForUpdates }"
                @click="sbp('dez.model/settings/setCheckForUpdates', !settings.checkForUpdates)"
              >
                <span class="settings-toggle-knob" />
              </button>
            </div>

            <div class="settings-row settings-row--end">
              <button
                class="settings-btn settings-btn--sm"
                :disabled="checkingUpdates"
                @click="manuallyCheckForUpdates()"
              >
                {{ checkingUpdates ? 'Checking…' : 'Check for updates' }}
              </button>
            </div>

            <div class="settings-row">
              <label class="settings-label">Dez folder</label>
              <button class="settings-btn settings-btn--sm" @click="sbp('dez.controller/openAppFolder')">
                Open Dez Folder
              </button>
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

.settings-label {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.8;
}

/* A checkbox and the rows that belong to it, closer together than the
   section's rows. */
.notifications-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.notifications-hint {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-muted);
}

/* Searchable default-model picker (replaces the old native <select>). The
   dropdown is absolutely positioned under the trigger and reuses ModelPicker. */
.settings-model-picker {
  position: relative;
  flex: 1;
  max-width: 320px;
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
     they mount (ProviderManager, PromptManager, ShortcutManager). Not scoped,
     because a parent's scoped styles do not reach elements inside a child
     component. -->
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
