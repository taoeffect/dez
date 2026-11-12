import { bytesToBase64 } from '../../utils/base64'
import type { ColorChange } from './imageColors'
import type { ImageMediaType } from './images'

// How Dez draws a stored image again as a new file: a part of it, at
// another size, mirrored or turned, on a painted background, with changed
// colors, as a file of another type. The code that decides what to draw is
// pure (`imageFit` in providers/imageSize.ts, the plans of the `image` tool
// in tools/imageTool.ts, the color math in imageColors.ts); the pixel work
// is in the webview (dez.controller/images/redraw).

/** The size of an image in whole pixels. */
export interface ImageSize {
  width: number
  height: number
}

/** A part of an image, in the image's pixels: `x` and `y` are the place of
 *  its top left corner. */
export interface ImageRegion extends ImageSize {
  x: number
  y: number
}

/** How a part is mirrored: `horizontal` swaps its left and right,
 *  `vertical` its top and bottom. */
export type ImageFlip = 'horizontal' | 'vertical'

/** One new drawing of an image: the part of the image to take (`crop`),
 *  and the size of the canvas (`width`, `height`). With none of the
 *  optional fields, the part fills the canvas, and the file is of the type
 *  that the caller of redraw asks for. A drawing with one of them is drawn
 *  in this order: the background, then the part at `partSize`, mirrored,
 *  then turned, with its center at the center of the canvas, and last the
 *  change of the colors of the whole canvas. */
export interface ImageDrawing extends ImageSize {
  crop: ImageRegion
  flip?: ImageFlip
  /** The turn of the part, in degrees clockwise. */
  turn?: number
  /** The size of the part before the turn; the size of the canvas when
   *  absent. */
  partSize?: ImageSize
  /** The paint of the whole canvas under the part, as `#rrggbb`, which
   *  shows where the part does not cover the canvas and through the
   *  transparent pixels of the part; transparent when absent. */
  background?: string
  /** The file type of the drawing when the plan chooses it: a drawing
   *  that leaves pixels transparent must not be a JPEG, and only the plan
   *  knows that, after redraw gives it the size of the image; `convert`
   *  names the type that the call asks for. */
  mediaType?: DrawnMediaType
  /** The change of the colors of every pixel of the canvas, after the
   *  draw. */
  colors?: ColorChange
}

/** The drawing of the whole image at its own size. */
export function wholeImageDrawing({ width, height }: ImageSize): ImageDrawing {
  return { crop: { x: 0, y: 0, width, height }, width, height }
}

/** The file types of a drawn image. The canvas of every webview writes
 *  PNG and JPEG (the HTML standard asks only for PNG). Only some write
 *  WebP (WebKitGTK since 2.53.4; WKWebView writes none): on the others,
 *  redraw rejects with an `UnwritableImageTypeError`. No canvas writes SVG:
 *  a drawn SVG is a PNG drawing in an SVG file (`svgOfPng`). */
export type DrawnMediaType = Extract<ImageMediaType, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'>

/** The file type of a new drawing of an image of the type `source`. A JPEG
 *  stays a JPEG: it has no transparent pixels, and a photo is some times
 *  larger as a PNG. An image of every other type can have transparent
 *  pixels, and PNG keeps them with no loss. */
export function drawnMediaType(source: ImageMediaType): DrawnMediaType {
  return source === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

/** The error of redraw when the canvas of this webview does not write the
 *  file type of a drawing (WebP in WKWebView). Each caller words it for its
 *  reader. */
export class UnwritableImageTypeError extends Error {
  constructor(readonly mediaType: DrawnMediaType) {
    super(`The canvas of this webview does not write ${mediaType} files.`)
    this.name = 'UnwritableImageTypeError'
  }
}

/** The file of an SVG image that shows the PNG `png` of `size`: one
 *  `<image>` that holds the PNG as a `data:` URL, with the size of the PNG
 *  as the size of the SVG. It holds the pixels, not shapes. A `data:` image
 *  is the one kind that an SVG shown as an image may load, and WebKit
 *  draws it on a canvas with no taint, so Dez can draw the SVG again (the
 *  PNG copy of a request, the `image` tool). `xlink:href`, not `href`:
 *  viewers of SVG 1.1 read only that one. */
export function svgOfPng(png: Uint8Array, { width, height }: ImageSize): Uint8Array {
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<image width="${width}" height="${height}" xlink:href="data:image/png;base64,${bytesToBase64(png)}"/></svg>`)
}

/** The file of a new drawing, its file type, and the size of the drawing. */
export interface DrawnImage extends ImageSize {
  bytes: Uint8Array
  /** The file type of `bytes`: the type that the drawing names, else the
   *  type that the caller of redraw asked for. */
  mediaType: DrawnMediaType
}