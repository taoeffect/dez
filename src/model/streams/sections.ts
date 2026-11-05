import type { ModelRef, Role, Section } from '../chat/types'
import { emptyContent, sectionIsEmpty, setSectionPlainText } from '../chat/content'
import { cloneModelRef } from '../chat/modelRef'

export function createStreamSection(role: Role): Section {
  return {
    id: crypto.randomUUID(),
    role,
    content: emptyContent(),
  }
}

// The returned section gets `model`, also when it is a reused empty agent
// section: it records the model that writes the next response.
export function ensureTrailingAgentSection(sections: Section[], model: ModelRef): Section {
  const lastSection = sections[sections.length - 1]
  if (!lastSection || lastSection.role !== 'agent' || !sectionIsEmpty(lastSection)) {
    const section: Section = { ...createStreamSection('agent'), model: cloneModelRef(model) }
    sections.push(section)
    return section
  }

  lastSection.content = emptyContent()
  lastSection.model = cloneModelRef(model)
  return lastSection
}

export function ensureTrailingUserSection(sections: Section[]): Section {
  const lastSection = sections[sections.length - 1]
  if (!lastSection || lastSection.role !== 'user') {
    const section = createStreamSection('user')
    sections.push(section)
    return section
  }

  return lastSection
}

export function fillEmptyAgentSectionOnError(section: Section, error: string | null): void {
  if (section.role === 'agent' && sectionIsEmpty(section)) {
    setSectionPlainText(section, error ? `Error: ${error}` : '')
  }
}
