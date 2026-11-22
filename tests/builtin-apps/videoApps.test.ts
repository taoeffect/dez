import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import cuts from '../../src-tauri/builtin-apps/dez-cuts/main'
import sync from '../../src-tauri/builtin-apps/dez-sync/main'
import { clickTrack, CUT_HEIGHT, CUT_WIDTH, cutFrames, oracle } from '../dez-media/testing'
import { input, shotFrames, testRun, type TestRun } from './testing'

let run: TestRun
beforeEach(async () => {
  run = await testRun()
})
afterEach(async () => {
  await run.remove()
})

const rounded = (value: number) => Math.round(value * 1000) / 1000

describe('dez-cuts', () => {
  it('writes the cuts of a video to /work/cuts-<id>.json, timed by its frame rate', async () => {
    const video = input('a', 'video', { frames: await run.frames('a', cutFrames(), CUT_WIDTH, CUT_HEIGHT, 30) })
    const text = await cuts({}, run.dez([video]))
    const expected = oracle.cuts.cuts.map((frame) => ({ frame, time: rounded(frame / 30), score: rounded(oracle.cuts.scores[frame - 1]) }))
    expect(await run.workJson('cuts-a.json')).toStrictEqual({ id: 'a', fps: 30, frames: 48, duration: 1.6, threshold: 0.35, cuts: expected })
    expect(text.split('\n')[0]).toBe('@a (48 frames, 1.600 s at 30 fps): 4 cuts, at 0.667, 0.900, 0.933, 1.133 s. In /work/cuts-a.json.')
  })

  it('takes 24 fps for a video whose frame rate Dez does not know, and tells it', async () => {
    const video = input('a', 'video', { frames: await run.frames('a', cutFrames(), CUT_WIDTH, CUT_HEIGHT, null) })
    const text = await cuts({ threshold: 2, save_to: '/work/strong.json' }, run.dez([video]))
    expect(await run.workJson('strong.json')).toMatchObject({ fps: 24, threshold: 2, cuts: [{ frame: 27 }, { frame: 28 }, { frame: 34 }] })
    expect(text.split('\n')[0]).toBe('@a (48 frames, 2.000 s at 24 fps): 3 cuts, at 1.125, 1.167, 1.417 s. In /work/strong.json. '
      + 'Dez does not know the frame rate of @a, so the times are for 24 fps.')
  })

  it('lists the first 20 cuts in the text, and keeps all in the file', async () => {
    const cutAt = Array.from({ length: 33 }, (_, k) => 6 * (k + 1))
    const video = input('a', 'video', { frames: await run.frames('a', shotFrames(204, cutAt), 16, 9, 24) })
    const text = await cuts({}, run.dez([video]))
    expect((await run.workJson('cuts-a.json') as { cuts: unknown[] }).cuts).toHaveLength(33)
    expect(text.split('\n')[0]).toMatch(/^@a \(204 frames, 8\.500 s at 24 fps\): 33 cuts, at 0\.250, 0\.500, (\d\.\d{3}, ){17}5\.000 s, and 13 more\. In \/work\/cuts-a\.json\.$/)
  })

  it('refuses an input that is no video, or has no picture', async () => {
    await expect(cuts({}, run.dez([input('a', 'audio')]))).rejects.toThrow('@a is no video (it is an audio clip)')
    await expect(cuts({}, run.dez([input('a', 'video', { frames: null })]))).rejects.toThrow('@a has no picture')
    await expect(cuts({ threshold: 0 }, run.dez([input('a', 'video', { frames: null })]))).rejects.toThrow(/^threshold must be a number more than 0/)
  })
})

describe('dez-sync', () => {
  const FPS = 24
  const OFFSET = 1
  const song = clickTrack()
  const songBeats = oracle.beats.beats.map((frame) => frame * 256 / 22050)
  // Cuts of the edit: one before the song starts, 5 on the beats of the
  // song, and one 0.2 s after a beat.
  const onBeat = [4, 8, 12, 16, 20].map((k) => Math.round((songBeats[k] + OFFSET) * FPS))
  const offBeat = Math.round((songBeats[24] + OFFSET + 0.2) * FPS)
  const cutAt = [12, ...onBeat, offBeat]
  const frameCount = 22 * FPS

  // The sound of the edit: the song from OFFSET, over soft noise.
  function editSound(): Float32Array {
    const sound = new Float32Array(22 * 22050)
    for (let i = 0; i < sound.length; i++) sound[i] = Math.sin(i * 12.9898) * 0.005
    sound.set(song.map((value, i) => value + sound[i + OFFSET * 22050]), OFFSET * 22050)
    return sound
  }

  async function edit(sound: Float32Array | null) {
    return input('a', 'video', {
      audio: sound === null ? null : await run.audio('a', sound, 22050),
      frames: await run.frames('a', shotFrames(frameCount, cutAt), 16, 9, FPS),
    })
  }

  it('finds the song in the sound of the edit, and tells each cut that is off the beat', async () => {
    const text = await sync({}, run.dez([await edit(editSound()), input('b', 'audio', { audio: await run.audio('b', song, 22050) })]))
    const result = await run.workJson('sync-a-to-b.json') as {
      offset: number, confidence: number, tolerance: number, cuts: { time: number, offBeat: boolean, error: number }[], meanError: number, maxError: number,
    }
    expect(result.offset).toBeCloseTo(OFFSET, 2)
    expect(result.confidence).toBeGreaterThan(0.5)
    expect(result).toMatchObject({ edit: 'a', song: 'b', bpm: 123.03, fps: FPS, tolerance: rounded(1 / FPS) })
    expect(result.cuts.map(({ time }) => time)).toStrictEqual([...onBeat, offBeat].map((frame) => rounded(frame / FPS)))
    expect(result.cuts.map((cut) => cut.offBeat)).toStrictEqual([false, false, false, false, false, true])
    expect(result.cuts[5].error).toBeCloseTo(0.2, 1)
    expect(result.maxError).toBe(Math.abs(result.cuts[5].error))

    const lines = text.split('\n')
    expect(lines[0]).toBe(`@b (123.03 BPM) starts at ${result.offset.toFixed(3)} s in @a (found with the confidence ${result.confidence}); @a has ${frameCount} frames at 24 fps.`)
    expect(lines[1]).toMatch(/^6 cuts \(1 cut before the song starts left out\): mean error \d+ ms, max error \d+ ms; 1 off the beat by more than 42 ms\.$/)
    expect(lines[2]).toBe(`Off the beat (cut time, and its error: + after the beat, - before it): ${(offBeat / FPS).toFixed(3)} s (+${Math.round(result.cuts[5].error * 1000)} ms).`)
  })

  it('takes the offset of the call, so the edit needs no sound', async () => {
    const songInput = input('b', 'audio', { audio: await run.audio('b', song, 22050) })
    const text = await sync({ offset: OFFSET, tolerance: 0.25, save_to: '/work/sync.json' }, run.dez([await edit(null), songInput]))
    expect(await run.workJson('sync.json')).toMatchObject({ offset: OFFSET, confidence: null, tolerance: 0.25 })
    expect(text).toContain('starts at 1.000 s in @a (given)')
    expect(text).toContain('none off the beat by more than 250 ms')

    await expect(sync({}, run.dez([await edit(null), songInput]))).rejects.toThrow('@a has no sound, so dez-sync cannot find where the song starts in it. Give that time with the parameter offset')
  })

  it('tells that the song can start later when the offset is at the end of the search', async () => {
    const songInput = input('b', 'audio', { audio: await run.audio('b', song, 22050) })
    expect(await sync({ max_lag: 0 }, run.dez([await edit(editSound()), songInput])))
      .toContain('The offset is at the end of the search: @b can start later in @a. Run again with a larger max_lag, or give the offset with the parameter offset.')
    // 30 ms of sound: the search stops at its half, before max_lag.
    expect(await sync({}, run.dez([await edit(editSound().subarray(0, 662)), songInput])))
      .toContain('The offset is at the end of the search, and dez-sync searches only the first half of the sound of @a: @b can start later.')
  })

  it('names the clip of a measurement that fails', async () => {
    const songInput = input('b', 'audio', { audio: await run.audio('b', song, 22050) })
    const shortSong = input('c', 'audio', { audio: await run.audio('c', new Float32Array(100), 22050) })
    await expect(sync({}, run.dez([await edit(editSound()), shortSong]))).rejects.toThrow(/^@c: beatGrid: the song is too short/)
    await expect(sync({}, run.dez([await edit(new Float32Array(100)), songInput]))).rejects.toThrow(/^@a: align: a clip is too short/)
    const tinyFrames = input('a', 'video', { audio: null, frames: await run.frames('a', new Uint8Array(2 * 2 * 3 * 4), 2, 2, FPS) })
    await expect(sync({ offset: 0 }, run.dez([tinyFrames, songInput]))).rejects.toThrow(/^@a: cuts: the frames must be at least 3×3 pixels/)
  })

  it('refuses the inputs in the wrong order', async () => {
    const songInput = input('b', 'audio', { audio: await run.audio('b', song, 22050) })
    await expect(sync({}, run.dez([songInput, await edit(editSound())]))).rejects.toThrow('The first input, @b, must be the edit, a video.')
    await expect(sync({}, run.dez([await edit(editSound())]))).rejects.toThrow(/^dez-sync needs exactly two inputs, and the run has 1/)
  })
})
