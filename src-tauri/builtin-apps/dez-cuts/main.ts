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
import { cuts, resultJson, rgbFrames, roundTo, workFile } from 'dez-media'

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

// Throws for a parameter that this app does not take: with a misspelled
// name, the run would else go on with the default value.
function checkParameterNames(parameters: Record<string, unknown>): void {
  const unknown = Object.keys(parameters).filter((name) => !PARAMETERS.includes(name))
  if (unknown.length === 0) return
  const names = (list: readonly string[]) => list.map((name) => JSON.stringify(name)).join(', ')
  throw new RangeError(`${APP} does not take the parameter ${names(unknown)}. It takes only ${names(PARAMETERS)}.`)
}

// The `threshold` of the run.
function thresholdParameter(parameters: Record<string, unknown>): number {
  const { threshold } = parameters
  if (threshold === undefined) return 0.35
  if (typeof threshold !== 'number' || !(threshold > 0) || !Number.isFinite(threshold)) {
    throw new RangeError(`threshold must be a number more than 0, such as 0.35, not ${JSON.stringify(threshold)}.`)
  }
  return threshold
}

// The result files of the run: `save_to` for one input, else
// /work/cuts-<id>.json for each.
function resultFiles(parameters: Record<string, unknown>, dez: Dez) {
  const saveTo = parameters.save_to
  if (saveTo === undefined) return dez.inputs.map(({ id }) => workFile(dez.workFolder, `/work/cuts-${id}.json`))
  if (typeof saveTo !== 'string') throw new RangeError(`save_to must be a path in /work/, as in "/work/cuts.json", not ${JSON.stringify(saveTo)}.`)
  if (dez.inputs.length !== 1) throw new RangeError(`save_to names one file, and the run has ${dez.inputs.length} inputs. Leave it out: each input then gets /work/cuts-<id>.json.`)
  return [workFile(dez.workFolder, saveTo)]
}

// The decoded frames of `input`.
function decodedFrames(input: Dez['inputs'][number]) {
  if (input.kind !== 'video') throw new RangeError(`@${input.id} is no video (it is an ${input.kind === 'image' ? 'image' : 'audio clip'}), and ${APP} takes only videos.`)
  if (input.frames === undefined) {
    throw new RangeError(`The run has no decoded frames of @${input.id}: the \`decode\` of the call asked for none. Call ${APP} without \`decode\`.`)
  }
  if (input.frames === null) throw new RangeError(`@${input.id} has no picture, and ${APP} takes only videos.`)
  return input.frames
}

const seconds = (time: number) => `${time.toFixed(3)} s`

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(parameters)
  const threshold = thresholdParameter(parameters)
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more videos: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles(parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const decoded = decodedFrames(input)
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
