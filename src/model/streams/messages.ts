import type { MessagePart, ModelRef, Section } from '../chat/types'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findImageReferences, holdsImagePath, splitImageReferences, withoutImagePaths } from '../chat/images'
import { sameModelRef } from '../chat/modelRef'
import { thinkingField } from '../chat/thinking'
import type { RequestMessages, StreamMessage } from './types'

// The request messages: every section that has text, in order. No image path
// ever goes to a provider: every text (user and agent text, prompt bodies)
// goes through `withoutImagePaths`, so a reference goes as `![image](id=a)`,
// with the ids and other metadata that later requests can name. Each message
// is built from its own section only, so an earlier message is the same
// bytes in every later request (prompt cache).
//
// An agent section brings its thinking only when `requestModel` wrote it, it
// has a replay, and it holds no image path: a replay is valid only for the
// model that made it, a signed replay cannot be changed, and thinking with no
// replay (pasted, cut off, or split from inline tags) never goes back.
//
// The image references of a user section also go as image parts. With
// `sendImages` false (the request model does not read images), only their
// text goes. An agent section's images go as text only: both formats take
// images only from the user.
export function sectionsToStreamMessages(sections: Section[], requestModel: ModelRef, sendImages: boolean): RequestMessages {
  let imagesLeftOut = 0
  const messages = sections
    .filter((section) => !sectionIsEmpty(section))
    .map((section): StreamMessage => {
      const text = sectionPlainText(section)
      if (section.role === 'agent') {
        const { thinking } = section
        // A `field` replay sends the thinking text; the other kinds hold the
        // thinking in their own JSON.
        const sendThinking = thinking?.replay && sameModelRef(section.model, requestModel) &&
          !holdsImagePath(thinking.text) && !holdsImagePath(JSON.stringify(thinking.replay))
        return {
          role: 'agent',
          content: withoutImagePaths(text),
          ...(sendThinking ? thinkingField(thinking) : {}),
        }
      }
      if (!sendImages) {
        imagesLeftOut += findImageReferences(text).length
        return { role: 'user', content: withoutImagePaths(text) }
      }
      return { role: 'user', content: userMessageContent(text) }
    })

  return { messages, imagesLeftOut }
}

// Text and image parts in doc order. Each image part comes right after its
// reference's text, `![image](id=a)`, at the end of the text part before it,
// so that a model can name the image by its id. A text with no image
// reference stays a string, so a text-only request body is the same bytes as
// before images existed: the prefix hashes of saved thinking replays depend
// on it. A whitespace-only text after the last image is left out: Anthropic
// refuses a text block with no visible text.
function userMessageContent(text: string): string | MessagePart[] {
  const pieces = splitImageReferences(text)
  if (!pieces.some((piece) => piece.kind === 'image')) return withoutImagePaths(text)

  const parts: MessagePart[] = []
  let textBefore = ''
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      textBefore = piece.text
      continue
    }
    parts.push({ type: 'text', text: withoutImagePaths(textBefore + piece.source) }, { type: 'image', path: piece.path })
    textBefore = ''
  }
  if (textBefore.trim()) parts.push({ type: 'text', text: withoutImagePaths(textBefore) })
  return parts
}
