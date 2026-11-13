import { imagesText, maxInputImages, tooManyImagesMessage, type InputImageRules } from './clipImages'
import type { KnownLimit } from './knownLimits'
import type { RequestReader } from './requestReader'
import type { MediaKind, ModelInfo } from './types'

// The image count that a provider's refusal told for a model
// (`ClipFormat.refusedImages`: a Venice video model that takes no last
// frame), which no field of the provider's model data tells. Dez keeps it
// with the model (`ModelInfo.learnedImageLimit`, model_cache.json) and
// refuses a message with more images before any request, with the text of
// the refusal. It holds while the model's raw entries stay the same: a
// changed entry (a new feature, a new price) can mean that the model now
// takes more, and one more refusal costs nothing.

/** The most images that a provider's refusal told for a model, with the
 *  fingerprint of the model's raw entries at that refusal
 *  (`modelEntriesFingerprint`). */
export interface LearnedImageLimit {
  maxImages: number
  entry: string
}

/** A short fingerprint of the raw entries of a model: its entry in the
 *  provider's model list, and its entry in a model list of the media API.
 *  Undefined when there is neither. 32-bit FNV-1a of their JSON text, in
 *  hex: it only tells whether the entries changed, so a rare collision is
 *  harmless. */
export function modelEntriesFingerprint(entry: unknown, mediaEntry: unknown): string | undefined {
  if (entry === undefined && mediaEntry === undefined) return undefined
  const text = JSON.stringify([entry ?? null, mediaEntry ?? null])
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** `models`, the list of a good model check, each model with the image
 *  limit that `cached` (the models from the checks before) learned for it,
 *  as long as its new raw entries (`entries`, `mediaEntries`: by model id)
 *  have the fingerprint of the refusal. A model that is new, or whose
 *  entries changed, has none. A model with a limit is a new object; the
 *  result shares the other models with `models`. */
export function withKeptImageLimits(
  models: readonly ModelInfo[],
  cached: readonly ModelInfo[],
  entries: ReadonlyMap<string, unknown> | undefined,
  mediaEntries: ReadonlyMap<string, unknown> | undefined,
): ModelInfo[] {
  const learned = new Map(cached.flatMap((model) => (model.learnedImageLimit ? [[model.id, model.learnedImageLimit] as const] : [])))
  return models.map((model) => {
    const limit = learned.get(model.id)
    if (!limit || modelEntriesFingerprint(entries?.get(model.id), mediaEntries?.get(model.id)) !== limit.entry) return model
    return { ...model, learnedImageLimit: limit }
  })
}

/** Why a request with `imageCount` images (before the cut to the most that
 *  the model's rules take) does not go to the model `modelName` with the
 *  learned limit `learned`, in the words of the provider's refusal
 *  (`tooManyImagesMessage`) for `reader`; null when it can go. The request
 *  is refused and not cut: the user would pay for a clip that leaves out
 *  an image that the reader meant. */
export function learnedImagesProblem(modelName: string, learned: LearnedImageLimit | undefined, imageCount: number, reader: RequestReader = 'user'): string | null {
  if (!learned || imageCount <= learned.maxImages) return null
  return tooManyImagesMessage(modelName, { maxImages: learned.maxImages, sentImages: imageCount }, reader)
}

/** `rules`, the image rules of a request of `kind`, with the most images
 *  lowered to the learned limit `learned` when that is lower, for the
 *  facts and the usage of `model_info`. */
export function imageRulesWithLearnedLimit(kind: MediaKind, rules: InputImageRules | undefined, learned: LearnedImageLimit | undefined): InputImageRules | undefined {
  if (!learned || learned.maxImages >= maxInputImages(kind, rules)) return rules
  return { ...rules, maxImages: learned.maxImages }
}

/** The learned limit `learned` of a model of the provider `providerName`,
 *  as a known limit of `model_info` (`dez.limits`). */
export function learnedImageLimitRow(providerName: string, learned: LearnedImageLimit): KnownLimit {
  return {
    text: `This model takes at most ${imagesText(learned.maxImages)} in one request: ${providerName} refused a request with more. `
      + `Dez refuses a message with more images before it sends a request, until ${providerName} changes its data of the model.`,
    source: `Learned from ${providerName}'s refusal of a request to this model`,
    limit: { maxImages: learned.maxImages },
  }
}
