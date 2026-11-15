import type { ImageSize } from '../chat/imageDrawing'
import { shownPictureSize } from '../chat/shownPictures'
import { imageTokens, type ModelFamily } from '../providers/modelFamilies'
import { toolJsonSchema } from '../tools/registry'
import type { StreamedToolCall, ToolDefinition } from '../tools/types'
import type { StreamMessage } from './types'

// Dez's own estimate of the tokens of a chat request, for the context size
// of a tab (chat/contextSize.ts). It uses no tokenizer: a tokenizer is
// large, and each one is wrong for the models of the other makers. The
// estimate counts characters and images with the numbers of the model's
// family (providers/modelFamilies.ts).
//
// It is exact for nothing. Its use is the difference of two estimates of
// one tab, on top of a provider's count (`contextSize`), and the size of a
// tab that no provider counted.

/** What a chat request holds, as far as its size goes. */
export interface EstimatedRequest {
  /** Absent for a request with no system prompt. */
  system?: string
  /** The Dez tools that the request offers. */
  tools: readonly ToolDefinition[]
  messages: readonly StreamMessage[]
  /** The tool calls of the newest answer, which no message holds yet. */
  answerCalls?: readonly StreamedToolCall[]
}

/** The size that an image of a user message counts as, and a picture
 *  whose block does not tell its size: Dez reads no pixel size of them
 *  here. So the same request is the same number in every run of the app,
 *  and two estimates of one tab differ only by what changed in it. The
 *  picture budget counts an image of a user message as this size too
 *  (pictureBudget.ts).
 *
 *  It is a middle size, not the largest one that a family's rule knows. An
 *  image is in the estimate of a tab only while its user message is the
 *  newest one, so its count is added and then taken off again. A count far
 *  over the true one (a GPT model reads the largest image as 36,000 tokens,
 *  and a common one as 1,000 to 3,000) would put the context size far under
 *  the true one when the image leaves.
 *
 *  1568 px is the long side of the review pictures of `asset_view`
 *  (`IMAGE_PICTURE_SIDES`), and the side over which most Claude models make
 *  an image smaller. */
export const ASSUMED_IMAGE_SIZE: ImageSize = { width: 1568, height: 1568 }

// How many characters of `text` are kana, Han, or Hangul. The characters
// per token of a family are for English text; a tokenizer makes about one
// token of each of these characters (the makers state 0.6 to 1 for Han),
// so a ratio of 2.5 to 4 would count such a text at a third of its size.
function wideCharacters(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x3040) continue
    if (code <= 0x30ff || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) count++
  }
  return count
}

/** About how many tokens a model of `family` reads `request` as: its
 *  system prompt, its tools (as the JSON that a request lists them in),
 *  and its messages with their tool calls, tool results, and the thinking
 *  that goes back.
 *
 *  A character counts by the family's characters per token, and a kana,
 *  Han, or Hangul character as one token. An image counts by the family's
 *  image rule, as one of `ASSUMED_IMAGE_SIZE`; a picture of an
 *  `asset_view` call by the same rule, at the size of its saved copy. */
export function estimatedRequestTokens(request: EstimatedRequest, family: ModelFamily): number {
  let characters = 0
  let wide = 0
  let imageTokenCount = 0
  const addText = (text: string) => {
    const wideOfText = wideCharacters(text)
    wide += wideOfText
    characters += text.length - wideOfText
  }

  if (request.system !== undefined) addText(request.system)
  if (request.tools.length > 0) {
    addText(JSON.stringify(request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toolJsonSchema(tool) }))))
  }
  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        if (typeof message.content === 'string') {
          addText(message.content)
          break
        }
        for (const part of message.content) {
          if (part.type === 'text') addText(part.text)
          else imageTokenCount += imageTokens(family.imageTokens, (part.type === 'picture' ? shownPictureSize(part.picture) : null) ?? ASSUMED_IMAGE_SIZE)
        }
        break
      case 'agent':
        addText(message.content)
        // A replay that is no text field holds the thinking in its own
        // JSON, with parts that are no text (a signature, encrypted data).
        // The thinking text stands for all of them.
        if (message.thinking) addText(message.thinking.text)
        for (const call of message.toolCalls ?? []) {
          addText(call.name)
          addText(JSON.stringify(call.arguments))
        }
        break
      case 'tool':
        for (const result of message.results) addText(result.content)
    }
  }
  for (const call of request.answerCalls ?? []) {
    addText(call.name)
    addText(call.argumentsText)
  }

  return Math.ceil(characters / family.charsPerToken) + wide + imageTokenCount
}
