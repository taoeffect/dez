// The color changes of the `image` tool (tools/imageTool.ts): pure math on
// the pixels of a new drawing, which dez.controller/images/redraw runs after
// the draw. The formulas are those of the CSS filter functions
// `brightness()`, `contrast()`, `saturate()`, and `invert()` (Filter Effects
// Module Level 1), on the sRGB values, as those functions run. Pure math,
// not the `filter` of the canvas: the support of that in WebKit is not
// certain, and the unit tests have no canvas.
//
// https://www.w3.org/TR/filter-effects-1/#filter-functions

/** A change of the colors of every pixel of an image. An `amount` of 1
 *  keeps the colors; each kind tells what 0 does. The alpha of each pixel
 *  stays as it is. */
export type ColorChange =
  /** 0 makes the image black; 2 makes it twice as bright. */
  | { kind: 'brightness', amount: number }
  /** 0 makes the image one flat gray; 2 doubles the contrast. */
  | { kind: 'contrast', amount: number }
  /** 0 makes the image gray; 2 doubles the color. */
  | { kind: 'saturation', amount: number }
  /** Each color value becomes its opposite: black is white. */
  | { kind: 'invert' }

// The share of red, green, and blue in the gray of a pixel, as in the
// matrix of `saturate()`.
const GRAY_WEIGHTS = [0.213, 0.715, 0.072] as const

/** Changes the colors of `pixels` in place: red, green, blue, and alpha
 *  bytes of each pixel, not premultiplied, as `getImageData` gives them.
 *  Each new value is clamped to 0-255 and rounded (by the
 *  `Uint8ClampedArray`). */
export function changeColors(pixels: Uint8ClampedArray, change: ColorChange): void {
  if (change.kind === 'saturation') {
    saturate(pixels, change.amount)
    return
  }
  // The other changes map each channel value alone: a table of the 256
  // values costs less than the math for each pixel of a large image.
  const table = new Uint8ClampedArray(256)
  for (let value = 0; value < 256; value++) table[value] = channelValue(change, value)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = table[pixels[index]]
    pixels[index + 1] = table[pixels[index + 1]]
    pixels[index + 2] = table[pixels[index + 2]]
  }
}

// The new value of a channel value (0-255) of a change that maps each
// channel alone, before the clamp.
function channelValue(change: Exclude<ColorChange, { kind: 'saturation' }>, value: number): number {
  switch (change.kind) {
    case 'brightness':
      return value * change.amount
    case 'contrast':
      return (value - 127.5) * change.amount + 127.5
    case 'invert':
      return 255 - value
  }
}

// The matrix of `saturate()`, in a shorter form: the distance of each
// channel from the gray of its pixel is multiplied by `amount`.
function saturate(pixels: Uint8ClampedArray, amount: number): void {
  const [redWeight, greenWeight, blueWeight] = GRAY_WEIGHTS
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    const gray = red * redWeight + green * greenWeight + blue * blueWeight
    pixels[index] = gray + (red - gray) * amount
    pixels[index + 1] = gray + (green - gray) * amount
    pixels[index + 2] = gray + (blue - gray) * amount
  }
}
