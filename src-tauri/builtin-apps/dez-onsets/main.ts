// dez-onsets: where the sound of each input clip starts, its loudest
// moment, and each hit, from onsets of dez-media. Use it to put a sound
// effect on a beat or a cut: its `first` onset is the time to line up.
//
// Inputs: one or more clips with sound. Dez decodes the sound of each to
// one channel at 8000 samples a second (the "decode" of manifest.json).
//
// Parameters:
// - level (more than 0 and less than 1, 0.3 by default): a hit starts
//   where the level of a 10 ms frame goes over this part of the level of
//   the loudest frame, after the level fell to half of that.
// - save_to: the result file, a path in /work/; only for a run with one
//   input. By default each input gets /work/onsets-<id>.json.
//
// Each result file is a JSON object with the fields:
// - id: the id of the clip.
// - duration: the length of the sound in seconds.
// - level: the level of the run.
// - first: the first onset, where the sound starts.
// - peak: the start of the loudest 10 ms frame.
// - onsets: the time of each hit.
// Times are in seconds from the start of the clip, to the millisecond. A
// clip with no sound has no onset: first and peak are null.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkParameterNames, decodedSound, f32Samples, numberParameter, onsets, resultFiles, resultJson, roundTo } from 'dez-media'

const APP = 'dez-onsets'
const PARAMETERS = ['level', 'save_to']

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

const seconds = (time: number) => `${time.toFixed(3)} s`
const rounded = (time: number | null) => time === null ? null : roundTo(time, 3)

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(APP, parameters, PARAMETERS)
  const level = numberParameter(parameters, 'level', (value) => value > 0 && value < 1, 'a number more than 0 and less than 1, such as 0.3') ?? 0.3
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more clips with sound: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles('onsets', parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const { path, rate } = decodedSound(APP, input)
    const samples = f32Samples(await readFile(path))
    const found = onsets(samples, rate, { level })
    results.push({
      id: input.id,
      duration: roundTo(samples.length / rate, 3),
      level,
      first: rounded(found.first),
      peak: rounded(found.peak),
      onsets: found.onsets.map((time) => roundTo(time, 3)),
    })
  }

  const lines = []
  for (const [index, result] of results.entries()) {
    const file = files[index]
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, resultJson(result))
    const facts = result.first === null || result.peak === null
      ? 'no sound, so no onset'
      : `the sound starts at ${seconds(result.first)}, the loudest moment is at ${seconds(result.peak)}, ${result.onsets.length} ${result.onsets.length === 1 ? 'onset' : 'onsets'}`
    lines.push(`@${result.id} (${seconds(result.duration)}): ${facts}. In ${file.shown}.`)
  }
  lines.push('Each file holds id, duration, level, first (where the sound starts), peak, and onsets. Times are in seconds.')
  return lines.join('\n')
}
