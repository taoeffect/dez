import { computed, type ComputedRef } from 'vue'
import sbp from '@sbp/sbp'
import type { ActiveModel, Section } from '../model/chat/types'
import type { Prompt } from '../model/state/prompts'
import type { DefaultModel, SettingsSection, Theme } from '../model/state/settings'
import type { SettingsSnapshot } from '../model/state'
import type { ModelSnapshot } from '../model/snapshot'

export interface ViewModelState {
  tabs: ComputedRef<ModelSnapshot['tabs']>
  activeTabId: ComputedRef<string>
  activeModel: ComputedRef<ActiveModel | null>
  activeSections: ComputedRef<Section[]>
  activeSectionsIdentity: ComputedRef<string>
  settings: ComputedRef<SettingsSnapshot>
  prompts: ComputedRef<Prompt[]>
  activeTabStreaming: ComputedRef<boolean>
  activeTabStreamError: ComputedRef<string | null>
}

// View components need reactive reads without owning Pinia stores directly;
// these computed selectors preserve Vue dependency tracking because the model
// selectors read the underlying reactive state during each computed evaluation.
export function useModelState(): ViewModelState {
  return {
    tabs: computed(() => sbp('dez.model/tabs/list') as ModelSnapshot['tabs']),
    activeTabId: computed(() => sbp('dez.model/tabs/activeId') as string),
    activeModel: computed(() => sbp('dez.model/activeModel') as ActiveModel | null),
    activeSections: computed(() => sbp('dez.model/thread/sections') as Section[]),
    activeSectionsIdentity: computed(() => sbp('dez.model/thread/sectionsIdentity') as string),
    settings: computed(() => sbp('dez.model/settings/snapshot') as SettingsSnapshot),
    prompts: computed(() => sbp('dez.model/prompts/list') as Prompt[]),
    activeTabStreaming: computed(() => {
      const activeTabId = sbp('dez.model/tabs/activeId') as string
      return sbp('dez.model/streams/isStreaming', activeTabId) as boolean
    }),
    activeTabStreamError: computed(() => sbp('dez.model/streams/activeTabError') as string | null),
  }
}

export type { DefaultModel, Prompt, SettingsSection, Theme }
