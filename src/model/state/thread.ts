import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { Role, Section } from '../chat/types'
import {
  appendStreamingText,
  contentEquals,
  emptyContent,
  normalizeContent,
  sectionIsEmpty,
  sectionPlainText,
  setSectionPlainText,
  splitContentAt,
} from '../chat/content'
import type { ContentNode } from '../chat/types'
import { useSettingsStore } from './settings'
import { useTabStore } from './tabs'

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

  /** Replace a section's entire content with plain text (used by the DOM reader). */
  function updateSectionContent(id: string, text: string) {
    const section = sections.value.find((s) => s.id === id)
    if (section) {
      setSectionPlainText(section, text)
      tabStore.autoTitle(tabStore.activeTabId)
    }
  }

  /**
   * Replace a section's entire content with a structured ContentNode[] (used by
   * the DOM reader when the section contains prompt pills). Normalizes and
   * skips the mutation if the resulting array is structurally equal to the
   * current one, to avoid unnecessary reactivity churn during DOM typing.
   */
  function setSectionContent(id: string, nodes: ContentNode[]) {
    const section = sections.value.find((s) => s.id === id)
    if (!section) return
    const normalized = normalizeContent(nodes)
    if (contentEquals(section.content, normalized)) return
    section.content.splice(0, section.content.length, ...normalized)
    tabStore.autoTitle(tabStore.activeTabId)
  }

  function togglePromptExpanded(sectionId: string, nodeId: string) {
    const section = sections.value.find((s) => s.id === sectionId)
    if (!section) return
    for (const node of section.content) {
      if (node.kind === 'prompt' && node.id === nodeId) {
        node.expanded = !node.expanded
        return
      }
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
      content: emptyContent(),
    }
    sections.value.push(section)
    return section
  }

  function removeSectionIfEmpty(id: string) {
    const index = sections.value.findIndex((s) => s.id === id)
    if (index !== -1 && sectionIsEmpty(sections.value[index]) && sections.value.length > 1) {
      sections.value.splice(index, 1)
    }
  }

  function clearThread() {
    tabStore.activeTab.sections = [
      { id: crypto.randomUUID(), role: 'user', content: emptyContent() },
    ]
  }

  function getThreadForSubmission(): { role: Role; content: string }[] {
    return sections.value
      .filter((s) => !sectionIsEmpty(s))
      .map((s) => ({ role: s.role, content: sectionPlainText(s) }))
  }

  function splitSection(id: string, cursorPosition: number): Section | null {
    const index = sections.value.findIndex((s) => s.id === id)
    if (index === -1) return null
    const current = sections.value[index]
    const [before, after] = splitContentAt(current.content, cursorPosition)
    current.content = before
    const newSection: Section = {
      id: crypto.randomUUID(),
      role: 'user',
      content: after,
    }
    sections.value.splice(index + 1, 0, newSection)
    return newSection
  }

  function appendTokenToSection(id: string, token: string) {
    const section = sections.value.find((s) => s.id === id)
    if (section) appendStreamingText(section, token)
  }

  return {
    sections,
    activeModel,
    initActiveModel,
    setActiveModel,
    updateSectionContent,
    setSectionContent,
    togglePromptExpanded,
    toggleSectionRole,
    addSection,
    removeSectionIfEmpty,
    splitSection,
    clearThread,
    getThreadForSubmission,
    appendTokenToSection,
  }
})
