import type { Section } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import type { StreamMessage } from './types'

export function sectionsToStreamMessages(sections: Section[]): StreamMessage[] {
  return sections
    .filter((section) => !sectionIsEmpty(section))
    .map((section) => ({
      role: section.role,
      content: sectionPlainText(section),
    }))
}

export function hasStreamMessages(sections: Section[]): boolean {
  return sectionsToStreamMessages(sections).length > 0
}
