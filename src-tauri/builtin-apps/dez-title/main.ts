// dez-title: an animated title clip in the look of a 1980s anime title
// card: chrome letters with a red outline, a pink glow, and a shadow, a
// subtitle of wide letters, a slam entrance with a flash, a glint, and a
// glitch exit. The clip has an alpha channel (MOV with the PNG codec), so
// `video ffmpeg` can put it over another clip with the overlay filter.
//
// Inputs: none.
//
// Parameters (each optional, apart from text):
// - text: the title, one line.
// - subtitle: a small line under the title.
// - font: the file name of a font that Dez ships, for the title;
//   NotoSerifCJKjp-Black.otf by default. A character that the font lacks
//   comes from another shipped font.
// - width, height: the size of the clip, 1920×1080 by default.
// - fps: 30 by default, 1 to 60. duration: 4 s by default, 1 to 30 s.
// - fill: "chrome" (default), or a hex color of the letters.
// - outline, glow: a hex color, or "none"; red and pink by default.
// - position: "center" (default), "top", or "bottom".
// - entrance: "slam" (default), "fade", or "none".
// - exit: "glitch" (default), "fade", or "none".
// - glint: true (default) or false.
// The clip has at most 600 million pixels in all its frames (MAX_PIXEL_FRAMES,
// parameters.ts).
//
// It writes the frames of the clip into title.frames/ of the output folder,
// and Dez encodes them into a video clip of the run.

import { Canvas } from 'skia-canvas'
import { titleMotion } from 'dez-media'
import { drawTitleFrame, titleLayer, useShippedFonts } from 'dez-media/canvas'
import { FrameWriter } from 'dez-media/frames'
import { APP, titleParameters } from './parameters.ts'

/** What a run gives the code (only the parts that this app reads). */
interface Dez {
  inputs: readonly unknown[]
  outputFolder: string
  fonts: readonly { file: string, family: string, weight: number, scripts: string, path: string }[]
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  if (dez.inputs.length > 0) throw new RangeError(`${APP} takes no input: give only parameters, with the text of the title.`)
  const title = titleParameters(parameters, dez.fonts.map(({ file }) => file))
  const families = useShippedFonts(dez.fonts)
  const font = dez.fonts.find(({ file }) => file === title.font)
  const { width, height, fps } = title
  const layer = titleLayer({
    width,
    height,
    text: title.text,
    subtitle: title.subtitle,
    families,
    family: font?.family,
    weight: font?.weight,
    fill: title.fill,
    outline: title.outline,
    glow: title.glow,
    position: title.position,
  })
  const canvas = new Canvas(width, height, { gpu: false })
  const ctx = canvas.getContext('2d')
  const frames = new FrameWriter(dez.outputFolder, 'title', { fps, width, height, alpha: true })
  for (let frame = 0; frame < title.frames; frame += 1) {
    drawTitleFrame(ctx, layer, titleMotion(frame / fps, { duration: title.duration, entrance: title.entrance, exit: title.exit, glint: title.glint }))
    frames.add(canvas)
  }
  frames.end()
  const subtitle = title.subtitle === '' ? '' : ` and the subtitle ${JSON.stringify(title.subtitle)}`
  return `The title ${JSON.stringify(title.text)}${subtitle}: ${title.frames} frames of ${width}×${height} at ${fps} fps (${title.duration} s), `
    + `with an alpha channel, in ${title.font}.`
}
