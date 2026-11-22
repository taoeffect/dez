// dez-sync: whether the cuts of a video edit are on the beats of its song.
// It finds the beats of the song (beatGrid of dez-media), where the song
// starts in the sound of the edit (align), the cuts of the edit (cuts),
// and the error of each cut against its nearest beat (syncCheck).
//
// Inputs: exactly two: first the edit (a video), then the song (a clip
// with sound). Dez decodes the sound of each to one channel at 22050
// samples a second, and each frame of the edit once, scaled to 96×54 RGB
// pixels (the "decode" of manifest.json).
//
// Parameters:
// - offset (seconds): where the song starts in the edit. With it, the run
//   does not search for the song in the sound of the edit, so the edit
//   needs no sound. Without it, the song must be in the sound of the edit.
// - max_lag (seconds, 0 or more, 6 by default): the latest offset to
//   search.
// - threshold (more than 0, 0.35 by default): the lowest score of a cut,
//   as in dez-cuts.
// - tolerance (seconds, more than 0; one frame of the edit by default): a
//   cut is off the beat when its error is more than this.
// - save_to: the result file, a path in /work/. By default
//   /work/sync-<edit>-to-<song>.json, with the ids of the two clips.
//
// The result file is a JSON object with the fields:
// - edit, song: the ids of the two clips.
// - offset: where the song starts in the edit; confidence: how well the
//   song matched the sound of the edit there (null for a given offset).
// - bpm: the tempo of the song; fps: the frame rate of the edit.
// - tolerance: the tolerance of the run.
// - cuts: each cut of the edit from the start of the song, as {time, beat,
//   error, offBeat}: the time of the cut and of its nearest beat in the
//   edit, the error (time − beat), and whether the error is more than the
//   tolerance.
// - meanError, maxError: of the errors without their signs; null with no
//   cut.
// Times are in seconds, to the millisecond.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { align, beatGrid, cuts, f32Samples, resultJson, rgbFrames, roundTo, syncCheck, workFile } from 'dez-media'

const APP = 'dez-sync'
const PARAMETERS = ['offset', 'max_lag', 'threshold', 'tolerance', 'save_to']
// The frame rate of an edit whose rate Dez does not know: the rate of most
// films.
const DEFAULT_FPS = 24
// The confidence of a sure match, and the one under which the sounds do
// not match (as in dez-align).
const MATCH = 0.5
const NO_MATCH = 0.3
// The most off-beat cuts that the text lists.
const LISTED_CUTS = 20

type Input = Dez['inputs'][number]

/** What a run gives the code (only the parts that this app reads). */
interface Dez {
  inputs: readonly {
    id: string
    kind: 'image' | 'audio' | 'video'
    /** The decoded sound: absent when the decode asks for none, null for
     *  a clip with no sound. */
    audio?: { path: string, rate: number, count: number } | null
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

// The number parameter `name`: undefined when the call does not give it.
// `rule` tells the numbers that `isValid` takes.
function numberParameter(parameters: Record<string, unknown>, name: string, isValid: (value: number) => boolean, rule: string): number | undefined {
  const value = parameters[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !isValid(value)) throw new RangeError(`${name} must be ${rule}, not ${JSON.stringify(value)}.`)
  return value
}

// The decoded sound of `input`, as samples; null for a clip with no
// sound.
async function sound(input: Input): Promise<{ samples: Float32Array, rate: number } | null> {
  if (input.audio === undefined) {
    throw new RangeError(`The run has no decoded sound of @${input.id}: the \`decode\` of the call asked for none. Call ${APP} without \`decode\`.`)
  }
  if (input.audio === null) return null
  return { samples: f32Samples(await readFile(input.audio.path)), rate: input.audio.rate }
}

const milliseconds = (time: number) => `${Math.round(time * 1000)} ms`
const signedMilliseconds = (time: number) => `${time > 0 ? '+' : ''}${milliseconds(time)}`

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(parameters)
  const givenOffset = numberParameter(parameters, 'offset', () => true, 'a number of seconds, such as 0 or 1.5')
  const maxLag = numberParameter(parameters, 'max_lag', (value) => value >= 0, 'a number of seconds, 0 or more, such as 6') ?? 6
  const threshold = numberParameter(parameters, 'threshold', (value) => value > 0, 'a number more than 0, such as 0.35') ?? 0.35
  const givenTolerance = numberParameter(parameters, 'tolerance', (value) => value > 0, 'a number of seconds more than 0, such as 0.042')
  if (dez.inputs.length !== 2) {
    throw new RangeError(`${APP} needs exactly two inputs, and the run has ${dez.inputs.length}: first the edit (a video), then its song, as in "@a @b".`)
  }
  const [editInput, songInput] = dez.inputs
  const saveTo = parameters.save_to ?? `/work/sync-${editInput.id}-to-${songInput.id}.json`
  if (typeof saveTo !== 'string') throw new RangeError(`save_to must be a path in /work/, as in "/work/sync.json", not ${JSON.stringify(saveTo)}.`)
  const file = workFile(dez.workFolder, saveTo)

  if (editInput.kind !== 'video') throw new RangeError(`The first input, @${editInput.id}, must be the edit, a video. Give the edit first, then its song, as in "@a @b".`)
  if (editInput.frames === undefined) {
    throw new RangeError(`The run has no decoded frames of @${editInput.id}: the \`decode\` of the call asked for none. Call ${APP} without \`decode\`.`)
  }
  if (editInput.frames === null) throw new RangeError(`@${editInput.id} has no picture, so it has no cut. The first input must be the edit, a video.`)
  if (songInput.kind === 'image') throw new RangeError(`The second input, @${songInput.id}, is an image: it must be the song, a clip with sound.`)
  const song = await sound(songInput)
  if (song === null) throw new RangeError(`The second input, @${songInput.id}, has no sound: it must be the song, a clip with sound.`)

  let offset = givenOffset
  let confidence: number | null = null
  if (offset === undefined) {
    const editSound = await sound(editInput)
    if (editSound === null) {
      throw new RangeError(`@${editInput.id} has no sound, so ${APP} cannot find where the song starts in it. `
        + 'Give that time with the parameter offset, in seconds: 0 when the song starts with the edit.')
    }
    const found = align(song.samples, editSound.samples, song.rate, { maxLag })
    offset = found.offset
    confidence = found.confidence
  }

  const grid = beatGrid(song.samples, song.rate)
  const { path, width, height, fps: editFps, count } = editInput.frames
  const fps = editFps ?? DEFAULT_FPS
  const tolerance = givenTolerance ?? 1 / fps
  const cutTimes = cuts(rgbFrames(await readFile(path), width, height), { fps, threshold }).cuts.map(({ time }) => time)
  const checked = syncCheck(cutTimes, grid.beats, { offset, tolerance })
  const rounded = (time: number | null) => time === null ? null : roundTo(time, 3)
  const result = {
    edit: editInput.id,
    song: songInput.id,
    offset: roundTo(offset, 3),
    confidence: rounded(confidence),
    bpm: roundTo(grid.bpm, 2),
    fps,
    tolerance: roundTo(tolerance, 3),
    cuts: checked.cuts.map((cut) => ({ time: roundTo(cut.time, 3), beat: roundTo(cut.beat, 3), error: roundTo(cut.error, 3), offBeat: cut.offBeat })),
    meanError: rounded(checked.meanError),
    maxError: rounded(checked.maxError),
  }
  await mkdir(dirname(file.path), { recursive: true })
  await writeFile(file.path, resultJson(result))

  const lines = []
  const start = confidence === null ? 'given' : `found with the confidence ${result.confidence}`
  lines.push(`@${songInput.id} (${result.bpm} BPM) starts at ${result.offset.toFixed(3)} s in @${editInput.id} (${start}); `
    + `@${editInput.id} has ${count} frames at ${roundTo(fps, 3)} fps.`)
  if (confidence !== null && confidence < MATCH) {
    lines.push(confidence < NO_MATCH
      ? `The song does not match the sound of @${editInput.id}, so the offset is likely wrong, and so are the errors. If you know where the song starts, give it with the parameter offset.`
      : 'The song matches the sound of the edit only weakly: check the offset, or give it with the parameter offset.')
  }
  const left = cutTimes.length - checked.cuts.length
  const before = left > 0 ? ` (${left} ${left === 1 ? 'cut' : 'cuts'} before the song starts left out)` : ''
  if (checked.meanError === null || checked.maxError === null) {
    lines.push(`@${editInput.id} has no cut from the start of the song${before}.`)
  } else {
    const offBeat = result.cuts.filter((cut) => cut.offBeat)
    lines.push(`${checked.cuts.length} ${checked.cuts.length === 1 ? 'cut' : 'cuts'}${before}: mean error ${milliseconds(checked.meanError)}, `
      + `max error ${milliseconds(checked.maxError)}; ${offBeat.length === 0 ? 'none' : offBeat.length} off the beat by more than ${milliseconds(tolerance)}.`)
    if (offBeat.length > 0) {
      const listed = offBeat.slice(0, LISTED_CUTS).map((cut) => `${cut.time.toFixed(3)} s (${signedMilliseconds(cut.error)})`).join(', ')
      const more = offBeat.length > LISTED_CUTS ? `, and ${offBeat.length - LISTED_CUTS} more` : ''
      lines.push(`Off the beat (cut time, and its error: + after the beat, - before it): ${listed}${more}.`)
    }
  }
  if (editFps === null) lines.push(`Dez does not know the frame rate of @${editInput.id}, so the cut times are for ${DEFAULT_FPS} fps.`)
  lines.push(`In ${file.shown}: edit, song, offset, confidence, bpm, fps, tolerance, cuts ({time, beat, error, offBeat} each, times in the edit), meanError, and maxError. Times are in seconds.`)
  return lines.join('\n')
}
