import zlib from 'node:zlib'
import type { E2EBrowser } from './session'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A PNG of one color: 8-bit RGB, no interlace, each row with filter 0. */
export function solidPng (width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(typeAndData))
    return Buffer.concat([length, typeAndData, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per sample
  header[9] = 2 // color type: RGB
  const row = Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

/** An image that the editor shows, with its natural size: 0 x 0 until the
 *  asset protocol has served the file. */
export interface ShownImage {
  alt: string
  width: number
  height: number
}

/** The images that the active editor shows, in doc order. */
export async function shownImages (browser: E2EBrowser): Promise<ShownImage[]> {
  return browser.execute(() => Array.from(
    document.querySelectorAll<HTMLImageElement>('.cm-content .dez-image__img'),
    (img) => ({ alt: img.alt, width: img.naturalWidth, height: img.naturalHeight }),
  ))
}
