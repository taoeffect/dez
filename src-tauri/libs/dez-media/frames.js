// @ts-check
// dez-media/frames: the writer of a frame sequence of a script app. The
// folder `<name>.frames` of `dez.outputFolder` holds the frames of one clip
// (000000.png, 000001.png, and so on, or raw RGBA: 000000.rgba, and so on)
// and frames.json, the facts of the clip. After the run, Dez encodes the
// folder with its ffmpeg into one clip; src/model/tools/frameSequences.ts
// has the rules that Dez checks.
//
// The writer writes files with node:fs, so only a Deno run loads it: the
// import map of a page does not have it (`DENO_ONLY_IMPORTS`,
// src/model/tools/appTemplates.ts).

import { mkdirSync, writeFileSync } from 'node:fs'

// The name of a clip: a name that the file selectors of Dez take
// (`isPathName`, src/model/tools/appsTool.ts).
const NAME = /^[A-Za-z0-9._-]+$/

// The digits of the number of a frame in its name (`FRAME_DIGITS`,
// src/model/tools/frameSequences.ts).
const FRAME_DIGITS = 6

// The limits of a frame sequence that Dez checks after the run (`parsedFacts`,
// src/model/tools/frameSequences.ts): `FRAMES_MIN_FPS`, `FRAMES_MAX_FPS`,
// `FRAMES_MAX_SIDE`, and `APP_RUN_MAX_FRAMES` of src/model/tools/appsTool.ts.
// A run cannot import the TypeScript of Dez, so these are copies, which
// tests/dez-media/frames.test.ts checks against it. The writer checks them
// before the first frame, so that a run does not draw a clip that Dez
// refuses after it.
const MIN_FPS = 0.01
const MAX_FPS = 240
const MAX_SIDE = 4096
const MAX_FRAMES = 36_000

/**
 * A canvas of skia-canvas, or another object that gives its pixels as a
 * PNG file.
 * @typedef {{ toBufferSync(format: 'png'): Uint8Array }} PngCanvas
 */

/**
 * The facts of a clip, as frames.json gives them: `fps` from 0.01 to 240,
 * and a `width` and a `height` of at most 4096 pixels. With `alpha`, the
 * clip keeps the alpha of each pixel (MOV with the PNG codec, for an overlay
 * with `video ffmpeg`); with no alpha, it is H.264 in MP4, and the width and
 * the height must be even.
 * @typedef {{ fps: number, width: number, height: number, alpha?: boolean }} ClipFacts
 */

/**
 * Writes the frames of one clip into `<outputFolder>/<name>.frames/`, one
 * frame at a time, so that the code holds one frame at a time. A frame is a
 * canvas, which the writer writes as a PNG file, or the raw RGBA pixels of
 * width × height (4 bytes for each pixel, row after row). The first frame
 * sets the kind of all the frames, and a clip has at most 36,000 frames.
 * `end()` writes frames.json, with the count of the frames: Dez encodes no
 * folder without it.
 */
export class FrameWriter {
  /** @type {string} */
  #folder
  /** @type {Required<ClipFacts>} */
  #facts
  /** @type {'png' | 'rgba' | null} */
  #format = null
  #count = 0
  #ended = false

  /**
   * @param {string} outputFolder `dez.outputFolder`
   * @param {string} name the name of the clip: Dez names it
   *   `<name>.frames/` in its result
   * @param {ClipFacts} facts
   */
  constructor(outputFolder, name, facts) {
    if (typeof outputFolder !== 'string' || outputFolder === '') throw new TypeError('FrameWriter takes the output folder of the run first: give it `dez.outputFolder`.')
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new RangeError(`FrameWriter takes the name of a clip, with only ASCII letters, digits, "-", "_", and ".": ${JSON.stringify(name)} is not one.`)
    }
    const { fps, width, height, alpha = false } = facts ?? {}
    if (typeof fps !== 'number' || !(fps >= MIN_FPS && fps <= MAX_FPS)) {
      throw new RangeError(`FrameWriter takes the frames per second of the clip as \`fps\`, a number from ${MIN_FPS} to ${MAX_FPS}.`)
    }
    if (!Number.isInteger(width) || width < 1 || width > MAX_SIDE || !Number.isInteger(height) || height < 1 || height > MAX_SIDE) {
      throw new RangeError(`FrameWriter takes the size of the clip in pixels as \`width\` and \`height\`, whole numbers from 1 to ${MAX_SIDE}.`)
    }
    if (typeof alpha !== 'boolean') throw new TypeError('FrameWriter takes `alpha` as true or false.')
    // H.264 stores the color of each 2 × 2 pixels once (4:2:0).
    if (!alpha && (width % 2 !== 0 || height % 2 !== 0)) {
      throw new RangeError(`FrameWriter: a clip with no alpha is H.264, which needs an even \`width\` and an even \`height\`, and ${width} × ${height} is not. `
        + 'Give an even size, or `alpha: true` for a MOV clip of any size.')
    }
    this.#folder = `${outputFolder}/${name}.frames`
    this.#facts = { fps, width, height, alpha }
    mkdirSync(this.#folder, { recursive: true })
  }

  /**
   * Writes the next frame.
   * @param {PngCanvas | Uint8Array | Uint8ClampedArray} frame
   */
  add(frame) {
    if (this.#ended) throw new Error('FrameWriter.add came after end(): add every frame, then call end() once.')
    if (this.#count === MAX_FRAMES) throw new RangeError(`FrameWriter takes at most ${MAX_FRAMES.toLocaleString('en-US')} frames, the most that Dez encodes into one clip.`)
    const raw = frame instanceof Uint8Array || frame instanceof Uint8ClampedArray
    if (!raw && typeof frame?.toBufferSync !== 'function') {
      throw new TypeError('FrameWriter.add takes a canvas of skia-canvas, or the raw RGBA pixels of a frame as a Uint8Array or a Uint8ClampedArray.')
    }
    const format = raw ? 'rgba' : 'png'
    if (this.#format !== null && format !== this.#format) {
      throw new TypeError(`The frames of one clip are all canvases or all raw RGBA pixels, and the first frame was ${this.#format === 'png' ? 'a canvas' : 'raw RGBA pixels'}.`)
    }
    const { width, height } = this.#facts
    if (raw && frame.length !== width * height * 4) {
      throw new RangeError(`A raw frame of ${width} × ${height} pixels has ${width * height * 4} bytes, 4 for each pixel (R, G, B, A), row after row, and this one has ${frame.length}. `
        + 'Give a PNG frame as a canvas.')
    }
    const bytes = raw ? frame : frame.toBufferSync('png')
    writeFileSync(`${this.#folder}/${String(this.#count).padStart(FRAME_DIGITS, '0')}.${format}`, bytes)
    this.#format = format
    this.#count += 1
  }

  /**
   * Writes frames.json, after the last frame. Returns the count of the
   * frames.
   * @returns {number}
   */
  end() {
    if (this.#ended) throw new Error('FrameWriter.end came a second time: call it once, after the last frame.')
    if (this.#count === 0) throw new Error('FrameWriter.end came before any frame: add the frames of the clip first.')
    writeFileSync(`${this.#folder}/frames.json`, JSON.stringify({ ...this.#facts, count: this.#count }))
    this.#ended = true
    return this.#count
  }
}
