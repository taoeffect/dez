// The length of an MP4 or QuickTime (`.mov`) video, read from its movie
// header, so that Dez can check a clip against a model's length rules
// before a paid request. The webview can tell the length of an audio clip
// (`dez.controller/media/decodeAudio` decodes it), but it has no decoder of a
// video that does not play. The file is a list of boxes, each one a 32-bit
// big-endian size, then a 4-letter type, then its content; the `moov` box
// holds the `mvhd` box, with the time scale (units in one second) and the
// length in those units.
// https://developer.apple.com/documentation/quicktime-file-format/movie_header_atom
// ISO/IEC 14496-12, 8.2.2 (Movie Header Box)

// The start and end of the content of the first box of `type` among the
// boxes from `start` to `end`; null when there is none or when a box size
// does not fit.
function findBox(view: DataView, start: number, end: number, type: string): { start: number, end: number } | null {
  let offset = start
  while (offset + 8 <= end) {
    let size = view.getUint32(offset)
    let header = 8
    // Size 1: a 64-bit size follows the type. Size 0: the box runs to the
    // end of the file.
    if (size === 1) {
      if (offset + 16 > end) return null
      const largeSize = view.getBigUint64(offset + 8)
      if (largeSize > BigInt(end - offset)) return null
      size = Number(largeSize)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) return null
    const boxType = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4))
    if (boxType === type) return { start: offset + header, end: offset + size }
    offset += size
  }
  return null
}

/** The length in seconds of the MP4 or QuickTime video `bytes`; null when
 *  the file has no movie header that Dez can read, when it is a fragmented
 *  file, or when the header tells no length (all bits set, a length of 0,
 *  or a time scale of 0). */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const movie = findBox(view, 0, bytes.length, 'moov')
  const header = movie && findBox(view, movie.start, movie.end, 'mvhd')
  if (!movie || !header) return null
  // A fragmented file (a `mvex` box: screen recorders, `MediaRecorder`,
  // `ffmpeg -movflags frag_keyframe`) has its media in fragments after the
  // movie box, which the movie header does not count: its length is 0, or
  // the length of the first fragment only.
  // ISO/IEC 14496-12, 8.8 (Movie Fragments)
  if (findBox(view, movie.start, movie.end, 'mvex')) return null
  // Version 0 has 32-bit times and length; version 1 has 64-bit ones. The
  // version and 3 bytes of flags come first.
  const version = header.end - header.start >= 1 ? view.getUint8(header.start) : null
  if (version === 0 && header.end - header.start >= 20) {
    const timescale = view.getUint32(header.start + 12)
    const duration = view.getUint32(header.start + 16)
    return timescale === 0 || duration === 0 || duration === 0xFFFFFFFF ? null : duration / timescale
  }
  if (version === 1 && header.end - header.start >= 32) {
    const timescale = view.getUint32(header.start + 20)
    const duration = view.getBigUint64(header.start + 24)
    return timescale === 0 || duration === 0n || duration === 0xFFFFFFFFFFFFFFFFn ? null : Number(duration) / timescale
  }
  return null
}
