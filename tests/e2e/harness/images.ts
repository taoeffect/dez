import zlib from 'node:zlib'
import type { E2EBrowser } from './session'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The red, green, and blue of one pixel. */
export type Rgb = readonly [number, number, number]

// A PNG in which every row is `row`, one color for each column: 8-bit RGB,
// no interlace, each row with filter 0.
function rowsPng (row: readonly Rgb[], height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(typeAndData))
    return Buffer.concat([length, typeAndData, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(row.length, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per sample
  header[9] = 2 // color type: RGB
  const line = Buffer.from([0, ...row.flat()])
  const pixels = Buffer.concat(Array.from({ length: height }, () => line))
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

/** A PNG of one color. */
export function solidPng (width: number, height: number, rgb: Rgb): Buffer {
  return rowsPng(Array.from({ length: width }, () => rgb), height)
}

/** A PNG of vertical stripes, one in each color of `colors` from left to
 *  right, each `stripeWidth` columns wide. */
export function stripedPng (stripeWidth: number, height: number, colors: readonly Rgb[]): Buffer {
  return rowsPng(colors.flatMap((rgb) => Array.from({ length: stripeWidth }, () => rgb)), height)
}

/** A PNG as a data URL, as a request holds an image. */
export function pngDataUrl (png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** An image as the WebView decodes it: its size, and the colors (red,
 *  green, blue, alpha) of some pixels of its middle row. */
export interface DecodedImage {
  width: number
  height: number
  pixels: number[][]
}

/** Decodes the image at `url` (a data URL) in the page, and reads the
 *  pixel of its middle row in each column of `columns`. */
export async function decodedImage (browser: E2EBrowser, url: string, columns: number[]): Promise<DecodedImage> {
  return browser.execute(async (source: string, wanted: number[]) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('decodedImage: no canvas context')
    context.drawImage(image, 0, 0)
    const row = Math.floor(canvas.height / 2)
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: wanted.map((column) => Array.from(context.getImageData(column, row, 1, 1).data)),
    }
  }, url, columns)
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

/** Pastes a PNG file with no text into the active editor, as an image
 *  copied in an image viewer gives it. */
export async function pasteImage (browser: E2EBrowser, png: Buffer): Promise<void> {
  await browser.execute((base64: string) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('pasteImage: .cm-content not found')
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], 'image.png', { type: 'image/png' }))
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, png.toString('base64'))
}
