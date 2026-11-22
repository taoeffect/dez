// @ts-check
// The audio measurements of dez-media: the beat grid of a song, the onsets
// of a sound, and the offset of one clip in another. Each one takes mono
// samples (such as the float32 output of ffmpeg `-ac 1 -f f32le`, read with
// f32Samples) and gives times in seconds.
//
// They port the Python of a music video that a model made by hand
// (beats.py, sfx_anchor, sync_check.py), and give the same results as that
// code with NumPy: tests/dez-media/ checks it. The changes from that code
// are marked in tests/dez-media/numpyOracle.py.

import { argmax, convolve, mean, stft, std } from './dsp.js'

/** @typedef {ArrayLike<number>} Samples */
/** @typedef {{ frames: number, bins: number, magnitude: ArrayLike<number> }} Spectrogram */

/** The sample rate that beatGrid is tuned for, in Hz. */
export const BEAT_RATE = 22050
/** The sample rate of align, in Hz: the envelope needs no more. */
export const ALIGN_RATE = 8000
/** The sample rate of onsets, in Hz. */
export const ANCHOR_RATE = 8000

const BEAT_NFFT = 2048
const BEAT_HOP = 256
// The kick drum is under this frequency: its strength finds the downbeat.
const KICK_HZ = 150
const LOUDNESS_STEP = 0.5
const ACCENT_STRENGTH = 3
const MAX_ACCENTS = 60

/**
 * The spectral flux of each frame of a spectrogram (frame 0 gets 0): the
 * sum of the rises of log(1 + 100·magnitude) over bins lo to hi − 1, less
 * its moving mean over 16 frames, no lower than 0, and divided by its
 * standard deviation. A peak is a note or a hit that starts.
 * @param {Spectrogram} spectrogram  as stft gives it
 * @param {number} [lo]  the first bin
 * @param {number} [hi]  the bin after the last
 */
export function onsetEnvelope({ frames, bins, magnitude }, lo = 0, hi = bins) {
  const first = Math.max(0, lo)
  const end = Math.min(bins, hi)
  const flux = new Float64Array(frames)
  const before = new Float64Array(Math.max(0, end - first))
  for (let f = 0; f < frames; f++) {
    const row = f * bins
    let sum = 0
    for (let b = first; b < end; b++) {
      const level = Math.log1p(100 * magnitude[row + b])
      if (f > 0) sum += Math.max(0, level - before[b - first])
      before[b - first] = level
    }
    flux[f] = sum
  }
  const local = convolve(flux, new Float64Array(16).fill(1 / 16), 'same')
  for (let f = 0; f < frames; f++) flux[f] = Math.max(0, flux[f] - local[f])
  const scale = std(flux) + 1e-9
  for (let f = 0; f < frames; f++) flux[f] /= scale
  return flux
}

/**
 * The tempo of an onset envelope: the lag of its autocorrelation with the
 * best score from 70 to 190 BPM, where a lag near 120 BPM weighs more, then
 * refined between frames with a parabola.
 *
 * Throws a RangeError when the envelope is too short or has no beat.
 * @param {ArrayLike<number>} env  an onset envelope
 * @param {number} fps  frames per second of the envelope
 * @returns {{ bpm: number, period: number }}  period: the beat length in frames
 */
export function tempo(env, fps) {
  const n = env.length
  /** @param {number} lag */
  const bpmOf = (lag) => (60 * fps) / Math.max(lag, 1)
  /** @param {number} lag */
  const valid = (lag) => bpmOf(lag) > 70 && bpmOf(lag) < 190
  // Only the lags of 70 to 190 BPM can win, so only they get the
  // autocorrelation: each other lag has a score of 0.
  /** @param {number} lag */
  const score = (lag) => {
    if (lag < 0 || lag >= n || !valid(lag)) return 0
    let sum = 0
    for (let i = lag; i < n; i++) sum += env[i] * env[i - lag]
    const weight = Math.exp(-0.5 * (Math.log2(bpmOf(lag) / 120) / 0.9) ** 2)
    return sum * weight
  }
  let lag = -1
  let best = 0
  for (let l = 1; l < n; l++) {
    if (!valid(l)) continue
    const s = score(l)
    if (s > best) {
      best = s
      lag = l
    }
  }
  if (lag < 0) throw new RangeError('tempo: no beat from 70 to 190 BPM. Is the clip music with a beat, and longer than a second?')
  if (lag + 1 >= n) throw new RangeError('tempo: the envelope is too short for its tempo. Measure a longer part of the song.')
  const a = score(lag - 1)
  const c = score(lag + 1)
  const offset = (0.5 * (a - c)) / (a - 2 * best + c + 1e-9)
  return { bpm: (60 * fps) / (lag + offset), period: lag + offset }
}

/**
 * The beats of an onset envelope, by dynamic programming: each frame's
 * best chain of earlier beats, where a gap far from the period costs
 * `tightness`·log(gap / period)². The chain ends at the best frame of the
 * last period.
 * @param {ArrayLike<number>} env  an onset envelope
 * @param {number} period  the beat length in frames, as tempo gives it
 * @param {number} [tightness]
 * @returns {number[]}  the frame of each beat
 */
export function trackBeats(env, period, tightness = 100) {
  if (!(period > 0)) throw new RangeError(`trackBeats: the period must be more than 0 frames, not ${period}.`)
  const n = env.length
  if (n === 0) return []
  const score = Float64Array.from(env)
  const back = new Int32Array(n).fill(-1)
  // The cost of a gap depends only on the gap, so each one is computed
  // once. Math.trunc is Python's int().
  const longest = Math.ceil(2 * period) + 2
  const cost = new Float64Array(longest + 1)
  for (let gap = 1; gap <= longest; gap++) cost[gap] = -tightness * Math.log(gap / period) ** 2
  for (let i = 0; i < n; i++) {
    const hi = Math.trunc(i - period / 2)
    if (hi <= 0) continue
    const lo = Math.max(Math.trunc(i - 2 * period), 0)
    let bestPrev = lo
    let best = score[lo] + cost[i - lo]
    for (let prev = lo + 1; prev < hi; prev++) {
      const candidate = score[prev] + cost[i - prev]
      if (candidate > best) {
        best = candidate
        bestPrev = prev
      }
    }
    score[i] = env[i] + best
    back[i] = bestPrev
  }
  const tail = Math.min(Math.max(Math.trunc(n - period), 0), n - 1)
  let i = tail + argmax(score.subarray(tail))
  const beats = []
  while (i >= 0) {
    beats.push(i)
    i = back[i]
  }
  return beats.reverse()
}

/**
 * The beat grid of a song.
 *
 * - `bpm`, and `beats`: the time of each beat.
 * - `downbeatPhase` (0 to 3): the beat of each bar where the kick drum
 *   (under 150 Hz) is strongest, if the song has 4 beats in a bar.
 *   `downbeats` holds the times of those beats.
 * - `loudness`: the RMS level in dBFS of each whole 0.5 s, from 0 s.
 * - `accents`: up to 60 strong hits (the strongest), in time order.
 *
 * Throws a RangeError when the song is too short or has no beat.
 * @param {Samples} samples  mono, at `rate` (BEAT_RATE is the rate that it
 *   is tuned for)
 * @param {number} [rate]  in Hz
 */
export function beatGrid(samples, rate = BEAT_RATE) {
  const fps = rate / BEAT_HOP
  const spectrogram = stft(samples, { nfft: BEAT_NFFT, hop: BEAT_HOP })
  if (spectrogram.frames < 2) throw new RangeError(`beatGrid: the song is too short. It needs at least ${(BEAT_NFFT + BEAT_HOP) / rate} s.`)
  const env = onsetEnvelope(spectrogram)
  const low = onsetEnvelope(spectrogram, 0, Math.trunc(KICK_HZ / (rate / BEAT_NFFT)))
  const { bpm, period } = tempo(env, fps)
  const beats = trackBeats(env, period)
  const strengths = [0, 1, 2, 3].map((phase) => mean(beats.filter((_, k) => k % 4 === phase).map((frame) => low[frame])))
  const downbeatPhase = argmax(strengths)
  /** @param {number} frame */
  const time = (frame) => (frame * BEAT_HOP) / rate
  const accents = []
  for (let i = 2; i < env.length - 2; i++) {
    const value = env[i]
    if (value > ACCENT_STRENGTH && value >= env[i - 2] && value >= env[i - 1] && value >= env[i + 1] && value >= env[i + 2]) accents.push(i)
  }
  // Array sort keeps the time order of equal strengths.
  const strongest = accents.sort((a, b) => env[b] - env[a]).slice(0, MAX_ACCENTS).sort((a, b) => a - b)
  return {
    duration: samples.length / rate,
    bpm,
    beats: beats.map(time),
    downbeatPhase,
    downbeats: beats.filter((_, k) => k % 4 === downbeatPhase).map(time),
    loudness: loudness(samples, Math.trunc(rate * LOUDNESS_STEP)),
    accents: strongest.map(time),
  }
}

/**
 * The RMS level in dBFS of each whole part of `size` samples.
 * @param {Samples} samples
 * @param {number} size
 */
function loudness(samples, size) {
  const levels = []
  for (let start = 0; start + size <= samples.length; start += size) {
    levels.push(20 * Math.log10(Math.sqrt(meanSquare(samples, start, size)) + 1e-9))
  }
  return levels
}

/**
 * The mean of the squares of `count` samples from `start`.
 * @param {Samples} samples
 * @param {number} start
 * @param {number} count
 */
function meanSquare(samples, start, count) {
  let sum = 0
  for (let i = start; i < start + count; i++) sum += samples[i] * samples[i]
  return sum / count
}

/**
 * The RMS level of each whole frame of `size` samples.
 * @param {Samples} samples
 * @param {number} size
 */
function frameLevels(samples, size) {
  const levels = new Float64Array(Math.floor(samples.length / size))
  for (let f = 0; f < levels.length; f++) levels[f] = Math.sqrt(meanSquare(samples, f * size, size))
  return levels
}

/**
 * The onsets of a sound, from its RMS level in frames of 10 ms
 * (rate / 100 samples, rounded).
 *
 * - `onsets`: the start time of each frame whose level goes over `level`
 *   times the level of the loudest frame, after the level fell to half of
 *   that. 0.3 by default.
 * - `first`: the first onset, where the sound starts (the anchor to put on
 *   a hit).
 * - `peak`: the start time of the loudest frame.
 *
 * A clip with no sound has no onset: `first` and `peak` are null.
 * @param {Samples} samples  mono, at `rate` (ANCHOR_RATE is enough)
 * @param {number} [rate]  in Hz
 * @param {{ level?: number }} [options]
 */
export function onsets(samples, rate = ANCHOR_RATE, { level = 0.3 } = {}) {
  if (!(level > 0 && level < 1)) throw new RangeError(`onsets: the level must be more than 0 and less than 1, not ${level}.`)
  const size = Math.max(1, Math.round(rate / 100))
  const levels = frameLevels(samples, size)
  /** @param {number} frame */
  const time = (frame) => (frame * size) / rate
  const loudest = levels.length > 0 ? argmax(levels) : -1
  if (loudest < 0 || !(levels[loudest] > 0)) return { first: null, peak: null, onsets: [] }
  const threshold = level * levels[loudest]
  /** @type {number[]} */
  const times = []
  let armed = true
  for (let f = 0; f < levels.length; f++) {
    if (armed && levels[f] > threshold) {
      times.push(time(f))
      armed = false
    } else if (!armed && levels[f] <= threshold / 2) {
      armed = true
    }
  }
  return { first: times[0], peak: time(loudest), onsets: times }
}

/**
 * The rises of the log level of a clip, every 5 ms from the sample
 * `start`: what align matches.
 * @param {Samples} samples
 * @param {number} hop  samples in 5 ms
 * @param {number} [start]
 */
function riseEnvelope(samples, hop, start = 0) {
  // The 1e-12 of the reference code: a frame of silence gets the log of
  // 1e-4 + 1e-6, not of 1e-4.
  const logLevels = new Float64Array(Math.max(0, Math.floor((samples.length - start) / hop)))
  for (let f = 0; f < logLevels.length; f++) logLevels[f] = Math.log(Math.sqrt(meanSquare(samples, start + f * hop, hop) + 1e-12) + 1e-4)
  const rises = new Float64Array(Math.max(0, logLevels.length - 1))
  for (let i = 0; i < rises.length; i++) rises[i] = Math.max(0, logLevels[i + 1] - logLevels[i])
  const average = mean(rises)
  for (let i = 0; i < rises.length; i++) rises[i] -= average
  return rises
}

/**
 * The lag of `withinRises` (0 to `maxLags` frames) where `clipRises`
 * matches best, as sync_check.py finds it, and the normalized correlation
 * there.
 * @param {Float64Array} clipRises
 * @param {Float64Array} withinRises
 * @param {number} maxLags
 */
function bestLag(clipRises, withinRises, maxLags) {
  const lags = Math.min(maxLags, Math.floor(withinRises.length / 2))
  const used = Math.min(clipRises.length, withinRises.length - lags)
  const pattern = clipRises.subarray(0, used)
  let best = 0
  let top = -Infinity
  for (let lag = 0; lag <= lags; lag++) {
    let sum = 0
    for (let i = 0; i < used; i++) sum += withinRises[lag + i] * pattern[i]
    if (sum > top) {
      top = sum
      best = lag
    }
  }
  let patternEnergy = 0
  let segmentEnergy = 0
  for (let i = 0; i < used; i++) {
    patternEnergy += pattern[i] * pattern[i]
    segmentEnergy += withinRises[best + i] ** 2
  }
  return { lag: best, confidence: top / (Math.sqrt(patternEnergy * segmentEnergy) + 1e-12) }
}

/**
 * Where `clip` starts in `within` (such as a song in the sound of a video
 * edit): the offset in seconds, from 0 to about `maxLag` (6 s by
 * default), where the rises of their levels match best.
 *
 * `within` is searched up to half its length at most, and the clip is cut
 * to fit it at each offset. `confidence` is the normalized correlation at
 * the offset, from −1 to 1: about 1 for the same sound, under 0.3 for
 * sounds that do not match.
 *
 * The levels are of 5 ms frames. A sound that starts between two frames
 * gets other levels than the same sound on a frame: half a frame off can
 * take the confidence of a match from 0.9 to under 0.3. So the search
 * tries the frames of `within` from `phases` starts in the first frame (4
 * by default: every 1.25 ms), and keeps the start with the highest
 * confidence. `phases: 1` is the search of sync_check.py.
 * @param {Samples} clip  mono, at `rate`
 * @param {Samples} within  mono, at `rate`
 * @param {number} [rate]  in Hz (ALIGN_RATE is enough)
 * @param {{ maxLag?: number, phases?: number }} [options]
 */
export function align(clip, within, rate = ALIGN_RATE, { maxLag = 6, phases = 4 } = {}) {
  if (!(maxLag >= 0)) throw new RangeError(`align: maxLag must be 0 s or more, not ${maxLag}.`)
  if (!(Number.isInteger(phases) && phases >= 1)) throw new RangeError(`align: phases must be a whole number from 1 up, such as 4, not ${phases}.`)
  const hop = Math.max(1, Math.round(rate * 0.005))
  const clipRises = riseEnvelope(clip, hop)
  const firstRises = riseEnvelope(within, hop)
  if (clipRises.length === 0 || firstRises.length === 0) throw new RangeError('align: a clip is too short. Each needs at least 10 ms of sound.')
  const maxLags = Math.round((maxLag * rate) / hop)
  const first = bestLag(clipRises, firstRises, maxLags)
  let found = { offset: (first.lag * hop) / rate, confidence: first.confidence }
  let lastStart = 0
  for (let phase = 1; phase < phases; phase++) {
    const start = Math.round((phase * hop) / phases)
    // A hop of fewer samples than phases has fewer starts.
    if (start === lastStart) continue
    lastStart = start
    const withinRises = riseEnvelope(within, hop, start)
    if (withinRises.length === 0) continue
    const { lag, confidence } = bestLag(clipRises, withinRises, maxLags)
    if (confidence > found.confidence) found = { offset: (lag * hop + start) / rate, confidence }
  }
  return found
}
