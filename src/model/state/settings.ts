import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ProviderConfig } from '../providers/config'
import type { ParameterValues } from '../providers/modelParameters'
import type { ModelOutput } from '../modelOutputs'
import { EDITOR_FONT_SIZE_DEFAULT } from '../editorFontSize'
import { DONE_SOUND_VOLUME_DEFAULT } from '../doneSoundVolume'
import { currentShortcutPlatform, resolveShortcuts, type ShortcutOverrides } from '../shortcuts'

export type Theme = 'light' | 'dark' | 'system'
export type SettingsSection = 'general' | 'providers' | 'prompts' | 'systemPrompt' | 'appearance' | 'notifications' | 'shortcuts'

export interface DefaultModel {
  providerId: string
  modelId: string
}

// The main window's last normal (not maximized) geometry, `window` in
// app_state.json. `width`/`height` is the logical inner size, so it means the
// same on screens with other scale factors. `x`/`y` is the outer position in
// the one coordinate space that the window system uses for all screens:
// logical points on macOS, physical px elsewhere (src/controller/window.ts).
// GTK's Wayland backend gives no positions, so a run there keeps the saved
// `x`/`y`, and saves none (both absent) when there were none; the next
// restore then centers the window.
export interface WindowGeometry {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<Theme>('system')
  const editorFontSize = ref(EDITOR_FONT_SIZE_DEFAULT)
  // null while app_state.json has no `window`; dez.controller/window fills it.
  const windowGeometry = ref<WindowGeometry | null>(null)
  // User-defined providers, already validated by customProviderConfigSchema.
  // Built-ins are not stored here; they are literals in providers/builtins.ts.
  const customProviders = ref<ProviderConfig[]>([])
  const defaultNewTabModel = ref<DefaultModel | null>(null)
  const lastUsedModel = ref<DefaultModel | null>(null)
  const favorites = ref<DefaultModel[]>([])
  // The model pickers' output filter (both pickers share it): the output
  // types to show, in table order; empty shows every model.
  const modelOutputFilter = ref<ModelOutput[]>([])
  // Sparse per-provider setting overrides keyed by provider id then setting
  // key; effective value = stored value ?? provider descriptor default.
  const providerSettings = ref<Record<string, Record<string, boolean>>>({})
  // The parameter values that the user chose for media models (the length
  // of a clip, a voice), keyed by full model id (`modelRefKey`) then
  // parameter name (`ModelParameter.name`). Sparse: a parameter with no
  // entry has its default (`effectiveParameterValues`).
  const modelParameters = ref<Record<string, ParameterValues>>({})
  const checkForUpdates = ref(true)
  const lastUpdateCheckAt = ref<number | null>(null)
  // The reply-end alerts (Settings › Notifications): a sound at
  // `doneSoundVolume` percent, and a system notification.
  const doneSound = ref(true)
  const doneSoundVolume = ref(DONE_SOUND_VOLUME_DEFAULT)
  const doneNotification = ref(true)
  // The user's shortcut keys that differ from the defaults, already
  // normalized and validated. Replaced as a whole on each change.
  const shortcutOverrides = ref<ShortcutOverrides>({})
  // Every shortcut with its effective key, computed once per change, since
  // the window handler reads it on every keydown.
  const shortcuts = computed(() => resolveShortcuts(currentShortcutPlatform, shortcutOverrides.value))
  // The user's system prompt template (Settings › System Prompt); null for
  // Dez's own template (`BUILT_IN_SYSTEM_PROMPT`). An empty or blank text
  // is kept: it sends no system prompt.
  const systemPrompt = ref<string | null>(null)
  // The overlay panels. At most one is open: opening one closes the others.
  const settingsOpen = ref(false)
  const settingsSection = ref<SettingsSection>('general')
  const historyOpen = ref(false)
  const helpOpen = ref(false)

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
    helpOpen.value = false
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  function openHistory() {
    settingsOpen.value = false
    helpOpen.value = false
    historyOpen.value = true
  }

  function closeHistory() {
    historyOpen.value = false
  }

  return {
    theme,
    editorFontSize,
    windowGeometry,
    customProviders,
    defaultNewTabModel,
    lastUsedModel,
    favorites,
    modelOutputFilter,
    providerSettings,
    modelParameters,
    checkForUpdates,
    lastUpdateCheckAt,
    doneSound,
    doneSoundVolume,
    doneNotification,
    shortcutOverrides,
    systemPrompt,
    shortcuts,
    settingsOpen,
    settingsSection,
    historyOpen,
    helpOpen,
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
