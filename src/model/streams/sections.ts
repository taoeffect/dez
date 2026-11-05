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
// section: it records the model that writes the next response. A reused
// section loses its old thinking, which belongs to the earlier request.
export function ensureTrailingAgentSection(sections: Section[], model: ModelRef): Section {
  const lastSection = sections[sections.length - 1]
  if (!lastSection || lastSection.role !== 'agent' || !sectionIsEmpty(lastSection)) {
    const section: Section = { ...createStreamSection('agent'), model: cloneModelRef(model) }
    sections.push(section)
    return section
  }

  lastSection.content = emptyContent()
  lastSection.model = cloneModelRef(model)
  delete lastSection.thinking
  return lastSection
}

function ensureTrailingUserSection(sections: Section[]): void {
  if (sections.at(-1)?.role !== 'user') sections.push(createStreamSection('user'))
}

// Ends the stream that wrote `section`. A failed request that wrote no answer
// text and no thinking leaves no trace: its agent section goes, and no user
// section is added, so the tab ends with the user's text as before the
// submit (the error shows in a toast). Any other end keeps the section,
// blanks it when it has only whitespace, and adds a trailing user section
// for the next message.
export function endStreamSection(sections: Section[], section: Section, failed: boolean): void {
  if (section.role !== 'agent') return
  const empty = sectionIsEmpty(section)
  if (failed && empty && !section.thinking) {
    const index = sections.findIndex((candidate) => candidate.id === section.id)
    // The first section is always a user section; never remove it.
    if (index > 0) sections.splice(index, 1)
    return
  }
  if (empty) setSectionPlainText(section, '')
  ensureTrailingUserSection(sections)
}
