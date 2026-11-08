import type { MessagePart, ModelRef, Section } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findImageReferences, labelImageReferences, splitImageReferences } from '../chat/images'
import { sameModelRef } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import type { RequestMessages, StreamMessage } from './types'

// The request messages: every section that has text, in order. An agent
// section brings its thinking only when `requestModel` wrote it and it has a
// replay: a replay is valid only for the model that made it, and thinking
// with no replay (pasted, cut off, or split from inline tags) never goes back.
//
// The image references of a user section go as image parts. With
// `sendImages` false (the request model does not read images), each one goes
// as the text `[image]` instead. Agent text is sent as it is: both formats
// take images only from the user.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, sendImages: boolean): RequestMessages {
  let imagesLeftOut = 0
  const messages = sections
    .filter((section) => !sectionIsEmpty(section))
    .map((section): StreamMessage => {
      const text = sectionPlainText(section)
      if (section.role === 'agent') {
        return {
          role: 'agent',
          content: text,
          ...(section.thinking?.replay && sameModelRef(section.model, requestModel) ? thinkingField(section.thinking) : {}),
        }
      }
      if (!sendImages) {
        imagesLeftOut += findImageReferences(text).length
        return { role: 'user', content: labelImageReferences(text) }
      }
      return { role: 'user', content: userMessageContent(text) }
    })

  return { messages, imagesLeftOut }
}

// Text and image parts in doc order. A text with no image reference stays a
// string, so a text-only request body is the same bytes as before images
// existed: the prefix hashes of saved thinking replays depend on it.
// Whitespace-only text between parts is left out: Anthropic refuses a text
// block with no visible text.
function userMessageContent(text: string): string | MessagePart[] {
  const pieces = splitImageReferences(text)
  if (!pieces.some((piece) => piece.kind === 'image')) return text

  return pieces.flatMap((piece): MessagePart[] => {
    if (piece.kind === 'image') return [{ type: 'image', path: piece.path }]
    return piece.text.trim() ? [{ type: 'text', text: piece.text }] : []
  })
}
