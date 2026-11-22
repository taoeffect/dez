import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import align from '../../src-tauri/builtin-apps/dez-align/main'
import beats from '../../src-tauri/builtin-apps/dez-beats/main'
import onsets from '../../src-tauri/builtin-apps/dez-onsets/main'
import { alignInputs, anchorInput, clickTrack, oracle } from '../dez-media/testing'
import { input, testRun, type TestRun } from './testing'

let run: TestRun
beforeEach(async () => {
  run = await testRun()
})
afterEach(async () => {
  await run.remove()
})

const BEAT_RATE = 22050
const BEAT_HOP = 256

describe('dez-beats', () => {
  it('writes the beat grid of a clip to /work/beats-<id>.json, with times to the millisecond, and tells its facts', async () => {
    const song = input('a', 'audio', { audio: await run.audio('a', clickTrack(), BEAT_RATE) })
    const text = await beats({}, run.dez([song]))

    const expected = oracle.beats
    const times = expected.beats.map((frame) => Math.round((frame * BEAT_HOP / BEAT_RATE) * 1000) / 1000)
    expect(await run.workJson('beats-a.json')).toMatchObject({
      id: 'a',
      duration: 20,
      bpm: Math.round(expected.bpm * 100) / 100,
      beats: times,
      downbeatPhase: expected.downbeatPhase,
      downbeats: times.filter((_, k) => k % 4 === expected.downbeatPhase),
      loudnessStep: 0.5,
    })
    expect(text.split('\n')[0]).toBe(`@a (20.000 s): 123.03 BPM, 41 beats from 0.000 s to ${times[40].toFixed(3)} s, 10 downbeats (the first at ${times[1].toFixed(3)} s), `
      + `${expected.accents.length} strong hits, loudness ${Math.min(...expected.loudness.map((level) => Math.round(level * 10) / 10))} to `
      + `${Math.max(...expected.loudness.map((level) => Math.round(level * 10) / 10))} dBFS. In /work/beats-a.json.`)
  })

  it('writes one file for each clip, or the save_to file for one clip', async () => {
    const sound = await run.audio('a', clickTrack(), BEAT_RATE)
    await beats({}, run.dez([input('a', 'audio', { audio: sound }), input('b', 'video', { audio: sound })]))
    await beats({ save_to: '/work/songs/main.json' }, run.dez([input('c', 'audio', { audio: sound })]))
    expect(await run.workFiles()).toStrictEqual(['beats-a.json', 'beats-b.json', 'songs', 'songs/main.json'])
    expect(await run.workJson('songs/main.json')).toMatchObject({ id: 'c' })
  })

  it('writes no file when a clip has no beat grid, and names that clip', async () => {
    const song = input('a', 'audio', { audio: await run.audio('a', clickTrack(), BEAT_RATE) })
    const short = input('b', 'audio', { audio: await run.audio('b', new Float32Array(100), BEAT_RATE) })
    await expect(beats({}, run.dez([song, short]))).rejects.toThrow(/^@b: beatGrid: the song is too short/)
    await expect(run.workFiles()).rejects.toThrow(/ENOENT/)
  })

  it('refuses a parameter that it does not take, save_to for more than one clip, and an input with no sound', async () => {
    const sound = await run.audio('a', clickTrack(), BEAT_RATE)
    const song = input('a', 'audio', { audio: sound })
    await expect(beats({ bpm: 120 }, run.dez([song]))).rejects.toThrow('dez-beats does not take the parameter "bpm". It takes only "save_to".')
    await expect(beats({ save_to: '/work/a.json' }, run.dez([song, input('b', 'audio', { audio: sound })]))).rejects.toThrow(/^save_to names one file/)
    await expect(beats({ save_to: '/apps/x/a.json' }, run.dez([song]))).rejects.toThrow(/is no file in \/work\//)
    await expect(beats({}, run.dez([input('b', 'image')]))).rejects.toThrow('@b is an image')
    await expect(beats({}, run.dez([input('b', 'video', { audio: null })]))).rejects.toThrow('@b has no sound')
    // A call whose own decode asked for no sound.
    await expect(beats({}, run.dez([input('b', 'audio')]))).rejects.toThrow('The run has no decoded sound of @b')
    await expect(beats({}, run.dez([]))).rejects.toThrow(/needs one or more clips/)
  })
})

describe('dez-onsets', () => {
  it('writes where the sound starts, its loudest moment, and each hit, and takes the level of the call', async () => {
    const hit = input('a', 'audio', { audio: await run.audio('a', anchorInput(), 8000) })
    const text = await onsets({}, run.dez([hit]))
    expect(await run.workJson('onsets-a.json')).toStrictEqual({ id: 'a', duration: 1.5, level: 0.3, first: 0.41, peak: 0.62, onsets: [0.41, 0.62, 1.1] })
    expect(text.split('\n')[0]).toBe('@a (1.500 s): the sound starts at 0.410 s, the loudest moment is at 0.620 s, 3 onsets. In /work/onsets-a.json.')

    // Over 0.8 of the loudest level, the swell and the soft hit are no
    // onsets.
    await onsets({ level: 0.8, save_to: '/work/loud.json' }, run.dez([hit]))
    expect(await run.workJson('loud.json')).toMatchObject({ level: 0.8, first: 0.62, onsets: [0.62] })
  })

  it('gives a silent clip no onset, with no error', async () => {
    const silence = input('a', 'audio', { audio: await run.audio('a', new Float32Array(8000), 8000) })
    const text = await onsets({}, run.dez([silence]))
    expect(await run.workJson('onsets-a.json')).toStrictEqual({ id: 'a', duration: 1, level: 0.3, first: null, peak: null, onsets: [] })
    expect(text.split('\n')[0]).toBe('@a (1.000 s): no sound, so no onset. In /work/onsets-a.json.')
  })

  it('refuses a level out of its range', async () => {
    const hit = input('a', 'audio', { audio: await run.audio('a', anchorInput(), 8000) })
    for (const level of [0, 1, -0.5, '0.3']) {
      await expect(onsets({ level }, run.dez([hit]))).rejects.toThrow(/^level must be a number more than 0 and less than 1/)
    }
  })
})

describe('dez-align', () => {
  it('finds where the first clip starts in the second, and tells a match', async () => {
    const { song, mix } = alignInputs()
    const inputs = [input('a', 'audio', { audio: await run.audio('a', song, 8000) }), input('b', 'video', { audio: await run.audio('b', mix, 8000) })]
    const text = await align({}, run.dez(inputs))
    expect(await run.workJson('align-a-in-b.json')).toStrictEqual({ clip: 'a', within: 'b', offset: 3.72, confidence: 0.976, maxLag: 6 })
    expect(text).toBe('@a starts at 3.720 s in @b, with the confidence 0.976 (a match). '
      + 'In /work/align-a-in-b.json: clip, within, offset (s), confidence, and maxLag (the latest offset searched, s).')
  })

  it('tells when the sounds do not match', async () => {
    const { song, noise } = alignInputs()
    const inputs = [input('a', 'audio', { audio: await run.audio('a', song, 8000) }), input('b', 'audio', { audio: await run.audio('b', noise, 8000) })]
    const text = await align({ save_to: '/work/noise.json' }, run.dez(inputs))
    expect(await run.workJson('noise.json')).toMatchObject({ confidence: 0.129 })
    expect(text).toContain('(no match: the sound of @a is likely not in @b at an offset up to 6.000 s)')
  })

  it('tells that the clip can start later when the offset is at the end of the search', async () => {
    const { song, mix } = alignInputs()
    const inputs = [input('a', 'audio', { audio: await run.audio('a', song, 8000) }), input('b', 'audio', { audio: await run.audio('b', mix, 8000) })]
    expect(await align({ max_lag: 0 }, run.dez(inputs))).toContain('The offset is at the end of the search: @a can start later. Run again with a larger max_lag.')
    // The mix is 12 s, and the search stops at its half.
    const later = await align({ max_lag: 20 }, run.dez(inputs))
    expect(later).toContain('@a starts at 3.720 s in @b')
    expect(later).not.toContain('end of the search')
    expect(await run.workJson('align-a-in-b.json')).toMatchObject({ maxLag: 6 })
  })

  it('refuses a run without exactly two clips, and a max_lag less than 0', async () => {
    const { song } = alignInputs()
    const clip = input('a', 'audio', { audio: await run.audio('a', song, 8000) })
    await expect(align({}, run.dez([clip]))).rejects.toThrow(/^dez-align needs exactly two clips with sound, and the run has 1/)
    await expect(align({ max_lag: -1 }, run.dez([clip, clip]))).rejects.toThrow(/^max_lag must be a number of seconds, 0 or more/)
  })
})
