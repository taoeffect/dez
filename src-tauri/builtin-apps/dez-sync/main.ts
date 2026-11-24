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
//   search. The search also stops at half of the length of the sound of
//   the edit.
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
import { align, atAlignSearchEnd, beatGrid, checkParameterNames, cuts, decodedFrames, decodedSound, f32Samples, namingInput, numberParameter, resultFile, resultJson, rgbFrames, roundTo, syncCheck } from 'dez-media'

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

const milliseconds = (time: number) => `${Math.round(time * 1000)} ms`
const signedMilliseconds = (time: number) => `${time > 0 ? '+' : ''}${milliseconds(time)}`

// The text of an offset at the end of the search of align: the song can
// start later, and a song with a steady beat can then match a whole bar
// early.
function searchEndText(offset: number, maxLag: number, halfEdit: number, edit: string, song: string): string | null {
  if (!atAlignSearchEnd(offset, Math.min(maxLag, halfEdit))) return null
  return maxLag < halfEdit
    ? `The offset is at the end of the search: @${song} can start later in @${edit}. Run again with a larger max_lag, or give the offset with the parameter offset.`
    : `The offset is at the end of the search, and ${APP} searches only the first half of the sound of @${edit}: @${song} can start later. If you know where the song starts, give it with the parameter offset.`
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(APP, parameters, PARAMETERS)
  const givenOffset = numberParameter(parameters, 'offset', () => true, 'a number of seconds, such as 0 or 1.5')
  const maxLag = numberParameter(parameters, 'max_lag', (value) => value >= 0, 'a number of seconds, 0 or more, such as 6') ?? 6
  const threshold = numberParameter(parameters, 'threshold', (value) => value > 0, 'a number more than 0, such as 0.35') ?? 0.35
  const givenTolerance = numberParameter(parameters, 'tolerance', (value) => value > 0, 'a number of seconds more than 0, such as 0.042')
  if (dez.inputs.length !== 2) {
    throw new RangeError(`${APP} needs exactly two inputs, and the run has ${dez.inputs.length}: first the edit (a video), then its song, as in "@a @b".`)
  }
  const [editInput, songInput] = dez.inputs
  const file = resultFile('sync', parameters, dez, `/work/sync-${editInput.id}-to-${songInput.id}.json`)

  if (editInput.kind !== 'video') throw new RangeError(`The first input, @${editInput.id}, must be the edit, a video. Give the edit first, then its song, as in "@a @b".`)
  if (editInput.frames === null) throw new RangeError(`@${editInput.id} has no picture, so it has no cut. The first input must be the edit, a video.`)
  const editFrames = decodedFrames(APP, editInput)
  if (songInput.kind === 'image') throw new RangeError(`The second input, @${songInput.id}, is an image: it must be the song, a clip with sound.`)
  if (songInput.audio === null) throw new RangeError(`The second input, @${songInput.id}, has no sound: it must be the song, a clip with sound.`)
  const songSound = decodedSound(APP, songInput)
  const song = f32Samples(await readFile(songSound.path))
  // The beat grid comes before the search for the song: a song long enough
  // for a beat grid (0.3 s or more at any rate) is long enough for align (10
  // ms), so a "too short" error of align is about the sound of the edit.
  const grid = namingInput(songInput.id, () => beatGrid(song, songSound.rate))

  let offset = givenOffset
  let confidence: number | null = null
  let searchEnd: string | null = null
  if (offset === undefined) {
    if (editInput.audio === null) {
      throw new RangeError(`@${editInput.id} has no sound, so ${APP} cannot find where the song starts in it. `
        + 'Give that time with the parameter offset, in seconds: 0 when the song starts with the edit.')
    }
    const editSound = decodedSound(APP, editInput)
    const edit = f32Samples(await readFile(editSound.path))
    const found = namingInput(editInput.id, () => align(song, edit, songSound.rate, { maxLag }))
    offset = found.offset
    confidence = found.confidence
    searchEnd = searchEndText(found.offset, maxLag, edit.length / editSound.rate / 2, editInput.id, songInput.id)
  }

  const { path, width, height, fps: editFps, count } = editFrames
  const fps = editFps ?? DEFAULT_FPS
  const tolerance = givenTolerance ?? 1 / fps
  const frameBytes = await readFile(path)
  const cutTimes = namingInput(editInput.id, () => cuts(rgbFrames(frameBytes, width, height), { fps, threshold })).cuts.map(({ time }) => time)
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
  if (searchEnd !== null) lines.push(searchEnd)
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
