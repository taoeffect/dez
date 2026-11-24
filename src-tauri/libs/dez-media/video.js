// @ts-check
// The video measurements of dez-media: the cuts of a clip, and the cuts of
// an edit against the beats of its song. Each one gives times in seconds.
//
// They port the Python of a music video that a model made by hand (cuts.py,
// sync_check.py), and give the same results as that code with NumPy:
// tests/dez-media/ checks it. The changes from that code are marked in
// tests/dez-media/numpyOracle.py.

import { argmin, median } from './dsp.js'

/** @typedef {{ width: number, height: number, count: number, data: Uint8Array }} RgbFrames */

const GRID = 3
const LEVELS = 8

/**
 * The colors of each cell of a 3×3 grid of a frame: for each cell and
 * each of R, G, B, the part of its pixels in each of 8 equal bins of the
 * value (0–31, 32–63, …).
 * @param {RgbFrames} frames
 * @param {number} index
 */
function gridColors({ width, height, data }, index) {
  const colors = new Float64Array(GRID * GRID * 3 * LEVELS)
  const start = index * width * height * 3
  for (let gy = 0; gy < GRID; gy++) {
    const top = Math.floor((gy * height) / GRID)
    const bottom = Math.floor(((gy + 1) * height) / GRID)
    for (let gx = 0; gx < GRID; gx++) {
      const left = Math.floor((gx * width) / GRID)
      const right = Math.floor(((gx + 1) * width) / GRID)
      const cell = (gy * GRID + gx) * 3 * LEVELS
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const pixel = start + (y * width + x) * 3
          for (let channel = 0; channel < 3; channel++) colors[cell + channel * LEVELS + (data[pixel + channel] >> 5)] += 1
        }
      }
      const pixels = (bottom - top) * (right - left)
      for (let i = cell; i < cell + 3 * LEVELS; i++) colors[i] /= pixels
    }
  }
  return colors
}

/**
 * The shot changes of a clip, from small RGB frames (such as 96×54 from
 * ffmpeg `-s 96x54 -pix_fmt rgb24 -f rawvideo`, read with rgbFrames).
 *
 * The score of each pair of frames is the change of the colors of a 3×3
 * grid (0 to 2) plus the mean change of the pixels (0 to 1). A pair is a
 * cut when its score is over `threshold` (0.35 by default) and over
 * 3 × the median of the 8 scores around it + 0.08: a fast pan or an AI
 * morph changes the score of many frames, a cut that of one.
 *
 * Gives each cut (the frame after it, its time, its score), and `scores`
 * (score i is for frames i and i + 1).
 * @param {RgbFrames} frames
 * @param {{ fps: number, threshold?: number }} options  fps: the frame rate
 *   of the frames
 */
export function cuts(frames, { fps, threshold = 0.35 }) {
  if (!(fps > 0)) throw new RangeError(`cuts: fps must be the frame rate of the frames, such as 24, not ${fps}.`)
  const { width, height, count, data } = frames
  if (width < GRID || height < GRID) throw new RangeError(`cuts: the frames must be at least ${GRID}×${GRID} pixels, not ${width}×${height}.`)
  const frameBytes = width * height * 3
  const scores = new Float64Array(Math.max(0, count - 1))
  let colors = count > 0 ? gridColors(frames, 0) : new Float64Array(0)
  for (let i = 0; i < scores.length; i++) {
    const next = gridColors(frames, i + 1)
    let colorChange = 0
    for (let k = 0; k < colors.length; k++) colorChange += Math.abs(next[k] - colors[k])
    let pixelChange = 0
    const start = i * frameBytes
    for (let k = start; k < start + frameBytes; k++) pixelChange += Math.abs(data[k + frameBytes] - data[k])
    scores[i] = colorChange / (GRID * GRID * 3) + pixelChange / frameBytes / 255
    colors = next
  }
  /** @type {{ frame: number, time: number, score: number }[]} */
  const found = []
  for (let i = 0; i < scores.length; i++) {
    const lo = Math.max(0, i - 4)
    const hi = Math.min(scores.length, i + 5)
    const around = hi - lo > 1 ? median([...scores.subarray(lo, i), ...scores.subarray(i + 1, hi)]) : 0
    if (scores[i] > threshold && scores[i] > 3 * around + 0.08) found.push({ frame: i + 1, time: (i + 1) / fps, score: scores[i] })
  }
  return { cuts: found, scores }
}

/**
 * Each cut of an edit against the beats of its song: the nearest beat, and
 * the error (the cut time less the beat time). A cut is off the beat when
 * the error is more than `tolerance` (0.042 s, one frame at 24 fps, by
 * default). Times in seconds.
 *
 * `offset` is where the song starts in the edit (as align gives it): the
 * beats move by it, and a cut more than 0.1 s before it is left out.
 * `meanError` and `maxError` are of the absolute errors; null with no cut.
 * @param {ArrayLike<number>} cutTimes  in the edit
 * @param {ArrayLike<number>} beatTimes  in the song
 * @param {{ offset?: number, tolerance?: number }} [options]
 */
export function syncCheck(cutTimes, beatTimes, { offset = 0, tolerance = 0.042 } = {}) {
  if (beatTimes.length === 0) throw new RangeError('syncCheck: there is no beat.')
  const beats = Array.from(beatTimes, (beat) => beat + offset)
  const checked = Array.from(cutTimes)
    .filter((time) => time > offset - 0.1)
    .map((time) => {
      const beat = beats[argmin(beats.map((b) => Math.abs(b - time)))]
      const error = time - beat
      return { time, beat, error, offBeat: Math.abs(error) > tolerance }
    })
  const errors = checked.map(({ error }) => Math.abs(error))
  return {
    cuts: checked,
    meanError: errors.length > 0 ? errors.reduce((sum, error) => sum + error, 0) / errors.length : null,
    maxError: errors.length > 0 ? Math.max(...errors) : null,
  }
}
