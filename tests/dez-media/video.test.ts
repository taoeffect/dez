import { describe, expect, it } from 'vitest'
import { f32Samples, rgbFrames } from '../../src-tauri/libs/dez-media/decoded.js'
import { cuts, syncCheck } from '../../src-tauri/libs/dez-media/video.js'
import { closeValues, CUT_HEIGHT, CUT_WIDTH, cutFrames, inputHash, oracle } from './testing'

describe('dez-media cuts against cuts.py with NumPy', () => {
  const bytes = cutFrames()
  const frames = rgbFrames(bytes, CUT_WIDTH, CUT_HEIGHT)

  it('gets the same frames as numpyOracle.py', () => {
    expect(inputHash(bytes)).toBe(oracle.inputs.cutFrames)
    expect(frames.count).toBe(48)
  })

  it('gives the scores and the cuts of cuts.py: the two scene changes, and the bright frame', () => {
    const found = cuts(frames, { fps: 24 })
    expect(closeValues(found.scores, oracle.cuts.scores, 0, 1e-7)).toBeNull()
    expect(found.cuts.map(({ frame }) => frame)).toEqual(oracle.cuts.cuts)
    expect(found.cuts.map(({ frame }) => frame)).toEqual([20, 27, 28, 34])
    for (const cut of found.cuts) expect(cut.score).toBe(found.scores[cut.frame - 1])
  })

  // cuts.py took each clip for 24 fps.
  it('times each cut by the frame rate of the clip', () => {
    expect(cuts(frames, { fps: 30 }).cuts.map(({ time }) => time)).toEqual([20 / 30, 27 / 30, 28 / 30, 34 / 30])
  })

  it('takes the threshold of the caller', () => {
    expect(cuts(frames, { fps: 24, threshold: 2 }).cuts.map(({ frame }) => frame)).toEqual([27, 28, 34])
  })

  it('refuses frames with no frame rate, or too small for its grid', () => {
    expect(() => cuts(frames, { fps: 0 })).toThrow(/fps/)
    expect(() => cuts(rgbFrames(new Uint8Array(2 * 2 * 3), 2, 2), { fps: 24 })).toThrow(RangeError)
  })
})

describe('dez-media syncCheck against sync_check.py with NumPy', () => {
  const { beats, delay, cuts: cutTimes, errors } = oracle.sync

  it('gives the error of each cut against its nearest beat, after the offset of the song', () => {
    const checked = syncCheck(cutTimes, beats, { offset: delay })
    expect(checked.cuts.map(({ time }) => time)).toEqual(errors.map(({ time }) => time))
    expect(closeValues(checked.cuts.map(({ error }) => error * 1000), errors.map(({ errorMs }) => errorMs), 1e-9, 1e-9)).toBeNull()
    expect(checked.cuts.map(({ offBeat }) => offBeat)).toEqual([true, true, false, false, false, true, true])
    const absolute = errors.map(({ errorMs }) => Math.abs(errorMs) / 1000)
    expect(checked.maxError).toBeCloseTo(Math.max(...absolute), 12)
    expect(checked.meanError).toBeCloseTo(absolute.reduce((a, b) => a + b) / absolute.length, 12)
  })

  it('has no error with no cut after the song starts', () => {
    expect(syncCheck([0.5], [1, 2], { offset: 3 })).toEqual({ cuts: [], meanError: null, maxError: null })
  })
})

describe('dez-media readers of decoded inputs', () => {
  it('reads f32le samples in place, or from a copy when they do not start at a multiple of 4 bytes', () => {
    const values = Float32Array.of(0.25, -1, 3.5)
    const bytes = new Uint8Array(values.buffer)
    expect(f32Samples(bytes).buffer).toBe(values.buffer)
    const shifted = new Uint8Array(13)
    shifted.set(bytes, 1)
    expect(Array.from(f32Samples(shifted.subarray(1)))).toEqual([0.25, -1, 3.5])
    expect(() => f32Samples(new Uint8Array(6))).toThrow(/f32le/)
  })

  it('copies the samples of a Node Buffer that does not start at a multiple of 4 bytes', () => {
    // Buffer's own slice gives a view of the whole memory, not a copy.
    const bytes = new Uint8Array(Float32Array.of(0.25, -1, 3.5).buffer)
    for (const size of [14, 16]) {
      const buffer = Buffer.alloc(size)
      buffer.set(bytes, 2)
      expect(Array.from(f32Samples(buffer.subarray(2, 14)))).toEqual([0.25, -1, 3.5])
    }
  })

  it('refuses RGB bytes that are not whole frames of the size', () => {
    expect(rgbFrames(new Uint8Array(4 * 3 * 3 * 2), 4, 3).count).toBe(2)
    expect(() => rgbFrames(new Uint8Array(4 * 3 * 3 + 1), 4, 3)).toThrow(/rgb24/)
  })
})
