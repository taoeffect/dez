// @ts-check
// Readers of the raw outputs of ffmpeg that the measurements of dez-media
// take: mono float32 samples (`-ac 1 -f f32le`) and RGB frames
// (`-pix_fmt rgb24 -f rawvideo`).

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
  // start at a multiple of 4 bytes: else the bytes are copied.
  if (view.byteOffset % 4 === 0) return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
  return new Float32Array(view.slice().buffer)
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
