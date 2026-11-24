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
import { beatGrid, checkParameterNames, decodedSound, f32Samples, namingInput, resultFiles, resultJson, roundTo } from 'dez-media'

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

const seconds = (time: number) => `${time.toFixed(3)} s`

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  checkParameterNames(APP, parameters, PARAMETERS)
  if (dez.inputs.length === 0) throw new RangeError(`${APP} needs one or more clips with sound: give their ids in \`inputs\`, as in "@a".`)
  const files = resultFiles('beats', parameters, dez)
  const results = []
  for (const input of dez.inputs) {
    const { path, rate } = decodedSound(APP, input)
    const samples = f32Samples(await readFile(path))
    const grid = namingInput(input.id, () => beatGrid(samples, rate))
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
