import type { ImageSizeRules } from './imageSize'
import type { ClipKind, MediaKind } from './types'

// The input images of a video request. What a model takes is data on the
// model (`ModelInfo.images`), which a media format reads from the
// provider's model data (`ClipFormat.imageRules` in mediaFormats.ts). Also
// the refusal of a media request that has no image and needs one.

// What a video model takes as input images.
export interface ClipImageRules {
  // The most images of one request, 1 or more: the first one is the first
  // frame of the video, and the second one is its last frame.
  maxFrames: number
  // The size rules of each image (imageSize.ts), for a model whose
  // provider tells some. Never empty.
  size?: ImageSizeRules
}

// A copy that shares no object with `rules`.
export function cloneClipImageRules(rules: ClipImageRules): ClipImageRules {
  return { ...rules, ...(rules.size && { size: { ...rules.size } }) }
}

/** The most images that a request of `kind` carries, for a model with
 *  `rules`. A model with no rules: an `imageToVideo` model takes its one
 *  image, and every other model takes none. */
export function maxClipImages(kind: ClipKind, rules: ClipImageRules | undefined): number {
  return rules?.maxFrames ?? (kind === 'imageToVideo' ? 1 : 0)
}

/** Why a request of `kind` with `imageCount` images does not go to the
 *  model `modelName`, as a sentence for the user; null when it can go. An
 *  edit and a video from an image need an image. The check costs nothing,
 *  and it comes before the reply starts, so the user's message stays as
 *  it is. */
export function missingImageProblem(modelName: string, kind: MediaKind, imageCount: number): string | null {
  if (imageCount > 0) return null
  const how = 'Paste an image, or name one with @id.'
  if (kind === 'imageEdit') return `${modelName} edits an image. ${how}`
  if (kind === 'imageToVideo') return `${modelName} makes a video from an image. ${how}`
  return null
}
