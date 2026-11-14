import { describe, expect, it } from 'vitest'
import { jpegSize } from './jpegSize'
import { jpegHeader } from './testing'

// The offset of the frame header marker (0xFF 0xC0) in `jpegHeader`.
const FRAME_HEADER = 27

describe('jpegSize', () => {
  it('reads the width and the height of the frame header, after the segments before it', () => {
    expect(jpegSize(jpegHeader(1292, 240))).toStrictEqual({ width: 1292, height: 240 })
    expect(jpegSize(jpegHeader(3000, 1))).toStrictEqual({ width: 3000, height: 1 })
  })

  it('reads a progressive frame header, and a marker after fill bytes', () => {
    const progressive = jpegHeader(800, 200)
    progressive[FRAME_HEADER + 1] = 0xC2
    expect(jpegSize(progressive)).toStrictEqual({ width: 800, height: 200 })

    const header = jpegHeader(800, 200)
    const filled = new Uint8Array([...header.slice(0, FRAME_HEADER), 0xFF, 0xFF, ...header.slice(FRAME_HEADER)])
    expect(jpegSize(filled)).toStrictEqual({ width: 800, height: 200 })
  })

  it('reads no size from a file that ends inside its frame header, a PNG, a scan with no frame header, or a height of 0', () => {
    const header = jpegHeader(800, 200)
    expect(jpegSize(header.slice(0, FRAME_HEADER + 6))).toBeNull()
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBeNull()
    expect(jpegSize(new Uint8Array([...header.slice(0, FRAME_HEADER), 0xFF, 0xDA, 0x00, 0x02]))).toBeNull()
    expect(jpegSize(jpegHeader(800, 0))).toBeNull()
  })
})
