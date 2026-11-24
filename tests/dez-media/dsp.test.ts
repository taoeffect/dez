import { describe, expect, it } from 'vitest'
import { argmax, argmin, convolve, correlate, diff, hann, histogram, mean, median, rfft, std, stft } from '../../src-tauri/libs/dez-media/dsp.js'
import { closeValues, oracle } from './testing'

const { primitives } = oracle

describe('dez-media DSP against NumPy', () => {
  it('hann is the symmetric window of np.hanning, for each length', () => {
    for (const [m, expected] of Object.entries(primitives.hann)) {
      expect(closeValues(hann(Number(m)), expected, 0, 1e-15), `hann(${m})`).toBeNull()
    }
  })

  it('rfft gives the bins of np.fft.rfft, with n that pads or cuts', () => {
    for (const { x, n, re, im } of primitives.rfft) {
      const out = n === null ? rfft(x) : rfft(x, n)
      expect(closeValues(out.re, re, 0, 1e-12), `rfft of ${x.length} values, n ${n}`).toBeNull()
      expect(closeValues(out.im, im, 0, 1e-12), `rfft of ${x.length} values, n ${n}`).toBeNull()
    }
  })

  it('rfft refuses a size that is not a power of two, and tells how to pad', () => {
    expect(() => rfft([1, 2, 3])).toThrow(/power of two.*rfft\(x, n\)/)
    expect(() => rfft([1, 2, 3], 6)).toThrow(RangeError)
  })

  it('diff is np.diff', () => {
    expect(closeValues(diff(primitives.diff.x), primitives.diff.out)).toBeNull()
    expect(diff([5])).toHaveLength(0)
  })

  it('convolve and correlate keep the values of each NumPy mode, for each order of the lengths', () => {
    for (const { a, v, mode, out } of primitives.convolve) {
      expect(closeValues(convolve(a, v, mode), out, 1e-12, 1e-15), `convolve ${a.length}×${v.length} ${mode}`).toBeNull()
    }
    for (const { a, v, mode, out } of primitives.correlate) {
      expect(closeValues(correlate(a, v, mode), out, 1e-12, 1e-15), `correlate ${a.length}×${v.length} ${mode}`).toBeNull()
    }
  })

  it('convolve and correlate default to the modes of NumPy (full, valid)', () => {
    expect(Array.from(convolve([1, 2, 3], [0, 1]))).toEqual([0, 1, 2, 3])
    expect(Array.from(correlate([1, 2, 3], [0, 1]))).toEqual([2, 3])
  })

  it('median is np.median, for odd and even lengths', () => {
    for (const { x, out } of primitives.median) expect(median(x)).toBeCloseTo(out, 15)
  })

  it('histogram counts as np.histogram: the last bin holds its right edge, values outside are left out', () => {
    for (const { x, bins, range, counts, edges } of primitives.histogram) {
      const out = range === null ? histogram(x, bins) : histogram(x, bins, range)
      expect(Array.from(out.counts), `histogram of ${x.length} values`).toEqual(counts)
      expect(closeValues(out.edges, edges, 1e-15), `edges of ${x.length} values`).toBeNull()
    }
  })

  it('mean and std are np.mean and np.std (which divides by n)', () => {
    const { x, mean: expectedMean, std: expectedStd } = primitives.mean
    expect(mean(x)).toBeCloseTo(expectedMean, 14)
    expect(std(x)).toBeCloseTo(expectedStd, 14)
    expect(std([1, 3])).toBe(1)
  })

  it('argmax and argmin give the first of equal values, and the first NaN, as NumPy', () => {
    expect(argmax([1, 3, 2, 3])).toBe(1)
    expect(argmin([2, 0, 1, 0])).toBe(1)
    expect(argmax([1, NaN, 5, NaN])).toBe(1)
    expect(argmin([1, 0, NaN])).toBe(2)
    expect(() => argmax([])).toThrow(RangeError)
  })

  it('median with a NaN is NaN, as in NumPy', () => {
    expect(median([1, NaN, 2])).toBeNaN()
    expect(median([])).toBeNaN()
  })

  it('stft has one frame for each whole hop, with no centering, and refuses a window of another length', () => {
    const { frames, bins, magnitude } = stft(new Float32Array(2048 + 3 * 256 + 100), { nfft: 2048, hop: 256 })
    expect([frames, bins, magnitude.length]).toEqual([4, 1025, 4 * 1025])
    expect(stft(new Float32Array(100)).frames).toBe(0)
    expect(() => stft(new Float32Array(4096), { nfft: 2048, window: hann(1024) })).toThrow(RangeError)
  })

  it('stft refuses an nfft that is not a power of two as stft, with no advice of rfft', () => {
    const badNfft = () => stft(new Float32Array(4096), { nfft: 1000 })
    expect(badNfft).toThrow(RangeError)
    expect(badNfft).toThrow(/^stft: nfft must be a power of two.* not 1000\.$/)
  })
})
