// dez-align: where one clip starts in another, such as a song in the sound
// of a video edit, from align of dez-media: the rises of the level of the
// two sounds are matched at each offset.
//
// Inputs: exactly two clips with sound: first the clip to find, then the
// clip to find it in. Dez decodes the sound of each to one channel at 8000
// samples a second (the "decode" of manifest.json).
//
// Parameters:
// - max_lag (seconds, 0 or more, 6 by default): the latest offset to
//   search. The search also stops at half of the length of the second
//   clip.
// - save_to: the result file, a path in /work/. By default
//   /work/align-<clip>-in-<within>.json, with the ids of the two clips.
//
// The result file is a JSON object with the fields:
// - clip, within: the ids of the two clips.
// - offset: where the first clip starts in the second, in seconds.
// - confidence (−1 to 1): how well the sounds match at the offset. About 1
//   for the same sound, 0.5 or more for a match, under 0.3 for sounds that
//   do not match.
// - maxLag: the latest offset that the run searched, in seconds.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { align, checkParameterNames, decodedSound, f32Samples, numberParameter, resultFile, resultJson, roundTo } from 'dez-media'

const APP = 'dez-align'
const PARAMETERS = ['max_lag', 'save_to']
// The confidence of a sure match, and the one under which the sounds do
// not match: align gives about 0.9 for the same sound and about 0.1 for
// noise.
const MATCH = 0.5
const NO_MATCH = 0.3

/** What a run gives the code (only the parts that this app reads). */
interface Dez {
  inputs: readonly {
    id: string
    kind: 'image' | 'audio' | 'video'
    /** The decoded sound: absent when the decode asks for none, null for
     *  a clip with no sound. */
    audio?: { path: string, rate: number, count: number } | null
  }[]
  workFolder: string
}

// What the confidence of a match tells, for the text.
function confidenceText(confidence: number, clip: string, within: string, maxLag: number): string {
  if (confidence >= MATCH) return 'a match'
  if (confidence >= NO_MATCH) return 'a weak match: listen to it, or check it with another measurement'
  return `no match: the sound of @${clip} is likely not in @${within} at an offset up to ${maxLag.toFixed(3)} s`
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(APP, parameters, PARAMETERS)
  const maxLag = numberParameter(parameters, 'max_lag', (value) => value >= 0, 'a number of seconds, 0 or more, such as 6') ?? 6
  if (dez.inputs.length !== 2) {
    throw new RangeError(`${APP} needs exactly two clips with sound, and the run has ${dez.inputs.length}: first the clip to find, then the clip to find it in, as in "@a @b".`)
  }
  const [clipInput, withinInput] = dez.inputs
  const file = resultFile('align', parameters, dez, `/work/align-${clipInput.id}-in-${withinInput.id}.json`)

  const clipSound = decodedSound(APP, clipInput)
  const withinSound = decodedSound(APP, withinInput)
  const clip = f32Samples(await readFile(clipSound.path))
  const within = f32Samples(await readFile(withinSound.path))
  const { offset, confidence } = align(clip, within, clipSound.rate, { maxLag })
  const halfWithin = within.length / withinSound.rate / 2
  const searched = Math.min(maxLag, halfWithin)
  const result = {
    clip: clipInput.id,
    within: withinInput.id,
    offset: roundTo(offset, 3),
    confidence: roundTo(confidence, 3),
    maxLag: roundTo(searched, 3),
  }
  await mkdir(dirname(file.path), { recursive: true })
  await writeFile(file.path, resultJson(result))

  // align steps by 5 ms, and its last step can be up to 2 steps short of
  // half of the second clip: an offset that near the end of the search is
  // at its end, and the clip can start later.
  const atEnd = searched - offset < 0.015
  const later = !atEnd ? '' : maxLag < halfWithin
    ? ` The offset is at the end of the search: @${clipInput.id} can start later. Run again with a larger max_lag.`
    : ` The offset is at the end of the search, and ${APP} searches only the first half of @${withinInput.id}: @${clipInput.id} can start later.`
  return `@${clipInput.id} starts at ${result.offset.toFixed(3)} s in @${withinInput.id}, with the confidence ${result.confidence} (${confidenceText(confidence, clipInput.id, withinInput.id, searched)}).${later} `
    + `In ${file.shown}: clip, within, offset (s), confidence, and maxLag (the latest offset searched, s).`
}
