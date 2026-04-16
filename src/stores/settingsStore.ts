import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { load } from '@tauri-apps/plugin-store'

export type Theme = 'light' | 'dark' | 'system'

export interface DefaultModel {
  providerId: string
  modelId: string
}

export const useSettingsStore = defineStore('settings', () => {
  const showPillSeparators = ref(true)
  const theme = ref<Theme>('system')
  const defaultModels = ref<Record<string, string>>({})
  const defaultNewTabModel = ref<DefaultModel | null>(null)
  const settingsOpen = ref(false)

  let storeInstance: Awaited<ReturnType<typeof load>> | null = null

  async function init() {
    storeInstance = await load('settings.json', { defaults: {}, autoSave: true })

    const saved = await storeInstance.get<{
      showPillSeparators?: boolean
      theme?: Theme
      defaultModels?: Record<string, string>
      defaultNewTabModel?: DefaultModel | null
    }>('settings')

    if (saved) {
      if (saved.showPillSeparators !== undefined) showPillSeparators.value = saved.showPillSeparators
      if (saved.theme) theme.value = saved.theme
      if (saved.defaultModels) defaultModels.value = saved.defaultModels
      if (saved.defaultNewTabModel !== undefined) defaultNewTabModel.value = saved.defaultNewTabModel
    }

    applyTheme(theme.value)

    watch([showPillSeparators, theme, defaultModels, defaultNewTabModel], persist, { deep: true })
    watch(theme, applyTheme)
  }

  async function persist() {
    if (!storeInstance) return
    await storeInstance.set('settings', {
      showPillSeparators: showPillSeparators.value,
      theme: theme.value,
      defaultModels: defaultModels.value,
      defaultNewTabModel: defaultNewTabModel.value,
    })
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
    settingsOpen,
    init,
    togglePillSeparators,
    setTheme,
    setDefaultModel,
    setDefaultNewTabModel,
    openSettings,
    closeSettings,
  }
})
