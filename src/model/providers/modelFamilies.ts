import * as z from 'zod'
import { isRegExpSource } from '../../utils/regExpSource'
import type { ImageSize } from '../chat/imageDrawing'
import { configIssueText } from './config'
import { LARGEST_PICTURE_SIDE } from './imageSize'
import modelFamiliesFile from './modelFamilies.json'
import type { ModelInfo } from './types'

// The model families (modelFamilies.json): what Dez knows of a model from
// its id alone, for the numbers that no model list gives. A family tells how
// many tokens a text and an image are for its models, and their context
// window and image limits. Every number is from the docs of the family's
// maker (`sources`, and `checked`, the day that someone last read them
// there); `note` tells which of the docs' numbers the entry took.
//
// The first entry whose `match` finds the model id is the family of the
// model, so an entry for some models of a maker is before the entry for the
// rest. `match` is a regular expression, read with no case, as the same
// model has an id of another form at each provider (`gpt-5.4`,
// `openai/gpt-5.4`, `openai-gpt-54`).
//
// Where the models of an entry differ, the entry holds the number that is
// safe for each of them: the smallest window and image limit, and the count
// that gives the most tokens. A window that is too small makes Dez compact
// early; one that is too large makes a request fail.

const positiveInt = z.number().int().positive()

// How a family counts the tokens of one image.
// - `fixed`: each image is `tokens`.
// - `patches`: the image is made smaller, never larger, until its long side
//   is at most `maxLongSidePx`. Each square of `patchPx` pixels that it then
//   covers is one patch, at most `maxPatches`, and each patch is
//   `tokensPerPatch` tokens (1 when missing).
// - `tiles`: the image is made smaller until it fits a square of `fitPx`
//   pixels, and then until its short side is at most `shortSidePx`. Each
//   square of `tilePx` pixels that it then covers is `tileTokens`, and
//   `baseTokens` come on top.
const imageTokenRuleSchema = z.discriminatedUnion('rule', [
  z.strictObject({ rule: z.literal('fixed'), tokens: positiveInt }),
  z.strictObject({
    rule: z.literal('patches'),
    patchPx: positiveInt,
    maxLongSidePx: positiveInt.optional(),
    maxPatches: positiveInt,
    tokensPerPatch: z.number().positive().optional(),
  }),
  z.strictObject({
    rule: z.literal('tiles'),
    fitPx: positiveInt,
    shortSidePx: positiveInt,
    tilePx: positiveInt,
    baseTokens: z.number().int().nonnegative(),
    tileTokens: positiveInt,
  }),
])

// The entry's `match` as the expression that finds a model id.
const matchSchema = z.string().min(1)
  .refine(isRegExpSource, 'The match is no regular expression.')
  .transform((source) => new RegExp(source, 'i'))

const modelFamilyEntrySchema = z.strictObject({
  // Unique in the file, and stable.
  id: z.string().min(1),
  match: matchSchema,
  // The characters of English text that are one token, at the low end of
  // what the docs state.
  charsPerToken: z.number().positive().optional(),
  imageTokens: imageTokenRuleSchema.optional(),
  // In tokens: the most that one request and its answer hold, or the
  // smaller limit of the request alone.
  contextWindow: positiveInt.optional(),
  // The most images of one request, in all of its messages. `null`: the
  // docs state that there is no limit.
  maxImages: positiveInt.nullable().optional(),
  // In a request with more than `over` images, no side of an image can be
  // more than `maxSidePx` pixels. It counts only when Dez sends a picture
  // with a longer side (`imageLimitOf`).
  manyImages: z.strictObject({ over: positiveInt, maxSidePx: positiveInt }).optional(),
  note: z.string().trim().min(1).optional(),
  sources: z.array(z.url()).min(1),
  checked: z.iso.date(),
})

/** The form of modelFamilies.json. The tests check the file with it. */
export const modelFamiliesFileSchema = z.strictObject({ families: z.array(modelFamilyEntrySchema) })

export type ImageTokenRule = z.infer<typeof imageTokenRuleSchema>
export type ModelFamilyEntry = z.infer<typeof modelFamilyEntrySchema>

/** What Dez knows of a model from its id: the numbers of its family's entry,
 *  and those of `DEFAULT_FAMILY` for the ones that the entry does not
 *  state. */
export interface ModelFamily {
  /** The id of the entry. `null`: no entry matches the model. */
  id: string | null
  charsPerToken: number
  imageTokens: ImageTokenRule
  contextWindow: number
  /** `Infinity`: the docs state that there is no limit. */
  maxImages: number
  manyImages?: { over: number, maxSidePx: number }
}

/** The numbers of a model of no known family, and of a family whose docs do
 *  not state one of them. They are Dez's choice, not a fact of a model, and
 *  each one is on the safe side:
 *  - text: the fewest characters per token that a maker states (Claude);
 *  - an image: one token for each square of 28 by 28 pixels, at most 4,784,
 *    which is the count of Claude with no scale down first;
 *  - a 200k window, the smallest one of the current large models;
 *  - 20 images in one request: no maker tells Dez how many such a model
 *    takes, and the smallest limit of a known family is 100. */
export const DEFAULT_FAMILY: ModelFamily = {
  id: null,
  charsPerToken: 2.5,
  imageTokens: { rule: 'patches', patchPx: 28, maxPatches: 4784 },
  contextWindow: 200_000,
  maxImages: 20,
}

/** The entries of a model families file. An entry that breaks the form is
 *  left out and logged, so that a bad entry never stops the app from
 *  starting; its models then get the next entry that matches, or the
 *  default. */
export function parseModelFamilies(file: unknown): ModelFamilyEntry[] {
  const list = z.object({ families: z.array(z.unknown()) }).safeParse(file)
  if (!list.success) {
    console.error(`Dez left out every model family: the file has no list of families. ${configIssueText(list.error)}`)
    return []
  }
  return list.data.families.flatMap((value, index) => {
    const entry = modelFamilyEntrySchema.safeParse(value)
    if (entry.success) return [entry.data]
    console.error(`Dez left out the model family at index ${index}: ${configIssueText(entry.error)}`)
    return []
  })
}

const MODEL_FAMILIES = parseModelFamilies(modelFamiliesFile)

/** The family of the model with the id `modelId` among `entries` (by
 *  default the ones of modelFamilies.json): the first entry that matches. */
export function modelFamily(modelId: string, entries: readonly ModelFamilyEntry[] = MODEL_FAMILIES): ModelFamily {
  const entry = entries.find(({ match }) => match.test(modelId))
  if (!entry) return DEFAULT_FAMILY
  return {
    id: entry.id,
    charsPerToken: entry.charsPerToken ?? DEFAULT_FAMILY.charsPerToken,
    imageTokens: entry.imageTokens ?? DEFAULT_FAMILY.imageTokens,
    contextWindow: entry.contextWindow ?? DEFAULT_FAMILY.contextWindow,
    maxImages: entry.maxImages === undefined ? DEFAULT_FAMILY.maxImages : entry.maxImages ?? Infinity,
    ...(entry.manyImages && { manyImages: entry.manyImages }),
  }
}

// How many squares of `cellPx` pixels cover `lengthPx` pixels. A side that
// a second scale brought down to its limit can come out a hair over it
// (600.0000000000001 for a limit of 600); that hair is no square more.
function cells(lengthPx: number, cellPx: number): number {
  return Math.max(1, Math.ceil(lengthPx / cellPx - 1e-9))
}

// `size` made smaller, never larger, so that `side` (its long or its short
// side) is at most `maxPx`. The other side keeps its fraction of a pixel,
// so that the count that follows is never too low.
function scaledDown(size: ImageSize, side: 'long' | 'short', maxPx: number): ImageSize {
  const length = side === 'long' ? Math.max(size.width, size.height) : Math.min(size.width, size.height)
  if (length <= maxPx) return size
  return { width: size.width * maxPx / length, height: size.height * maxPx / length }
}

/** About how many tokens a model that counts by `rule` reads an image of
 *  `size` pixels as. The count is never under the one of the docs' rule. An
 *  image of an unknown size (`null`) costs the most that the rule gives. */
export function imageTokens(rule: ImageTokenRule, size: ImageSize | null): number {
  switch (rule.rule) {
    case 'fixed':
      return rule.tokens
    case 'patches': {
      const scaled = size !== null && rule.maxLongSidePx !== undefined ? scaledDown(size, 'long', rule.maxLongSidePx) : size
      const patches = scaled === null
        ? rule.maxPatches
        : Math.min(rule.maxPatches, cells(scaled.width, rule.patchPx) * cells(scaled.height, rule.patchPx))
      // The makers round the product up. The hair off covers a product that
      // is a whole number and comes out a hair over it in floating point
      // (150 × 1.62 is 243.00000000000003).
      return Math.ceil(patches * (rule.tokensPerPatch ?? 1) - 1e-9)
    }
    case 'tiles': {
      // With no size: the image that covers the most tiles, which has the
      // largest long side and the largest short side.
      const fitted = size === null ? { width: rule.fitPx, height: rule.shortSidePx } : scaledDown(scaledDown(size, 'long', rule.fitPx), 'short', rule.shortSidePx)
      return rule.baseTokens + cells(fitted.width, rule.tilePx) * cells(fitted.height, rule.tilePx) * rule.tileTokens
    }
  }
}

/** The context window of `model`, in tokens: the one that its provider's
 *  model list or config gives, else the one of its family. */
export function contextWindowOf(model: Pick<ModelInfo, 'id' | 'contextWindow'>): number {
  return model.contextWindow ?? modelFamily(model.id).contextWindow
}

/** The most images of one request to a model of a family, when the longest
 *  side of a picture that goes to it is `largestSidePx` pixels. A family
 *  that takes fewer images when one of them has a long side (`manyImages`)
 *  gives that lower count when a picture can have such a side: a refused
 *  picture would fail each later request, as each one sends it again. */
export function familyImageLimit({ maxImages, manyImages }: Pick<ModelFamily, 'maxImages' | 'manyImages'>, largestSidePx: number): number {
  return manyImages && manyImages.maxSidePx < largestSidePx ? Math.min(maxImages, manyImages.over) : maxImages
}

/** The most image and picture parts of one chat request to `model`, in all
 *  of its messages (`Infinity`: no limit): the one that its provider's
 *  model list gives, else the one of its family for the largest picture
 *  that Dez sends (`LARGEST_PICTURE_SIDE`). */
export function imageLimitOf(model: Pick<ModelInfo, 'id' | 'imageLimit'>): number {
  return model.imageLimit ?? familyImageLimit(modelFamily(model.id), LARGEST_PICTURE_SIDE)
}

/** The most image and picture parts of one message of a chat request to
 *  `model`: the one that its provider's model list gives
 *  (`ModelInfo.messageImageLimit`), and the count that a refusal of the
 *  provider told (`learnedImageLimit`), which was a request of one
 *  message. With neither, and never over it, the limit of a whole request
 *  (`imageLimitOf`). */
export function messageImageLimitOf(model: Pick<ModelInfo, 'id' | 'imageLimit' | 'messageImageLimit' | 'learnedImageLimit'>): number {
  return Math.min(model.messageImageLimit ?? Infinity, model.learnedImageLimit?.maxImages ?? Infinity, imageLimitOf(model))
}
