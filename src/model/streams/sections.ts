import type { Role, Section } from '../chat/types'
import { emptyContent, sectionIsEmpty, setSectionPlainText } from '../chat/content'

export function createStreamSection(role: Role): Section {
  return {
    id: crypto.randomUUID(),
    role,
    content: emptyContent(),
  }
}

export function ensureTrailingAgentSection(sections: Section[]): Section {
  const lastSection = sections[sections.length - 1]
  if (!lastSection || lastSection.role !== 'agent' || !sectionIsEmpty(lastSection)) {
    const section = createStreamSection('agent')
    sections.push(section)
    return section
  }

  lastSection.content = emptyContent()
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
