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
import { f32Samples, onsets, resultJson, roundTo, workFile } from 'dez-media'

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

// Throws for a parameter that this app does not take: with a misspelled
// name, the run would else go on with the default value.
function checkParameterNames(parameters: Record<string, unknown>): void {
  const unknown = Object.keys(parameters).filter((name) => !PARAMETERS.includes(name))
  if (unknown.length === 0) return
  const names = (list: readonly string[]) => list.map((name) => JSON.stringify(name)).join(', ')
  throw new RangeError(`${APP} does not take the parameter ${names(unknown)}. It takes only ${names(PARAMETERS)}.`)
}

// The `level` of the run.
function levelParameter(parameters: Record<string, unknown>): number {
  const { level } = parameters
  if (level === undefined) return 0.3
  if (typeof level !== 'number' || !(level > 0 && level < 1)) throw new RangeError(`level must be a number more than 0 and less than 1, such as 0.3, not ${JSON.stringify(level)}.`)
  return level
}

// The result files of the run: `save_to` for one input, else
// /work/onsets-<id>.json for each.
function resultFiles(parameters: Record<string, unknown>, dez: Dez) {
  const saveTo = parameters.save_to
  if (saveTo === undefined) return dez.inputs.map(({ id }) => workFile(dez.workFolder, `/work/onsets-${id}.json`))
  if (typeof saveTo !== 'string') throw new RangeError(`save_to must be a path in /work/, as in "/work/onsets.json", not ${JSON.stringify(saveTo)}.`)
  if (dez.inputs.length !== 1) throw new RangeError(`save_to names one file, and the run has ${dez.inputs.length} inputs. Leave it out: each input then gets /work/onsets-<id>.json.`)
  return [workFile(dez.workFolder, saveTo)]
}

// The samples of the decoded sound of `input`.
async function sound(input: Dez['inputs'][number]): Promise<{ samples: Float32Array, rate: number }> {
  if (input.kind === 'image') throw new RangeError(`@${input.id} is an image, and ${APP} takes only clips with sound.`)
  if (input.audio === undefined) {
    throw new RangeError(`The run has no decoded sound of @${input.id}: the \`decode\` of the call asked for none. Call ${APP} without \`decode\`.`)
  }
  if (input.audio === null) throw new RangeError(`@${input.id} has no sound, and ${APP} takes only clips with sound.`)
  return { samples: f32Samples(await readFile(input.audio.path)), rate: input.audio.rate }
}

const seconds = (time: number) => `${time.toFixed(3)} s`
const rounded = (time: number | null) => time === null ? null : roundTo(time, 3)

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(parameters)
  const level = levelParameter(parameters)
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more clips with sound: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles(parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const { samples, rate } = await sound(input)
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
