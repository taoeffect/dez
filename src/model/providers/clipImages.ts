import type { ImageSizeRules } from './imageSize'
import type { OptionValue, ParameterValues } from './modelParameters'
import { requestHas, type RequestReader } from './requestReader'
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

// How the images of a request go to a model that takes them as
// references (a reference-to-video model), not as the frames of a video.
export interface ReferenceImages {
  // The name that the model's prompt gives the n-th image of the request,
  // with `{n}` for the number (1 for the first image): `@Image{n}`,
  // `<Image {n}>`. The prompt of a request gets these names in place of
  // the reference text and the @id mentions of each image that goes
  // (`mediaRequestInput`). Missing: the provider tells no names, and the
  // prompt keeps the ids.
  promptName?: string
}

// What a model takes as input images.
export interface InputImageRules {
  // The most images of one request, 1 or more. For a video, the first one
  // is the first frame, and the second one is the last frame (or each one
  // is a reference, with `references`). For an edit, the first one is the
  // image to edit, and the others are references.
  maxImages: number
  // The fewest images of one request, 1 to `maxImages`, for a model whose
  // kind can go with none but that needs an image all the same (an image
  // model that makes its image from a reference image). Missing: 0, or 1
  // for the kinds that need an image (`minInputImages`).
  minImages?: number
  // The size rules of each image (imageSize.ts), for a model whose
  // provider tells some. Never empty.
  size?: ImageSizeRules
  // Set for a video model that takes its images as references.
  references?: ReferenceImages
  // The rules that apply in place of these when the model parameter
  // `name` has `value` (`inputImageRulesFor`): an OpenRouter video model
  // takes its images as frames, or as references when the user chooses
  // so (mediaFormats.ts).
  whenParameter?: { name: string, value: OptionValue, rules: Omit<InputImageRules, 'whenParameter'> }
}

// A copy of rules with no `whenParameter`, which shares no object with them.
function cloneOwnRules(rules: Omit<InputImageRules, 'whenParameter'>): Omit<InputImageRules, 'whenParameter'> {
  return { ...rules, ...(rules.size && { size: { ...rules.size } }), ...(rules.references && { references: { ...rules.references } }) }
}

// A copy that shares no object with `rules`.
export function cloneInputImageRules(rules: InputImageRules): InputImageRules {
  const { whenParameter, ...own } = rules
  return {
    ...cloneOwnRules(own),
    ...(whenParameter && { whenParameter: { ...whenParameter, rules: cloneOwnRules(whenParameter.rules) } }),
  }
}

/** The image rules of a request to a model with `rules` that sends the
 *  parameter values `values` (`effectiveParameterValues`): the rules of
 *  `rules.whenParameter` when its parameter has its value, else `rules`.
 *  Every check and count of a request's images reads these, so that the
 *  submit, the request, and `model_info` agree. */
export function inputImageRulesFor(rules: InputImageRules | undefined, values: Readonly<ParameterValues>): InputImageRules | undefined {
  const other = rules?.whenParameter
  return other !== undefined && values[other.name] === other.value ? other.rules : rules
}

/** The most images that a request of `kind` carries, for a model with
 *  `rules`. A model with no rules: an edit takes every image (the provider
 *  checks the count), an `upscale` or `imageToVideo` model takes its one
 *  image, and every other model takes none. */
export function maxInputImages(kind: MediaKind, rules: InputImageRules | undefined): number {
  if (rules) return rules.maxImages
  if (kind === 'imageEdit') return Infinity
  return minInputImages(kind, undefined)
}

/** `1 image`, `2 images`. */
export function imagesText(count: number): string {
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

/** The text for `reader` whose request to the model `modelName` has
 *  `sentImages` images, of which the model takes only `maxImages`: from
 *  the provider's refusal (a `TooManyImagesError`), or from the limit that
 *  Dez learned from one (learnedImageLimit.ts). For the user, the images
 *  are the images of the message (`mediaRequestInput`); for a model, the
 *  images that the `prompt` of its `model_invoke` call names. Dez does not
 *  send the request again with fewer images by itself: the user would pay
 *  for a clip that leaves out an image that the reader meant. */
export function tooManyImagesMessage(
  modelName: string,
  { maxImages, sentImages }: Pick<TooManyImagesError, 'maxImages' | 'sentImages'>,
  reader: RequestReader = 'user',
): string {
  const takes = imagesText(maxImages)
  const fix = reader === 'user'
    ? `Keep only ${takes} in the message (pasted, or named with @id), and send it again.`
    : `Name only ${takes} with @id in \`prompt\`, and call again.`
  return `${modelName} takes only ${takes}, and ${requestHas(reader)} ${sentImages}. ${fix}`
}

/** Why a `model_invoke` call whose prompt names `imageCount` images does
 *  not go to the model `modelName`, which takes at most `maxImages` of
 *  them, as a sentence for the model that made the call; null when all of
 *  them go. A user message with more images is cut instead
 *  (`mediaRequestInput`), and a toast tells the user. */
export function unusedImagesProblem(modelName: string, maxImages: number, imageCount: number): string | null {
  if (imageCount <= maxImages) return null
  if (maxImages > 0) return tooManyImagesMessage(modelName, { maxImages, sentImages: imageCount }, 'model')
  return `${modelName} takes no input image, and the prompt names ${imagesText(imageCount)}. Remove the @id mentions of images from \`prompt\`, or choose another model.`
}

/** Why a request of `kind` with `imageCount` images does not go to the
 *  model `modelName` with the image rules `rules`, as a sentence for
 *  `reader`; null when it can go. An edit, an upscale, and a video from an
 *  image need an image, and so does a model whose rules tell so. The check
 *  costs nothing, and it comes before the reply starts, so the user's
 *  message stays as it is. */
export function missingImageProblem(modelName: string, kind: MediaKind, imageCount: number, rules: InputImageRules | undefined, reader: RequestReader = 'user'): string | null {
  const minImages = minInputImages(kind, rules)
  if (imageCount >= minImages) return null
  if (minImages > 1) {
    const fix = reader === 'user' ? 'Paste more images, or name them with @id.' : 'Name more images with @id in `prompt`.'
    return `${modelName} needs at least ${imagesText(minImages)}, and ${requestHas(reader)} ${imageCount}. ${fix}`
  }
  const fix = reader === 'user' ? 'Paste an image, or name one with @id.' : 'Name an image with @id in `prompt`.'
  return `${modelName} ${NEEDS_INPUT_IMAGE[kind] ?? 'needs an input image'}. ${fix}`
}
