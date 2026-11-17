import { sectionTextParts } from '../chat/compaction'
import type { ModelRef, Role, Section } from '../chat/types'
import { emptyContent, sectionIsEmpty, sectionPlainText, setSectionPlainText } from '../chat/content'
import { cloneModelRef } from '../chat/modelRef'
import type { StreamEndStatus } from './types'

export function createStreamSection(role: Role): Section {
  return {
    id: crypto.randomUUID(),
    role,
    content: emptyContent(),
  }
}

// The returned section gets `model`, also when it is a reused empty agent
// section: it records the model that writes the next response. A reused
// section loses its old thinking and duration, which belong to the earlier
// request.
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
  delete lastSection.durationMs
  return lastSection
}

function ensureTrailingUserSection(sections: Section[]): void {
  if (sections.at(-1)?.role !== 'user') sections.push(createStreamSection('user'))
}

// Ends the stream that wrote `section`, which took `durationMs`. A stream
// that wrote no answer text leaves no trace when the user stopped it or
// when it failed with no thinking either: its agent section goes, and no
// user section is added, so the tab ends with the user's text as before the
// submit (a failure shows in a toast). A stop drops the thinking too:
// thinking alone is not the start of an answer. Any other end keeps the
// section with its duration, blanks it when it has only whitespace, and
// adds a trailing user section for the next message.
//
// A compaction in the reply made its section the compaction section: the
// block, then the reply text (`sectionTextParts`). Only the reply text
// counts for these rules, and the section never goes, as it holds the
// notes that took the place of the conversation, with the message of the
// user. With no trace, it keeps no thinking and no duration. A blank reply
// text goes, with the line break after the block. It always gets a user
// section after it for the next message.
export function endStreamSection(sections: Section[], section: Section, status: StreamEndStatus, durationMs: number): void {
  if (section.role !== 'agent') return
  const index = sections.findIndex((candidate) => candidate.id === section.id)
  const { block, text } = sectionTextParts(section, index)
  const empty = block === null ? sectionIsEmpty(section) : text.trim() === ''
  const leavesNoTrace = empty && (status === 'cancelled' || (status === 'error' && !section.thinking))
  if (leavesNoTrace && block === null) {
    // The first section is a user section or the compaction section, which
    // has a block: never remove it.
    if (index > 0) sections.splice(index, 1)
    return
  }
  if (leavesNoTrace) delete section.thinking
  else section.durationMs = durationMs
  if (empty) setSectionPlainText(section, block === null ? '' : sectionPlainText(section).slice(0, block.to))
  ensureTrailingUserSection(sections)
}
