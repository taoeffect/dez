import type { ImageSizeRules } from './imageSize'
import type { MediaKind } from './types'

// The input images of a media request (an edit, an upscale, a video, the
// reference images of a new image). What a model takes is data on the
// model (`ModelInfo.images`), which a media format reads from the
// provider's model data (`MediaFormat.imageRules` in mediaFormats.ts).
// Also the refusal of a media request that has too few images, and the
// text of a request that the provider refused for its count of images.

// The media kinds that make nothing without an input image, each with what
// a model of the kind does, as the start of a sentence for the user.
const NEEDS_INPUT_IMAGE: Readonly<Partial<Record<MediaKind, string>>> = {
  imageEdit: 'edits an image',
  upscale: 'makes an image larger',
  imageToVideo: 'makes a video from an image',
}

/** The fewest images of a request of `kind` to a model with `rules`: 1
 *  for each kind that makes nothing without an image, else what the
 *  rules tell (an image model that needs a reference image), else 0. */
export function minInputImages(kind: MediaKind, rules: InputImageRules | undefined): number {
  return Math.max(NEEDS_INPUT_IMAGE[kind] === undefined ? 0 : 1, rules?.minImages ?? 0)
}

/** Whether a request of `kind` to a model with `rules` makes nothing
 *  without an input image. */
export function needsInputImage(kind: MediaKind, rules: InputImageRules | undefined): boolean {
  return minInputImages(kind, rules) > 0
}

// What a model takes as input images.
export interface InputImageRules {
  // The most images of one request, 1 or more. For a video, the first one
  // is the first frame, and the second one is the last frame. For an edit,
  // the first one is the image to edit, and the others are references.
  maxImages: number
  // The fewest images of one request, 1 to `maxImages`, for a model whose
  // kind can go with none but that needs an image all the same (an image
  // model that makes its image from a reference image). Missing: 0, or 1
  // for the kinds that need an image (`minInputImages`).
  minImages?: number
  // The size rules of each image (imageSize.ts), for a model whose
  // provider tells some. Never empty.
  size?: ImageSizeRules
}

// A copy that shares no object with `rules`.
export function cloneInputImageRules(rules: InputImageRules): InputImageRules {
  return { ...rules, ...(rules.size && { size: { ...rules.size } }) }
}

/** The most images that a request of `kind` carries, for a model with
 *  `rules`. A model with no rules: an edit takes every image (the provider
 *  checks the count), an `upscale` or `imageToVideo` model takes its one
 *  image, and every other model takes none. */
export function maxInputImages(kind: MediaKind, rules: InputImageRules | undefined): number {
  if (rules) return rules.maxImages
  if (kind === 'imageEdit') return Infinity
  return needsInputImage(kind, undefined) ? 1 : 0
}

function imagesText(count: number): string {
  return count === 1 ? '1 image' : `${count} images`
}

// A request that the provider refused because the model takes only
// `maxImages` input images, and the request had `sentImages`
// (`Provider.imageCountRefusal`). The message names no model and no chat
// message, because a tool can send a request too; `tooManyImagesMessage`
// is the text for the user who sent a message.
export class TooManyImagesError extends Error {
  constructor(readonly maxImages: number, readonly sentImages: number, options?: ErrorOptions) {
    super(`The model takes only ${imagesText(maxImages)}, and the request had ${sentImages}.`, options)
    this.name = 'TooManyImagesError'
  }
}

/** The text for the user whose message to the model `modelName` the
 *  provider refused with `error`: the message's images are the images of
 *  the request (`mediaRequestInput`). Dez does not send the request again
 *  with fewer images by itself: the user would pay for a clip that leaves
 *  out an image that they meant. */
export function tooManyImagesMessage(modelName: string, error: TooManyImagesError): string {
  const takes = imagesText(error.maxImages)
  return `${modelName} takes only ${takes}, and this message has ${error.sentImages}. `
    + `Keep only ${takes} in the message (pasted, or named with @id), and send it again.`
}

/** Why a request of `kind` with `imageCount` images does not go to the
 *  model `modelName` with the image rules `rules`, as a sentence for the
 *  user; null when it can go. An edit, an upscale, and a video from an
 *  image need an image, and so does a model whose rules tell so. The check
 *  costs nothing, and it comes before the reply starts, so the user's
 *  message stays as it is. */
export function missingImageProblem(modelName: string, kind: MediaKind, imageCount: number, rules: InputImageRules | undefined): string | null {
  const minImages = minInputImages(kind, rules)
  if (imageCount >= minImages) return null
  if (minImages > 1) {
    return `${modelName} needs at least ${imagesText(minImages)}, and this message has ${imageCount}. `
      + 'Paste more images, or name them with @id.'
  }
  return `${modelName} ${NEEDS_INPUT_IMAGE[kind] ?? 'needs an input image'}. Paste an image, or name one with @id.`
}
