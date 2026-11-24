// The inputs of the dez-media tests, and the NumPy results for them
// (numpy.json, written by numpyOracle.py).
//
// The generators make the same bytes as those of numpyOracle.py: keep each
// step, its order, and its order of LCG calls the same as there. They use
// only steps that IEEE doubles give the same in Python and JavaScript, then
// round to float32 or uint8. inputHash lets a test check the bytes against
// the SHA-256 that numpy.json holds.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

type Oracle = {
  inputs: Record<'clickTrack' | 'cutFrames' | 'alignSong' | 'alignMix' | 'alignNoise' | 'anchors', string>
  primitives: {
    hann: Record<string, number[]>
    rfft: { x: number[]; n: number | null; re: number[]; im: number[] }[]
    diff: { x: number[]; out: number[] }
    convolve: { a: number[]; v: number[]; mode: 'full' | 'same' | 'valid'; out: number[] }[]
    correlate: { a: number[]; v: number[]; mode: 'full' | 'same' | 'valid'; out: number[] }[]
    median: { x: number[]; out: number }[]
    histogram: { x: number[]; bins: number; range: [number, number] | null; counts: number[]; edges: number[] }[]
    mean: { x: number[]; mean: number; std: number }
  }
  beats: {
    stftFrames: number[]
    stftBins: number[]
    stft: number[][]
    frames: number
    envelope: number[]
    lowEnvelope: number[]
    bpm: number
    period: number
    beats: number[]
    downbeatPhase: number
    loudness: number[]
    accents: number[]
  }
  cuts: { cuts: number[]; scores: number[] }
  align: Record<'mix' | 'shortMix' | 'noise', { offset: number; confidence: number }>
  sync: { beats: number[]; delay: number; cuts: number[]; errors: { time: number; errorMs: number }[] }
  anchors: { onset: number; peak: number; onsets: number[] }
}

export const oracle: Oracle = JSON.parse(readFileSync(new URL('./numpy.json', import.meta.url), 'utf8'))

/** The SHA-256 of the bytes of an input, as numpyOracle.py computes it. */
export function inputHash(input: Float32Array | Uint8Array): string {
  return createHash('sha256').update(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)).digest('hex')
}

/** The 32-bit linear congruential generator of Numerical Recipes. */
class Lcg {
  private x: number

  constructor(seed: number) {
    this.x = seed >>> 0
  }

  next(): number {
    this.x = (Math.imul(1664525, this.x) + 1013904223) >>> 0
    return this.x
  }

  uniform(): number {
    return this.next() / 4294967296
  }
}

/** A run of noise that dies away: `scale`·env·(a uniform value in [−1, 1)). */
function addBurst(y: number[], r: Lcg, start: number, length: number, scale: number, decay: number) {
  let env = 1
  for (let j = 0; j < length; j++) {
    y[start + j] += scale * env * ((r.uniform() - 0.5) * 2)
    env *= decay
  }
}

/**
 * 20 s at 22050 Hz: clicks at 123.05 BPM with a jitter of up to 9 ms, a
 * louder click with a low hum on every fourth beat from the second, and 6
 * loud clicks off the beat.
 */
export function clickTrack(): Float32Array {
  const n = 22050 * 20
  const r = new Lcg(1)
  const y = Array.from({ length: n }, () => (r.uniform() - 0.5) * 0.02)
  for (let k = 0; ; k++) {
    const pos = 1000 + k * 10752 + (r.next() % 401) - 200
    if (pos + 3000 > n) break
    addBurst(y, r, pos, 2000, k % 4 === 1 ? 0.9 : 0.5, 0.997)
    if (k % 4 === 1) {
      let env = 1
      for (let j = 0; j < 3000; j++) {
        y[pos + j] += 0.6 * env * (Math.abs(((j % 368) / 368) * 4 - 2) - 1)
        env *= 0.999
      }
    }
  }
  for (let i = 0; i < 6; i++) addBurst(y, r, 5000 + (r.next() % (n - 10000)), 1500, 0.7, 0.996)
  return Float32Array.from(y)
}

export const CUT_WIDTH = 96
export const CUT_HEIGHT = 54

/**
 * 48 RGB frames of 96×54: a scene with a moving square (frames 0–19), a cut
 * to a second scene with one bright frame (27), and a cut to a dark scene
 * (34–47).
 */
export function cutFrames(): Uint8Array {
  const count = 48
  const r = new Lcg(2)
  const out = new Uint8Array(CUT_WIDTH * CUT_HEIGHT * 3 * count)
  let o = 0
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < CUT_HEIGHT; y++) {
      for (let x = 0; x < CUT_WIDTH; x++) {
        let rgb: number[]
        if (t < 20) {
          rgb = [(x * 2 + t * 3) % 256, (y * 4) % 256, 80]
          if (y >= 20 && y < 32 && x >= 5 + 2 * t && x < 17 + 2 * t) rgb = [250, 250, 250]
        } else if (t < 34) {
          rgb = [200 - y * 2, (x + y + t) % 256, 30]
          if (t === 27) rgb = rgb.map((c) => Math.min(255, c + 120))
        } else {
          rgb = [20 + (x % 7), 15, 40 + (y % 5)]
        }
        for (const c of rgb) out[o++] = Math.min(255, Math.max(0, c + (r.next() % 9) - 4))
      }
    }
  }
  return out
}

/**
 * At 8000 Hz: a song of 6 s (clicks at uneven gaps), a mix of 12 s with
 * the song at 3.72 s under other noise and 3 bursts, and 12 s of noise.
 */
export function alignInputs(): { song: Float32Array; mix: Float32Array; noise: Float32Array } {
  const r = new Lcg(3)
  const songValues = Array.from({ length: 48000 }, () => (r.uniform() - 0.5) * 0.01)
  for (let pos = 800; pos + 400 < 48000; pos += 1500 + (r.next() % 3500)) {
    addBurst(songValues, r, pos, 400, 0.3 + r.uniform() * 0.5, 0.99)
  }
  const song = Float32Array.from(songValues)
  const mix = Array.from({ length: 96000 }, () => (r.uniform() - 0.5) * 0.02)
  for (let j = 0; j < 48000; j++) mix[29760 + j] += 0.7 * song[j]
  for (let i = 0; i < 3; i++) addBurst(mix, r, r.next() % 95000, 800, 0.6, 0.995)
  const noise = Array.from({ length: 96000 }, () => (r.uniform() - 0.5) * 0.3)
  return { song, mix: Float32Array.from(mix), noise: Float32Array.from(noise) }
}

/** 1.5 s at 8000 Hz: a swell from 0.3 s to 0.5 s, a hit at 0.62 s, and a softer hit at 1.1 s. */
export function anchorInput(): Float32Array {
  const r = new Lcg(4)
  const y = Array.from({ length: 12000 }, () => (r.uniform() - 0.5) * 0.002)
  for (let i = 2400; i < 4000; i++) y[i] += ((i - 2400) / 1600) * 0.4 * ((r.uniform() - 0.5) * 2)
  addBurst(y, r, 4960, 800, 0.9, 0.995)
  addBurst(y, r, 8800, 800, 0.5, 0.995)
  return Float32Array.from(y)
}

/**
 * Expects each value of `actual` to be within `relative`·|expected| +
 * `absolute` of the value of `expected`, and names the first index that is
 * not.
 */
export function closeValues(actual: ArrayLike<number>, expected: ArrayLike<number>, relative = 1e-9, absolute = 1e-12): string | null {
  if (actual.length !== expected.length) return `${actual.length} values, expected ${expected.length}`
  for (let i = 0; i < expected.length; i++) {
    if (!(Math.abs(actual[i] - expected[i]) <= relative * Math.abs(expected[i]) + absolute)) {
      return `value ${i} is ${actual[i]}, expected ${expected[i]}`
    }
  }
  return null
}
