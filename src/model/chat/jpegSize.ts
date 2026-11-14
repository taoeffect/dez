import type { ImageSize } from './imageDrawing'

// The size in pixels of a JPEG picture, read from its frame header with no
// decode, so that Dez knows what a picture that ffmpeg made costs a model
// (streams/replyPictures.ts). A JPEG file is a list of segments: a 0xFF
// byte, a marker byte, and for most markers a 16-bit big-endian length that
// counts itself, then the content. The frame header (a SOF marker) comes
// before the first scan (SOS), and holds the precision, the height, and the
// width.
// https://www.w3.org/Graphics/JPEG/itu-t81.pdf (B.1.1, B.2.2)

const START_OF_IMAGE = 0xD8
const END_OF_IMAGE = 0xD9
const START_OF_SCAN = 0xDA

// The frame header markers SOF0 to SOF15. Three markers in the same range
// are no frame headers: DHT (0xC4) and DAC (0xCC) are tables, and JPG
// (0xC8) is reserved for extensions.
function isFrameHeader(marker: number): boolean {
  return marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
}

// The markers with no length and no content: TEM, and RST0 to RST7.
function standsAlone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)
}

/** The size of the JPEG picture `bytes`; null for bytes that are no JPEG,
 *  for a file that ends before its frame header, and for a frame header
 *  with a height of 0 (a later DNL segment tells the height). */
export function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== START_OF_IMAGE) return null
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xFF) return null
    // Any number of 0xFF fill bytes can come before a marker.
    while (bytes[offset] === 0xFF) offset += 1
    if (offset >= bytes.length) return null
    const marker = bytes[offset]
    offset += 1
    if (standsAlone(marker)) continue
    if (marker === START_OF_SCAN || marker === END_OF_IMAGE || marker === START_OF_IMAGE) return null
    if (offset + 2 > bytes.length) return null
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) return null
    if (isFrameHeader(marker)) {
      if (length < 7) return null
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4]
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6]
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += length
  }
  return null
}
