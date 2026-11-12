import { describe, expect, it } from 'vitest'
import { mp4DurationSeconds } from './mp4Duration'

const u32 = (value: number) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value)
  return bytes
}

const ascii = (text: string) => new TextEncoder().encode(text)

function concat(...parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    all.set(part, offset)
    offset += part.length
  }
  return all
}

// One box: a 32-bit big-endian size (with the 8 header bytes), a 4-letter
// type, then the content.
const box = (type: string, ...content: Uint8Array[]) => {
  const body = concat(...content)
  return concat(u32(8 + body.length), ascii(type), body)
}

// The creation and modification times come before the time scale; they are
// not 0 here, so that a read at a wrong offset gives a wrong length.
const CREATED = 3_786_912_000
// Rate, volume, matrix, and next track id: the rest of a movie header.
const REST_OF_MVHD = new Uint8Array(80)

const mvhdV0 = (timescale: number, duration: number) =>
  box('mvhd', new Uint8Array([0, 0, 0, 0]), u32(CREATED), u32(CREATED + 1), u32(timescale), u32(duration), REST_OF_MVHD)

const mvhdV1 = (timescale: number, duration: bigint) =>
  box('mvhd', new Uint8Array([1, 0, 0, 0]), u64(BigInt(CREATED)), u64(BigInt(CREATED + 1)), u32(timescale), u64(duration), REST_OF_MVHD)

const FTYP = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2avc1mp41'))
const TRAK = box('trak', box('tkhd', new Uint8Array(84)))
const MDAT = box('mdat', new Uint8Array(64).fill(0xAB))
// The movie extends box of a fragmented file, with one track extends box.
const MVEX = box('mvex', box('trex', new Uint8Array(24)))
const MOOF = box('moof', box('mfhd', new Uint8Array(8)))

describe('mp4DurationSeconds', () => {
  it('reads the length from a version 0 movie header', () => {
    expect(mp4DurationSeconds(concat(FTYP, box('moov', mvhdV0(1000, 12_500), TRAK), MDAT))).toBe(12.5)
  })

  // A length in units that does not fit in 32 bits: 50 000 seconds at 90 kHz.
  it('reads a 64-bit length from a version 1 movie header', () => {
    expect(mp4DurationSeconds(concat(FTYP, box('moov', mvhdV1(90_000, 90_000n * 50_000n), TRAK)))).toBe(50_000)
  })

  it('finds the movie box after the media data', () => {
    expect(mp4DurationSeconds(concat(FTYP, box('free'), MDAT, box('moov', mvhdV0(600, 1800), TRAK)))).toBe(3)
  })

  // Size 1: the real size is a 64-bit number after the type.
  it('skips a box with a 64-bit size', () => {
    const largeMdat = concat(u32(1), ascii('mdat'), u64(16n + 100n), new Uint8Array(100))

    expect(mp4DurationSeconds(concat(FTYP, largeMdat, box('moov', mvhdV0(1000, 4000))))).toBe(4)
  })

  // Size 0: the box runs to the end of the file.
  it('reads a last movie box of size 0', () => {
    expect(mp4DurationSeconds(concat(FTYP, u32(0), ascii('moov'), mvhdV0(1000, 2500), TRAK))).toBe(2.5)
  })

  const video = concat(FTYP, box('moov', mvhdV0(1000, 12_500), TRAK))

  it.each([
    ['an empty file', new Uint8Array(0)],
    ['a file with no movie box', concat(FTYP, MDAT)],
    ['a movie box with no movie header', concat(FTYP, box('moov', TRAK))],
    ['a file cut inside the movie box', video.slice(0, video.length - 10)],
    ['a 64-bit box size larger than the file', concat(FTYP, u32(1), ascii('mdat'), u64(1_000_000n), new Uint8Array(100), box('moov', mvhdV0(1000, 4000)))],
    ['a time scale of 0', concat(FTYP, box('moov', mvhdV0(0, 4000)))],
    ['an unknown length in a version 0 header', concat(FTYP, box('moov', mvhdV0(1000, 0xFFFFFFFF)))],
    ['an unknown length in a version 1 header', concat(FTYP, box('moov', mvhdV1(1000, 0xFFFFFFFFFFFFFFFFn)))],
    // The movie header counts only the first fragment (1 s here), as with
    // `ffmpeg -movflags frag_keyframe`; the rest is in the fragments.
    ['a fragmented file', concat(FTYP, box('moov', mvhdV0(1000, 1000), TRAK, MVEX), MOOF, MDAT, MOOF, MDAT)],
    ['a length of 0 in a version 0 header', concat(FTYP, box('moov', mvhdV0(1000, 0), TRAK))],
    ['a length of 0 in a version 1 header', concat(FTYP, box('moov', mvhdV1(1000, 0n), TRAK))],
  ])('tells no length for %s', (_name, bytes) => {
    expect(mp4DurationSeconds(bytes)).toBeNull()
  })
})
