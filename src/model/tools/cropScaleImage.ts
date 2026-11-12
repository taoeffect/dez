import type { ImageDrawing, ImageRegion, ImageSize } from '../chat/imageDrawing'
import { assetIdArgument } from './arguments'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

/** The most pixels of an image that `crop_scale_image` makes (8K, 7680 by
 *  4320). A model can ask for any size, and a canvas far past this size
 *  takes gigabytes of memory, or fails with no clear error at the size
 *  limit of the webview. */
export const MAX_DRAWN_PIXELS = 7680 * 4320

const CROP_PARAMETERS = ['crop_x', 'crop_y', 'crop_width', 'crop_height'] as const

// The description is static text (no counts, no dates): the tools array is
// in the provider's prompt cache.
export const CROP_SCALE_IMAGE_TOOL: ToolDefinition = {
  name: 'crop_scale_image',
  description: 'Make a new image from one image of this conversation: a part of it (a crop), the image at another size (a scale), or both. '
    + 'An image of the conversation shows in the text as `![image](id=a)`, where `a` is its id; the user writes `@a` for it. '
    + 'The image itself does not change. The new image goes into your reply, where the user sees it, and the result gives its id and its size in pixels. '
    + 'Use it when an image does not have the size or the shape that is needed, for example for a model that takes only some image sizes. '
    + 'A call with only `image` makes no image, and the result gives the size of that image: use it before a crop. '
    + 'All positions and sizes are whole pixels, and the top left corner of an image is x 0, y 0. '
    + 'The crop comes first: `width` and `height` are the size of the new image, and the cropped part is drawn at that size.',
  parameters: [
    {
      name: 'image',
      type: 'string',
      description: 'The id of the image, as in "a" or "@a".',
      required: true,
    },
    {
      name: 'crop_x',
      type: 'integer',
      description: 'The distance of the part from the left edge of the image. '
        + 'Give all four `crop_` parameters to take a part of the image, or none of them to take the whole image.',
      required: false,
    },
    {
      name: 'crop_y',
      type: 'integer',
      description: 'The distance of the part from the top edge of the image.',
      required: false,
    },
    {
      name: 'crop_width',
      type: 'integer',
      description: 'The width of the part. The part must be inside the image.',
      required: false,
    },
    {
      name: 'crop_height',
      type: 'integer',
      description: 'The height of the part.',
      required: false,
    },
    {
      name: 'width',
      type: 'integer',
      description: 'The width of the new image. With no `height`, the height keeps the shape of the part. '
        + 'With no `width` and no `height`, the new image has the size of the part.',
      required: false,
    },
    {
      name: 'height',
      type: 'integer',
      description: 'The height of the new image. With no `width`, the width keeps the shape of the part. '
        + 'With both, the part is stretched to that size.',
      required: false,
    },
  ],
}

/** The image id that the `image` argument of a call names (`a` or `@a`).
 *  Throws for any other text; the model reads the error. */
export function cropScaleImageId(args: ToolArguments): string {
  return assetIdArgument(args.image, 'an image', 'a')
}

function sizeText({ width, height }: ImageSize): string {
  return `${width}x${height} pixels`
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

/** What a call draws of an image of `size`: the part that its `crop_`
 *  arguments name (the whole image with none), at the size that `width` and
 *  `height` name. One of the two alone keeps the shape of the part, and
 *  with none the part keeps its size. Null for a call that names no part
 *  and no size: it makes no image.
 *
 *  Throws for a part of the `crop_` arguments, a part that is not inside
 *  the image, a size under one pixel, and a new image over
 *  `MAX_DRAWN_PIXELS`; the model reads the error, which tells the size of
 *  the image and a crop or a size that fits. */
export function cropScaleDrawing(args: ToolArguments, size: ImageSize): ImageDrawing | null {
  // The definition gives every one of these parameters the type `integer`
  // (`parseToolArguments`); a parameter that the call leaves out has no key.
  const integer = (name: string): number | undefined => {
    const value = args[name]
    return typeof value === 'number' ? value : undefined
  }
  const cropValues = CROP_PARAMETERS.map(integer)
  const cropGiven = cropValues.filter((value) => value !== undefined).length
  if (cropGiven > 0 && cropGiven < CROP_PARAMETERS.length) {
    throw new ToolError(`A crop needs all of ${CROP_PARAMETERS.join(', ')}. Give all four, or none of them for the whole image.`)
  }

  const [x = 0, y = 0, cropWidth = size.width, cropHeight = size.height] = cropValues
  const crop = { x, y, width: cropWidth, height: cropHeight }
  if (x < 0 || y < 0 || cropWidth < 1 || cropHeight < 1 || x + cropWidth > size.width || y + cropHeight > size.height) {
    const nearest = nearestCrop(crop, size)
    throw new ToolError(`The crop (x ${x}, y ${y}, ${sizeText(crop)}) is not inside the image, which is ${sizeText(size)}. `
      + `A crop inside it has crop_x and crop_y of 0 or more, crop_x + crop_width of ${size.width} or less, and crop_y + crop_height of ${size.height} or less. `
      + `The nearest such crop is crop_x ${nearest.x}, crop_y ${nearest.y}, crop_width ${nearest.width}, crop_height ${nearest.height}.`)
  }
  const width = integer('width')
  const height = integer('height')
  if ((width ?? 1) < 1 || (height ?? 1) < 1) {
    throw new ToolError('`width` and `height` must be 1 or more. Leave out one of them to keep the shape of the part, or both to keep its size.')
  }
  if (cropGiven === 0 && width === undefined && height === undefined) return null

  // One side alone: the other side at the same scale, to the nearest whole
  // pixel, and at least one pixel. With no side, the part keeps its size.
  const scale = width !== undefined ? width / cropWidth : height !== undefined ? height / cropHeight : 1
  const drawn = {
    width: width ?? Math.max(1, Math.round(cropWidth * scale)),
    height: height ?? Math.max(1, Math.round(cropHeight * scale)),
  }
  if (drawn.width * drawn.height > MAX_DRAWN_PIXELS) {
    const fit = largestSize(drawn)
    throw new ToolError(`The new image would be ${sizeText(drawn)}. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). `
      + `For the same shape, give a \`width\` of ${fit.width} and a \`height\` of ${fit.height}, or less.`)
  }
  return { crop, ...drawn }
}

/** The result of a call that made no image: the size of the image `id`. */
export function imageSizeText(id: string, size: ImageSize): string {
  return `The image @${id} is ${sizeText(size)}. Give a crop, a size, or both to make a new image from it.`
}

/** The result of a call that made the image `newId`, of `size`, from the
 *  image `id`. It names the images by their ids only: a result goes to the
 *  provider, which gets no path of a stored file. */
export function cropScaleResultText(id: string, newId: string, size: ImageSize): string {
  return `Made the image @${newId} from @${id}. The image @${newId} is ${sizeText(size)}.`
}
