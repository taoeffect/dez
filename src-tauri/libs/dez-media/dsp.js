// @ts-check
// Signal functions with the names and the results of NumPy, for the
// measurements of dez-media and for the code of a run. Each one gives what
// its NumPy function gives (np.hanning, np.fft.rfft, np.convolve, …), with
// these known differences: the math is in float64 (NumPy keeps float32
// values in float32), and a NumPy error is a RangeError.
//
// The details that a port from NumPy easily gets wrong, which these keep:
// np.hanning is symmetric (it divides by m − 1); the `same` mode of
// convolve and correlate starts at (min(n, m) − 1) / 2, rounded down; std
// divides by n; argmax and argmin give the first of equal values.

import FFTModule from '../fft.js/lib/fft.esm.js'

/** @typedef {ArrayLike<number>} Values */
/** @typedef {'full' | 'same' | 'valid'} Mode */
/**
 * The parts of an FFT plan of fft.js that this module uses.
 * @typedef {{ realTransform(out: Float64Array, data: Float64Array): void }} FftPlan
 */

// fft.js is a CommonJS file in an ES module wrapper, so its export has no
// type of its own.
const FFT = /** @type {new (size: number) => FftPlan} */ (/** @type {unknown} */ (FFTModule))

/** @type {Map<number, FftPlan>} */
const plans = new Map()

/**
 * The FFT plan of size `n` (a power of two of at least 2), made once.
 * @param {number} n
 */
function fftPlan(n) {
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 30 || (n & (n - 1)) !== 0) {
    throw new RangeError(`rfft: the size must be a power of two from 2 up, such as 2048, not ${n}. Pad the values with zeros: rfft(x, n).`)
  }
  let plan = plans.get(n)
  if (!plan) {
    plan = new FFT(n)
    plans.set(n, plan)
  }
  return plan
}

/**
 * np.hanning(m): the symmetric Hann window, 0.5 − 0.5·cos(2πk / (m − 1)).
 * m = 1 gives [1], and m < 1 gives no value.
 * @param {number} m
 */
export function hann(m) {
  if (m < 1) return new Float64Array(0)
  if (m === 1) return Float64Array.of(1)
  const window = new Float64Array(m)
  for (let k = 0; k < m; k++) window[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (m - 1))
  return window
}

/**
 * np.fft.rfft(x, n): the n / 2 + 1 bins of the FFT of real values, as their
 * real and imaginary parts. `n` (the length of x by default) must be a
 * power of two; x is cut to n values, or padded with zeros.
 * @param {Values} x
 * @param {number} [n]
 */
export function rfft(x, n = x.length) {
  const plan = fftPlan(n)
  const input = new Float64Array(n)
  const count = Math.min(n, x.length)
  for (let i = 0; i < count; i++) input[i] = x[i]
  const out = new Float64Array(2 * n)
  plan.realTransform(out, input)
  const bins = n / 2 + 1
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  for (let k = 0; k < bins; k++) {
    re[k] = out[2 * k]
    im[k] = out[2 * k + 1]
  }
  return { re, im }
}

/**
 * The magnitudes of the short-time Fourier transform of `y`, as the
 * reference code computed them with NumPy: a frame of `nfft` values every
 * `hop` values from the first value (no centering, and no padding: a last
 * part shorter than `nfft` is left out), times `window` (the symmetric Hann
 * window by default), then |rfft|.
 *
 * Gives `frames`, `bins` (nfft / 2 + 1), and `magnitude`, in which bin b of
 * frame f is `magnitude[f * bins + b]`. The magnitudes are float32, as
 * NumPy gives them for float32 samples, which halves the memory.
 * @param {Values} y
 * @param {{ nfft?: number, hop?: number, window?: Values }} [options]
 *   `nfft`: the frame length, a power of two (2048 by default); `hop`: the
 *   values from one frame to the next (256 by default); `window`: nfft
 *   values
 */
export function stft(y, { nfft = 2048, hop = 256, window = hann(nfft) } = {}) {
  const plan = fftPlan(nfft)
  if (!Number.isInteger(hop) || hop < 1) throw new RangeError(`stft: hop must be a whole number from 1 up, not ${hop}.`)
  if (window.length !== nfft) throw new RangeError(`stft: the window has ${window.length} values, and nfft is ${nfft}.`)
  const frames = y.length >= nfft ? 1 + Math.floor((y.length - nfft) / hop) : 0
  const bins = nfft / 2 + 1
  const magnitude = new Float32Array(frames * bins)
  const input = new Float64Array(nfft)
  const out = new Float64Array(2 * nfft)
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    for (let i = 0; i < nfft; i++) input[i] = y[start + i] * window[i]
    plan.realTransform(out, input)
    const row = f * bins
    for (let k = 0; k < bins; k++) {
      const re = out[2 * k]
      const im = out[2 * k + 1]
      magnitude[row + k] = Math.sqrt(re * re + im * im)
    }
  }
  return { frames, bins, magnitude }
}

/**
 * np.diff(x): each value minus the one before it (one value less than x).
 * @param {Values} x
 */
export function diff(x) {
  const out = new Float64Array(Math.max(0, x.length - 1))
  for (let i = 0; i < out.length; i++) out[i] = x[i + 1] - x[i]
  return out
}

/**
 * The part of the full result that a mode keeps, as NumPy: `full` all
 * n + m − 1 values; `same` max(n, m) values from (min(n, m) − 1) / 2,
 * rounded down; `valid` the max(n, m) − min(n, m) + 1 values where one
 * input covers the other.
 * @param {string} name
 * @param {number} n
 * @param {number} m
 * @param {Mode} mode
 */
function modeSpan(name, n, m, mode) {
  if (n === 0 || m === 0) throw new RangeError(`${name}: an input has no value.`)
  const short = Math.min(n, m)
  const long = Math.max(n, m)
  if (mode === 'full') return { start: 0, length: n + m - 1 }
  if (mode === 'same') return { start: Math.floor((short - 1) / 2), length: long }
  if (mode === 'valid') return { start: short - 1, length: long - short + 1 }
  throw new RangeError(`${name}: the mode must be 'full', 'same', or 'valid', not ${JSON.stringify(mode)}.`)
}

/**
 * np.convolve(a, v, mode): the discrete linear convolution. The mode is
 * `full` by default, as in NumPy.
 * @param {Values} a
 * @param {Values} v
 * @param {Mode} [mode]
 */
export function convolve(a, v, mode = 'full') {
  const n = a.length
  const m = v.length
  const { start, length } = modeSpan('convolve', n, m, mode)
  const out = new Float64Array(length)
  for (let o = 0; o < length; o++) {
    // Value j of the full result: the sum of a[i]·v[j − i].
    const j = start + o
    const last = Math.min(n - 1, j)
    let sum = 0
    for (let i = Math.max(0, j - m + 1); i <= last; i++) sum += a[i] * v[j - i]
    out[o] = sum
  }
  return out
}

/**
 * np.correlate(a, v, mode): the cross-correlation of real values, the sum
 * of a[i + k]·v[i] for each lag k. The mode is `valid` by default, as in
 * NumPy. In `full` mode, value j is the lag j − (m − 1).
 * @param {Values} a
 * @param {Values} v
 * @param {Mode} [mode]
 */
export function correlate(a, v, mode = 'valid') {
  const n = a.length
  const m = v.length
  const { start, length } = modeSpan('correlate', n, m, mode)
  const out = new Float64Array(length)
  for (let o = 0; o < length; o++) {
    const lag = start + o - (m - 1)
    const last = Math.min(m, n - lag)
    let sum = 0
    for (let i = Math.max(0, -lag); i < last; i++) sum += a[i + lag] * v[i]
    out[o] = sum
  }
  return out
}

/**
 * np.argmax(x): the index of the largest value, the first of equal values.
 * A NaN counts as the largest, as in NumPy.
 * @param {Values} x
 */
export function argmax(x) {
  if (x.length === 0) throw new RangeError('argmax: there is no value.')
  let best = 0
  let top = x[0]
  if (Number.isNaN(top)) return 0
  for (let i = 1; i < x.length; i++) {
    const value = x[i]
    if (Number.isNaN(value)) return i
    if (value > top) {
      top = value
      best = i
    }
  }
  return best
}

/**
 * np.argmin(x): the index of the smallest value, the first of equal values.
 * A NaN counts as the smallest, as in NumPy.
 * @param {Values} x
 */
export function argmin(x) {
  if (x.length === 0) throw new RangeError('argmin: there is no value.')
  let best = 0
  let bottom = x[0]
  if (Number.isNaN(bottom)) return 0
  for (let i = 1; i < x.length; i++) {
    const value = x[i]
    if (Number.isNaN(value)) return i
    if (value < bottom) {
      bottom = value
      best = i
    }
  }
  return best
}

/**
 * np.mean(x). NaN for no value.
 * @param {Values} x
 */
export function mean(x) {
  let sum = 0
  for (let i = 0; i < x.length; i++) sum += x[i]
  return sum / x.length
}

/**
 * np.std(x): the standard deviation, which divides by n (ddof = 0).
 * @param {Values} x
 */
export function std(x) {
  const average = mean(x)
  let sum = 0
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - average
    sum += d * d
  }
  return Math.sqrt(sum / x.length)
}

/**
 * np.median(x): the middle value, or the mean of the two middle values.
 * NaN for no value, or when a value is NaN.
 * @param {Values} x
 */
export function median(x) {
  const sorted = Float64Array.from(x)
  if (sorted.length === 0 || sorted.some(Number.isNaN)) return NaN
  sorted.sort()
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * np.histogram(x, bins, range): the count of values in each of `bins`
 * equal bins over `range` ([min, max] of x by default; a range of one value
 * v is [v − 0.5, v + 0.5]), and the bins + 1 edges. Each bin holds its left
 * edge, and the last bin also its right edge. A value outside the range is
 * not counted.
 * @param {Values} x
 * @param {number} [bins]
 * @param {[number, number]} [range]
 */
export function histogram(x, bins = 10, range) {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError(`histogram: bins must be a whole number from 1 up, not ${bins}.`)
  let first
  let last
  if (range) {
    ;[first, last] = range
    if (!(first <= last)) throw new RangeError(`histogram: the range must go from a smaller value to a larger one, not [${first}, ${last}].`)
  } else if (x.length === 0) {
    first = 0
    last = 1
  } else {
    first = Infinity
    last = -Infinity
    for (let i = 0; i < x.length; i++) {
      first = Math.min(first, x[i])
      last = Math.max(last, x[i])
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) throw new RangeError(`histogram: the range [${first}, ${last}] is not finite.`)
  if (first === last) {
    first -= 0.5
    last += 0.5
  }
  // As np.linspace: the last edge is `last` itself.
  const step = (last - first) / bins
  const edges = new Float64Array(bins + 1)
  for (let i = 0; i < bins; i++) edges[i] = i * step + first
  edges[bins] = last
  const counts = new Float64Array(bins)
  const width = last - first
  for (let i = 0; i < x.length; i++) {
    const value = x[i]
    if (!(value >= first && value <= last)) continue
    // As NumPy: the bin from the scaled value, then moved by one when
    // rounding put the value on the other side of an edge.
    let bin = Math.floor(((value - first) / width) * bins)
    if (bin === bins) bin -= 1
    if (value < edges[bin]) bin -= 1
    else if (bin !== bins - 1 && value >= edges[bin + 1]) bin += 1
    counts[bin] += 1
  }
  return { counts, edges }
}
