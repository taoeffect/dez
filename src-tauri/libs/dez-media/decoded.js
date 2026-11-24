// @ts-check
// Readers of the raw outputs of ffmpeg that the measurements of dez-media
// take: mono float32 samples (`-ac 1 -f f32le`) and RGB frames
// (`-pix_fmt rgb24 -f rawvideo`); the checks of the decoded files of an
// input of a run of a script app (`dez.inputs`); and the id of the input in
// the error of a measurement.

/**
 * The samples of raw float32 audio (ffmpeg `-f f32le`), as a Float32Array.
 * It shares the bytes when it can.
 * @param {Uint8Array | ArrayBuffer} bytes
 */
export function f32Samples(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength % 4 !== 0) throw new RangeError(`f32Samples: ${view.byteLength} bytes are not whole float32 samples (4 bytes each). Decode with ffmpeg -f f32le.`)
  // A Float32Array reads the bytes in the byte order of the computer, and
  // each computer that Dez runs on is little-endian, as f32le. It needs a
  // start at a multiple of 4 bytes: else the bytes are copied. The copy does
  // not use `slice`: a Node Buffer (a `node:fs` read) has its own `slice`,
  // which gives a view of the same memory, not a copy.
  if (view.byteOffset % 4 === 0) return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
  const samples = new Float32Array(view.byteLength / 4)
  new Uint8Array(samples.buffer).set(view)
  return samples
}

/**
 * The frames of raw RGB video (ffmpeg `-pix_fmt rgb24 -f rawvideo`): 3
 * bytes for each pixel, row by row, frame by frame.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {number} width  in pixels, as the decode gave it (`-s`)
 * @param {number} height  in pixels
 */
export function rgbFrames(bytes, width, height) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) throw new RangeError(`rgbFrames: the frame size must be whole pixels, not ${width}×${height}.`)
  const frameBytes = width * height * 3
  if (data.byteLength % frameBytes !== 0) throw new RangeError(`rgbFrames: ${data.byteLength} bytes are not whole ${width}×${height} RGB frames (${frameBytes} bytes each). Is that the size of the decode, with -pix_fmt rgb24?`)
  return { width, height, count: data.byteLength / frameBytes, data }
}

/**
 * The decoded sound of `input`, an input of a run of `app`, as Dez gives it
 * (`{ path, rate, count }`): read its samples with
 * `f32Samples(await readFile(path))`. For an app that takes only clips
 * with sound, and whose manifest decodes the sound of its inputs: only the
 * `decode` of a call can then leave it out. Throws a RangeError that tells
 * the caller what is wrong: for an image, for a run whose decode asked for
 * no sound, and for a clip with no sound.
 *
 * It reads no file: a UI page imports dez-media too, and has no node:fs.
 * @param {string} app  the name of the app, for the error texts
 * @param {{ id: string, kind: string, audio?: { path: string, rate: number, count: number } | null }} input
 */
export function decodedSound(app, input) {
  if (input.kind === 'image') throw new RangeError(`@${input.id} is an image, and ${app} takes only clips with sound.`)
  if (input.audio === undefined) {
    throw new RangeError(`The run has no decoded sound of @${input.id}: the \`decode\` of the call asked for none. Call ${app} without \`decode\`.`)
  }
  if (input.audio === null) throw new RangeError(`@${input.id} has no sound, and ${app} takes only clips with sound.`)
  return input.audio
}

/**
 * The decoded frames of `input`, an input of a run of `app`, as Dez gives
 * them (`{ path, width, height, fps, count }`): read them with
 * `rgbFrames(await readFile(path), width, height)`. For an app that takes
 * only videos, and whose manifest decodes the frames of its inputs: only
 * the `decode` of a call can then leave them out. Throws a RangeError that
 * tells the caller what is wrong: for an input that is no video, for a run
 * whose decode asked for no frames, and for a clip with no picture.
 *
 * It reads no file, as `decodedSound`.
 * @param {string} app  the name of the app, for the error texts
 * @param {{ id: string, kind: string, frames?: { path: string, width: number, height: number, fps: number | null, count: number } | null }} input
 */
export function decodedFrames(app, input) {
  if (input.kind !== 'video') throw new RangeError(`@${input.id} is no video (it is an ${input.kind === 'image' ? 'image' : 'audio clip'}), and ${app} takes only videos.`)
  if (input.frames === undefined) {
    throw new RangeError(`The run has no decoded frames of @${input.id}: the \`decode\` of the call asked for none. Call ${app} without \`decode\`.`)
  }
  if (input.frames === null) throw new RangeError(`@${input.id} has no picture, and ${app} takes only videos.`)
  return input.frames
}

/**
 * Runs `measure` on the input `id` of a run, and puts "@<id>: " before the
 * text of a RangeError that it throws: a measurement of dez-media names no
 * clip, and a run can have more than one. Another error is a bug of the
 * code, not a problem of the input, so it goes out as it is.
 * @template T
 * @param {string} id
 * @param {() => T} measure
 * @returns {T}
 */
export function namingInput(id, measure) {
  try {
    return measure()
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError(`@${id}: ${error.message}`)
    throw error
  }
}
