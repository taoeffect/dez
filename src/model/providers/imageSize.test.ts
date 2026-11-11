import { describe, expect, it } from 'vitest'
import { imageFit, imageSizeRules, type ImageSizeRules } from './imageSize'

// The rules of the Venice video models that tell all three.
const VIDEO_RULES: ImageSizeRules = { minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5 }

const whole = (width: number, height: number) => ({ x: 0, y: 0, width, height })

describe('imageSizeRules', () => {
  it('keeps each value that can be a limit', () => {
    const rules = { minShortSide: 300, minAspectRatio: 0.4, maxAspectRatio: 2.5, maxPixels: 33_177_600 }

    expect(imageSizeRules(rules)).toStrictEqual(rules)
  })

  it('drops a value that cannot be a limit, and keeps the others', () => {
    expect([
      imageSizeRules({ minShortSide: 299.5, minAspectRatio: '0.4', maxAspectRatio: 2.5, maxPixels: -1 }),
      imageSizeRules({ minShortSide: 240, minAspectRatio: 0, maxAspectRatio: null, maxPixels: Infinity }),
    ]).toStrictEqual([{ maxAspectRatio: 2.5 }, { minShortSide: 240 }])
  })

  it.each([
    ['no value', {}],
    ['only bad values', { minShortSide: NaN, maxAspectRatio: Infinity, maxPixels: '100' }],
    ['ratio limits with no ratio between them', { minAspectRatio: 2.5, maxAspectRatio: 0.4 }],
    ['two equal ratio limits', { minAspectRatio: 1, maxAspectRatio: 1 }],
  ])('gives no rules for %s', (_name, values) => {
    expect(imageSizeRules(values)).toBeUndefined()
  })

  it('drops only the ratio limits when no ratio is between them', () => {
    expect(imageSizeRules({ minShortSide: 240, minAspectRatio: 3, maxAspectRatio: 2 })).toStrictEqual({ minShortSide: 240 })
  })
})

describe('imageFit', () => {
  it.each([
    ['inside every rule', { width: 800, height: 600 }, { ...VIDEO_RULES, maxPixels: 1_000_000 }],
    ['with exactly the least short side', { width: 300, height: 700 }, VIDEO_RULES],
    ['with exactly the most pixels', { width: 7680, height: 4320 }, { maxPixels: 33_177_600 }],
    ['one pixel inside each ratio limit', { width: 400, height: 999 }, VIDEO_RULES],
    ['under no rule', { width: 1, height: 5000 }, {}],
  ])('leaves an image %s as it is', (_name, size, rules) => {
    expect(imageFit(size, rules)).toBeNull()
  })

  it.each([
    ['a square image', { width: 100, height: 100 }, { width: 300, height: 300 }],
    ['a wide image', { width: 200, height: 100 }, { width: 600, height: 300 }],
    ['a tall image', { width: 299, height: 500 }, { width: 300, height: 502 }],
    // 10 × 300 / 7 = 428.57…
    ['an image whose other side is not whole at that scale', { width: 7, height: 10 }, { width: 300, height: 429 }],
  ])('scales %s up until its short side has the least length, and crops nothing', (_name, size, drawn) => {
    expect(imageFit(size, { minShortSide: 300 })).toStrictEqual({ crop: whole(size.width, size.height), ...drawn })
  })

  it('scales an image with too many pixels down, with both sides rounded down', () => {
    // The scale is √(33,177,600 / 48,000,000) = 0.8313…: 6651.07 × 4988.30.
    expect(imageFit({ width: 8000, height: 6000 }, { maxPixels: 33_177_600 }))
      .toStrictEqual({ crop: whole(8000, 6000), width: 6651, height: 4988 })
  })

  // The limits are not allowed themselves, so the crop goes one pixel past
  // them.
  it.each([
    ['too narrow', { width: 100, height: 1000 }, { x: 0, y: 375, width: 100, height: 249 }],
    ['too wide', { width: 1500, height: 400 }, { x: 250, y: 0, width: 999, height: 400 }],
    ['exactly on the lower limit', { width: 400, height: 1000 }, { x: 0, y: 0, width: 400, height: 999 }],
    ['exactly on the upper limit', { width: 1000, height: 400 }, { x: 0, y: 0, width: 999, height: 400 }],
    // 2 / 0.4 is not exactly 5 in floating point.
    ['of a few pixels on the lower limit', { width: 2, height: 5 }, { x: 0, y: 0, width: 2, height: 4 }],
  ])('crops the middle of an image that is %s to the nearest ratio inside the limits, at the same scale', (_name, size, crop) => {
    expect(imageFit(size, { minAspectRatio: 0.4, maxAspectRatio: 2.5 }))
      .toStrictEqual({ crop, width: crop.width, height: crop.height })
  })

  it('crops to the ratio first, and then scales the part that is left', () => {
    expect([
      imageFit({ width: 100, height: 1000 }, VIDEO_RULES),
      imageFit({ width: 1000, height: 100 }, VIDEO_RULES),
      // The Venice edit rule: both sides 256 or more.
      imageFit({ width: 100, height: 50 }, { minShortSide: 256, maxPixels: 33_177_600 }),
    ]).toStrictEqual([
      { crop: { x: 0, y: 375, width: 100, height: 249 }, width: 300, height: 747 },
      { crop: { x: 375, y: 0, width: 249, height: 100 }, width: 747, height: 300 },
      { crop: whole(100, 50), width: 512, height: 256 },
    ])
  })

  it('keeps the ratio inside the limits when the rounding of a scale puts it on one', () => {
    // 590 × 290 at the scale for 17 pixels is 5.88 × 2.89, which rounds
    // down to 5 × 2: a ratio of exactly 2.5.
    expect(imageFit({ width: 590, height: 290 }, { maxAspectRatio: 2.5, maxPixels: 17 }))
      .toStrictEqual({ crop: whole(590, 290), width: 4, height: 2 })
  })

  it.each([
    ['rules that no size passes', { width: 1, height: 1 }, { minShortSide: 300, maxPixels: 100 }],
    ['ratio limits that no part of the image in whole pixels is between', { width: 1, height: 10 }, { minAspectRatio: 1.2, maxAspectRatio: 1.4 }],
    ['a size that is not whole pixels', { width: 100.5, height: 100 }, { minShortSide: 300 }],
    ['a size of zero', { width: 0, height: 100 }, { minShortSide: 300 }],
  ])('gives no drawing for %s', (_name, size, rules) => {
    expect(imageFit(size, rules)).toBeNull()
  })
})
