import { describe, expect, it } from 'vitest'
import type { ImageMediaType } from '../chat/images'
import { mediaTagText } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { checkArgumentValues } from './arguments'
import { brightnessPlan, contrastPlan, convertPlan, cropPlan, flipPlan, IMAGE_TOOL, imageIdArgument, imageOf, imageResultText, invertPlan, MAX_DRAWN_PIXELS, rotatePlan, saturationPlan, scalePlan, unwritableFormatError } from './imageTool'
import { ToolError, type ToolArguments } from './types'

// A wide image: the two sides differ, so a swap of width and height shows.
const SIZE = { width: 1000, height: 500 }
const WHOLE = { x: 0, y: 0, width: 1000, height: 500 }
// The file type of the image, for the plans that do not read it.
const PNG: ImageMediaType = 'image/png'

const stored = (name: string) => `/home/u/.config/dez/assets/images/${name}`

function section(role: Section['role'], text: string): Section {
  return { id: crypto.randomUUID(), role, content: [{ kind: 'text', text }] }
}

function errorOf(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return (error as ToolError).message
  }
  throw new Error('The call did not throw.')
}

describe('IMAGE_TOOL', () => {
  it('gives each subcommand an example that its parameters take', () => {
    for (const subcommand of IMAGE_TOOL.subcommands) {
      expect(checkArgumentValues(subcommand, subcommand.example).ok).toBe(true)
    }
  })
})

describe('imageIdArgument', () => {
  it.each([
    ['a', 'a'],
    ['@a', 'a'],
    [' @ab ', 'ab'],
  ])('reads %j as the image %j', (image, id) => {
    expect(imageIdArgument({ image })).toBe(id)
  })

  it.each(['', '@', 'A', 'a1', 'image a', '@a @b', 'a.png'])('refuses %j, which is no image id', (image) => {
    expect(errorOf(() => imageIdArgument({ image }))).toBe(`${JSON.stringify(image)} is not an image id. An image id is lower-case letters, as in "a" or "@a".`)
  })
})

describe('imageOf', () => {
  it('finds the newest reference with the id in the user and the agent sections, with its file type', () => {
    const made = '/home/u/.config/dez/assets/generated/images/fox.jpg'
    const sections = [section('user', `A fox: ![${stored('fox.png')}](id=a)`), section('agent', `![${made}](id=a|tool=image)`)]
    expect(imageOf(sections, 'a')).toStrictEqual({ path: made, mediaType: 'image/jpeg' })
    expect(imageOf(sections.slice(0, 1), 'a')).toStrictEqual({ path: stored('fox.png'), mediaType: 'image/png' })
  })

  it('tells the model that an id names an audio or a video clip', () => {
    const sections = [
      section('user', `![${stored('fox.png')}](id=a)`),
      section('agent', mediaTagText({ kind: 'audio', id: 'b', type: 'audio/mpeg', src: null, url: 'https://cdn.example/b.mp3', expires: null, other: [] })),
      section('agent', mediaTagText({ kind: 'video', id: 'c', type: 'video/mp4', src: null, url: null, expires: null, other: [] })),
    ]
    expect(errorOf(() => imageOf(sections, 'b'))).toBe('@b is an audio clip. The image tool works on images only.')
    expect(errorOf(() => imageOf(sections, 'c'))).toBe('@c is a video clip. The image tool works on images only.')
  })

  it('lists the images, each once and in the order they first came, for an id that names nothing', () => {
    const sections = [
      section('user', `![${stored('b.png')}](id=b) ![${stored('a.png')}](id=a) ![${stored('old.png')}]()`),
      section('user', `![${stored('b2.png')}](id=b)`),
    ]
    expect(errorOf(() => imageOf(sections, 'z'))).toBe('No image of this conversation has the id @z. Its images are @b, @a: call again with one of these ids.')
  })

  it('tells the model that the conversation has no images when it has none', () => {
    expect(errorOf(() => imageOf([section('user', 'Crop @a.')], 'a')))
      .toBe('This conversation has no images, so it has no image @a. Do not call the image tool until the user adds an image to the conversation.')
  })
})

describe('cropPlan', () => {
  it('draws nothing for a call with only the image, and gives the size of the image', () => {
    expect(cropPlan('a', { image: 'a' }, SIZE, PNG)).toBe('The image @a is 1000x500 pixels. Give x, y, width, and height to make a new image from a part of it.')
  })

  it('takes the part at its own size', () => {
    expect(cropPlan('a', { image: 'a', x: 100, y: 50, width: 200, height: 80 }, SIZE, PNG)).toStrictEqual({
      crop: { x: 100, y: 50, width: 200, height: 80 },
      width: 200,
      height: 80,
    })
  })

  it('takes a part that ends at the right and bottom edges, and a part that is the whole image', () => {
    expect(cropPlan('a', { image: 'a', x: 999, y: 499, width: 1, height: 1 }, SIZE, PNG)).toStrictEqual({
      crop: { x: 999, y: 499, width: 1, height: 1 },
      width: 1,
      height: 1,
    })
    expect(cropPlan('a', { image: 'a', x: 0, y: 0, width: 1000, height: 500 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500 })
  })

  it.each([
    ['only one', { width: 200 }],
    ['three', { x: 0, y: 0, width: 200 }],
    // 0 is a value, not an absent parameter.
    ['only a zero', { x: 0 }],
  ])('refuses a crop with %s of its four parameters', (_case, crop) => {
    expect(errorOf(() => cropPlan('a', { image: 'a', ...crop }, SIZE, PNG)))
      .toBe('A crop needs all four of x, y, width, and height. Give all four, or only `image` to get the size of the image.')
  })

  it.each([
    ['past the right edge', { x: 900, y: 0, width: 101, height: 10 }, [899, 0, 101, 10]],
    ['past the bottom edge', { x: 0, y: 499, width: 10, height: 2 }, [0, 498, 10, 2]],
    ['left of the image', { x: -1, y: 0, width: 10, height: 10 }, [0, 0, 10, 10]],
    ['above the image', { x: 0, y: -1, width: 10, height: 10 }, [0, 0, 10, 10]],
    ['with no width', { x: 0, y: 0, width: 0, height: 10 }, [0, 0, 1, 10]],
    ['with no height', { x: 0, y: 0, width: 10, height: 0 }, [0, 0, 10, 1]],
    ['larger than the image', { x: 5, y: 5, width: 2000, height: 100 }, [0, 5, 1000, 100]],
  ])('refuses a part %s, and tells the size of the image and the nearest part inside it', (_case, crop, [x, y, width, height]) => {
    expect(errorOf(() => cropPlan('a', { image: 'a', ...crop }, SIZE, PNG))).toBe(
      `The crop (x ${crop.x}, y ${crop.y}, ${crop.width}x${crop.height} pixels) is not inside the image @a, which is 1000x500 pixels. `
        + 'A crop inside it has x and y of 0 or more, x + width of 1000 or less, and y + height of 500 or less. '
        + `The nearest such crop is x ${x}, y ${y}, width ${width}, height ${height}.`,
    )
  })

  it('takes a part of the most pixels from an image larger than that, and refuses a larger part', () => {
    const huge = { width: 10000, height: 10000 }
    expect(cropPlan('a', { image: 'a', x: 0, y: 0, width: 7680, height: 4320 }, huge, PNG)).toStrictEqual({
      crop: { x: 0, y: 0, width: 7680, height: 4320 },
      width: 7680,
      height: 4320,
    })
    expect(errorOf(() => cropPlan('a', { image: 'a', x: 0, y: 0, width: 7681, height: 4320 }, huge, PNG)))
      .toBe(`The new image would be 7681x4320 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). Take a smaller part.`)
  })
})

describe('scalePlan', () => {
  it('draws nothing for a call with only the image, and gives the size of the image', () => {
    expect(scalePlan('a', { image: 'a' }, SIZE, PNG)).toBe('The image @a is 1000x500 pixels. Give a width, a height, or both to make a new image from it at another size.')
  })

  it('keeps the shape of the image when the call gives only the width or only the height', () => {
    expect(scalePlan('a', { image: 'a', width: 400 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 400, height: 200 })
    expect(scalePlan('a', { image: 'a', height: 100 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 200, height: 100 })
  })

  it('rounds the other side to the nearest whole pixel, and gives it at least one pixel', () => {
    // 500 * 333 / 1000 = 166.5
    expect(scalePlan('a', { image: 'a', width: 333 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 333, height: 167 })
    expect(scalePlan('a', { image: 'a', width: 1 }, { width: 1000, height: 10 }, PNG)).toStrictEqual({
      crop: { x: 0, y: 0, width: 1000, height: 10 },
      width: 1,
      height: 1,
    })
  })

  it('stretches the image to a width and a height of another shape', () => {
    expect(scalePlan('a', { image: 'a', width: 300, height: 300 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 300, height: 300 })
  })

  it.each<ToolArguments>([{ width: 0 }, { height: 0 }, { width: -5, height: 10 }])('refuses the size %j', (size) => {
    expect(errorOf(() => scalePlan('a', { image: 'a', ...size }, SIZE, PNG)))
      .toBe('`width` and `height` must be 1 or more. Leave out one of them to keep the shape of the image.')
  })

  it('draws an image of the most pixels, and refuses a larger one with the largest size of its shape', () => {
    expect(scalePlan('a', { image: 'a', width: 7680, height: 4320 }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 7680, height: 4320 })
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 7681, height: 4320 }, SIZE, PNG))).toBe(
      `The new image would be 7681x4320 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). `
        + 'For the same shape, give a `width` of 7680 and a `height` of 4319, or less.',
    )
    // The side that the call leaves out counts too.
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 10000 }, SIZE, PNG)))
      .toBe('The new image would be 10000x5000 pixels. The most is 33177600 pixels (width times height). For the same shape, give a `width` of 8145 and a `height` of 4072, or less.')
    // A side of one pixel stays at one pixel.
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 100_000_000, height: 1 }, SIZE, PNG)))
      .toContain(`For the same shape, give a \`width\` of ${MAX_DRAWN_PIXELS} and a \`height\` of 1, or less.`)
  })
})

// An image over the limit: 10000 by 10000 pixels; the largest size of its
// shape is 5760 by 5760.
const HUGE = { width: 10000, height: 10000 }
const TOO_LARGE = `The new image would be 10000x10000 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). `
const SCALE_FIRST = 'Make a smaller image from @a with scale first (for the same shape, a `width` of 5760 and a `height` of 5760, or less), '

describe('flipPlan', () => {
  it.each(['horizontal', 'vertical'] as const)('mirrors the whole image %s, at its own size', (direction) => {
    expect(flipPlan('a', { image: 'a', direction }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, flip: direction })
  })

  it('reads the direction with any case and spaces', () => {
    expect(flipPlan('a', { image: 'a', direction: ' Vertical ' }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, flip: 'vertical' })
  })

  it('refuses a direction that it does not have, and names the two that it has', () => {
    expect(errorOf(() => flipPlan('a', { image: 'a', direction: 'diagonal' }, SIZE, PNG))).toBe('"diagonal" is not a direction of flip. '
      + 'Give "horizontal" to swap the left and the right of the image, or "vertical" to swap its top and its bottom.')
  })

  it('refuses an image over the limit, and tells how to make a smaller image first', () => {
    expect(errorOf(() => flipPlan('a', { image: 'a', direction: 'vertical' }, HUGE, PNG))).toBe(`${TOO_LARGE}${SCALE_FIRST}then call flip with the new image.`)
  })
})

describe('rotatePlan', () => {
  const turned = (size: { width: number, height: number }, turn: number, more: object = {}) => ({ crop: WHOLE, ...size, partSize: SIZE, turn, ...more })

  // A right angle leaves no blank part, so the file type stays as for any
  // other drawing: a JPEG stays a JPEG.
  it.each([
    [90, 90, { width: 500, height: 1000 }],
    [-90, 270, { width: 500, height: 1000 }],
    [270, 270, { width: 500, height: 1000 }],
    [180, 180, { width: 1000, height: 500 }],
    [450, 90, { width: 500, height: 1000 }],
  ])('turns the image %s degrees as a clockwise turn of %s, to the exact size %j', (angle, turn, size) => {
    expect(rotatePlan('a', { image: 'a', angle }, SIZE, PNG)).toStrictEqual(turned(size, turn))
  })

  it('grows the new image to hold the whole turned image, and makes a PNG for its transparent corners', () => {
    expect(rotatePlan('a', { image: 'a', angle: 45 }, SIZE, PNG)).toStrictEqual(turned({ width: 1061, height: 1061 }, 45, { mediaType: 'image/png' }))
    // 1000 * cos 30 + 500 * sin 30 = 1116.03, 1000 * sin 30 + 500 * cos 30 = 933.01
    expect(rotatePlan('a', { image: 'a', angle: -30 }, SIZE, PNG)).toStrictEqual(turned({ width: 1117, height: 934 }, 330, { mediaType: 'image/png' }))
  })

  it('keeps the size of the image with keep_size, and makes the turned image smaller to fit inside it', () => {
    // The box of the turn is 1060.66 pixels on each side: 500 / 1060.66 of
    // the image fits.
    expect(rotatePlan('a', { image: 'a', angle: 45, keep_size: true }, SIZE, PNG))
      .toStrictEqual({ crop: WHOLE, width: 1000, height: 500, partSize: { width: 471, height: 236 }, turn: 45, mediaType: 'image/png' })
    // On its side, a wide image leaves blank parts at its left and right.
    expect(rotatePlan('a', { image: 'a', angle: 90, keep_size: true }, SIZE, PNG))
      .toStrictEqual({ crop: WHOLE, width: 1000, height: 500, partSize: { width: 500, height: 250 }, turn: 90, mediaType: 'image/png' })
    // A square image on its side has no blank part.
    const square = { width: 400, height: 400 }
    expect(rotatePlan('a', { image: 'a', angle: 90, keep_size: true }, square, PNG))
      .toStrictEqual({ crop: { x: 0, y: 0, ...square }, ...square, partSize: square, turn: 90 })
  })

  it.each([
    ['black', '#000000'],
    ['White', '#ffffff'],
    ['#FF8800', '#ff8800'],
    [' #f80 ', '#ff8800'],
  ])('paints the fill %j under the turned image as %s, and keeps the file type', (fill, background) => {
    expect(rotatePlan('a', { image: 'a', angle: 45, fill }, SIZE, PNG)).toStrictEqual(turned({ width: 1061, height: 1061 }, 45, { background }))
  })

  it('takes a transparent fill as no fill', () => {
    expect(rotatePlan('a', { image: 'a', angle: 45, fill: 'Transparent' }, SIZE, PNG)).toStrictEqual(rotatePlan('a', { image: 'a', angle: 45 }, SIZE, PNG))
  })

  it.each(['red', '#ff88', 'constructor', ''])('refuses the fill %j, and names the fills that it takes', (fill) => {
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle: 45, fill }, SIZE, PNG)))
      .toBe(`${JSON.stringify(fill)} is not a fill of rotate. Give "transparent", "black", "white", or a hex color, as in "#ff8800" or "#f80".`)
  })

  it.each([0, 360, -720])('refuses the angle %s, which makes no change', (angle) => {
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle }, SIZE, PNG))).toBe(`An angle of ${angle} degrees is a whole number of turns, so the new image would be the same as @a. `
      + 'Give an angle that is not a multiple of 360, as in 90 or -90.')
  })

  it('refuses a turn that grows the image over the limit, and tells it to keep the size', () => {
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle: 45 }, { width: 7680, height: 4320 }, PNG))).toBe(
      `The new image would be 8486x8486 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). Give \`keep_size\` true to keep the size of @a.`,
    )
  })

  it('refuses an image over the limit, and tells how to make a smaller image first', () => {
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle: 90 }, HUGE, PNG))).toBe(`${TOO_LARGE}${SCALE_FIRST}then call rotate with the new image.`)
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle: 45, keep_size: true }, HUGE, PNG))).toBe(`${TOO_LARGE}${SCALE_FIRST}then call rotate with the new image.`)
    // The turn of the smaller image would grow it over the limit again.
    expect(errorOf(() => rotatePlan('a', { image: 'a', angle: 45 }, HUGE, PNG)))
      .toBe(`The new image would be 14143x14143 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). ${SCALE_FIRST}then call rotate with the new image and \`keep_size\` true.`)
  })
})

describe('the color plans', () => {
  const PLANS = { brightness: brightnessPlan, contrast: contrastPlan, saturation: saturationPlan, invert: invertPlan }

  // 0 is the least amount, and a valid one.
  it.each([
    ['brightness', 0],
    ['contrast', 0],
    ['saturation', 0],
    ['brightness', 1.5],
    ['contrast', 1.5],
    ['saturation', 1.5],
  ] as const)('%s changes the colors of the whole image by the amount %s, at its own size', (kind, amount) => {
    expect(PLANS[kind]('a', { image: 'a', amount }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, colors: { kind, amount } })
  })

  it('invert inverts the colors of the whole image, at its own size', () => {
    expect(invertPlan('a', { image: 'a' }, SIZE, PNG)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, colors: { kind: 'invert' } })
  })

  it.each([
    ['brightness', '0 makes the image black, 1 keeps it as it is, and 2 makes it twice as bright'],
    ['contrast', '0 makes the image one flat gray, 1 keeps it as it is, and 2 doubles the contrast'],
    ['saturation', '0 makes the image gray, 1 keeps it as it is, and 2 doubles the strength of the colors'],
  ] as const)('%s refuses an amount under 0, and tells what the amounts do', (kind, scale) => {
    expect(errorOf(() => PLANS[kind]('a', { image: 'a', amount: -0.5 }, SIZE, PNG))).toBe(`An \`amount\` of -0.5 is less than 0. Give 0 or more: ${scale}.`)
  })

  it.each([
    ['brightness', 'a darker image', 'a brighter image'],
    ['contrast', 'less contrast', 'more contrast'],
    ['saturation', 'weaker colors', 'stronger colors'],
  ] as const)('%s refuses an amount of 1, which makes no change', (kind, less, more) => {
    expect(errorOf(() => PLANS[kind]('a', { image: 'a', amount: 1 }, SIZE, PNG)))
      .toBe(`An \`amount\` of 1 keeps the colors of @a, so the new image would be the same as @a. Give less than 1 for ${less}, or more than 1 for ${more}.`)
  })

  it.each(['brightness', 'contrast', 'saturation', 'invert'] as const)('%s refuses an image over the limit, and tells how to make a smaller image first', (kind) => {
    expect(errorOf(() => PLANS[kind]('a', { image: 'a', amount: 2 }, HUGE, PNG))).toBe(`${TOO_LARGE}${SCALE_FIRST}then call ${kind} with the new image.`)
  })
})

describe('convertPlan', () => {
  const ALL_FORMATS = '"png", "jpeg", "webp", or "svg"'

  // A GIF source, as no plan makes a GIF.
  it.each([
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['svg', 'image/svg+xml'],
    [' WebP ', 'image/webp'],
  ] as const)('draws the whole image at its own size as the format %j', (format, mediaType) => {
    expect(convertPlan('a', { image: 'a', format }, SIZE, 'image/gif')).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, mediaType })
  })

  // A JPEG has no transparency: the transparent parts would be black.
  it.each(['jpeg', 'jpg', 'JPG'])('draws a JPEG for %j on white', (format) => {
    expect(convertPlan('a', { image: 'a', format }, SIZE, 'image/svg+xml')).toStrictEqual({ crop: WHOLE, width: 1000, height: 500, mediaType: 'image/jpeg', background: '#ffffff' })
  })

  it.each([
    ['png', 'image/png', 'The image @a is already in the PNG format, so the new image would be the same as @a. Give another format: "jpeg", "webp", or "svg".'],
    ['jpg', 'image/jpeg', 'The image @a is already in the JPEG format, so the new image would be the same as @a. Give another format: "png", "webp", or "svg".'],
    ['svg', 'image/svg+xml', 'The image @a is already in the SVG format, so the new image would be the same as @a. Give another format: "png", "jpeg", or "webp".'],
  ] as const)('refuses %j for an image of the type %s, and names the other formats', (format, mediaType, message) => {
    expect(errorOf(() => convertPlan('a', { image: 'a', format }, SIZE, mediaType))).toBe(message)
  })

  it.each([
    ['gif', `Dez cannot make GIF images. Give ${ALL_FORMATS}.`],
    ['bmp', `"bmp" is not a format of convert. Give ${ALL_FORMATS}.`],
    ['constructor', `"constructor" is not a format of convert. Give ${ALL_FORMATS}.`],
  ])('refuses the format %j, and names the formats that it makes', (format, message) => {
    expect(errorOf(() => convertPlan('a', { image: 'a', format }, SIZE, PNG))).toBe(message)
  })

  it('refuses an image over the limit, and tells how to make a smaller image first', () => {
    expect(errorOf(() => convertPlan('a', { image: 'a', format: 'jpeg' }, HUGE, PNG))).toBe(`${TOO_LARGE}${SCALE_FIRST}then call convert with the new image.`)
  })

  // Scale writes these types as a PNG, so a convert to PNG after the scale
  // would be refused as one of the image's own format.
  it.each(['image/webp', 'image/gif', 'image/svg+xml'] as const)('for a PNG of a %s image over the limit, tells that the scale alone makes it', (mediaType) => {
    expect(errorOf(() => convertPlan('a', { image: 'a', format: 'png' }, HUGE, mediaType))).toBe(
      `${TOO_LARGE}Make a smaller image from @a with scale (for the same shape, a \`width\` of 5760 and a \`height\` of 5760, or less). `
      + 'Scale makes a PNG image from @a, so no convert call is needed.',
    )
  })
})

describe('unwritableFormatError', () => {
  const NOT_AT_FAULT = 'This is not a fault of the call, and there is no new image from @a. '

  // convert refuses the format of the image itself, so the text never
  // offers it.
  it.each([
    ['image/png', 'If another format will do for the user, call convert with "jpeg"; else tell'],
    ['image/jpeg', 'If another format will do for the user, call convert with "png"; else tell'],
    ['image/gif', 'If another format will do for the user, call convert with "png" or "jpeg"; else tell'],
  ] as const)('says that the call is not at fault, and names the formats that every computer makes, but not the format of an image of the type %s', (sourceType, advice) => {
    expect(unwritableFormatError('a', 'image/webp', sourceType).message).toBe('Dez cannot make WebP images on this computer: its web view does not write them. '
      + `${NOT_AT_FAULT}${advice} the user that this computer cannot make WebP images.`)
  })

  it('offers no format when no other format is left', () => {
    expect(unwritableFormatError('a', 'image/jpeg', 'image/png').message).toBe('Dez cannot make JPEG images on this computer: its web view does not write them. '
      + `${NOT_AT_FAULT}Tell the user that this computer cannot make JPEG images.`)
  })
})

describe('imageResultText', () => {
  it('names the images by their ids, with the size in pixels', () => {
    expect(imageResultText('a', 'b', { width: 400, height: 200 })).toBe('Made the image @b from @a. The image @b is 400x200 pixels.')
  })
})
