import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type SettingsSection = 'general' | 'providers' | 'prompts' | 'appearance'

export interface DefaultModel {
  providerId: string
  modelId: string
}

export const useSettingsStore = defineStore('settings', () => {
  const showPillSeparators = ref(true)
  const theme = ref<Theme>('system')
  const defaultModels = ref<Record<string, string>>({})
  const defaultNewTabModel = ref<DefaultModel | null>(null)
  const lastUsedModel = ref<DefaultModel | null>(null)
  const favorites = ref<DefaultModel[]>([])
  const checkForUpdates = ref(true)
  const lastUpdateCheckAt = ref<number | null>(null)
  const settingsOpen = ref(false)
  const settingsSection = ref<SettingsSection>('general')
  const historyOpen = ref(false)

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

  function setCheckForUpdates(enabled: boolean) {
    checkForUpdates.value = enabled
  }

  function setLastUpdateCheckAt(timestamp: number | null) {
    lastUpdateCheckAt.value = timestamp
  }

  function isFavorite(providerId: string, modelId: string): boolean {
    return favorites.value.some(
      (f) => f.providerId === providerId && f.modelId === modelId,
    )
  }

  function toggleFavorite(providerId: string, modelId: string) {
    const idx = favorites.value.findIndex(
      (f) => f.providerId === providerId && f.modelId === modelId,
    )
    if (idx >= 0) {
      favorites.value.splice(idx, 1)
    } else {
      favorites.value.push({ providerId, modelId })
    }
  }

  function openSettings(section: SettingsSection = 'general') {
    settingsSection.value = section
    historyOpen.value = false
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  function openHistory() {
    settingsOpen.value = false
    historyOpen.value = true
  }

  function closeHistory() {
    historyOpen.value = false
  }

  return {
    showPillSeparators,
    theme,
    defaultModels,
    defaultNewTabModel,
    lastUsedModel,
    favorites,
    checkForUpdates,
    lastUpdateCheckAt,
    settingsOpen,
    settingsSection,
    historyOpen,
    applyTheme,
    togglePillSeparators,
    setTheme,
    setDefaultModel,
    setDefaultNewTabModel,
    setLastUsedModel,
    setCheckForUpdates,
    setLastUpdateCheckAt,
    isFavorite,
    toggleFavorite,
    openSettings,
    closeSettings,
    openHistory,
    closeHistory,
  }
})
