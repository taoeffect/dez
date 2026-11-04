import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProviderConfig } from '../providers/config'

export type Theme = 'light' | 'dark' | 'system'
export type SettingsSection = 'general' | 'providers' | 'prompts' | 'appearance'

export interface DefaultModel {
  providerId: string
  modelId: string
}

export const useSettingsStore = defineStore('settings', () => {
  const showPillSeparators = ref(true)
  const theme = ref<Theme>('system')
  // User-defined providers, already validated by customProviderConfigSchema.
  // Built-ins are not stored here; they are literals in providers/builtins.ts.
  const customProviders = ref<ProviderConfig[]>([])
  const defaultNewTabModel = ref<DefaultModel | null>(null)
  const lastUsedModel = ref<DefaultModel | null>(null)
  const favorites = ref<DefaultModel[]>([])
  // Sparse per-provider setting overrides keyed by provider id then setting
  // key; effective value = stored value ?? provider descriptor default.
  const providerSettings = ref<Record<string, Record<string, boolean>>>({})
  const checkForUpdates = ref(true)
  const lastUpdateCheckAt = ref<number | null>(null)
  const settingsOpen = ref(false)
  const settingsSection = ref<SettingsSection>('general')
  const historyOpen = ref(false)

  function togglePillSeparators() {
    showPillSeparators.value = !showPillSeparators.value
  }

  function setTheme(t: Theme) {
    theme.value = t
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
    customProviders,
    defaultNewTabModel,
    lastUsedModel,
    favorites,
    providerSettings,
    checkForUpdates,
    lastUpdateCheckAt,
    settingsOpen,
    settingsSection,
    historyOpen,
    togglePillSeparators,
    setTheme,
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
