// The parameters of dez-title (main.ts) and their checks. Apart from the
// drawing, so that a unit test reads them with no skia-canvas. The help of
// `video title` (src/model/tools/appAliases.ts) tells these parameters,
// their defaults, and their limits: keep the two the same.

import { checkParameterNames, choiceParameter, numberParameter, TITLE_ENTRANCES, TITLE_EXITS, type TitleEntrance, type TitleExit } from 'dez-media'

export const APP = 'dez-title'

/** The names of the parameters, in the order of the help of `video title`. */
export const TITLE_PARAMETERS = ['text', 'subtitle', 'font', 'width', 'height', 'fps', 'duration', 'fill', 'outline', 'glow', 'position', 'entrance', 'exit', 'glint']
const POSITIONS = ['center', 'top', 'bottom'] as const

/** The font of the title when the call names none: the black weight of
 *  the serif CJK font, the font of the reference card. */
export const DEFAULT_FONT = 'NotoSerifCJKjp-Black.otf'
// The most pixels of one side of a frame (FRAMES_MAX_SIDE of Dez,
// src/model/tools/appsTool.ts).
const MAX_SIDE = 4096
const MAX_FPS = 60
const MIN_DURATION = 1
const MAX_DURATION = 30
const MAX_TEXT_LENGTH = 200

/** The most pixels in all the frames of one clip (width × height ×
 *  frames): about 9.6 s of 1920×1080 at 30 fps. A PNG frame of a title is
 *  about 0.3 bytes a pixel, so a clip at the cap stays well below the
 *  256 MiB that a run can leave in its output folder
 *  (APP_RUN_MAX_OUTPUT_BYTES, src/model/tools/appsTool.ts). */
export const MAX_PIXEL_FRAMES = 600_000_000

export interface TitleParameters {
  text: string
  subtitle: string
  /** The file name of a shipped font. */
  font: string
  width: number
  height: number
  fps: number
  duration: number
  /** "chrome", or a hex color. */
  fill: string
  /** A hex color, or "none". */
  outline: string
  /** A hex color, or "none". */
  glow: string
  position: typeof POSITIONS[number]
  entrance: TitleEntrance
  exit: TitleExit
  glint: boolean
  /** The frame count of the clip: duration × fps, rounded. */
  frames: number
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const quoted = (value: unknown) => JSON.stringify(value) ?? String(value)
const listed = (values: readonly string[]) => values.map((value) => `"${value}"`).join(', ')

// A text parameter of one line.
function lineParameter(name: string, value: unknown, fallback: string | null): string {
  if (value === undefined && fallback !== null) return fallback
  if (typeof value !== 'string' || value.trim() === '') throw new RangeError(`${name} must be a text, as in "NEON CITY", not ${quoted(value)}.`)
  if (/[\r\n]/.test(value)) throw new RangeError(`${name} must be one line: give the second line as subtitle, or make two titles.`)
  if (value.length > MAX_TEXT_LENGTH) throw new RangeError(`${name} has ${value.length} characters, and takes at most ${MAX_TEXT_LENGTH}.`)
  return value
}

// A whole number of `name` from `min` to `max`.
function wholeParameter(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number from ${min} to ${max}, not ${quoted(value)}.`)
  }
  return value
}

// A color of `name`: a hex color, or one of `words`.
function colorParameter(name: string, value: unknown, fallback: string, words: readonly string[]): string {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (HEX_COLOR.test(value) || words.includes(value))) return value
  throw new RangeError(`${name} must be a hex color, as in "#c80a1e", or ${listed(words)}, not ${quoted(value)}.`)
}

/**
 * The parameters of a run, checked: `fontFiles` are the file names of the
 * fonts that Dez ships (`dez.fonts`). Throws a RangeError that tells how to
 * fix a parameter that the app does not take or whose value is not valid,
 * and for a clip with more pixels than `MAX_PIXEL_FRAMES`.
 */
export function titleParameters(parameters: Record<string, unknown>, fontFiles: readonly string[]): TitleParameters {
  checkParameterNames(APP, parameters, TITLE_PARAMETERS)

  const text = lineParameter('text', parameters.text, null)
  const subtitle = parameters.subtitle === undefined ? '' : lineParameter('subtitle', parameters.subtitle, null)
  const font = parameters.font ?? DEFAULT_FONT
  if (typeof font !== 'string' || !fontFiles.includes(font)) {
    throw new RangeError(`font must be the file name of a font that Dez ships, one of ${listed(fontFiles)}, not ${quoted(font)}.`)
  }
  const width = wholeParameter('width', parameters.width, 1920, 16, MAX_SIDE)
  const height = wholeParameter('height', parameters.height, 1080, 16, MAX_SIDE)
  const fps = wholeParameter('fps', parameters.fps, 30, 1, MAX_FPS)
  const duration = numberParameter(parameters, 'duration', (value) => value >= MIN_DURATION && value <= MAX_DURATION, `a number of seconds from ${MIN_DURATION} to ${MAX_DURATION}`) ?? 4
  const { glint = true } = parameters
  if (typeof glint !== 'boolean') throw new RangeError(`glint must be true or false, not ${quoted(glint)}.`)

  const frames = Math.max(1, Math.round(duration * fps))
  const pixelFrames = width * height * frames
  if (pixelFrames > MAX_PIXEL_FRAMES) {
    throw new RangeError(`A clip of ${width}×${height} at ${fps} fps for ${duration} s has ${frames} frames of ${(width * height / 1e6).toFixed(1)} million pixels, `
      + `and ${APP} makes at most ${MAX_PIXEL_FRAMES / 1e6} million pixels in all (about ${(MAX_PIXEL_FRAMES / (1920 * 1080 * 30)).toFixed(1)} s of 1920×1080 at 30 fps). `
      + 'Give a shorter duration, a lower fps, or a smaller width and height (the overlay can scale the title up).')
  }
  return {
    text,
    subtitle,
    font,
    width,
    height,
    fps,
    duration,
    fill: colorParameter('fill', parameters.fill, 'chrome', ['chrome']),
    outline: colorParameter('outline', parameters.outline, '#c80a1e', ['none']),
    glow: colorParameter('glow', parameters.glow, '#ff2878', ['none']),
    position: choiceParameter(parameters, 'position', POSITIONS),
    entrance: choiceParameter(parameters, 'entrance', TITLE_ENTRANCES),
    exit: choiceParameter(parameters, 'exit', TITLE_EXITS),
    glint,
    frames,
  }
}
