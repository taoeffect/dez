import { computed, type ComputedRef } from 'vue'
import sbp from '@sbp/sbp'
import type { ActiveModel, Section } from '../model/chat/types'
import type { Prompt } from '../model/state/prompts'
import type { DefaultModel, SettingsSection, Theme } from '../model/state/settings'
import type { SettingsSnapshot, TabActivity } from '../model/state'
import type { ModelSnapshot } from '../model/snapshot'
import type { ModelCache } from '../model/persistence/types'
import type { ModelDisplayNames } from '../model/providers/types'
import type { Shortcut } from '../model/shortcuts'

export interface ViewModelState {
  tabs: ComputedRef<ModelSnapshot['tabs']>
  activeTabId: ComputedRef<string>
  activeConversationId: ComputedRef<string>
  activeModel: ComputedRef<ActiveModel | null>
  activeSections: ComputedRef<Section[]>
  activeSectionsIdentity: ComputedRef<string>
  settings: ComputedRef<SettingsSnapshot>
  prompts: ComputedRef<Prompt[]>
  modelCache: ComputedRef<ModelCache>
  modelCacheRefreshing: ComputedRef<boolean>
  modelCacheErrors: ComputedRef<Record<string, string>>
  modelCacheChecking: ComputedRef<string[]>
  modelDisplayNames: ComputedRef<ModelDisplayNames>
  activeTabStreaming: ComputedRef<boolean>
  activeTabStreamingSectionId: ComputedRef<string | null>
  tabActivity: ComputedRef<Record<string, TabActivity>>
  shortcuts: ComputedRef<readonly Shortcut[]>
}

// View components need reactive reads without owning Pinia stores directly;
// these computed selectors preserve Vue dependency tracking because the model
// selectors read the underlying reactive state during each computed evaluation.
export function useModelState(): ViewModelState {
  return {
    tabs: computed(() => sbp('dez.model/tabs/list') as ModelSnapshot['tabs']),
    activeTabId: computed(() => sbp('dez.model/tabs/activeId') as string),
    activeConversationId: computed(() => sbp('dez.model/tabs/activeConversationId') as string),
    activeModel: computed(() => sbp('dez.model/activeModel') as ActiveModel | null),
    activeSections: computed(() => sbp('dez.model/thread/sections') as Section[]),
    activeSectionsIdentity: computed(() => sbp('dez.model/thread/sectionsIdentity') as string),
    settings: computed(() => sbp('dez.model/settings/snapshot') as SettingsSnapshot),
    prompts: computed(() => sbp('dez.model/prompts/list') as Prompt[]),
    // Reactive model-selector cache snapshot. Reading the snapshot selector
    // inside a computed tracks the underlying Pinia cache store, so the popup
    // re-renders live as the background refresh applies per-provider results.
    modelCache: computed(() => sbp('dez.model/modelCache/snapshot') as ModelCache),
    // Reactive in-progress flag for the model cache refresh; drives the popup
    // spinner. Reads the store ref so it stays reactive.
    modelCacheRefreshing: computed(() => sbp('dez.model/modelCache/refreshing') as boolean),
    // Provider id -> last model-list error, for providers whose last check
    // failed. In memory only, so it is empty after a restart.
    modelCacheErrors: computed(() => sbp('dez.model/modelCache/errors') as Record<string, string>),
    // Ids of the providers whose newest model check is still running.
    modelCacheChecking: computed(() => sbp('dez.model/modelCache/checking') as string[]),
    // Provider and model names for agent role pills and history rows.
    // Updates when a custom provider changes or a model refresh lands in the
    // cache.
    modelDisplayNames: computed(() => sbp('dez.provider/modelDisplayNames') as ModelDisplayNames),
    activeTabStreaming: computed(() => {
      const activeTabId = sbp('dez.model/tabs/activeId') as string
      return sbp('dez.model/streams/isStreaming', activeTabId) as boolean
    }),
    // Drives the "generating" state of the streaming response's agent pill.
    activeTabStreamingSectionId: computed(() => {
      const activeTabId = sbp('dez.model/tabs/activeId') as string
      return sbp('dez.model/streams/streamingSectionId', activeTabId) as string | null
    }),
    // Tab id -> busy or done, for the tab bar colors.
    tabActivity: computed(() => sbp('dez.model/tabs/activity') as Record<string, TabActivity>),
    // Every shortcut with its effective key; changes when the user sets a key.
    shortcuts: computed(() => sbp('dez.model/settings/shortcuts') as readonly Shortcut[]),
  }
}

export type { DefaultModel, Prompt, SettingsSection, Theme }
