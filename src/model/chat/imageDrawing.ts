import type { ImageMediaType } from './images'

// How Dez draws a stored image again as a new file: a part of it, at
// another size. The code that decides what to draw is pure
// (`imageFit` in providers/imageSize.ts, the plans of the `image` tool in
// tools/imageTool.ts); the pixel work is in the webview
// (dez.controller/images/redraw).

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

/** One new drawing of an image: the part of the image to take (`crop`), and
 *  the size to draw that part at. */
export interface ImageDrawing extends ImageSize {
  crop: ImageRegion
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