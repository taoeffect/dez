import { describe, expect, it } from 'vitest'
import { changeColors, type ColorChange } from './imageColors'

// Pixels as red, green, blue, and alpha: two colors, one of them half
// transparent, so a change that touches the alpha or mixes up pixels shows.
const PIXELS = [100, 150, 200, 255, 10, 250, 0, 128]

function changed(change: ColorChange, pixels: number[] = PIXELS): number[] {
  const bytes = new Uint8ClampedArray(pixels)
  changeColors(bytes, change)
  return [...bytes]
}

describe('changeColors', () => {
  it('multiplies each color value by the brightness, clamped to 255, and keeps the alpha', () => {
    expect(changed({ kind: 'brightness', amount: 0 })).toStrictEqual([0, 0, 0, 255, 0, 0, 0, 128])
    // 10 * 0.25 = 2.5 rounds to the even 2.
    expect(changed({ kind: 'brightness', amount: 0.25 })).toStrictEqual([25, 38, 50, 255, 2, 62, 0, 128])
    expect(changed({ kind: 'brightness', amount: 2 })).toStrictEqual([200, 255, 255, 255, 20, 255, 0, 128])
  })

  it('moves each color value away from the middle gray by the contrast', () => {
    // 127.5 rounds to the even 128.
    expect(changed({ kind: 'contrast', amount: 0 })).toStrictEqual([128, 128, 128, 255, 128, 128, 128, 128])
    // (100 - 127.5) * 2 + 127.5 = 72.5; (150 - 127.5) * 2 + 127.5 = 172.5.
    expect(changed({ kind: 'contrast', amount: 2 })).toStrictEqual([72, 172, 255, 255, 0, 255, 0, 128])
    expect(changed({ kind: 'contrast', amount: 0.5 })).toStrictEqual([114, 139, 164, 255, 69, 189, 64, 128])
  })

  it('moves each color value away from the gray of its pixel by the saturation', () => {
    // The gray of 100, 150, 200 is 0.213 * 100 + 0.715 * 150 + 0.072 * 200 =
    // 142.95; of 10, 250, 0 it is 180.88.
    expect(changed({ kind: 'saturation', amount: 0 })).toStrictEqual([143, 143, 143, 255, 181, 181, 181, 128])
    expect(changed({ kind: 'saturation', amount: 2 })).toStrictEqual([57, 157, 255, 255, 0, 255, 0, 128])
    expect(changed({ kind: 'saturation', amount: 0.5 })).toStrictEqual([121, 146, 171, 255, 95, 215, 90, 128])
  })

  it('keeps a gray pixel gray at any saturation', () => {
    expect(changed({ kind: 'saturation', amount: 3 }, [90, 90, 90, 255])).toStrictEqual([90, 90, 90, 255])
  })

  it('inverts each color value, and keeps the alpha', () => {
    expect(changed({ kind: 'invert' })).toStrictEqual([155, 105, 55, 255, 245, 5, 255, 128])
  })
})
