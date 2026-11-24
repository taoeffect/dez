import { compactionThreshold } from '../chat/contextSize'
import type { ImageSize } from '../chat/imageDrawing'
import type { MessagePart } from '../chat/types'
import { shownPictureSize, type PictureFile, type ShownPicture } from '../chat/shownPictures'
import { contextWindowOf, imageLimitOf, imageTokens, messageImageLimitOf, type ImageTokenRule } from '../providers/modelFamilies'
import type { ModelInfo } from '../providers/types'
import { ASSUMED_IMAGE_SIZE } from './contextEstimate'
import type { StreamMessage } from './types'

// The picture budget: what the pictures of an `asset_view` call can still
// cost. A picture goes to the model in one `user` message right after the
// tool message of its call's round (`agentSectionMessages`, messages.ts),
// and each later request of the conversation sends it again, until a
// compaction takes the round out. So the budget follows the context, from
// one compaction to the next: it is the limits of one request to the
// model, less the cost of every image and picture that the context holds
// now. A picture costs the tokens that the model reads it as (the image
// rule of its family, providers/modelFamilies.ts), the base64 text of its
// bytes, and one of the images of a request.
//
// The same limits tell when a compaction is due (`compactionReason`,
// compactionRequest.ts), and how much a compaction leaves
// (`compactedPictureLimits`): the three must read one count, else a tool
// tells a model of room that the next compaction check does not see.

/** The share of the compaction threshold (`compactionThreshold`) that the
 *  images and the pictures of a context can take, in tokens. They are the
 *  part of a context that a text summary cannot keep, so they must leave
 *  room for the text. */
const PICTURE_TOKEN_SHARE = 0.4

/** The most bytes of the base64 text of the images and the pictures of one
 *  request: providers refuse a request body of some tens of megabytes. */
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 ** 2

/** The share of each picture limit of a request that the images and the
 *  pictures of a conversation can take right after a compaction. A
 *  compaction is due near a limit (`compactionReason`), so with this share
 *  the next one is due only after new images or pictures came, and a reply
 *  can view pictures again. */
const COMPACTED_PICTURE_SHARE = 0.5

/** What pictures can still cost, or what they cost. */
export interface PictureBudget {
  /** About how many tokens a model reads them as (`imageTokens`). */
  tokens: number
  /** The bytes of their base64 text. */
  bytes: number
  pictures: number
}

/** Nothing: the cost of no picture (`totalCost`), and a budget that no
 *  picture fits in. */
export const NO_PICTURE_BUDGET: PictureBudget = { tokens: 0, bytes: 0, pictures: 0 }

/** What the pictures of a tool call can still cost
 *  (`ToolRunContext.pictureBudget`, controller/tools.ts). */
export interface CallPictureBudget {
  /** What the context has left, until the next compaction
   *  (`pictureBudgetLeft`). */
  left: PictureBudget
  /** How many more pictures the calls of the round can show. The pictures
   *  of a round go in one message, and a message has an image limit of its
   *  own (`messageImageLimitOf`); the next round has that count again. */
  roundPictures: number
}

/** The budget of a call that shows no picture: its model reads no images,
 *  or its tool round was stopped. */
export const NO_CALL_PICTURE_BUDGET: CallPictureBudget = { left: NO_PICTURE_BUDGET, roundPictures: 0 }

/** What the picture limits read of a model. */
export type PictureLimitsModel = Pick<ModelInfo, 'id' | 'contextWindow' | 'imageLimit' | 'messageImageLimit' | 'learnedImageLimit'>

/** The most that the images and the pictures of one request to `model` can
 *  cost. The count is the image limit of the model (`imageLimitOf`), so it
 *  is `Infinity` for a model with no limit. */
export function pictureLimits(model: PictureLimitsModel): PictureBudget {
  return {
    tokens: Math.floor(PICTURE_TOKEN_SHARE * compactionThreshold(contextWindowOf(model))),
    bytes: MAX_REQUEST_IMAGE_BYTES,
    pictures: imageLimitOf(model),
  }
}

/** The most that the images and the pictures of a conversation can cost a
 *  request to `model` right after a compaction: a share of each limit
 *  (`COMPACTED_PICTURE_SHARE`). They all go in one message, the compaction
 *  message, so their count is also at most the limit of one message
 *  (`messageImageLimitOf`). The count is never under 1: a model that takes
 *  one image can still see one of the user's. */
export function compactedPictureLimits(model: PictureLimitsModel): PictureBudget {
  const limits = pictureLimits(model)
  return {
    tokens: Math.floor(COMPACTED_PICTURE_SHARE * limits.tokens),
    bytes: Math.floor(COMPACTED_PICTURE_SHARE * limits.bytes),
    pictures: Math.min(Math.max(1, Math.floor(COMPACTED_PICTURE_SHARE * limits.pictures)), messageImageLimitOf(model)),
  }
}

// The bytes of the base64 text of a file of `bytes` bytes: base64 writes
// each 3 bytes, and the 1 or 2 at the end, as 4 characters.
function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

// What one image of `size` pixels and `byteCount` bytes costs a model that
// counts by `rule`. Every cost of an image or a picture comes from here, so
// a saved picture costs what it cost before its save.
function imageCost(rule: ImageTokenRule, size: ImageSize | null, byteCount: number): PictureBudget {
  return { tokens: imageTokens(rule, size), bytes: base64Length(byteCount), pictures: 1 }
}

/** What a new picture with the file `file`, of `size` pixels, costs a
 *  model that counts by `rule`. A picture of an unknown size (null) costs
 *  the most tokens that the rule gives. */
export function pictureCost(rule: ImageTokenRule, file: PictureFile, size: ImageSize | null): PictureBudget {
  return imageCost(rule, size, file.bytes.length)
}

/** What the saved picture `picture` costs a model that counts by `rule`:
 *  the same as `pictureCost` gave for it before its save. The copy of an
 *  older Dez tells no byte count, so it counts no bytes. */
export function shownPictureCost(rule: ImageTokenRule, picture: ShownPicture): PictureBudget {
  return imageCost(rule, shownPictureSize(picture), picture.bytes ?? 0)
}

/** `budget` after a picture that costs `cost`; null when the picture does
 *  not fit in it. */
export function budgetAfter(budget: PictureBudget, cost: PictureBudget): PictureBudget | null {
  const left = { tokens: budget.tokens - cost.tokens, bytes: budget.bytes - cost.bytes, pictures: budget.pictures - cost.pictures }
  return left.tokens < 0 || left.bytes < 0 || left.pictures < 0 ? null : left
}

/** The sum of `costs`. */
export function totalCost(costs: readonly PictureBudget[]): PictureBudget {
  return costs.reduce((sum, cost) => ({ tokens: sum.tokens + cost.tokens, bytes: sum.bytes + cost.bytes, pictures: sum.pictures + cost.pictures }), NO_PICTURE_BUDGET)
}

/** What the images and the pictures of `messages` cost a model that counts
 *  by `rule`. Dez does not decode an image of a user message for this: it
 *  counts as an image of `ASSUMED_IMAGE_SIZE`, as in the context estimate,
 *  and by the bytes that a request sends for it in `imageBytes` (by path;
 *  none: no bytes), which `dez.provider/chatImageSizes` gives. */
export function contextImageCost(messages: readonly StreamMessage[], rule: ImageTokenRule, imageBytes: ReadonlyMap<string, number>): PictureBudget {
  return totalCost(Array.from(attachmentParts(messages), (part) => (part.type === 'picture'
    ? shownPictureCost(rule, part.picture)
    : imageCost(rule, ASSUMED_IMAGE_SIZE, imageBytes.get(part.path) ?? 0))))
}

/** What is left of `limits` after `spent`: never under 0 in a part, as
 *  the images of a user message can cost more than a limit. */
export function pictureBudgetLeft(limits: PictureBudget, spent: PictureBudget): PictureBudget {
  return {
    tokens: Math.max(0, limits.tokens - spent.tokens),
    bytes: Math.max(0, limits.bytes - spent.bytes),
    pictures: Math.max(0, limits.pictures - spent.pictures),
  }
}

/** The image and picture parts of the user messages of `messages`: the
 *  images of the user messages, the pictures of a compaction tag, and the
 *  pictures of the rounds of the replies (`sectionsToStreamMessages`,
 *  streams/messages.ts). A clip part (a `model_invoke` request) is no
 *  picture. */
export function* attachmentParts(messages: readonly StreamMessage[]): Generator<Extract<MessagePart, { type: 'image' | 'picture' }>> {
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (const part of message.content) if (part.type === 'image' || part.type === 'picture') yield part
  }
}

/** The images of `messages` that count against the image limit of a
 *  request (`imageLimitOf`): all their `attachmentParts`. */
export function requestImageCount(messages: readonly StreamMessage[]): number {
  return Array.from(attachmentParts(messages)).length
}
