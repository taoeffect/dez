import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type Theme = 'light' | 'dark' | 'system'

export interface DefaultModel {
  providerId: string
  modelId: string
}

interface AppStatePayload {
  tabs?: unknown[]
  activeTabId?: string | null
  showPillSeparators?: boolean
  theme?: Theme
  defaultModels?: Record<string, string>
  defaultNewTabModel?: DefaultModel | null
  lastUsedModel?: DefaultModel | null
}

export const useSettingsStore = defineStore('settings', () => {
  const showPillSeparators = ref(true)
  const theme = ref<Theme>('system')
  const defaultModels = ref<Record<string, string>>({})
  const defaultNewTabModel = ref<DefaultModel | null>(null)
  const lastUsedModel = ref<DefaultModel | null>(null)
  const settingsOpen = ref(false)

  let initialized = false
  let persistCallback: (() => void) | null = null
  let pendingPersist: ReturnType<typeof setTimeout> | null = null

  async function init(onPersist?: () => void) {
    if (onPersist) persistCallback = onPersist

    const state = (await invoke<AppStatePayload>('load_app_state').catch(() => ({}))) as AppStatePayload

    if (state) {
      if (typeof state.showPillSeparators === 'boolean')
        showPillSeparators.value = state.showPillSeparators
      if (state.theme) theme.value = state.theme
      if (state.defaultModels) defaultModels.value = state.defaultModels
      if (state.defaultNewTabModel !== undefined)
        defaultNewTabModel.value = state.defaultNewTabModel
      if (state.lastUsedModel !== undefined) lastUsedModel.value = state.lastUsedModel
    }

    applyTheme(theme.value)

    initialized = true

    watch(
      [showPillSeparators, theme, defaultModels, defaultNewTabModel, lastUsedModel],
      schedulePersist,
      { deep: true },
    )
    watch(theme, applyTheme)

    return state
  }

  function schedulePersist() {
    if (!initialized) return
    if (pendingPersist) clearTimeout(pendingPersist)
    pendingPersist = setTimeout(() => {
      pendingPersist = null
      if (persistCallback) persistCallback()
    }, 200)
  }

  function applyTheme(t: Theme) {
    const root = document.documentElement
    if (t === 'system') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', t)
    }
  }

  function togglePillSeparators() {
    showPillSeparators.value = !showPillSeparators.value
  }

  function setTheme(t: Theme) {
    theme.value = t
  }

  function setDefaultModel(providerId: string, modelId: string) {
    defaultModels.value[providerId] = modelId
  }

  function setDefaultNewTabModel(model: DefaultModel | null) {
    defaultNewTabModel.value = model
  }

  function setLastUsedModel(model: DefaultModel | null) {
    lastUsedModel.value = model
  }

  function openSettings() {
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  return {
    showPillSeparators,
    theme,
    defaultModels,
    defaultNewTabModel,
    lastUsedModel,
    settingsOpen,
    init,
    togglePillSeparators,
    setTheme,
    setDefaultModel,
    setDefaultNewTabModel,
    setLastUsedModel,
    openSettings,
    closeSettings,
  }
})
