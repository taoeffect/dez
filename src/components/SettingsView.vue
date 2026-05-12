<script setup lang="ts">
import { onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useSettingsStore, type SettingsSection, type Theme } from '../model/state/settings'
import type { ModelInfo, ProviderInfo } from '../model/providers'
import PromptManager from './PromptManager.vue'

const settings = useSettingsStore()
const sections: SettingsSection[] = ['general', 'providers', 'prompts', 'appearance']

const providers = ref<ProviderInfo[]>([])
const providerModels = ref<Record<string, ModelInfo[]>>({})
const apiKeyInputs = ref<Record<string, string>>({})
const savingKey = ref<string | null>(null)
const keyError = ref<string | null>(null)
const checkingUpdates = ref(false)

const copilotDeviceFlow = ref<{ userCode: string; verificationUri: string } | null>(null)
const copilotPolling = ref(false)

const themes: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const shortcuts = [
  { keys: 'Cmd/Ctrl + Enter', action: 'Submit thread to LLM' },
  { keys: 'Cmd/Ctrl + N', action: 'New tab' },
  { keys: 'Cmd/Ctrl + W', action: 'Close tab' },
  { keys: 'Cmd/Ctrl + H', action: 'Open history' },
  { keys: 'Cmd/Ctrl + ,', action: 'Open settings' },
  { keys: 'Escape', action: 'Close overlays' },
]

interface ProviderSettingsData {
  providers: ProviderInfo[]
  providerModels: Record<string, ModelInfo[]>
}

interface CopilotDeviceFlowViewState {
  userCode: string
  verificationUri: string
}

onMounted(async () => {
  await loadProviders()
})

async function loadProviders() {
  try {
    applyProviderSettings(await sbp('dez.controller/loadProviderSettings') as ProviderSettingsData)
  } catch {
    // silently fail — providers may not be reachable
  }
}

function applyProviderSettings(data: ProviderSettingsData) {
  providers.value = data.providers
  providerModels.value = data.providerModels
}

async function saveApiKey(providerId: string) {
  const key = apiKeyInputs.value[providerId]?.trim()
  if (!key) return

  savingKey.value = providerId
  keyError.value = null
  try {
    applyProviderSettings(await sbp('dez.controller/saveProviderSecret', providerId, key) as ProviderSettingsData)
    apiKeyInputs.value[providerId] = ''
  } catch (e) {
    keyError.value = `Failed to save key for ${providerId}: ${e}`
  } finally {
    savingKey.value = null
  }
}

async function startCopilotDeviceFlow() {
  keyError.value = null
  copilotPolling.value = true
  try {
    applyProviderSettings(await sbp('dez.controller/signInWithCopilot', {
      onDeviceFlow(flow: CopilotDeviceFlowViewState) {
        copilotDeviceFlow.value = flow
      },
    }) as ProviderSettingsData)
  } catch (e) {
    keyError.value = `Copilot sign-in failed: ${e}`
  } finally {
    copilotPolling.value = false
    copilotDeviceFlow.value = null
  }
}

async function manuallyCheckForUpdates() {
  checkingUpdates.value = true
  try {
    await sbp('dez.controller/checkForUpdatesNow')
  } finally {
    checkingUpdates.value = false
  }
}

function onClose() {
  settings.closeSettings()
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('settings-overlay')) {
    onClose()
  }
}
</script>

<template>
  <div class="settings-overlay" @click="onOverlayClick" @keydown.escape="onClose">
    <div class="settings-modal" :class="{ 'settings-modal--wide': settings.settingsSection === 'prompts' }">
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
            @click="settings.settingsSection = s"
          >
            {{ s.charAt(0).toUpperCase() + s.slice(1) }}
          </button>
        </nav>

        <div class="settings-content">
          <!-- Providers -->
          <div v-if="settings.settingsSection === 'providers'" class="settings-section">
            <div v-for="provider in providers" :key="provider.id" class="provider-card">
              <div class="provider-header">
                <span class="provider-name">{{ provider.name }}</span>
                <span
                  class="provider-status"
                  :class="provider.configured ? 'provider-status--ok' : 'provider-status--missing'"
                >
                  {{ provider.configured ? 'Configured' : 'Not configured' }}
                </span>
              </div>

              <div v-if="provider.id === 'copilot'" class="provider-key-row">
                <template v-if="copilotDeviceFlow">
                  <div class="copilot-device-flow">
                    <p class="copilot-flow-text">Enter code <code class="copilot-code">{{ copilotDeviceFlow.userCode }}</code> on GitHub</p>
                    <p class="copilot-flow-hint">Code copied to clipboard. Waiting for authorization…</p>
                  </div>
                </template>
                <template v-else>
                  <button
                    class="settings-btn"
                    :disabled="copilotPolling"
                    @click="startCopilotDeviceFlow()"
                  >
                    {{ provider.configured ? 'Re-authenticate with GitHub' : 'Sign in with GitHub' }}
                  </button>
                </template>
              </div>
              <div v-else class="provider-key-row">
                <input
                  v-model="apiKeyInputs[provider.id]"
                  type="password"
                  class="settings-input"
                  :placeholder="provider.configured ? '••••••••  (update key)' : 'Enter API key'"
                  @keydown.enter="saveApiKey(provider.id)"
                />
                <button
                  class="settings-btn settings-btn--sm"
                  :disabled="savingKey === provider.id"
                  @click="saveApiKey(provider.id)"
                >
                  {{ savingKey === provider.id ? 'Saving…' : 'Save' }}
                </button>
              </div>

              <div v-if="provider.configured && providerModels[provider.id]?.length" class="provider-model-row">
                <label class="settings-label">Default model</label>
                <select
                  class="settings-select"
                  :value="settings.defaultModels[provider.id] || ''"
                  @change="settings.setDefaultModel(provider.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>Select a model</option>
                  <option
                    v-for="model in providerModels[provider.id]"
                    :key="model.id"
                    :value="model.id"
                  >
                    {{ model.name }}
                  </option>
                </select>
              </div>
            </div>

            <p v-if="keyError" class="settings-error">{{ keyError }}</p>
            <p v-if="!providers.length" class="settings-empty">No providers available.</p>
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
                  @click="settings.setTheme(t.value)"
                >
                  {{ t.label }}
                </button>
              </div>
            </div>

            <div class="settings-row">
              <label class="settings-label">Show role pill separators</label>
              <button
                class="settings-toggle"
                :class="{ 'settings-toggle--on': settings.showPillSeparators }"
                @click="settings.togglePillSeparators()"
              >
                <span class="settings-toggle-knob" />
              </button>
            </div>
          </div>

          <!-- General -->
          <div v-if="settings.settingsSection === 'general'" class="settings-section">
            <div class="settings-row">
              <label class="settings-label">Default model for new tabs</label>
              <select
                class="settings-select"
                :value="settings.defaultNewTabModel ? `${settings.defaultNewTabModel.providerId}:${settings.defaultNewTabModel.modelId}` : ''"
                @change="
                  (() => {
                    const v = ($event.target as HTMLSelectElement).value
                    if (!v) { settings.setDefaultNewTabModel(null); return }
                    const [pid, mid] = v.split(':')
                    settings.setDefaultNewTabModel({ providerId: pid, modelId: mid })
                  })()
                "
              >
                <option value="">None (use last used)</option>
                <template v-for="provider in providers" :key="provider.id">
                  <option
                    v-for="model in (providerModels[provider.id] || [])"
                    :key="model.id"
                    :value="`${provider.id}:${model.id}`"
                  >
                    {{ provider.name }} — {{ model.name }}
                  </option>
                </template>
              </select>
            </div>

            <div class="settings-row">
              <label class="settings-label">Check for updates</label>
              <button
                class="settings-toggle"
                :class="{ 'settings-toggle--on': settings.checkForUpdates }"
                @click="settings.setCheckForUpdates(!settings.checkForUpdates)"
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

            <div class="settings-shortcuts">
              <label class="settings-label">Keyboard shortcuts</label>
              <table class="shortcuts-table">
                <tbody>
                  <tr v-for="s in shortcuts" :key="s.keys">
                    <td class="shortcut-keys">{{ s.keys }}</td>
                    <td class="shortcut-action">{{ s.action }}</td>
                  </tr>
                </tbody>
              </table>
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

.settings-modal {
  width: 560px;
  max-height: 80vh;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.settings-modal--wide {
  width: 820px;
  height: 80vh;
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

.settings-select {
  padding: 6px 30px 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--color-text);
  color-scheme: dark light;
  font-size: 13px;
  outline: none;
  min-width: 180px;
  -webkit-appearance: none;
  appearance: none;
}

.settings-select option {
  background: var(--color-bg);
  color: var(--color-text);
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

.settings-btn:hover {
  background: var(--color-border);
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
  background: #4c8dff;
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

.provider-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.provider-name {
  font-size: 13px;
  font-weight: 600;
}

.provider-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}

.provider-status--ok {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
}

.provider-status--missing {
  background: rgba(255, 152, 0, 0.15);
  color: #ff9800;
}

.provider-key-row {
  display: flex;
  gap: 8px;
}

.copilot-device-flow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.copilot-flow-text {
  font-size: 13px;
  margin: 0;
}

.copilot-code {
  font-family: monospace;
  font-size: 14px;
  font-weight: 700;
  background: var(--color-border);
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 1px;
}

.copilot-flow-hint {
  font-size: 11px;
  opacity: 0.6;
  margin: 0;
}

.provider-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.settings-error {
  font-size: 12px;
  color: #f44336;
}

.settings-empty {
  font-size: 13px;
  opacity: 0.5;
  text-align: center;
  padding: 20px;
}

.settings-shortcuts {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shortcuts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.shortcuts-table td {
  padding: 4px 0;
}

.shortcut-keys {
  font-family: monospace;
  opacity: 0.7;
  width: 180px;
}

.shortcut-action {
  opacity: 0.9;
}
</style>
