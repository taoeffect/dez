<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import type { ApiFormatId, ProviderConfig, ProviderInfo } from '../../model/providers'
import { API_FORMATS } from '../../model/providers/apiFormats'
import { customProviderConfigSchema } from '../../model/providers/config'
import { isThinkingEnabled, THINKING_SETTING_KEY } from '../../model/providers/thinking'

interface CopilotDeviceFlowViewState {
  userCode: string
  verificationUri: string
}

// Status dot: green when the last model check worked, red when it failed,
// grey when the provider has no key or was not checked yet.
type ProviderHealth = 'ok' | 'error' | 'off'

// `label` names a format button, `name` follows a built-in's base URL, and
// `placeholder` is the base URL field's example for the format.
const FORMATS: Record<ApiFormatId, { label: string, name: string, placeholder: string }> = {
  openai: { label: 'OpenAI-compatible', name: 'OpenAI format', placeholder: 'http://localhost:11434/v1' },
  anthropic: { label: 'Anthropic', name: 'Anthropic format', placeholder: 'https://api.anthropic.com' },
}

// The same field rules that dez.controller/providers/save applies, so a
// field accepts exactly what a save accepts, with the same message.
const { name: nameSchema, baseUrl: baseUrlSchema } = customProviderConfigSchema.shape

const { settings, modelCache, modelCacheErrors, modelCacheChecking } = useModelState()

// Loaded from dez.provider/infos, which reads the stored keys (async and not
// reactive), so it is reloaded after every change made on this page.
const infos = ref<ProviderInfo[]>([])
const selectedId = ref<string | null>(null)

const providerGroups = computed(() => [
  { label: 'Built-in', infos: infos.value.filter((info) => info.builtIn) },
  { label: 'Custom', infos: infos.value.filter((info) => !info.builtIn), emptyHint: 'Local or self-hosted servers' },
])
const selectedInfo = computed(() => infos.value.find((info) => info.id === selectedId.value) ?? null)
// The editable definition of the selected custom provider; null for built-ins.
const selectedConfig = computed<ProviderConfig | null>(
  () => settings.value.customProviders.find((config) => config.id === selectedId.value) ?? null,
)
const isChecking = computed(() => selectedId.value !== null && modelCacheChecking.value.includes(selectedId.value))
// The same stored value as the Thinking row of the model picker's popup.
const thinkingEnabled = computed(
  () => isThinkingEnabled(selectedId.value ? settings.value.providerSettings[selectedId.value] : undefined),
)

const nameDraft = ref('')
const nameError = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const baseUrlDraft = ref('')
const baseUrlError = ref<string | null>(null)
const modelDraft = ref('')
const modelError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const pendingDelete = ref(false)

const keyDraft = ref('')
const keyError = ref<string | null>(null)
// Ids of the providers whose key save or remove is running. The user can
// select another provider meanwhile, and its key controls stay usable.
const keySavingIds = reactive(new Set<string>())
const keySaving = computed(() => selectedId.value !== null && keySavingIds.has(selectedId.value))

const copilotDeviceFlow = ref<CopilotDeviceFlowViewState | null>(null)
const copilotPolling = ref(false)
const copilotError = ref<string | null>(null)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function health(info: ProviderInfo): ProviderHealth {
  if (!info.configured) return 'off'
  const working = modelCache.value.providers[info.id]?.working
  if (working === true) return 'ok'
  if (working === false) return 'error'
  return 'off'
}

const statusText = computed(() => {
  const info = selectedInfo.value
  if (!info) return ''
  if (!info.configured) return info.auth === 'githubCopilot' ? 'Not signed in' : 'No API key'
  const state = health(info)
  if (state === 'ok') return 'Connected'
  if (state === 'error') return 'Not working'
  return isChecking.value ? 'Checking…' : 'Not checked'
})

const modelsStatus = computed(() => {
  const info = selectedInfo.value
  if (!info) return ''
  if (!info.configured) {
    return info.auth === 'githubCopilot'
      ? 'Sign in with GitHub to use this provider'
      : 'Add an API key to use this provider'
  }
  if (isChecking.value) return 'Checking…'
  const entry = modelCache.value.providers[info.id]
  if (!entry) return 'Not checked yet'
  // The error text is in memory only, so after a restart a failed check has
  // no text.
  if (!entry.working) return modelCacheErrors.value[info.id] ?? 'The last check failed'
  const count = entry.models.length
  return count === 1 ? '1 model available' : `${count} models available`
})

// Shows where chat requests go for the URL in the field, before it is saved,
// so the user sees whether the format adds `/v1` or not.
const chatUrlPreview = computed(() => {
  const config = selectedConfig.value
  if (!config) return null
  const result = baseUrlSchema.safeParse(baseUrlDraft.value)
  return result.success ? API_FORMATS[config.apiFormat].chatUrl(result.data) : null
})

// Every draft, error, and pending action belongs to one provider, so a new
// selection starts clean. A click on the selected row keeps them, because
// the key and model fields do not save on blur.
function selectProvider(providerId: string | null) {
  if (providerId === selectedId.value) return
  selectedId.value = providerId
  const config = selectedConfig.value
  nameDraft.value = config?.name ?? ''
  baseUrlDraft.value = config?.baseUrl ?? ''
  modelDraft.value = ''
  keyDraft.value = ''
  nameError.value = null
  baseUrlError.value = null
  modelError.value = null
  saveError.value = null
  keyError.value = null
  pendingDelete.value = false
}

let infosLoad = 0

async function loadInfos() {
  const load = ++infosLoad
  try {
    const loaded = await sbp('dez.provider/infos') as ProviderInfo[]
    // An older load can finish after a newer one; keep the newest list.
    if (load !== infosLoad) return
    infos.value = loaded
    if (!loaded.some((info) => info.id === selectedId.value)) selectProvider(loaded[0]?.id ?? null)
  } catch (error) {
    console.error('Failed to load providers:', error)
  }
}

function saveConfig(config: ProviderConfig) {
  saveError.value = null
  try {
    sbp('dez.controller/providers/save', config)
  } catch (error) {
    saveError.value = errorText(error)
  }
  void loadInfos()
}

function commitName() {
  const config = selectedConfig.value
  if (!config) return
  const result = nameSchema.safeParse(nameDraft.value)
  if (!result.success) {
    nameError.value = result.error.issues[0].message
    return
  }
  nameError.value = null
  nameDraft.value = result.data
  if (result.data !== config.name) saveConfig({ ...config, name: result.data })
}

function commitBaseUrl() {
  const config = selectedConfig.value
  if (!config) return
  const result = baseUrlSchema.safeParse(baseUrlDraft.value)
  if (!result.success) {
    baseUrlError.value = result.error.issues[0].message
    return
  }
  baseUrlError.value = null
  baseUrlDraft.value = result.data
  if (result.data !== config.baseUrl) saveConfig({ ...config, baseUrl: result.data })
}

function setApiFormat(apiFormat: ApiFormatId) {
  const config = selectedConfig.value
  if (config && config.apiFormat !== apiFormat) saveConfig({ ...config, apiFormat })
}

function addModel() {
  const config = selectedConfig.value
  if (!config) return
  const id = modelDraft.value.trim()
  if (!id) return
  if (config.models.some((model) => model.id === id)) {
    modelError.value = 'This model is already listed.'
    return
  }
  modelError.value = null
  modelDraft.value = ''
  saveConfig({ ...config, models: [...config.models, { id }] })
}

function removeModel(index: number) {
  const config = selectedConfig.value
  if (config) saveConfig({ ...config, models: config.models.filter((_, i) => i !== index) })
}

function toggleFetchModels() {
  const config = selectedConfig.value
  if (config) saveConfig({ ...config, fetchModels: !config.fetchModels })
}

// Checked stores an empty `thinking` object: thinking with the API format's
// default requests. Unchecked removes the key, with any request bodies added
// to app_state.json by hand.
function toggleSupportsThinking() {
  const config = selectedConfig.value
  if (!config) return
  const { thinking, ...withoutThinking } = config
  saveConfig(thinking ? withoutThinking : { ...config, thinking: {} })
}

function toggleThinking() {
  if (selectedId.value) {
    sbp('dez.model/settings/setProviderSetting', selectedId.value, THINKING_SETTING_KEY, !thinkingEnabled.value)
  }
}

// `key` null removes the stored key.
async function updateKey(key: string | null) {
  const providerId = selectedId.value
  // Enter in the key field skips the disabled Save button, so check here.
  if (!providerId || keySavingIds.has(providerId)) return
  keySavingIds.add(providerId)
  keyError.value = null
  try {
    await sbp('dez.controller/providers/setApiKey', providerId, key)
    if (selectedId.value === providerId) keyDraft.value = ''
  } catch (error) {
    if (selectedId.value === providerId) {
      keyError.value = `Could not ${key ? 'save' : 'remove'} the key: ${errorText(error)}`
    }
  } finally {
    keySavingIds.delete(providerId)
    await loadInfos()
  }
}

function saveKey() {
  const key = keyDraft.value.trim()
  if (key) void updateKey(key)
}

async function signInWithCopilot() {
  copilotError.value = null
  copilotPolling.value = true
  try {
    await sbp('dez.controller/signInWithCopilot', {
      onDeviceFlow (flow: CopilotDeviceFlowViewState) {
        copilotDeviceFlow.value = flow
      },
    })
  } catch (error) {
    copilotError.value = `Copilot sign-in failed: ${errorText(error)}`
  } finally {
    copilotPolling.value = false
    copilotDeviceFlow.value = null
    await loadInfos()
  }
}

function checkAgain() {
  if (selectedId.value) void sbp('dez.controller/modelCache/refresh', { providerIds: [selectedId.value], force: true })
}

// Selects the new provider only once the list has it; selecting it earlier
// shows "No provider selected." until the list loads.
async function addProvider() {
  const config = sbp('dez.controller/providers/add') as ProviderConfig
  await loadInfos()
  selectProvider(config.id)
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

async function deleteProvider() {
  const info = selectedInfo.value
  if (!info || info.builtIn) return
  const index = infos.value.findIndex((candidate) => candidate.id === info.id)
  const neighbor = infos.value[index + 1] ?? infos.value[index - 1] ?? null
  // The config is gone as soon as remove starts, and remove fails only when
  // it was gone already. So select the neighbor and drop the row at once:
  // while the stored key is deleted, the pane must not show the deleted
  // provider, and its row must not stay clickable.
  selectProvider(neighbor?.id ?? null)
  infos.value = infos.value.filter((candidate) => candidate.id !== info.id)
  try {
    await sbp('dez.controller/providers/remove', info.id)
  } catch (error) {
    saveError.value = `Could not delete the provider: ${errorText(error)}`
  }
  await loadInfos()
}

// A commit stores the normalized value (trimmed, no trailing '/'), so the
// field shows what was saved, unless the field holds an invalid edit.
watch(() => selectedConfig.value?.name, (name) => {
  if (name !== undefined && !nameError.value) nameDraft.value = name
})
watch(() => selectedConfig.value?.baseUrl, (baseUrl) => {
  if (baseUrl !== undefined && !baseUrlError.value) baseUrlDraft.value = baseUrl
})

onMounted(async () => {
  await loadInfos()
  // Statuses come from the model cache; bring stale entries up to date.
  void sbp('dez.controller/modelCache/refresh')
})

// Closing Settings with Escape removes the fields without a blur, so commit
// pending edits here.
onBeforeUnmount(() => {
  commitName()
  commitBaseUrl()
})
</script>

<template>
  <div class="provider-manager">
    <!-- LEFT COLUMN -->
    <div class="provider-sidebar">
      <template v-for="group in providerGroups" :key="group.label">
        <div class="provider-group-label">{{ group.label }}</div>
        <ul v-if="group.infos.length" class="provider-list">
          <li v-for="info in group.infos" :key="info.id">
            <button
              type="button"
              class="settings-list-row provider-row"
              :class="{ 'settings-list-row--active': info.id === selectedId }"
              :data-provider-id="info.id"
              :aria-current="info.id === selectedId"
              @click="selectProvider(info.id)"
            >
              <span class="provider-dot" :class="`provider-dot--${health(info)}`" />
              <span class="provider-row-name">{{ info.name }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="group.emptyHint" class="provider-group-hint">{{ group.emptyHint }}</p>
      </template>

      <button class="provider-add-btn" @click="addProvider">+ Add provider</button>
    </div>

    <!-- RIGHT COLUMN -->
    <div v-if="selectedInfo" class="provider-detail">
      <div class="provider-detail-header">
        <h3 class="provider-detail-name">{{ selectedInfo.name }}</h3>
        <span v-if="selectedInfo.builtIn" class="provider-badge">Built-in</span>
        <span class="provider-status">
          <span class="provider-dot" :class="`provider-dot--${health(selectedInfo)}`" />
          {{ statusText }}
        </span>
      </div>

      <p v-if="selectedInfo.builtIn" class="provider-meta">
        {{ selectedInfo.baseUrl }} · {{ FORMATS[selectedInfo.apiFormat].name }}
      </p>

      <template v-if="selectedConfig">
        <div class="provider-field">
          <label class="provider-field-label" for="provider-name-input">Name</label>
          <div class="provider-field-row">
            <input
              id="provider-name-input"
              ref="nameInput"
              v-model="nameDraft"
              type="text"
              class="settings-input provider-name-input"
              spellcheck="false"
              @blur="commitName"
              @keydown.enter="commitName"
            />
          </div>
          <p v-if="nameError" class="settings-error">{{ nameError }}</p>
        </div>

        <div class="provider-field">
          <span class="provider-field-label">API format</span>
          <div class="settings-btn-group provider-format-group">
            <button
              v-for="(format, formatId) in FORMATS"
              :key="formatId"
              class="settings-btn provider-format-btn"
              :class="{ 'settings-btn--active': selectedConfig.apiFormat === formatId }"
              :data-format="formatId"
              @click="setApiFormat(formatId)"
            >
              {{ format.label }}
            </button>
          </div>
        </div>

        <div class="provider-field">
          <label class="provider-field-label" for="provider-base-url-input">Base URL</label>
          <div class="provider-field-row">
            <input
              id="provider-base-url-input"
              v-model="baseUrlDraft"
              type="text"
              class="settings-input provider-base-url-input"
              spellcheck="false"
              :placeholder="FORMATS[selectedConfig.apiFormat].placeholder"
              @blur="commitBaseUrl"
              @keydown.enter="commitBaseUrl"
            />
          </div>
          <p v-if="baseUrlError" class="settings-error">{{ baseUrlError }}</p>
          <p v-else-if="chatUrlPreview" class="provider-hint">Chat requests go to {{ chatUrlPreview }}</p>
        </div>
      </template>

      <div v-if="selectedInfo.auth === 'githubCopilot'" class="provider-field">
        <span class="provider-field-label">GitHub account</span>
        <div v-if="copilotDeviceFlow" class="copilot-device-flow">
          <p class="copilot-flow-text">Enter code <code class="copilot-code">{{ copilotDeviceFlow.userCode }}</code> on GitHub</p>
          <p class="copilot-flow-hint">Code copied to clipboard. Waiting for authorization…</p>
        </div>
        <div v-else class="provider-field-row">
          <span v-if="selectedInfo.hasKey" class="provider-signed-in">Signed in</span>
          <button
            class="settings-btn settings-btn--sm provider-copilot-btn"
            :disabled="copilotPolling"
            @click="signInWithCopilot"
          >
            {{ selectedInfo.hasKey ? 'Sign in again' : 'Sign in with GitHub' }}
          </button>
        </div>
        <p v-if="copilotError" class="settings-error">{{ copilotError }}</p>
      </div>

      <div v-else class="provider-field">
        <label class="provider-field-label" for="provider-key-input">API key</label>
        <div class="provider-field-row">
          <input
            id="provider-key-input"
            v-model="keyDraft"
            type="password"
            class="settings-input provider-key-input"
            autocomplete="off"
            spellcheck="false"
            :placeholder="selectedInfo.hasKey ? 'Key saved — paste to replace' : 'Paste API key'"
            @keydown.enter="saveKey"
          />
          <button
            class="settings-btn settings-btn--sm provider-key-save-btn"
            :disabled="keySaving || !keyDraft.trim()"
            @click="saveKey"
          >
            {{ keySaving ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <div v-if="selectedInfo.hasKey || !selectedInfo.builtIn" class="provider-field-row provider-field-row--between">
          <p v-if="!selectedInfo.builtIn" class="provider-hint">Optional — leave empty for local servers</p>
          <button
            v-if="selectedInfo.hasKey"
            class="provider-link-btn provider-key-remove-btn"
            :disabled="keySaving"
            @click="updateKey(null)"
          >
            Remove key
          </button>
        </div>
        <p v-if="keyError" class="settings-error">{{ keyError }}</p>
      </div>

      <div v-if="selectedConfig" class="provider-field">
        <span class="provider-field-label">Models</span>
        <ul v-if="selectedConfig.models.length" class="provider-model-list">
          <!-- Hand-edited JSON can list a model id twice, so the index is in the key. -->
          <li v-for="(model, index) in selectedConfig.models" :key="`${index}:${model.id}`" class="provider-model-row">
            <span class="provider-model-text">
              <span class="provider-model-id">{{ model.id }}</span>
              <span v-if="model.name && model.name !== model.id" class="provider-model-name">{{ model.name }}</span>
            </span>
            <button
              class="provider-model-remove"
              :title="`Remove ${model.id}`"
              @click="removeModel(index)"
            >
              ×
            </button>
          </li>
        </ul>
        <div class="provider-field-row">
          <input
            v-model="modelDraft"
            type="text"
            class="settings-input provider-model-input"
            spellcheck="false"
            placeholder="Add model id"
            aria-label="Model id"
            @input="modelError = null"
            @keydown.enter="addModel"
          />
          <button
            class="settings-btn settings-btn--sm provider-model-add-btn"
            :disabled="!modelDraft.trim()"
            @click="addModel"
          >
            Add
          </button>
        </div>
        <p v-if="modelError" class="settings-error">{{ modelError }}</p>
        <div class="provider-field-row provider-field-row--between">
          <span id="provider-fetch-toggle-label" class="provider-toggle-label">Also list models reported by the server</span>
          <button
            class="settings-toggle provider-fetch-toggle"
            :class="{ 'settings-toggle--on': selectedConfig.fetchModels }"
            role="switch"
            aria-labelledby="provider-fetch-toggle-label"
            :aria-checked="selectedConfig.fetchModels"
            @click="toggleFetchModels"
          >
            <span class="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <div class="provider-field">
        <span v-if="!selectedConfig" class="provider-field-label">Models</span>
        <div class="provider-field-row provider-field-row--between">
          <span
            class="provider-models-status"
            :class="{ 'provider-models-status--error': !isChecking && health(selectedInfo) === 'error' }"
          >
            {{ modelsStatus }}
          </span>
          <button
            v-if="selectedInfo.configured"
            class="settings-btn settings-btn--sm provider-check-btn"
            :disabled="isChecking"
            @click="checkAgain"
          >
            Check again
          </button>
        </div>
      </div>

      <div v-if="selectedConfig || selectedInfo.supportsThinking" class="provider-field">
        <span id="provider-thinking-label" class="provider-field-label">Thinking</span>
        <label v-if="selectedConfig" class="provider-checkbox-row">
          <input
            type="checkbox"
            class="provider-supports-thinking-checkbox"
            :checked="selectedConfig.thinking !== undefined"
            @change="toggleSupportsThinking"
          />
          Supports thinking
        </label>
        <div v-if="selectedInfo.supportsThinking" class="provider-field-row provider-field-row--between">
          <span id="provider-thinking-toggle-text" class="provider-toggle-label">Ask for, show, and send back the model's thinking</span>
          <button
            class="settings-toggle provider-thinking-toggle"
            :class="{ 'settings-toggle--on': thinkingEnabled }"
            role="switch"
            aria-labelledby="provider-thinking-label"
            aria-describedby="provider-thinking-toggle-text"
            :aria-checked="thinkingEnabled"
            @click="toggleThinking"
          >
            <span class="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <p v-if="saveError" class="settings-error">{{ saveError }}</p>

      <div v-if="!selectedInfo.builtIn" class="provider-danger">
        <div v-if="pendingDelete" class="provider-delete-confirm">
          <span class="provider-delete-confirm-text">Delete this provider and its API key?</span>
          <button class="settings-confirm-btn settings-confirm-btn--danger provider-delete-confirm-btn" @click="deleteProvider">
            Delete
          </button>
          <button class="settings-confirm-btn provider-delete-cancel-btn" @click="pendingDelete = false">Cancel</button>
        </div>
        <button v-else class="provider-link-btn provider-link-btn--danger provider-delete-btn" @click="pendingDelete = true">
          Delete provider
        </button>
      </div>
    </div>
    <div v-else class="provider-detail-empty">
      <p>No provider selected.</p>
    </div>
  </div>
</template>

<style scoped>
.provider-manager {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

/* Left column */
.provider-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
  /* Room for the overlay scrollbar, which would cover the row edges. */
  padding-right: 8px;
}

.provider-group-label {
  padding: 8px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  opacity: 0.5;
}

.provider-group-label:first-child {
  padding-top: 0;
}

.provider-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.provider-row {
  gap: 8px;
}

.provider-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
}

.provider-dot--ok {
  background: #4caf50;
}

.provider-dot--error {
  background: #f44336;
}

.provider-dot--off {
  background: var(--color-text);
  opacity: 0.25;
}

.provider-group-hint {
  padding: 4px 8px;
  font-size: 12px;
  opacity: 0.5;
}

.provider-add-btn {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  opacity: 0.8;
  transition: background 0.15s, opacity 0.15s;
}

.provider-add-btn:hover {
  background: var(--color-border);
  opacity: 1;
}

/* Right column */
.provider-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  /* Room for the overlay scrollbar, which would cover the field edges. */
  padding-right: 10px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.provider-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-detail-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
}

.provider-badge {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  font-size: 11px;
  opacity: 0.8;
}

.provider-status {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.8;
}

.provider-meta {
  margin: -8px 0 0;
  font-size: 12px;
  opacity: 0.6;
  overflow-wrap: anywhere;
}

.provider-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.provider-field-label {
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
}

.provider-field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-field-row--between {
  justify-content: space-between;
}

.provider-hint {
  font-size: 12px;
  opacity: 0.55;
  overflow-wrap: anywhere;
}

.provider-link-btn {
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  opacity: 0.7;
  flex-shrink: 0;
}

.provider-link-btn:hover:not(:disabled) {
  opacity: 1;
  text-decoration: underline;
}

.provider-link-btn--danger {
  color: #f44336;
  opacity: 0.9;
}

.provider-link-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.provider-signed-in {
  font-size: 13px;
}

.provider-model-list {
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.provider-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 4px 10px;
  font-size: 13px;
}

.provider-model-row + .provider-model-row {
  border-top: 1px solid var(--color-border);
}

.provider-model-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-model-id {
  font-family: monospace;
}

.provider-model-name {
  margin-left: 8px;
  opacity: 0.6;
}

.provider-model-remove {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
}

.provider-model-remove:hover {
  opacity: 1;
  color: #f44336;
}

.provider-toggle-label {
  font-size: 13px;
}

.provider-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.provider-checkbox-row input {
  margin: 0;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.provider-models-status {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.provider-models-status--error {
  color: #f44336;
}

.provider-danger {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

.provider-delete-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-delete-confirm-text {
  font-size: 12px;
  opacity: 0.8;
}

.provider-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  opacity: 0.5;
}

.copilot-device-flow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.copilot-flow-text {
  font-size: 13px;
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
}
</style>
