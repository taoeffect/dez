import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { Role, Section } from '../types/chat'
import { useSettingsStore } from './settingsStore'
import { useTabStore } from './tabStore'

export const useThreadStore = defineStore('thread', () => {
  const tabStore = useTabStore()

  const sections = computed({
    get: () => tabStore.activeTab.sections,
    set: (val: Section[]) => { tabStore.activeTab.sections = val },
  })

  const activeModel = computed({
    get: () => tabStore.activeTab.activeModel,
    set: (val) => { tabStore.activeTab.activeModel = val },
  })

  function initActiveModel() {
    if (activeModel.value) return
    const settings = useSettingsStore()
    if (settings.defaultNewTabModel) {
      activeModel.value = {
        providerId: settings.defaultNewTabModel.providerId,
        modelId: settings.defaultNewTabModel.modelId,
        modelName: settings.defaultNewTabModel.modelId,
      }
    } else if (settings.lastUsedModel) {
      activeModel.value = {
        providerId: settings.lastUsedModel.providerId,
        modelId: settings.lastUsedModel.modelId,
        modelName: settings.lastUsedModel.modelId,
      }
    }
  }

  function setActiveModel(providerId: string, modelId: string, modelName: string) {
    activeModel.value = { providerId, modelId, modelName }
    const settings = useSettingsStore()
    settings.setLastUsedModel({ providerId, modelId })
  }

  function updateSectionContent(id: string, content: string) {
    const section = sections.value.find((s) => s.id === id)
    if (section) {
      section.content = content
      tabStore.autoTitle(tabStore.activeTabId)
    }
  }

  function toggleSectionRole(id: string) {
    const section = sections.value.find((s) => s.id === id)
    if (section) {
      section.role = section.role === 'user' ? 'agent' : 'user'
    }
  }

  function addSection(role: Role): Section {
    const section: Section = {
      id: crypto.randomUUID(),
      role,
      content: '',
    }
    sections.value.push(section)
    return section
  }

  function removeSectionIfEmpty(id: string) {
    const index = sections.value.findIndex((s) => s.id === id)
    if (index !== -1 && sections.value[index].content.trim() === '' && sections.value.length > 1) {
      sections.value.splice(index, 1)
    }
  }

  function clearThread() {
    tabStore.activeTab.sections = [
      { id: crypto.randomUUID(), role: 'user', content: '' },
    ]
  }

  function getThreadForSubmission(): { role: Role; content: string }[] {
    return sections.value
      .filter((s) => s.content.trim() !== '')
      .map((s) => ({ role: s.role, content: s.content }))
  }

  function splitSection(id: string, cursorPosition: number): Section | null {
    const index = sections.value.findIndex((s) => s.id === id)
    if (index === -1) return null
    const current = sections.value[index]
    const before = current.content.slice(0, cursorPosition)
    const after = current.content.slice(cursorPosition)
    current.content = before
    const newSection: Section = {
      id: crypto.randomUUID(),
      role: 'user',
      content: after,
    }
    sections.value.splice(index + 1, 0, newSection)
    return newSection
  }

  return {
    sections,
    activeModel,
    initActiveModel,
    setActiveModel,
    updateSectionContent,
    toggleSectionRole,
    addSection,
    removeSectionIfEmpty,
    splitSection,
    clearThread,
    getThreadForSubmission,
  }
})
