// dez-cuts: the shot changes (cuts) of each input video, from cuts of
// dez-media: the change of the colors and of the pixels from each frame to
// the next, against the change of the frames around it.
//
// Inputs: one or more videos. Dez decodes each frame of each video once,
// scaled to 96×54 RGB pixels (the "decode" of manifest.json).
//
// Parameters:
// - threshold (more than 0, 0.35 by default): the lowest score of a cut.
//   The score of two frames is 0 to 3; give a lower threshold for soft
//   cuts, a higher one for a clip with fast motion.
// - save_to: the result file, a path in /work/; only for a run with one
//   input. By default each input gets /work/cuts-<id>.json.
//
// Each result file is a JSON object with the fields:
// - id: the id of the video.
// - fps: the frame rate that gives the times; frames: the frame count;
//   duration: frames / fps, in seconds.
// - threshold: the threshold of the run.
// - cuts: each cut, as {frame, time, score}: the first frame after the cut,
//   its time in seconds (to the millisecond), and its score.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkParameterNames, cuts, decodedFrames, numberParameter, resultFiles, resultJson, rgbFrames, roundTo } from 'dez-media'

const APP = 'dez-cuts'
const PARAMETERS = ['threshold', 'save_to']
// The frame rate of a video whose rate Dez does not know: the rate of
// most films.
const DEFAULT_FPS = 24
// The most cut times that the text lists for one video.
const LISTED_CUTS = 20

/** What a run gives the code (only the parts that this app reads). */
interface Dez {
  inputs: readonly {
    id: string
    kind: 'image' | 'audio' | 'video'
    /** The decoded frames: absent when the decode asks for none, null for
     *  a clip with no picture. `fps` is null when Dez does not know it. */
    frames?: { path: string, width: number, height: number, fps: number | null, count: number } | null
  }[]
  workFolder: string
}

const seconds = (time: number) => `${time.toFixed(3)} s`

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(APP, parameters, PARAMETERS)
  const threshold = numberParameter(parameters, 'threshold', (value) => value > 0, 'a number more than 0, such as 0.35') ?? 0.35
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more videos: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles('cuts', parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const decoded = decodedFrames(APP, input)
    const fps = decoded.fps ?? DEFAULT_FPS
    const found = cuts(rgbFrames(await readFile(decoded.path), decoded.width, decoded.height), { fps, threshold })
    results.push({
      id: input.id,
      fps,
      frames: decoded.count,
      duration: roundTo(decoded.count / fps, 3),
      threshold,
      cuts: found.cuts.map(({ frame, time, score }) => ({ frame, time: roundTo(time, 3), score: roundTo(score, 3) })),
      knowsFps: decoded.fps !== null,
    })
  }

  const lines = []
  for (const [index, { knowsFps, ...result }] of results.entries()) {
    const file = files[index]
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, resultJson(result))
    const count = result.cuts.length
    const times = result.cuts.slice(0, LISTED_CUTS).map(({ time }) => time.toFixed(3)).join(', ')
    const more = count > LISTED_CUTS ? `, and ${count - LISTED_CUTS} more` : ''
    const found = count === 0 ? 'no cut' : `${count} ${count === 1 ? 'cut' : 'cuts'}, at ${times} s${more}`
    const rate = knowsFps ? '' : ` Dez does not know the frame rate of @${result.id}, so the times are for ${DEFAULT_FPS} fps.`
    lines.push(`@${result.id} (${result.frames} frames, ${seconds(result.duration)} at ${roundTo(result.fps, 3)} fps): ${found}. In ${file.shown}.${rate}`)
  }
  lines.push('Each file holds id, fps, frames, duration, threshold, and cuts: {frame, time, score} each, where frame is the first frame after the cut. Times are in seconds.')
  return lines.join('\n')
}
