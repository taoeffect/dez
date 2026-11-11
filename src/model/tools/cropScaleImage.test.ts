import { describe, expect, it } from 'vitest'
import { cropScaleDrawing, cropScaleImageId, cropScaleResultText, imageSizeText, MAX_DRAWN_PIXELS } from './cropScaleImage'
import type { ToolArguments } from './types'

// A wide image: the two sides differ, so a swap of width and height shows.
const SIZE = { width: 1000, height: 500 }
const WHOLE = { x: 0, y: 0, width: 1000, height: 500 }

describe('cropScaleImageId', () => {
  it.each([
    ['a', 'a'],
    ['@a', 'a'],
    [' @ab ', 'ab'],
  ])('reads %j as the image %j', (image, id) => {
    expect(cropScaleImageId({ image })).toBe(id)
  })

  it.each(['', '@', 'A', 'a1', 'image a', '@a @b', 'a.png'])('refuses %j, which is no image id', (image) => {
    expect(() => cropScaleImageId({ image })).toThrow(`${JSON.stringify(image)} is not an image id.`)
  })

  it('refuses a call with no image', () => {
    expect(() => cropScaleImageId({})).toThrow('"" is not an image id.')
  })
})

describe('cropScaleDrawing', () => {
  it('draws nothing for a call that names no part and no size', () => {
    expect(cropScaleDrawing({ image: 'a' }, SIZE)).toBeNull()
  })

  it('keeps the shape of the image when the call gives only the width', () => {
    expect(cropScaleDrawing({ image: 'a', width: 400 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 400, height: 200 })
  })

  it('keeps the shape of the image when the call gives only the height', () => {
    expect(cropScaleDrawing({ image: 'a', height: 100 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 200, height: 100 })
  })

  it('rounds the other side to the nearest whole pixel', () => {
    // 500 * 333 / 1000 = 166.5
    expect(cropScaleDrawing({ image: 'a', width: 333 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 333, height: 167 })
  })

  it('gives the other side at least one pixel', () => {
    expect(cropScaleDrawing({ image: 'a', width: 1 }, { width: 1000, height: 10 })).toStrictEqual({
      crop: { x: 0, y: 0, width: 1000, height: 10 },
      width: 1,
      height: 1,
    })
  })

  it('stretches the image to a width and a height of another shape', () => {
    expect(cropScaleDrawing({ image: 'a', width: 300, height: 300 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 300, height: 300 })
  })

  it('takes a part at its own size when the call gives no size', () => {
    expect(cropScaleDrawing({ image: 'a', crop_x: 100, crop_y: 50, crop_width: 200, crop_height: 80 }, SIZE)).toStrictEqual({
      crop: { x: 100, y: 50, width: 200, height: 80 },
      width: 200,
      height: 80,
    })
  })

  it('scales a part by its own shape, not by the shape of the image', () => {
    expect(cropScaleDrawing({ image: 'a', crop_x: 100, crop_y: 50, crop_width: 200, crop_height: 80, height: 40 }, SIZE)).toStrictEqual({
      crop: { x: 100, y: 50, width: 200, height: 80 },
      width: 100,
      height: 40,
    })
  })

  it('takes a part that ends at the right and bottom edges, and a part that is the whole image', () => {
    expect(cropScaleDrawing({ image: 'a', crop_x: 999, crop_y: 499, crop_width: 1, crop_height: 1 }, SIZE)).toStrictEqual({
      crop: { x: 999, y: 499, width: 1, height: 1 },
      width: 1,
      height: 1,
    })
    expect(cropScaleDrawing({ image: 'a', crop_x: 0, crop_y: 0, crop_width: 1000, crop_height: 500 }, SIZE)).toStrictEqual({
      crop: WHOLE,
      width: 1000,
      height: 500,
    })
  })

  it.each([
    ['only one', { crop_width: 200 }],
    ['three', { crop_x: 0, crop_y: 0, crop_width: 200 }],
    // 0 is a value, not an absent parameter.
    ['only a zero', { crop_x: 0 }],
  ])('refuses a crop with %s of its four parameters', (_case, crop) => {
    expect(() => cropScaleDrawing({ image: 'a', ...crop }, SIZE))
      .toThrow('A crop needs all of crop_x, crop_y, crop_width, crop_height. Give all four, or none of them for the whole image.')
  })

  it.each([
    ['past the right edge', { crop_x: 900, crop_y: 0, crop_width: 101, crop_height: 10 }],
    ['past the bottom edge', { crop_x: 0, crop_y: 499, crop_width: 10, crop_height: 2 }],
    ['left of the image', { crop_x: -1, crop_y: 0, crop_width: 10, crop_height: 10 }],
    ['above the image', { crop_x: 0, crop_y: -1, crop_width: 10, crop_height: 10 }],
    ['with no width', { crop_x: 0, crop_y: 0, crop_width: 0, crop_height: 10 }],
    ['with no height', { crop_x: 0, crop_y: 0, crop_width: 10, crop_height: 0 }],
  ])('refuses a part %s, and tells the size of the image', (_case, crop) => {
    expect(() => cropScaleDrawing({ image: 'a', ...crop }, SIZE)).toThrow(
      `The crop (x ${crop.crop_x}, y ${crop.crop_y}, ${crop.crop_width}x${crop.crop_height} pixels) is not inside the image, which is 1000x500 pixels.`,
    )
  })

  it.each<ToolArguments>([{ width: 0 }, { height: 0 }, { width: -5, height: 10 }])('refuses the size %j', (size) => {
    expect(() => cropScaleDrawing({ image: 'a', ...size }, SIZE)).toThrow('`width` and `height` must be 1 or more.')
  })

  it('draws an image of the most pixels, and refuses a larger one', () => {
    expect(cropScaleDrawing({ image: 'a', width: 7680, height: 4320 }, SIZE)).toStrictEqual({ crop: WHOLE, width: 7680, height: 4320 })
    expect(() => cropScaleDrawing({ image: 'a', width: 7681, height: 4320 }, SIZE))
      .toThrow(`The new image would be 7681x4320 pixels. The most is ${MAX_DRAWN_PIXELS} pixels (width times height).`)
    // The side that the call leaves out counts too.
    expect(() => cropScaleDrawing({ image: 'a', width: 10000 }, SIZE)).toThrow('The new image would be 10000x5000 pixels.')
  })
})

describe('the result texts', () => {
  it('names images by their ids, with the size in pixels', () => {
    expect(imageSizeText('a', SIZE)).toBe('The image @a is 1000x500 pixels. Give a crop, a size, or both to make a new image from it.')
    expect(cropScaleResultText('a', 'b', { width: 400, height: 200 })).toBe('Made the image @b from @a. The image @b is 400x200 pixels.')
  })
})
