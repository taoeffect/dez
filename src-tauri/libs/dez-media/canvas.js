// @ts-check
// dez-media/canvas: the graphics helpers of a script app that draws with
// skia-canvas: the shipped fonts, and an animated title in the look of a
// 1980s anime title card. Only a Deno run of an app whose manifest has
// `"native": ["skia-canvas"]` can load skia-canvas, which loads a native
// file. So this entry is apart from 'dez-media' (mod.js), which the pages
// of UI apps import too, and the import map of a page does not have it
// (`pageImportMap`, src/model/tools/appTemplates.ts).

import { Canvas, FontLibrary } from 'skia-canvas'

/**
 * A font that Dez ships, as `dez.fonts` of a run of an app lists it.
 * @typedef {{ file: string, family: string, weight: number, scripts: string, path: string }} ShippedFont
 */

// The shipped family of each generic family that a canvas font can name.
// skia-canvas draws the default font of a context (`10px sans-serif`), and
// a family that it does not know, with `sans-serif`.
const GENERIC_FAMILIES = { 'sans-serif': 'Noto Sans', monospace: 'JetBrains Mono' }

/**
 * Gives skia-canvas the fonts that Dez ships, each under its family, and
 * `sans-serif` and `monospace` as shipped families. A run of an app sees
 * no font of the computer, so a canvas draws no text before this call.
 *
 * Returns every shipped family as one list for `ctx.font`, Noto Sans first:
 * skia-canvas takes each character from the first family of the list that
 * has it, so the list draws each script that the fonts cover
 * (`ctx.font = \`bold 48px ${families}\``). One family alone draws only
 * its own scripts.
 *
 * @param {readonly ShippedFont[]} fonts `dez.fonts`
 * @returns {string}
 */
export function useShippedFonts(fonts) {
  if (!Array.isArray(fonts)) throw new TypeError('useShippedFonts takes the fonts that Dez ships: give it `dez.fonts`.')
  /** @type {Map<string, string[]>} */
  const families = new Map()
  for (const { family, path } of fonts) families.set(family, [...(families.get(family) ?? []), path])
  for (const [family, paths] of families) FontLibrary.use(family, paths)
  for (const [generic, family] of Object.entries(GENERIC_FAMILIES)) {
    const paths = families.get(family)
    if (paths) FontLibrary.use(generic, paths)
  }
  return [...families.keys()].map((family) => `"${family}"`).join(', ')
}

/** @typedef {import('skia-canvas').CanvasRenderingContext2D} Context */
/** @typedef {import('./motion.js').TitleMotion} TitleMotion */

/**
 * The picture of a title, which `drawTitleFrame` draws in each frame of
 * its clip: the title at its own size on a clear canvas of the frame size,
 * and the center of its block, around which the motion scales it.
 * @typedef {{ canvas: Canvas, scratch: Canvas, width: number, height: number, centerX: number, centerY: number, size: number }} TitleLayer
 */

/**
 * The options of a title (`titleLayer`).
 * @typedef {object} TitleOptions
 * @property {number} width the width of the frame, in pixels
 * @property {number} height the height of the frame, in pixels
 * @property {string} text the title: one line
 * @property {string} families the shipped families, from `useShippedFonts`:
 *   the title and the subtitle take a character that their font lacks
 *   from them
 * @property {string} [subtitle] a small line of wide letters under the title
 * @property {string} [family] the family of the font of the title; by
 *   default the first family of `families`
 * @property {number} [weight] the CSS weight of that font, 400 by default
 * @property {string} [fill] "chrome" (default), a gradient of the card,
 *   or a CSS color for the letters
 * @property {string} [outline] a CSS color of the outline, or "none";
 *   "#c80a1e" (red) by default
 * @property {string} [glow] a CSS color of the glow around the outline,
 *   or "none"; "#ff2878" (pink) by default
 * @property {'center' | 'top' | 'bottom'} [position] where the block of
 *   the title and the subtitle is: "center" (default), or 12% of the
 *   height from the top or the bottom
 */

// The sizes of the effects are those of the reference card, whose title is
// REFERENCE_SIZE pixels high: each one scales with the size of the title.
const REFERENCE_SIZE = 150
// The colors of the chrome gradient, from the top of the letters to their
// bottom (and a little more), with the horizon line of a 1980s chrome.
/** @type {readonly [number, string][]} */
const CHROME = [[0, 'rgb(255,255,255)'], [0.45, 'rgb(170,210,255)'], [0.5, 'rgb(30,40,110)'], [0.62, 'rgb(255,90,170)'], [1, 'rgb(255,230,150)']]
const SHADOW = 'rgb(5,0,15)'
const SUBTITLE_GLOW = 'rgb(80,220,255)'
// The width of the title is at most this part of the frame, and its
// height at most HEIGHT_PART of the frame.
const WIDTH_PART = 0.84
const HEIGHT_PART = 0.22
// The subtitle: its size and its letter spacing, as parts of the title
// size and of its own size.
const SUBTITLE_PART = 0.227
const SUBTITLE_SPACING = 0.41
const TITLE_SPACING = 0.02
const POSITION_MARGIN = 0.12

/** @param {number} width @param {number} height */
function blankCanvas(width, height) {
  return new Canvas(width, height, { gpu: false })
}

/**
 * A clear canvas with the text that `draw` draws in `color`, made wider by
 * `radius` pixels on each side (a stroke of the text), for an outline, a
 * glow, or a shadow.
 * @param {number} width
 * @param {number} height
 * @param {(ctx: Context, stroke: boolean) => void} draw
 * @param {number} radius
 * @param {string} color
 */
function tintedText(width, height, draw, radius, color) {
  const canvas = blankCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineJoin = 'round'
  ctx.lineWidth = radius * 2
  draw(ctx, radius > 0)
  return canvas
}

/**
 * Draws `source` on `ctx` blurred by `blur` pixels, `times` times at
 * `alpha`.
 * @param {Context} ctx
 * @param {Canvas} source
 * @param {number} blur
 * @param {number} alpha
 * @param {number} [times]
 */
function drawBlurred(ctx, source, blur, alpha, times = 1) {
  ctx.save()
  ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none'
  ctx.globalAlpha = alpha
  for (let time = 0; time < times; time += 1) ctx.drawImage(source, 0, 0)
  ctx.restore()
}

/**
 * Draws `source` on `ctx` blurred by `blur` pixels, with the alpha of each
 * blurred pixel squared: a glow that stays close to the letters and fades
 * fast, as the glow of the reference card. The squared alpha is a draw of
 * the blurred copy over itself with `destination-in`.
 * @param {Context} ctx
 * @param {Canvas} source
 * @param {number} blur
 */
function drawTightGlow(ctx, source, blur) {
  const glow = blankCanvas(source.width, source.height)
  const glowCtx = glow.getContext('2d')
  glowCtx.filter = `blur(${blur}px)`
  glowCtx.drawImage(source, 0, 0)
  glowCtx.filter = 'none'
  const copy = blankCanvas(source.width, source.height)
  copy.getContext('2d').drawImage(glow, 0, 0)
  glowCtx.globalCompositeOperation = 'destination-in'
  glowCtx.drawImage(copy, 0, 0)
  ctx.drawImage(glow, 0, 0)
}

/**
 * The picture of a title (`TitleLayer`): chrome letters (or a color) with
 * a white edge, a red outline, a pink glow, and a dark shadow, and under
 * them a subtitle of wide white letters with a cyan glow and a rule on each
 * side. The title gets the largest size that fits 84% of the width and
 * 22% of the height of the frame.
 *
 * Call `useShippedFonts` first: a canvas draws no text before. A frame of
 * the clip is then `drawTitleFrame(ctx, layer, titleMotion(time, …))`.
 * @param {TitleOptions} options
 * @returns {TitleLayer}
 */
export function titleLayer(options) {
  const { width, height, text, families, subtitle = '', weight = 400, fill = 'chrome', outline = '#c80a1e', glow = '#ff2878', position = 'center' } = options
  for (const [name, side] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(side) || Number(side) < 1) throw new RangeError(`The ${name} of a title is a whole number of pixels, 1 or more, not ${side}.`)
  }
  if (typeof text !== 'string' || text.trim() === '') throw new RangeError('A title needs a text.')
  if (typeof families !== 'string' || families === '') throw new TypeError('titleLayer needs the families of the shipped fonts: give it the return of useShippedFonts(dez.fonts).')
  if (!['center', 'top', 'bottom'].includes(position)) throw new RangeError(`The position of a title is "center", "top", or "bottom", not ${JSON.stringify(position)}.`)
  const titleFamilies = options.family ? `"${options.family}", ${families}` : families

  const canvas = blankCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const titleFont = (/** @type {number} */ size) => `${weight} ${size}px ${titleFamilies}`
  const subtitleFont = (/** @type {number} */ size) => `700 ${size}px ${families}`
  // The ink box of `words`: its extent from the origin of the text, which
  // is at the left end of the alphabetic baseline.
  const measure = (/** @type {string} */ font, /** @type {number} */ spacing, /** @type {string} */ words) => {
    ctx.font = font
    ctx.letterSpacing = `${spacing}px`
    const metrics = ctx.measureText(words)
    return { left: metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight, ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent }
  }

  // The size that fits: the ink of the text at a probe size scales with
  // the size, so one measure gives the widest line.
  const probe = 100
  const titleProbe = measure(titleFont(probe), probe * TITLE_SPACING, text)
  const subtitleProbe = subtitle ? measure(subtitleFont(probe * SUBTITLE_PART), probe * SUBTITLE_PART * SUBTITLE_SPACING, subtitle) : null
  const widest = Math.max(titleProbe.left + titleProbe.right, subtitleProbe ? subtitleProbe.left + subtitleProbe.right : 0, 1)
  const size = Math.max(4, Math.min(height * HEIGHT_PART, (probe * width * WIDTH_PART) / widest))
  const k = size / REFERENCE_SIZE
  const title = measure(titleFont(size), size * TITLE_SPACING, text)
  const subtitleSize = size * SUBTITLE_PART
  const sub = subtitle ? measure(subtitleFont(subtitleSize), subtitleSize * SUBTITLE_SPACING, subtitle) : null

  const gap = 40 * k
  const titleHeight = title.ascent + title.descent
  const blockHeight = titleHeight + (sub ? gap + sub.ascent + sub.descent : 0)
  const margin = height * POSITION_MARGIN
  const top = position === 'top' ? margin : position === 'bottom' ? height - margin - blockHeight : (height - blockHeight) / 2
  // The origin of the text, so that its ink is in the middle of the frame.
  const titleX = width / 2 - (title.right - title.left) / 2
  const titleY = top + title.ascent
  const drawTitle = (/** @type {Context} */ c, /** @type {boolean} */ stroke) => {
    c.font = titleFont(size)
    c.letterSpacing = `${size * TITLE_SPACING}px`
    c.textBaseline = 'alphabetic'
    c.textAlign = 'left'
    if (stroke) c.strokeText(text, titleX, titleY)
    c.fillText(text, titleX, titleY)
  }

  drawBlurred(ctx, tintedText(width, height, drawTitle, 8 * k, SHADOW), 14 * k, 0.9)
  if (glow !== 'none') drawTightGlow(ctx, tintedText(width, height, drawTitle, 4 * k, glow), 18 * k)
  if (outline !== 'none') {
    ctx.drawImage(tintedText(width, height, drawTitle, 4 * k, outline), 0, 0)
    ctx.drawImage(tintedText(width, height, drawTitle, 1 * k, '#ffffff'), 0, 0)
  }

  // The letters, on a canvas of their own, so that the streak of the chrome
  // (a `source-atop` fill) shows only on them.
  const letters = blankCanvas(width, height)
  const lettersCtx = letters.getContext('2d')
  const gradientTop = titleY - title.ascent - 50 * k
  const gradientHeight = titleHeight + 100 * k
  if (fill === 'chrome') {
    const gradient = lettersCtx.createLinearGradient(0, gradientTop, 0, gradientTop + gradientHeight)
    for (const [at, color] of CHROME) gradient.addColorStop(at, color)
    lettersCtx.fillStyle = gradient
  } else {
    lettersCtx.fillStyle = fill
  }
  drawTitle(lettersCtx, false)
  if (fill === 'chrome') {
    lettersCtx.globalCompositeOperation = 'source-atop'
    lettersCtx.fillStyle = 'rgba(255,255,255,0.706)'
    lettersCtx.fillRect(0, gradientTop + gradientHeight * 0.47, width, gradientHeight * 0.02)
  }
  ctx.drawImage(letters, 0, 0)

  if (sub) {
    const subtitleX = width / 2 - (sub.right - sub.left) / 2
    const subtitleTop = top + titleHeight + gap
    const subtitleY = subtitleTop + sub.ascent
    const drawSubtitle = (/** @type {Context} */ c, /** @type {boolean} */ stroke) => {
      c.font = subtitleFont(subtitleSize)
      c.letterSpacing = `${subtitleSize * SUBTITLE_SPACING}px`
      c.textBaseline = 'alphabetic'
      c.textAlign = 'left'
      if (stroke) c.strokeText(subtitle, subtitleX, subtitleY)
      c.fillText(subtitle, subtitleX, subtitleY)
    }
    drawBlurred(ctx, tintedText(width, height, drawSubtitle, 3 * k, SHADOW), 8 * k, 1, 2)
    drawTightGlow(ctx, tintedText(width, height, drawSubtitle, 0, SUBTITLE_GLOW), 5 * k)
    ctx.fillStyle = '#ffffff'
    drawSubtitle(ctx, false)
    // A rule on each side of the subtitle, when both fit in the frame.
    const ruleY = subtitleTop + (sub.ascent + sub.descent) / 2
    const half = (sub.right - sub.left) / 2 + 30 * k
    const ruleLength = 120 * k
    if (width / 2 + half + ruleLength < width) {
      ctx.strokeStyle = 'rgba(255,255,255,0.784)'
      ctx.lineWidth = 2 * k
      ctx.beginPath()
      ctx.moveTo(width / 2 - half, ruleY)
      ctx.lineTo(width / 2 - half - ruleLength, ruleY)
      ctx.moveTo(width / 2 + half, ruleY)
      ctx.lineTo(width / 2 + half + ruleLength, ruleY)
      ctx.stroke()
    }
  }
  return { canvas, scratch: blankCanvas(width, height), width, height, centerX: width / 2, centerY: top + blockHeight / 2, size }
}

/**
 * Draws one frame of a title clip on `ctx`, a canvas of the frame size:
 * the title of `layer` (`titleLayer`) in the state `motion`
 * (`titleMotion` of 'dez-media'). It clears the canvas first, so a frame
 * shows only the title, on clear pixels.
 * @param {Context} ctx
 * @param {TitleLayer} layer
 * @param {TitleMotion} motion
 */
export function drawTitleFrame(ctx, layer, motion) {
  const { width, height, scratch } = layer
  // The effects are those of a 1280-pixel frame of the reference card.
  const unit = width / 1280
  const scratchCtx = scratch.getContext('2d')
  scratchCtx.save()
  scratchCtx.clearRect(0, 0, width, height)
  scratchCtx.filter = motion.blur > 0 ? `blur(${motion.blur * height}px)` : 'none'
  scratchCtx.translate(layer.centerX, layer.centerY)
  scratchCtx.scale(motion.scale, motion.scale)
  scratchCtx.translate(-layer.centerX, -layer.centerY)
  scratchCtx.drawImage(layer.canvas, 0, 0)
  scratchCtx.restore()
  if (motion.flash > 0) {
    scratchCtx.save()
    scratchCtx.globalCompositeOperation = 'source-atop'
    scratchCtx.fillStyle = `rgba(255,255,255,${motion.flash})`
    scratchCtx.fillRect(0, 0, width, height)
    scratchCtx.restore()
  }
  if (motion.glint !== null) {
    // A slanted band of light that sweeps from left of the frame to right
    // of it, only on the pixels of the title.
    const x = (-200 + motion.glint * 1680) * unit
    const slant = 120 * unit
    scratchCtx.save()
    scratchCtx.globalCompositeOperation = 'source-atop'
    scratchCtx.filter = `blur(${8 * unit}px)`
    scratchCtx.fillStyle = 'rgba(255,255,255,0.9)'
    scratchCtx.beginPath()
    scratchCtx.moveTo(x - 40 * unit, 0)
    scratchCtx.lineTo(x + 10 * unit, 0)
    scratchCtx.lineTo(x + 10 * unit - slant, height)
    scratchCtx.lineTo(x - 40 * unit - slant, height)
    scratchCtx.closePath()
    scratchCtx.fill()
    scratchCtx.restore()
  }
  ctx.save()
  ctx.clearRect(0, 0, width, height)
  ctx.globalAlpha = motion.alpha
  if (motion.glitch > 0) {
    // Horizontal slices that move left and right by set amounts.
    const slice = Math.max(1, Math.round((24 * height) / 720))
    for (let index = 0, y = 0; y < height; index += 1, y += slice) {
      const shift = (index % 2 === 0 ? 1 : -1) * 120 * unit * motion.glitch * (((index * 37) % 7) / 6)
      const sliceHeight = Math.min(slice, height - y)
      ctx.drawImage(scratch, 0, y, width, sliceHeight, shift, y, width, sliceHeight)
    }
  } else {
    ctx.drawImage(scratch, 0, 0)
  }
  ctx.restore()
}
