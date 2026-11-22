// dez-beats: the beat grid of each input clip (a song, or the sound of a
// video), from beatGrid of dez-media.
//
// Inputs: one or more clips with sound. Dez decodes the sound of each to
// one channel at 22050 samples a second (the "decode" of manifest.json),
// the rate that beatGrid is tuned for.
//
// Parameters:
// - save_to: the result file, a path in /work/; only for a run with one
//   input. By default each input gets /work/beats-<id>.json.
//
// Each result file is a JSON object with the fields:
// - id: the id of the clip.
// - duration: the length of the sound in seconds.
// - bpm: the tempo in beats a minute.
// - beats: the time of each beat.
// - downbeatPhase (0 to 3): the beat of each bar of 4 beats where the kick
//   drum is strongest; downbeats: the times of those beats.
// - loudnessStep: 0.5; loudness: the level in dBFS of each whole 0.5 s.
// - accents: up to 60 strong hits, in time order.
// Times are in seconds from the start of the clip, to the millisecond.
//
// The result text gives the main facts of each clip and the path of its
// file. The run writes the files only when every input has a beat grid.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { beatGrid, f32Samples, resultJson, roundTo, workFile } from 'dez-media'

const APP = 'dez-beats'
const PARAMETERS = ['save_to']
// The steps of `loudness` in beatGrid, in seconds.
const LOUDNESS_STEP = 0.5

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

// The result files of the run: `save_to` for one input, else
// /work/beats-<id>.json for each.
function resultFiles(parameters: Record<string, unknown>, dez: Dez) {
  const saveTo = parameters.save_to
  if (saveTo === undefined) return dez.inputs.map(({ id }) => workFile(dez.workFolder, `/work/beats-${id}.json`))
  if (typeof saveTo !== 'string') throw new RangeError(`save_to must be a path in /work/, as in "/work/beats.json", not ${JSON.stringify(saveTo)}.`)
  if (dez.inputs.length !== 1) throw new RangeError(`save_to names one file, and the run has ${dez.inputs.length} inputs. Leave it out: each input then gets /work/beats-<id>.json.`)
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

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(parameters)
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more clips with sound: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles(parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const { samples, rate } = await sound(input)
    let grid
    try {
      grid = beatGrid(samples, rate)
    } catch (error) {
      throw new RangeError(`@${input.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    results.push({
      id: input.id,
      duration: roundTo(grid.duration, 3),
      bpm: roundTo(grid.bpm, 2),
      beats: grid.beats.map((time) => roundTo(time, 3)),
      downbeatPhase: grid.downbeatPhase,
      downbeats: grid.downbeats.map((time) => roundTo(time, 3)),
      loudnessStep: LOUDNESS_STEP,
      loudness: grid.loudness.map((level) => roundTo(level, 1)),
      accents: grid.accents.map((time) => roundTo(time, 3)),
    })
  }

  const lines = []
  for (const [index, result] of results.entries()) {
    const file = files[index]
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, resultJson(result))
    const { beats, downbeats, loudness } = result
    const beatRange = beats.length > 0 ? ` from ${seconds(beats[0])} to ${seconds(beats[beats.length - 1])}` : ''
    const firstDownbeat = downbeats.length > 0 ? ` (the first at ${seconds(downbeats[0])})` : ''
    const levels = loudness.length > 0 ? `, loudness ${Math.min(...loudness)} to ${Math.max(...loudness)} dBFS` : ''
    lines.push(`@${result.id} (${seconds(result.duration)}): ${result.bpm} BPM, ${beats.length} beats${beatRange}, `
      + `${downbeats.length} downbeats${firstDownbeat}, ${result.accents.length} strong hits${levels}. In ${file.shown}.`)
  }
  lines.push('Each file holds id, duration, bpm, beats, downbeatPhase, downbeats, loudnessStep, loudness (dBFS), and accents. Times are in seconds.')
  return lines.join('\n')
}
