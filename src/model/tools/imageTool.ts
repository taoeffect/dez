import { sectionPlainText } from '../chat/content'
import type { ImageDrawing, ImageRegion, ImageSize } from '../chat/imageDrawing'
import { findImageReferences, imageMediaType, type ImageMediaType } from '../chat/images'
import { findMediaTags } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { assetIdArgument } from './arguments'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type ToolArguments, type ToolParameter } from './types'

// The `image` tool: make new images from the images of a conversation, one
// subcommand each (subcommands.ts). Each subcommand has a pure plan here
// (`ImagePlan`): what to draw of an image of a given size. The runner of
// controller/tools.ts reads the image, has the webview draw the plan, and
// puts the new image into the reply.

/** The most pixels of an image that the `image` tool makes (8K, 7680 by
 *  4320). A model can ask for any size, and a canvas far past this size
 *  takes gigabytes of memory, or fails with no clear error at the size
 *  limit of the webview. */
export const MAX_DRAWN_PIXELS = 7680 * 4320

const IMAGE_PARAMETER: ToolParameter = { name: 'image', type: 'string', description: 'The id of the image, as in "a" or "@a".', required: true }

// What every subcommand does with the image that it names and with the new
// image, for the help texts.
const NEW_IMAGE_TEXT = 'An image of the conversation shows in the text as `![image](id=a)`, where `a` is its id; the user writes `@a` for it. '
  + 'The image itself does not change. The new image goes into your reply, where the user sees it, and the result gives its id and its size in pixels.'

const CROP_PARAMETERS = ['x', 'y', 'width', 'height'] as const

// The texts are static (no counts, no dates): the tools array, which names
// the subcommands, is in the provider's prompt cache.
export const IMAGE_TOOL: SubcommandTool = {
  name: 'image',
  summary: 'Work with the images of this conversation: each subcommand makes a new image from one of them.',
  subcommands: [
    {
      name: 'crop',
      summary: 'Make a new image from a part of an image.',
      description: `Makes a new image from a part (a crop) of an image of this conversation, at the size of the part. ${NEW_IMAGE_TEXT} `
        + 'A call with only `image` makes no image, and the result gives the size of that image: use it before a crop. '
        + 'All positions and sizes are whole pixels, and the top left corner of an image is x 0, y 0. '
        + 'To give the part another size too, call scale with the new image.',
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'x',
          type: 'integer',
          description: 'The distance of the part from the left edge of the image. Give all four of x, y, width, and height, or only `image` to get the size of the image.',
          required: false,
        },
        { name: 'y', type: 'integer', description: 'The distance of the part from the top edge of the image.', required: false },
        { name: 'width', type: 'integer', description: 'The width of the part. The part must be inside the image.', required: false },
        { name: 'height', type: 'integer', description: 'The height of the part.', required: false },
      ],
      example: { image: 'a', x: 0, y: 0, width: 512, height: 512 },
    },
    {
      name: 'scale',
      summary: 'Make a new image from an image at another size, for example for a model that takes only some image sizes.',
      description: `Makes a new image from an image of this conversation at another size. ${NEW_IMAGE_TEXT} `
        + 'Give `width`, `height`, or both, in whole pixels: one of them alone keeps the shape of the image, and both stretch the image to that size. '
        + 'A call with only `image` makes no image, and the result gives the size of that image.',
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'width',
          type: 'integer',
          description: 'The width of the new image. With no `height`, the height keeps the shape of the image.',
          required: false,
        },
        {
          name: 'height',
          type: 'integer',
          description: 'The height of the new image. With no `width`, the width keeps the shape of the image. With both, the image is stretched to that size.',
          required: false,
        },
      ],
      example: { image: 'a', width: 1024 },
    },
  ],
}

export const IMAGE_TOOL_DEFINITION = subcommandToolDefinition(IMAGE_TOOL)

/** What an `image` subcommand draws of the image `id`, of `size`, for a
 *  call with `args` (the subcommand's checked arguments): the drawing, or
 *  the result text of a call that draws nothing (one that asks for the
 *  size of the image). Throws a `ToolError` that tells the model how to fix
 *  a bad call. */
export type ImagePlan = (id: string, args: ToolArguments, size: ImageSize) => ImageDrawing | string

/** The image id that the `image` parameter of a call names (`a` or `@a`).
 *  Throws for any other text; the model reads the error. */
export function imageToolId(args: ToolArguments): string {
  return assetIdArgument(args.image, 'an image', 'a')
}

/** A stored image of a conversation: its file and its file type. */
export interface ConversationImage {
  path: string
  mediaType: ImageMediaType
}

/** The image `id` of a tab's `sections`: the newest reference with that id,
 *  as for an `@id` mention (`sectionsToStreamMessages`). Throws for an id
 *  that names a clip or nothing; the text tells the model the ids of the
 *  images that it can name. */
export function imageOf(sections: readonly Section[], id: string): ConversationImage {
  // A later reference with an id replaces an earlier one, and keeps the
  // place of the first one in the list of the error text.
  const images = new Map<string, ConversationImage>()
  for (const reference of sections.flatMap((section) => findImageReferences(sectionPlainText(section)))) {
    const mediaType = imageMediaType(reference.path)
    if (reference.id !== null && mediaType) images.set(reference.id, { path: reference.path, mediaType })
  }
  const image = images.get(id)
  if (image) return image

  const clip = sections.flatMap((section) => findMediaTags(sectionPlainText(section))).findLast((tag) => tag.id === id)
  if (clip) throw new ToolError(`@${id} is ${clip.kind === 'audio' ? 'an audio' : 'a video'} clip. The image tool works on images only.`)
  const ids = [...images.keys()].map((imageId) => `@${imageId}`)
  throw new ToolError(ids.length === 0
    ? `This conversation has no images, so it has no image @${id}. Do not call the image tool until the user adds an image to the conversation.`
    : `No image of this conversation has the id @${id}. Its images are ${ids.join(', ')}: call again with one of these ids.`)
}

function sizeText({ width, height }: ImageSize): string {
  return `${width}x${height} pixels`
}

// An integer parameter of a subcommand, or undefined when the call leaves
// it out. The subcommand gives the parameter the type `integer`
// (`checkArgumentValues`), and a parameter that is left out has no key.
function integerArgument(args: ToolArguments, name: string): number | undefined {
  const value = args[name]
  return typeof value === 'number' ? value : undefined
}

// The error of a new image of `size` over `MAX_DRAWN_PIXELS`; `fix` tells
// the model what to give instead.
function tooLargeError(size: ImageSize, fix: string): ToolError {
  return new ToolError(`The new image would be ${sizeText(size)}. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). ${fix}`)
}

// The crop inside an image of `size` that is nearest to `crop`: of the same
// size (each side at least 1 pixel and at most the image's), moved by the
// least distance.
function nearestCrop(crop: ImageRegion, size: ImageSize): ImageRegion {
  const width = Math.min(Math.max(crop.width, 1), size.width)
  const height = Math.min(Math.max(crop.height, 1), size.height)
  return {
    x: Math.min(Math.max(crop.x, 0), size.width - width),
    y: Math.min(Math.max(crop.y, 0), size.height - height),
    width,
    height,
  }
}

// The largest size of the shape of `size` that is not over
// `MAX_DRAWN_PIXELS`. The scale takes two square roots, so that the product
// of two huge sides cannot overflow. A side that the scale takes under one
// pixel stays at one, and the other side then gives way.
function largestSize({ width, height }: ImageSize): ImageSize {
  const scale = Math.sqrt(MAX_DRAWN_PIXELS / width) / Math.sqrt(height)
  const fit = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
  if (fit.width * fit.height > MAX_DRAWN_PIXELS) {
    if (fit.width > fit.height) fit.width = Math.floor(MAX_DRAWN_PIXELS / fit.height)
    else fit.height = Math.floor(MAX_DRAWN_PIXELS / fit.width)
  }
  return fit
}

/** The plan of `image crop`: the part that `x`, `y`, `width`, and `height`
 *  name, at its own size. A call with none of them asks for the size of the
 *  image. Throws for only some of the four, for a part that is not inside
 *  the image (the text gives the nearest part that is), and for a part over
 *  `MAX_DRAWN_PIXELS`. */
export const cropPlan: ImagePlan = (id, args, size) => {
  const values = CROP_PARAMETERS.map((name) => integerArgument(args, name))
  const given = values.filter((value) => value !== undefined).length
  if (given === 0) return `The image @${id} is ${sizeText(size)}. Give x, y, width, and height to make a new image from a part of it.`
  if (given < CROP_PARAMETERS.length) {
    throw new ToolError('A crop needs all four of x, y, width, and height. Give all four, or only `image` to get the size of the image.')
  }

  const [x = 0, y = 0, width = 0, height = 0] = values
  const crop = { x, y, width, height }
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > size.width || y + height > size.height) {
    const nearest = nearestCrop(crop, size)
    throw new ToolError(`The crop (x ${x}, y ${y}, ${sizeText(crop)}) is not inside the image @${id}, which is ${sizeText(size)}. `
      + `A crop inside it has x and y of 0 or more, x + width of ${size.width} or less, and y + height of ${size.height} or less. `
      + `The nearest such crop is x ${nearest.x}, y ${nearest.y}, width ${nearest.width}, height ${nearest.height}.`)
  }
  // Only an image over the limit can hold such a part.
  if (width * height > MAX_DRAWN_PIXELS) throw tooLargeError(crop, 'Take a smaller part.')
  return { crop, width, height }
}

/** The plan of `image scale`: the whole image at the size that `width` and
 *  `height` name. One of the two alone keeps the shape of the image; a call
 *  with neither asks for the size of the image. Throws for a side under one
 *  pixel and for a new image over `MAX_DRAWN_PIXELS` (the text gives the
 *  largest size of the same shape). */
export const scalePlan: ImagePlan = (id, args, size) => {
  const width = integerArgument(args, 'width')
  const height = integerArgument(args, 'height')
  if (width === undefined && height === undefined) {
    return `The image @${id} is ${sizeText(size)}. Give a width, a height, or both to make a new image from it at another size.`
  }
  if ((width ?? 1) < 1 || (height ?? 1) < 1) {
    throw new ToolError('`width` and `height` must be 1 or more. Leave out one of them to keep the shape of the image.')
  }

  // One side alone: the other side at the same scale, to the nearest whole
  // pixel, and at least one pixel.
  const scale = width !== undefined ? width / size.width : (height ?? size.height) / size.height
  const drawn = {
    width: width ?? Math.max(1, Math.round(size.width * scale)),
    height: height ?? Math.max(1, Math.round(size.height * scale)),
  }
  if (drawn.width * drawn.height > MAX_DRAWN_PIXELS) {
    const fit = largestSize(drawn)
    throw tooLargeError(drawn, `For the same shape, give a \`width\` of ${fit.width} and a \`height\` of ${fit.height}, or less.`)
  }
  return { crop: { x: 0, y: 0, width: size.width, height: size.height }, ...drawn }
}

/** The result of a call that made the image `newId`, of `size`, from the
 *  image `id`. It names the images by their ids only: a result goes to the
 *  provider, which gets no path of a stored file. */
export function imageResultText(id: string, newId: string, size: ImageSize): string {
  return `Made the image @${newId} from @${id}. The image @${newId} is ${sizeText(size)}.`
}
