import { describe, expect, it } from 'vitest'
import { mediaTagText } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { checkArgumentValues } from './arguments'
import { cropPlan, IMAGE_TOOL, imageOf, imageResultText, imageToolId, MAX_DRAWN_PIXELS, scalePlan } from './imageTool'
import { ToolError, type ToolArguments } from './types'

// A wide image: the two sides differ, so a swap of width and height shows.
const SIZE = { width: 1000, height: 500 }
const WHOLE = { x: 0, y: 0, width: 1000, height: 500 }

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

describe('imageToolId', () => {
  it.each([
    ['a', 'a'],
    ['@a', 'a'],
    [' @ab ', 'ab'],
  ])('reads %j as the image %j', (image, id) => {
    expect(imageToolId({ image })).toBe(id)
  })

  it.each(['', '@', 'A', 'a1', 'image a', '@a @b', 'a.png'])('refuses %j, which is no image id', (image) => {
    expect(errorOf(() => imageToolId({ image }))).toBe(`${JSON.stringify(image)} is not an image id. An image id is lower-case letters, as in "a" or "@a".`)
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
    expect(cropPlan('a', { image: 'a' }, SIZE)).toBe('The image @a is 1000x500 pixels. Give x, y, width, and height to make a new image from a part of it.')
  })

  it('takes the part at its own size', () => {
    expect(cropPlan('a', { image: 'a', x: 100, y: 50, width: 200, height: 80 }, SIZE)).toStrictEqual({
      crop: { x: 100, y: 50, width: 200, height: 80 },
      width: 200,
      height: 80,
    })
  })

  it('takes a part that ends at the right and bottom edges, and a part that is the whole image', () => {
    expect(cropPlan('a', { image: 'a', x: 999, y: 499, width: 1, height: 1 }, SIZE)).toStrictEqual({
      crop: { x: 999, y: 499, width: 1, height: 1 },
      width: 1,
      height: 1,
    })
    expect(cropPlan('a', { image: 'a', x: 0, y: 0, width: 1000, height: 500 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 1000, height: 500 })
  })

  it.each([
    ['only one', { width: 200 }],
    ['three', { x: 0, y: 0, width: 200 }],
    // 0 is a value, not an absent parameter.
    ['only a zero', { x: 0 }],
  ])('refuses a crop with %s of its four parameters', (_case, crop) => {
    expect(errorOf(() => cropPlan('a', { image: 'a', ...crop }, SIZE)))
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
    expect(errorOf(() => cropPlan('a', { image: 'a', ...crop }, SIZE))).toBe(
      `The crop (x ${crop.x}, y ${crop.y}, ${crop.width}x${crop.height} pixels) is not inside the image @a, which is 1000x500 pixels. `
        + 'A crop inside it has x and y of 0 or more, x + width of 1000 or less, and y + height of 500 or less. '
        + `The nearest such crop is x ${x}, y ${y}, width ${width}, height ${height}.`,
    )
  })

  it('takes a part of the most pixels from an image larger than that, and refuses a larger part', () => {
    const huge = { width: 10000, height: 10000 }
    expect(cropPlan('a', { image: 'a', x: 0, y: 0, width: 7680, height: 4320 }, huge)).toStrictEqual({
      crop: { x: 0, y: 0, width: 7680, height: 4320 },
      width: 7680,
      height: 4320,
    })
    expect(errorOf(() => cropPlan('a', { image: 'a', x: 0, y: 0, width: 7681, height: 4320 }, huge)))
      .toBe(`The new image would be 7681x4320 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). Take a smaller part.`)
  })
})

describe('scalePlan', () => {
  it('draws nothing for a call with only the image, and gives the size of the image', () => {
    expect(scalePlan('a', { image: 'a' }, SIZE)).toBe('The image @a is 1000x500 pixels. Give a width, a height, or both to make a new image from it at another size.')
  })

  it('keeps the shape of the image when the call gives only the width or only the height', () => {
    expect(scalePlan('a', { image: 'a', width: 400 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 400, height: 200 })
    expect(scalePlan('a', { image: 'a', height: 100 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 200, height: 100 })
  })

  it('rounds the other side to the nearest whole pixel, and gives it at least one pixel', () => {
    // 500 * 333 / 1000 = 166.5
    expect(scalePlan('a', { image: 'a', width: 333 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 333, height: 167 })
    expect(scalePlan('a', { image: 'a', width: 1 }, { width: 1000, height: 10 })).toStrictEqual({
      crop: { x: 0, y: 0, width: 1000, height: 10 },
      width: 1,
      height: 1,
    })
  })

  it('stretches the image to a width and a height of another shape', () => {
    expect(scalePlan('a', { image: 'a', width: 300, height: 300 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 300, height: 300 })
  })

  it.each<ToolArguments>([{ width: 0 }, { height: 0 }, { width: -5, height: 10 }])('refuses the size %j', (size) => {
    expect(errorOf(() => scalePlan('a', { image: 'a', ...size }, SIZE)))
      .toBe('`width` and `height` must be 1 or more. Leave out one of them to keep the shape of the image.')
  })

  it('draws an image of the most pixels, and refuses a larger one with the largest size of its shape', () => {
    expect(scalePlan('a', { image: 'a', width: 7680, height: 4320 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 7680, height: 4320 })
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 7681, height: 4320 }, SIZE))).toBe(
      `The new image would be 7681x4320 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height). `
        + 'For the same shape, give a `width` of 7680 and a `height` of 4319, or less.',
    )
    // The side that the call leaves out counts too.
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 10000 }, SIZE)))
      .toBe('The new image would be 10000x5000 pixels. The most is 33177600 pixels (width times height). For the same shape, give a `width` of 8145 and a `height` of 4072, or less.')
    // A side of one pixel stays at one pixel.
    expect(errorOf(() => scalePlan('a', { image: 'a', width: 100_000_000, height: 1 }, SIZE)))
      .toContain(`For the same shape, give a \`width\` of ${MAX_DRAWN_PIXELS} and a \`height\` of 1, or less.`)
  })
})

describe('imageResultText', () => {
  it('names the images by their ids, with the size in pixels', () => {
    expect(imageResultText('a', 'b', { width: 400, height: 200 })).toBe('Made the image @b from @a. The image @b is 400x200 pixels.')
  })
})
