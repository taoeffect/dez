import sbp from '@sbp/sbp'
import { usePromptsStore } from '../stores/promptsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useThreadStore } from '../stores/threadStore'
import type { ActiveModel, ContentNode, Role, Section, Tab } from '../types/chat'
import type { StreamMessage } from '../core/stream/types'
import type { ModelSnapshot } from './types'

function cloneSections(sections: Section[]): ModelSnapshot['tabs'][number]['sections'] {
  return sections.map((section) => ({
    id: section.id,
    role: section.role,
    content: section.content.map((node): ContentNode => ({ ...node })),
  }))
}

function cloneTabs(tabs: Tab[]): ModelSnapshot['tabs'] {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    conversationId: tab.conversationId,
    activeModel: tab.activeModel ? { ...tab.activeModel } : null,
    sections: cloneSections(tab.sections),
    createdAt: tab.createdAt,
  }))
}

export default sbp('sbp/selectors/register', {
  'dez.model/snapshot' (): ModelSnapshot {
    const tabStore = useTabStore()
    const threadStore = useThreadStore()
    const settings = useSettingsStore()
    const prompts = usePromptsStore()

    return {
      tabs: cloneTabs(tabStore.tabs),
      activeTabId: tabStore.activeTabId,
      activeModel: threadStore.activeModel ? { ...threadStore.activeModel } : null,
      settings: {
        showPillSeparators: settings.showPillSeparators,
        theme: settings.theme,
        defaultModels: { ...settings.defaultModels },
        defaultNewTabModel: settings.defaultNewTabModel ? { ...settings.defaultNewTabModel } : null,
        lastUsedModel: settings.lastUsedModel ? { ...settings.lastUsedModel } : null,
        favorites: settings.favorites.map((favorite) => ({ ...favorite })),
        checkForUpdates: settings.checkForUpdates,
        lastUpdateCheckAt: settings.lastUpdateCheckAt,
        settingsOpen: settings.settingsOpen,
        settingsSection: settings.settingsSection,
        historyOpen: settings.historyOpen,
      },
      prompts: prompts.prompts.map((prompt) => ({ ...prompt })),
    }
  },

  'dez.model/activeTab' (): Tab {
    const tabStore = useTabStore()
    return cloneTabs([tabStore.activeTab])[0]
  },

  'dez.model/tab' (tabId: string): Tab | null {
    const tab = useTabStore().tabById(tabId)
    return tab ? cloneTabs([tab])[0] : null
  },

  'dez.model/activeModel' (): ActiveModel | null {
    const threadStore = useThreadStore()
    return threadStore.activeModel ? { ...threadStore.activeModel } : null
  },

  'dez.model/activeModelForTab' (tabId: string): ActiveModel | null {
    const model = useTabStore().activeModelForTab(tabId)
    return model ? { ...model } : null
  },

  'dez.model/streamMessagesForTab' (tabId: string): StreamMessage[] {
    return useTabStore().streamMessagesForTab(tabId).map((message) => ({ ...message }))
  },

  'dez.model/ensureTrailingAgentSectionForTab' (tabId: string): Section | null {
    const section = useTabStore().ensureTrailingAgentSectionForTab(tabId)
    return section ? cloneSections([section])[0] : null
  },

  'dez.model/appendTokenToTabSection' (tabId: string, sectionId: string, token: string): boolean {
    return useTabStore().appendTokenToTabSection(tabId, sectionId, token)
  },

  'dez.model/ensureTrailingUserSectionForTab' (tabId: string): Section | null {
    const section = useTabStore().ensureTrailingUserSectionForTab(tabId)
    return section ? cloneSections([section])[0] : null
  },

  'dez.model/finalizeStreamSectionForTab' (tabId: string, sectionId: string, error: string | null): Section | null {
    const section = useTabStore().finalizeStreamSectionForTab(tabId, sectionId, error)
    return section ? cloneSections([section])[0] : null
  },

  'dez.model/setActiveModel' (providerId: string, modelId: string, modelName: string): void {
    useThreadStore().setActiveModel(providerId, modelId, modelName)
  },

  'dez.model/addSection' (role: Role): Section {
    const section = useThreadStore().addSection(role)
    return cloneSections([section])[0]
  },

  'dez.model/updateSectionContent' (id: string, text: string): void {
    useThreadStore().updateSectionContent(id, text)
  },

  'dez.model/setSectionContent' (id: string, nodes: ContentNode[]): void {
    useThreadStore().setSectionContent(id, nodes)
  },

  'dez.model/toggleSectionRole' (id: string): void {
    useThreadStore().toggleSectionRole(id)
  },

  'dez.model/togglePromptExpanded' (sectionId: string, nodeId: string): void {
    useThreadStore().togglePromptExpanded(sectionId, nodeId)
  },

  'dez.model/clearThread' (): void {
    useThreadStore().clearThread()
  },
})
