import type { ImageSize } from '../chat/imageDrawing'
import type { MessagePart, PicturePart } from '../chat/types'
import type { StreamMessage } from './types'

// The pictures that the `asset_view` calls of one reply show the model.
// The section never holds them: a request of the reply sends them in one
// `user` message right after the tool message of the round whose call
// showed them. Each later request of the same reply sends them again, at
// the same place, as the same bytes: the prompt cache needs the same bytes
// of the earlier messages, and so do the thinking replays, as a replay
// goes back only while the request before it hashes to its `prefixHash`
// (`wireChat`, providers/apiFormats.ts). The next reply has none of them:
// a model that needs a picture again calls `asset_view` again. The
// Anthropic format joins the message to the tool results before it, after
// the results (`withResultsJoined`).
//
// As each later request sends every picture again, the pictures of a reply
// share one budget that follows what they cost: the tokens that a model
// reads them as, the base64 text of their bytes, and their count. The
// budget is the same for every model, from the Claude limits and costs.
// https://platform.claude.com/docs/en/build-with-claude/vision

/** The most tokens of one picture: Claude Opus 5.5 reads a larger picture
 *  at its high resolution as this many tokens. */
export const MAX_PICTURE_TOKENS = 4784

/** The most tokens of the pictures of one reply: 12 pictures that cost the
 *  most. */
export const MAX_REPLY_PICTURE_TOKENS = 12 * MAX_PICTURE_TOKENS

/** The most bytes of the base64 text of the pictures of one reply. */
export const MAX_REPLY_PICTURE_BYTES = 20 * 1024 ** 2

/** The most images of one request: the Claude API refuses an image with a
 *  side over 3,000 px in a request with more. The images of the newest user
 *  message go in each request of the reply too. */
export const MAX_REQUEST_IMAGES = 20

/** What the pictures of a reply can still cost, or what one picture
 *  costs. */
export interface PictureBudget {
  /** About how many tokens a model reads them as (`pictureTokens`). */
  tokens: number
  /** The bytes of their base64 text. */
  bytes: number
  pictures: number
}

/** The budget of a reply that shows no picture any more. */
export const NO_PICTURE_BUDGET: PictureBudget = { tokens: 0, bytes: 0, pictures: 0 }

/** About how many tokens a model reads a picture of `size` pixels as: one
 *  for each square of 28 by 28 pixels, at most `MAX_PICTURE_TOKENS`. A
 *  picture of an unknown size costs the most. */
export function pictureTokens(size: ImageSize | null): number {
  if (size === null) return MAX_PICTURE_TOKENS
  return Math.min(MAX_PICTURE_TOKENS, Math.ceil(size.width / 28) * Math.ceil(size.height / 28))
}

/** What `picture`, of `size` pixels (null: not known), costs. */
export function pictureCost(picture: PicturePart, size: ImageSize | null): PictureBudget {
  // Base64 writes each 3 bytes, and the 1 or 2 at the end, as 4 characters.
  return { tokens: pictureTokens(size), bytes: 4 * Math.ceil(picture.bytes.length / 3), pictures: 1 }
}

/** `budget` after a picture that costs `cost`; null when the picture does
 *  not fit in it. */
export function budgetAfter(budget: PictureBudget, cost: PictureBudget): PictureBudget | null {
  const left = { tokens: budget.tokens - cost.tokens, bytes: budget.bytes - cost.bytes, pictures: budget.pictures - cost.pictures }
  return left.tokens < 0 || left.bytes < 0 || left.pictures < 0 ? null : left
}

/** The images of `messages` that count against `MAX_REQUEST_IMAGES`: the
 *  image and picture parts of their user messages. Only the newest user
 *  message of the messages of a reply has any (`sectionsToStreamMessages`,
 *  streams/messages.ts). */
export function requestImageCount(messages: readonly StreamMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === 'user' && typeof message.content !== 'string'
    ? message.content.filter((part) => part.type !== 'text').length
    : 0), 0)
}

/** One picture that a tool shows the model. */
export interface ReplyPicture {
  /** What the picture shows: the text that goes right before it. */
  label: string
  picture: PicturePart
  /** Its size in pixels, as it goes; null when Dez does not know it. */
  size: ImageSize | null
}

/** The pictures of one reply. */
export class ReplyPictures {
  // By the id of the first call of the group of calls whose round showed
  // them: the `callId` of the first result of that round's tool message.
  private readonly byRound = new Map<string, ReplyPicture[]>()
  private budget: PictureBudget

  /** `userImages`: the images of the messages before the reply
   *  (`requestImageCount`), which go with the pictures in each request of
   *  the reply. */
  constructor(userImages: number) {
    this.budget = { tokens: MAX_REPLY_PICTURE_TOKENS, bytes: MAX_REPLY_PICTURE_BYTES, pictures: Math.max(0, MAX_REQUEST_IMAGES - userImages) }
  }

  /** What the reply can still show. */
  get left(): PictureBudget {
    return this.budget
  }

  /** Keeps `pictures` for the round whose group of calls starts with the
   *  call `roundCallId`, in order, after the earlier ones of that round:
   *  each one that fits in what is left, so a smaller picture after one
   *  that does not fit can still go. */
  add(roundCallId: string, pictures: readonly ReplyPicture[]): void {
    const kept: ReplyPicture[] = []
    for (const picture of pictures) {
      const left = budgetAfter(this.budget, pictureCost(picture.picture, picture.size))
      if (left === null) continue
      this.budget = left
      kept.push(picture)
    }
    if (kept.length === 0) return
    const round = this.byRound.get(roundCallId)
    if (round) round.push(...kept)
    else this.byRound.set(roundCallId, kept)
  }

  /** `messages` with the picture message of each round right after the
   *  tool message of that round. */
  inMessages(messages: readonly StreamMessage[]): StreamMessage[] {
    return messages.flatMap((message): StreamMessage[] => {
      const pictures = message.role === 'tool' && message.results.length > 0 ? this.byRound.get(message.results[0].callId) : undefined
      if (!pictures) return [message]
      return [message, { role: 'user', content: pictures.flatMap(({ label, picture }): MessagePart[] => [{ type: 'text', text: label }, picture]) }]
    })
  }
}
