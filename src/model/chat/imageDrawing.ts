import type { ImageMediaType } from './images'

// How Dez draws a stored image again as a new file: a part of it, at
// another size, mirrored or turned, on a painted background. The code that
// decides what to draw is pure (`imageFit` in providers/imageSize.ts, the
// plans of the `image` tool in tools/imageTool.ts); the pixel work is in
// the webview (dez.controller/images/redraw).

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
 *  then turned, with its center at the center of the canvas. */
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
   *  knows that, after redraw gives it the size of the image. */
  mediaType?: DrawnMediaType
}

/** The drawing of the whole image at its own size. */
export function wholeImageDrawing({ width, height }: ImageSize): ImageDrawing {
  return { crop: { x: 0, y: 0, width, height }, width, height }
}

/** The file types of a drawn image: the two that the canvas of every
 *  webview writes (the HTML standard asks only for PNG; WKWebView writes no
 *  WebP). */
export type DrawnMediaType = Extract<ImageMediaType, 'image/png' | 'image/jpeg'>

/** The file type of a new drawing of an image of the type `source`. A JPEG
 *  stays a JPEG: it has no transparent pixels, and a photo is some times
 *  larger as a PNG. An image of every other type can have transparent
 *  pixels, and PNG keeps them with no loss. */
export function drawnMediaType(source: ImageMediaType): DrawnMediaType {
  return source === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

/** The file of a new drawing, and the size of the drawing. */
export interface DrawnImage extends ImageSize {
  bytes: Uint8Array
}