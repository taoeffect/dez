import { describe, expect, it } from 'vitest'
import { gridLayout, gridTexts, type GridPiece } from './assetGrid'

const image = (id: string): GridPiece => ({ kind: 'image', id })
const sheet = (id: string): GridPiece => ({ kind: 'sheet', id, shows: `the frame sheet of the video clip @${id}: 2 frames in one row, at 1, 2 s` })
const square = (side: number) => ({ width: side, height: side })

describe('gridLayout', () => {
  it('puts a run of images side by side, each one in the frame box and in the middle of its line, and each frame sheet in a line of its own', () => {
    const layout = gridLayout(
      [image('a'), image('b'), sheet('c'), image('d')],
      [{ width: 1000, height: 500 }, { width: 300, height: 600 }, { width: 968, height: 364 }, { width: 200, height: 100 }],
      'review',
      1568,
    )

    expect(layout).toStrictEqual({
      width: 968,
      height: 816,
      places: [
        { x: 0, y: 80, width: 320, height: 160 },
        { x: 324, y: 0, width: 160, height: 320 },
        { x: 0, y: 336, width: 968, height: 364 },
        { x: 0, y: 716, width: 200, height: 100 },
      ],
      background: '#ffffff',
      mediaType: 'image/jpeg',
      scale: 1,
      imagesSmaller: true,
    })
  })

  it('puts more than 4 images in rows as even as can be, 4 pixels apart, and two frame sheets 16 pixels apart', () => {
    const images = gridLayout(['a', 'b', 'c', 'd', 'e'].map(image), Array(5).fill(square(100)), 'review', 1568)
    expect(images.places.map(({ x, y }) => [x, y])).toStrictEqual([[0, 0], [104, 0], [208, 0], [0, 104], [104, 104]])
    expect(images).toMatchObject({ width: 308, height: 204, imagesSmaller: false })

    const sheets = gridLayout([sheet('a'), sheet('b')], [{ width: 100, height: 50 }, { width: 80, height: 40 }], 'review', 1568)
    expect(sheets.places).toStrictEqual([{ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 66, width: 80, height: 40 }])
    expect(sheets).toMatchObject({ width: 100, height: 106 })
  })

  it('fits images in the frame box of full detail', () => {
    expect(gridLayout([image('a'), image('b')], [{ width: 2000, height: 1000 }, square(500)], 'full', 3000).places)
      .toStrictEqual([{ x: 0, y: 90, width: 640, height: 320 }, { x: 644, y: 0, width: 500, height: 500 }])
  })

  it('makes the whole grid smaller to fit the side, each edge on the nearest pixel', () => {
    const layout = gridLayout([image('a'), image('b')], [{ width: 100, height: 50 }, { width: 100, height: 50 }], 'review', 100)

    expect(layout).toMatchObject({
      width: 100,
      height: 25,
      places: [{ x: 0, y: 0, width: 49, height: 25 }, { x: 51, y: 0, width: 49, height: 25 }],
      scale: 100 / 204,
    })
  })
})

describe('gridTexts', () => {
  it('names the lines top to bottom, and tells how to see more of an image that is a smaller copy', () => {
    const pieces = [image('a'), image('b'), sheet('c'), image('d')]
    const layout = gridLayout(pieces, [square(1000), square(100), { width: 968, height: 364 }, square(100)], 'review', 1568)

    const { note, shows } = gridTexts(pieces, layout, 'review')

    const map = 'the images @a and @b, left to right; the frame sheet of the video clip @c: 2 frames in one row, at 1, 2 s; the image @d'
    expect(shows).toBe(`a grid, top to bottom: ${map}`)
    expect(note).toBe(`Grid picture of ${layout.width}x${layout.height} pixels, top to bottom: ${map}. `
      + 'Each image fits in 320 by 320 pixels: a larger one is a smaller copy. '
      + 'For more detail, call again with fewer assets, with `detail` "full", or with `layout` "separate".')
  })

  it('tells the size of a grid that is a smaller copy, and no more detail for one that is not', () => {
    const pieces = [image('a'), image('b')]
    const smaller = gridLayout(pieces, [{ width: 100, height: 50 }, { width: 100, height: 50 }], 'full', 100)
    expect(gridTexts(pieces, smaller, 'full').note).toMatch(/ The whole grid is a smaller copy, at 49% of the size of its parts\. For more detail, call again with fewer assets or with `layout` "separate"\.$/)

    const whole = gridLayout(pieces, [{ width: 100, height: 50 }, { width: 100, height: 50 }], 'full', 3000)
    expect(gridTexts(pieces, whole, 'full').note).toBe('Grid picture of 204x50 pixels, top to bottom: the images @a and @b, left to right.')
  })
})
