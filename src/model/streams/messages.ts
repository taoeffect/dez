import type { ModelRef, Section } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { sameModelRef } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import type { StreamMessage } from './types'

// The request messages: every section that has text, in order. An agent
// section brings its thinking only when `requestModel` wrote it and it has a
// replay: a replay is valid only for the model that made it, and thinking
// with no replay (pasted, cut off, or split from inline tags) never goes back.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef): StreamMessage[] {
  return sections
    .filter((section) => !sectionIsEmpty(section))
    .map((section) => ({
      role: section.role,
      content: sectionPlainText(section),
      ...(section.role === 'agent' && section.thinking?.replay && sameModelRef(section.model, requestModel)
        ? thinkingField(section.thinking)
        : {}),
    }))
}
