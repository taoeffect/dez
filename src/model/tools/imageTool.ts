import { sectionPlainText } from '../chat/content'
import type { ColorChange } from '../chat/imageColors'
import { drawnMediaType, wholeImageDrawing, type DrawnMediaType, type ImageDrawing, type ImageFlip, type ImageRegion, type ImageSize } from '../chat/imageDrawing'
import { findImageReferences, imageMediaType, type ImageMediaType } from '../chat/images'
import { findMediaTags } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { assetIdArgument } from './arguments'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type ToolArguments, type ToolArgumentValue, type ToolParameter } from './types'

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

// The subcommands that change the colors by an `amount`.
type AmountKind = Extract<ColorChange, { amount: number }>['kind']

// What the `amount` of each such subcommand does, for its help and for the
// errors of a bad amount: what 0, 1, and 2 do (`scale`), and what an
// amount under 1 (`less`) and over 1 (`more`) give.
const AMOUNTS: Record<AmountKind, { scale: string, less: string, more: string }> = {
  brightness: { scale: '0 makes the image black, 1 keeps it as it is, and 2 makes it twice as bright', less: 'a darker image', more: 'a brighter image' },
  contrast: { scale: '0 makes the image one flat gray, 1 keeps it as it is, and 2 doubles the contrast', less: 'less contrast', more: 'more contrast' },
  saturation: { scale: '0 makes the image gray, 1 keeps it as it is, and 2 doubles the strength of the colors', less: 'weaker colors', more: 'stronger colors' },
}

// What every color subcommand keeps, for the help texts.
const KEPT_ALPHA_TEXT = 'The transparency of each pixel stays as it is.'

// The format that a `convert` call names for each file type that it makes,
// in the order of the texts. A call can also name JPEG `jpg`.
const CONVERT_FORMATS: Record<DrawnMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

const CONVERT_TYPES = Object.keys(CONVERT_FORMATS) as DrawnMediaType[]

// The name of each file type that the image tool makes, in the texts.
const FORMAT_NAMES: Record<DrawnMediaType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
}

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
    {
      name: 'flip',
      summary: 'Make a new image from an image mirrored left to right or top to bottom.',
      description: `Makes a new image from an image of this conversation, mirrored, at the same size. ${NEW_IMAGE_TEXT} `
        + 'A horizontal flip swaps the left and the right of the image, as a mirror shows it; a vertical flip swaps its top and its bottom. '
        + 'To turn an image, call rotate.',
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'direction',
          type: 'string',
          description: '"horizontal" to swap the left and the right of the image, or "vertical" to swap its top and its bottom.',
          required: true,
        },
      ],
      example: { image: 'a', direction: 'horizontal' },
    },
    {
      name: 'rotate',
      summary: 'Make a new image from an image turned by an angle.',
      description: `Makes a new image from an image of this conversation, turned about its center. ${NEW_IMAGE_TEXT} `
        + 'A turn of 90 or 270 degrees swaps the width and the height, and a turn of 180 keeps them. '
        + 'Any other angle makes the new image larger, so that it holds the whole turned image, with blank corners. '
        + 'With `keep_size`, the new image has the size of the image, and the turned image is made smaller to fit inside it. '
        + '`fill` paints the blank parts.',
      parameters: [
        IMAGE_PARAMETER,
        { name: 'angle', type: 'number', description: 'The angle of the turn in degrees, clockwise, as in 90. A negative angle turns counterclockwise.', required: true },
        {
          name: 'keep_size',
          type: 'boolean',
          description: 'true to give the new image the size of the image, with the turned image made smaller to fit inside it. '
            + 'The default is false: the new image grows to hold the whole turned image.',
          required: false,
        },
        {
          name: 'fill',
          type: 'string',
          description: 'The color under the turned image, which shows in its blank parts and through its transparent parts: '
            + '"transparent" (the default), "black", "white", or a hex color, as in "#ff8800" or "#f80".',
          required: false,
        },
      ],
      example: { image: 'a', angle: 90 },
    },
    {
      name: 'brightness',
      summary: 'Make a new image from an image made brighter or darker.',
      description: `Makes a new image from an image of this conversation, brighter or darker, at the same size. ${NEW_IMAGE_TEXT} `
        + `Each color value is multiplied by \`amount\`: ${AMOUNTS.brightness.scale}. ${KEPT_ALPHA_TEXT}`,
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'amount',
          type: 'number',
          description: 'The brightness of the new image, as a multiple of that of the image: 0 or more, as in 0.7 for a darker image or 1.3 for a brighter one.',
          required: true,
        },
      ],
      example: { image: 'a', amount: 1.3 },
    },
    {
      name: 'contrast',
      summary: 'Make a new image from an image with more or less contrast.',
      description: `Makes a new image from an image of this conversation with more or less contrast, at the same size. ${NEW_IMAGE_TEXT} `
        + `The distance of each color value from the middle gray is multiplied by \`amount\`: ${AMOUNTS.contrast.scale}. ${KEPT_ALPHA_TEXT}`,
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'amount',
          type: 'number',
          description: 'The contrast of the new image, as a multiple of that of the image: 0 or more, as in 0.7 for less contrast or 1.3 for more.',
          required: true,
        },
      ],
      example: { image: 'a', amount: 1.3 },
    },
    {
      name: 'saturation',
      summary: 'Make a new image from an image with stronger or weaker colors, or in shades of gray.',
      description: `Makes a new image from an image of this conversation with stronger or weaker colors, at the same size. ${NEW_IMAGE_TEXT} `
        + `The distance of each color value from the gray of its pixel is multiplied by \`amount\`: ${AMOUNTS.saturation.scale}. ${KEPT_ALPHA_TEXT}`,
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'amount',
          type: 'number',
          description: 'The strength of the colors of the new image, as a multiple of that of the image: 0 or more, as in 0 for shades of gray, 0.5 for weaker colors, or 1.5 for stronger ones.',
          required: true,
        },
      ],
      example: { image: 'a', amount: 0 },
    },
    {
      name: 'invert',
      summary: 'Make a new image from an image with inverted colors, as in a photo negative.',
      description: `Makes a new image from an image of this conversation with each color inverted, at the same size: black becomes white, and red becomes cyan. ${NEW_IMAGE_TEXT} `
        + KEPT_ALPHA_TEXT,
      parameters: [IMAGE_PARAMETER],
      example: { image: 'a' },
    },
    {
      name: 'convert',
      summary: 'Make a new image from an image in another file format: PNG, JPEG, WebP, or SVG.',
      description: `Makes a new image from an image of this conversation in another file format, at the same size. ${NEW_IMAGE_TEXT} `
        + 'PNG keeps each pixel as it is. JPEG and WebP make smaller files of photos, with colors near to those of the image. '
        + 'PNG, WebP, and SVG keep the transparency; JPEG has none, so the transparent parts of the image become white. '
        + 'An SVG made from an image holds its pixels, not shapes, so it is not sharper at a larger size. '
        + 'An SVG image becomes an image of its size in pixels, and a GIF image becomes its first frame. Dez cannot make GIF images.',
      parameters: [
        IMAGE_PARAMETER,
        {
          name: 'format',
          type: 'string',
          description: 'The format of the new image: "png", "jpeg" (or "jpg"), "webp", or "svg". It must not be the format of the image.',
          required: true,
        },
      ],
      example: { image: 'a', format: 'jpeg' },
    },
  ],
}

export const IMAGE_TOOL_DEFINITION = subcommandToolDefinition(IMAGE_TOOL)

/** What an `image` subcommand draws of the image `id`, of `size` and of
 *  the file type `mediaType`, for a call with `args` (the subcommand's
 *  checked arguments): the drawing, or the result text of a call that draws
 *  nothing (one that asks for the size of the image). Throws a `ToolError`
 *  that tells the model how to fix a bad call. */
export type ImagePlan = (id: string, args: ToolArguments, size: ImageSize, mediaType: ImageMediaType) => ImageDrawing | string

/** The image id that the `image` parameter of a call names (`a` or `@a`).
 *  Throws for any other text; the model reads the error. */
export function imageIdArgument(args: ToolArguments): string {
  return assetIdArgument(args.image, 'an image', 'a')
}

/** An image of a conversation, stored or linked: its file and its file
 *  type. */
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
  for (const reference of sections.flatMap((section) => findImageReferences(sectionPlainText(section), section.role))) {
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

/** The error result of a tool whose input image `id` Dez cannot read. It
 *  names the image by its id only: the name of a linked file is private. */
export function unreadableImageText(id: string): string {
  return `Dez cannot read the file of the image @${id}: the file is gone or moved, or Dez may not read it. `
    + 'This is not a fault of the call. Tell the user, who can paste or drop the image again (it then gets a new id).'
}

function sizeText({ width, height }: ImageSize): string {
  return `${width}x${height} pixels`
}

// A number parameter of a subcommand (of the type `number` or `integer`),
// or undefined when the call leaves it out. `checkArgumentValues` checked
// its type, and a parameter that is left out has no key.
function numberArgument(args: ToolArguments, name: string): number | undefined {
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

// The call of scale that makes an image from the image `id`, of `size`,
// that is not over `MAX_DRAWN_PIXELS`. `when` goes after "scale", as
// " first".
function smallerImageText(id: string, size: ImageSize, when = ''): string {
  const fit = largestSize(size)
  return `Make a smaller image from @${id} with scale${when} (for the same shape, a \`width\` of ${fit.width} and a \`height\` of ${fit.height}, or less)`
}

// The fix of a call of `subcommand` that would make an image over
// `MAX_DRAWN_PIXELS` because the image `id`, of `size`, is over it: a
// smaller image from it first. `needs` is what else the call of
// `subcommand` must give for its image not to be over the limit.
function scaleFirstText(id: string, size: ImageSize, subcommand: string, needs = ''): string {
  return `${smallerImageText(id, size, ' first')}, then call ${subcommand} with the new image${needs}.`
}

// The drawing of the whole image `id`, of `size`, at its own size, for a
// call of `subcommand`. Throws for an image over `MAX_DRAWN_PIXELS` (the
// text tells how to make a smaller image first).
function wholeDrawing(id: string, size: ImageSize, subcommand: string): ImageDrawing {
  if (size.width * size.height > MAX_DRAWN_PIXELS) throw tooLargeError(size, scaleFirstText(id, size, subcommand))
  return wholeImageDrawing(size)
}

const FLIPS: readonly ImageFlip[] = ['horizontal', 'vertical']

// The named fills of `rotate`, as `#rrggbb`. A Map, not an object: the key
// is the model's text, which can be a name such as `constructor`.
const NAMED_FILLS = new Map([['black', '#000000'], ['white', '#ffffff']])

// The paint of the `fill` of a `rotate` call as `#rrggbb`, or undefined
// for a transparent fill. Throws for a text that names no fill.
function fillColor(fill: ToolArgumentValue | undefined): string | undefined {
  if (fill === undefined) return undefined
  const text = String(fill).trim().toLowerCase()
  if (text === 'transparent') return undefined
  const named = NAMED_FILLS.get(text)
  if (named) return named
  if (/^#[0-9a-f]{6}$/.test(text)) return text
  // `#rgb` is `#rrggbb` with each digit twice, as in CSS.
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((digit) => digit.repeat(2)).join('')}`
  throw new ToolError(`${JSON.stringify(fill)} is not a fill of rotate. Give "transparent", "black", "white", or a hex color, as in "#ff8800" or "#f80".`)
}

// The sizes of a turn by `turn` degrees clockwise (more than 0, less than
// 360) of an image of `size`: the new image (`canvas`), and the image in it
// before the turn (`part`).
function turnSizes(size: ImageSize, turn: number, keepSize: boolean): { canvas: ImageSize, part: ImageSize } {
  // The box that holds the whole turned image. The cosine and the sine of
  // a right angle in radians are not exact, so a right angle gives its box
  // with no math.
  let box: ImageSize
  if (turn % 90 === 0) {
    box = turn === 180 ? size : { width: size.height, height: size.width }
  } else {
    const radians = turn * Math.PI / 180
    const cos = Math.abs(Math.cos(radians))
    const sin = Math.abs(Math.sin(radians))
    box = { width: size.width * cos + size.height * sin, height: size.width * sin + size.height * cos }
  }
  if (!keepSize) {
    // The whole pixels that hold the box. A float error of under a
    // millionth of a pixel adds no row.
    return { canvas: { width: Math.ceil(box.width - 1e-6), height: Math.ceil(box.height - 1e-6) }, part: size }
  }
  // The scale is 1 or less: the box of a turned image has at least the
  // area of the image, so it is not narrower and lower than the image.
  const scale = Math.min(size.width / box.width, size.height / box.height)
  return { canvas: size, part: { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) } }
}

/** The plan of `image crop`: the part that `x`, `y`, `width`, and `height`
 *  name, at its own size. A call with none of them asks for the size of the
 *  image. Throws for only some of the four, for a part that is not inside
 *  the image (the text gives the nearest part that is), and for a part over
 *  `MAX_DRAWN_PIXELS`. */
export const cropPlan: ImagePlan = (id, args, size) => {
  const values = CROP_PARAMETERS.map((name) => numberArgument(args, name))
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
  const width = numberArgument(args, 'width')
  const height = numberArgument(args, 'height')
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

/** The plan of `image flip`: the whole image, mirrored, at its own size.
 *  Throws for a `direction` that is not `horizontal` or `vertical`, and for
 *  an image over `MAX_DRAWN_PIXELS` (the text tells how to make a smaller
 *  image first). */
export const flipPlan: ImagePlan = (id, args, size) => {
  const direction = String(args.direction).trim().toLowerCase()
  const flip = FLIPS.find((name) => name === direction)
  if (!flip) {
    throw new ToolError(`${JSON.stringify(args.direction)} is not a direction of flip. `
      + 'Give "horizontal" to swap the left and the right of the image, or "vertical" to swap its top and its bottom.')
  }
  return { ...wholeDrawing(id, size, 'flip'), flip }
}

/** The plan of `image rotate`: the whole image turned by `angle` degrees
 *  clockwise about its center. The new image holds the whole turned image,
 *  or with `keep_size` has the size of the image, with the turned image
 *  made smaller to fit. `fill` paints under the turned image; with a
 *  transparent fill, a turn that leaves blank parts makes a PNG. Throws for
 *  an angle that makes no change, for a fill that names no color, and for
 *  a new image over `MAX_DRAWN_PIXELS`. */
export const rotatePlan: ImagePlan = (id, args, size) => {
  const angle = numberArgument(args, 'angle') ?? 0
  // The same turn, in degrees from 0 up to 360.
  const turn = ((angle % 360) + 360) % 360
  if (turn === 0) {
    throw new ToolError(`An angle of ${angle} degrees is a whole number of turns, so the new image would be the same as @${id}. Give an angle that is not a multiple of 360, as in 90 or -90.`)
  }
  const background = fillColor(args.fill)
  const keepSize = args.keep_size === true
  const rightAngle = turn % 90 === 0
  const { canvas, part } = turnSizes(size, turn, keepSize)
  if (canvas.width * canvas.height > MAX_DRAWN_PIXELS) {
    // Only a turn that grows the image makes a new image over the limit
    // from an image that is not.
    throw tooLargeError(canvas, size.width * size.height > MAX_DRAWN_PIXELS
      ? scaleFirstText(id, size, 'rotate', keepSize || rightAngle ? '' : ' and `keep_size` true')
      : `Give \`keep_size\` true to keep the size of @${id}.`)
  }

  const drawing: ImageDrawing = { ...wholeImageDrawing(size), width: canvas.width, height: canvas.height, partSize: part, turn }
  // Only a right angle can leave no blank part: when the turned image has
  // the size of the new image.
  const turned = turn === 180 ? part : { width: part.height, height: part.width }
  const covered = rightAngle && turned.width === canvas.width && turned.height === canvas.height
  if (background) drawing.background = background
  // A JPEG has no transparent pixels: the blank parts would be black.
  else if (!covered) drawing.mediaType = 'image/png'
  return drawing
}

// The plan of the color subcommand `kind`, which changes the colors by
// its `amount`. Throws for an amount under 0, and for an amount of 1,
// which keeps the colors. A color change makes no pixel transparent, so
// the color plans (this one and `invertPlan`) keep the file type of any
// other drawing.
function amountPlan(kind: AmountKind): ImagePlan {
  const { scale, less, more } = AMOUNTS[kind]
  return (id, args, size) => {
    const amount = numberArgument(args, 'amount') ?? 1
    if (amount < 0) throw new ToolError(`An \`amount\` of ${amount} is less than 0. Give 0 or more: ${scale}.`)
    if (amount === 1) {
      throw new ToolError(`An \`amount\` of 1 keeps the colors of @${id}, so the new image would be the same as @${id}. `
        + `Give less than 1 for ${less}, or more than 1 for ${more}.`)
    }
    return { ...wholeDrawing(id, size, kind), colors: { kind, amount } }
  }
}

/** The plan of `image brightness`: the whole image at its own size, with
 *  each color value multiplied by `amount`. */
export const brightnessPlan = amountPlan('brightness')

/** The plan of `image contrast`: the whole image at its own size, with the
 *  distance of each color value from the middle gray multiplied by
 *  `amount`. */
export const contrastPlan = amountPlan('contrast')

/** The plan of `image saturation`: the whole image at its own size, with
 *  the distance of each color value from the gray of its pixel multiplied
 *  by `amount`. */
export const saturationPlan = amountPlan('saturation')

/** The plan of `image invert`: the whole image at its own size, with each
 *  color inverted. */
export const invertPlan: ImagePlan = (id, _args, size) => ({ ...wholeDrawing(id, size, 'invert'), colors: { kind: 'invert' } })

// The formats of the file types `types` as a call names them, as in
// `"png", "jpeg", or "svg"`.
function formatsText(types: readonly DrawnMediaType[]): string {
  return new Intl.ListFormat('en', { type: 'disjunction' }).format(types.map((type) => `"${CONVERT_FORMATS[type]}"`))
}

/** The plan of `image convert`: the whole image at its own size, as a file
 *  of the format that `format` names. A JPEG gets white under the image,
 *  as it has no transparency: the transparent parts would be black. Throws
 *  for a format that Dez does not make, for the format of the image itself,
 *  and for an image over `MAX_DRAWN_PIXELS` (the text tells how to make a
 *  smaller image first). */
export const convertPlan: ImagePlan = (id, args, size, mediaType) => {
  const text = String(args.format).trim().toLowerCase()
  const format = text === 'jpg' ? 'jpeg' : text
  const target = CONVERT_TYPES.find((type) => CONVERT_FORMATS[type] === format)
  if (!target) {
    throw new ToolError(format === 'gif'
      ? `Dez cannot make GIF images. Give ${formatsText(CONVERT_TYPES)}.`
      : `${JSON.stringify(args.format)} is not a format of convert. Give ${formatsText(CONVERT_TYPES)}.`)
  }
  if (target === mediaType) {
    throw new ToolError(`The image @${id} is already in the ${FORMAT_NAMES[target]} format, so the new image would be the same as @${id}. `
      + `Give another format: ${formatsText(CONVERT_TYPES.filter((type) => type !== target))}.`)
  }
  // Scale writes a WebP, GIF, or SVG image as a PNG (`drawnMediaType`), so
  // for a PNG target its new image is the answer: a convert of that image
  // to PNG would be refused, as it is already a PNG.
  if (target === drawnMediaType(mediaType) && size.width * size.height > MAX_DRAWN_PIXELS) {
    throw tooLargeError(size, `${smallerImageText(id, size)}. Scale makes a ${FORMAT_NAMES[target]} image from @${id}, so no convert call is needed.`)
  }
  const drawing: ImageDrawing = { ...wholeDrawing(id, size, 'convert'), mediaType: target }
  if (target === 'image/jpeg') drawing.background = '#ffffff'
  return drawing
}

/** The error of a call whose new image from the image `id` (a file of the
 *  type `sourceType`) is of the type `mediaType`, which the canvas of this
 *  computer's webview does not write (WebP on macOS). It is not a fault of
 *  the call; the text names the formats that every computer makes (only
 *  WebP is known to fail), except the format of the image itself, which
 *  convert refuses. */
export function unwritableFormatError(id: string, mediaType: DrawnMediaType, sourceType: ImageMediaType, options?: ErrorOptions): ToolError {
  const name = FORMAT_NAMES[mediaType]
  const others = (['image/png', 'image/jpeg'] as const).filter((type) => type !== mediaType && type !== sourceType)
  const advice = others.length > 0 ? `If another format will do for the user, call convert with ${formatsText(others)}; else tell` : 'Tell'
  return new ToolError(`Dez cannot make ${name} images on this computer: its web view does not write them. This is not a fault of the call, and there is no new image from @${id}. `
    + `${advice} the user that this computer cannot make ${name} images.`, '', options)
}

/** The result of a call that made the image `newId`, of `size`, from the
 *  image `id`. It names the images by their ids only: a result goes to the
 *  provider, which gets no path of a stored file. */
export function imageResultText(id: string, newId: string, size: ImageSize): string {
  return `Made the image @${newId} from @${id}. The image @${newId} is ${sizeText(size)}.`
}
