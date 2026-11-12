import type { ImageDrawing, ImageSize } from '../chat/imageDrawing'

// The size rules of the input images of a media request (the images of an
// edit, the frames of a video). Only a rule that the provider tells before
// a request counts: a field of the model's entry in its model list, or a
// sentence of its API docs (mediaFormats.ts). A provider refuses an image
// that breaks one, so Dez sends a copy that passes them (`imageFit`,
// dez.provider/generateMedia). The stored file does not change.

export interface ImageSizeRules {
  // The least length in pixels of the shorter side.
  minShortSide?: number
  // The limits of width / height. The ratio must be between them: an image
  // with exactly `minAspectRatio` or `maxAspectRatio` breaks the rule
  // (Venice: "exclusive (0.4, 2.5)").
  minAspectRatio?: number
  maxAspectRatio?: number
  // The most pixels (width × height).
  maxPixels?: number
}

// The limits of an input image that no fitted copy can meet, from the API
// docs of a media request (`ImageFormat.inputImageLimits`). Dez refuses an
// image that breaks one before the request (`ImageFormat.inputImageProblem`).
export interface InputImageLimits {
  // The image must have fewer pixels (width × height) than this.
  pixelsBelow?: number
  // The most bytes of the image file.
  maxBytes?: number
}

/** A limit from a provider's data: a finite number above zero, and a
 *  whole one when `whole` (a count). Undefined for any other value. */
export function positiveLimit(value: unknown, whole: boolean): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && (!whole || Number.isInteger(value)) ? value : undefined
}

/** The rules that the values of a provider's model data give, each under
 *  the name of its rule. A value that cannot be a limit (not a number above
 *  zero; pixels that are not whole) gives no rule, and neither do two
 *  ratio limits with no ratio between them. Undefined when no rule is
 *  left. */
export function imageSizeRules(values: { readonly [Rule in keyof ImageSizeRules]?: unknown }): ImageSizeRules | undefined {
  const rules: ImageSizeRules = {}
  const minShortSide = positiveLimit(values.minShortSide, true)
  const minAspectRatio = positiveLimit(values.minAspectRatio, false)
  const maxAspectRatio = positiveLimit(values.maxAspectRatio, false)
  const maxPixels = positiveLimit(values.maxPixels, true)
  const ratiosAgree = minAspectRatio === undefined || maxAspectRatio === undefined || minAspectRatio < maxAspectRatio
  if (minShortSide !== undefined) rules.minShortSide = minShortSide
  if (minAspectRatio !== undefined && ratiosAgree) rules.minAspectRatio = minAspectRatio
  if (maxAspectRatio !== undefined && ratiosAgree) rules.maxAspectRatio = maxAspectRatio
  if (maxPixels !== undefined) rules.maxPixels = maxPixels
  return Object.keys(rules).length > 0 ? rules : undefined
}

function passesRules({ width, height }: ImageSize, rules: ImageSizeRules): boolean {
  const ratio = width / height
  return (rules.minShortSide === undefined || Math.min(width, height) >= rules.minShortSide)
    && (rules.minAspectRatio === undefined || ratio > rules.minAspectRatio)
    && (rules.maxAspectRatio === undefined || ratio < rules.maxAspectRatio)
    && (rules.maxPixels === undefined || width * height <= rules.maxPixels)
}

// The largest size in `size` whose ratio is between the limits: a size that
// is too narrow loses rows, and one that is too wide loses columns. The
// division gives a first size, and the loops then step in whole pixels
// until the ratio itself passes, so the result holds for a limit that is
// not an exact number (0.4) and for a ratio that is exactly on a limit.
function withRatioInside({ width, height }: ImageSize, { minAspectRatio, maxAspectRatio }: ImageSizeRules): ImageSize {
  if (minAspectRatio !== undefined && width / height <= minAspectRatio) {
    height = Math.max(1, Math.floor(width / minAspectRatio))
    while (height > 1 && width / height <= minAspectRatio) height--
  }
  if (maxAspectRatio !== undefined && width / height >= maxAspectRatio) {
    width = Math.max(1, Math.floor(height * maxAspectRatio))
    while (width > 1 && width / height >= maxAspectRatio) width--
  }
  return { width, height }
}

// `size` at the scale that the rules need: up until the shorter side has
// `minShortSide`, or down until it has no more than `maxPixels`; else as it
// is. The other side is rounded to a whole pixel, which can put a ratio that
// was just inside a limit onto it, so the ratio is checked again.
function scaledSize(size: ImageSize, rules: ImageSizeRules): ImageSize {
  const { width, height } = size
  const { minShortSide, maxPixels } = rules
  const short = Math.min(width, height)
  if (minShortSide !== undefined && short < minShortSide) {
    const long = Math.round(Math.max(width, height) * minShortSide / short)
    return withRatioInside(width <= height ? { width: minShortSide, height: long } : { width: long, height: minShortSide }, rules)
  }
  if (maxPixels !== undefined && width * height > maxPixels) {
    const factor = Math.sqrt(maxPixels / (width * height))
    const scaled = { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) }
    // A rounding error of the root can leave one pixel row too many.
    while (scaled.width * scaled.height > maxPixels) {
      if (scaled.width >= scaled.height) scaled.width--
      else scaled.height--
    }
    return withRatioInside(scaled, rules)
  }
  return size
}

/** How to draw an image of `size` again so that it passes `rules`: the part
 *  in its middle with the nearest ratio that the rules allow (the least
 *  pixels lost), at the nearest size that they allow. Null for an image
 *  that passes the rules as it is, which must go as it is, and for one
 *  that no drawing brings inside the rules (rules that no size passes). */
export function imageFit(size: ImageSize, rules: ImageSizeRules): ImageDrawing | null {
  const { width, height } = size
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null
  if (passesRules(size, rules)) return null

  const crop = withRatioInside(size, rules)
  const drawn = scaledSize(crop, rules)
  if (!passesRules(drawn, rules)) return null
  return {
    crop: { x: Math.floor((width - crop.width) / 2), y: Math.floor((height - crop.height) / 2), ...crop },
    ...drawn,
  }
}
