import zlib from 'node:zlib'
import { waitForValue } from './dom'
import { appFilePath } from './fixtures'
import type { E2EBrowser } from './session'
import { threadSections } from './thread'

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

/** The colors of the stripes of `STRIPES_PNG` and `STRIPES_SVG`, from
 *  left to right: red, green, blue. */
export const STRIPE_COLORS: readonly [Rgb, Rgb, Rgb] = [[220, 40, 40], [40, 160, 60], [40, 90, 220]]

/** 90 x 20, in three stripes of 30 columns: an image of the `image` tool
 *  tests. */
export const STRIPES_PNG = stripedPng(30, 20, STRIPE_COLORS)

/** Three stripes of 20 viewBox units, with no width and height. The size
 *  that WebKit gives it depends on the version: WebKitGTK 2.54 gives it
 *  300 x 150 (the default size, fitted to the viewBox), and 2.52 (the CI
 *  runner's) gives it the viewBox size (`WEBKIT_SVG_SIZES`). A test works
 *  in the size that the webview gives. Where that is not the viewBox size,
 *  WebKit draws a part of an SVG wrong unless Dez draws it whole
 *  (`dez.controller/images/redraw`). */
export const STRIPES_SVG = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30">',
  '<rect width="20" height="30" fill="rgb(220,40,40)"/>',
  '<rect x="20" width="20" height="30" fill="rgb(40,160,60)"/>',
  '<rect x="40" width="20" height="30" fill="rgb(40,90,220)"/>',
  '</svg>',
].join(''))

/** The sizes that WebKit gives `STRIPES_SVG`. */
export const WEBKIT_SVG_SIZES = [{ width: 300, height: 150 }, { width: 60, height: 30 }]

/** An image as the WebView decodes it: its size, and the colors (red,
 *  green, blue, alpha) of some pixels of one row. */
export interface DecodedImage {
  width: number
  height: number
  pixels: number[][]
}

/** Decodes the image at `url` (a data URL) in the page, and reads the
 *  pixel of the row `row` (the middle row when absent) in each column of
 *  `columns`. */
export async function decodedImage (browser: E2EBrowser, url: string, columns: number[], row?: number): Promise<DecodedImage> {
  return browser.execute(async (source: string, wanted: number[], wantedRow: number | null) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('decodedImage: no canvas context')
    context.drawImage(image, 0, 0)
    const y = wantedRow ?? Math.floor(canvas.height / 2)
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: wanted.map((column) => Array.from(context.getImageData(column, y, 1, 1).data)),
    }
  }, url, columns, row ?? null)
}

/** The JPEG that the WebView encodes from the PNG `png`, at full quality:
 *  a JPEG test image with no JPEG encoder in Node. */
export async function jpegImage (browser: E2EBrowser, png: Buffer): Promise<Buffer> {
  const base64 = await browser.execute(async (source: string) => {
    const image = new Image()
    image.src = source
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('jpegImage: no canvas context')
    context.drawImage(image, 0, 0)
    const url = canvas.toDataURL('image/jpeg', 1)
    if (!url.startsWith('data:image/jpeg;base64,')) throw new Error('jpegImage: the WebView made no JPEG')
    return url.slice('data:image/jpeg;base64,'.length)
  }, pngDataUrl(png))
  return Buffer.from(base64, 'base64')
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

/** Pastes an image file with no text into the active editor, as an image
 *  copied in an image viewer gives it: a PNG, or a file of the type
 *  `type`. */
export async function pasteImage (browser: E2EBrowser, image: Buffer, type = 'image/png'): Promise<void> {
  await browser.execute((base64: string, fileType: string) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('pasteImage: .cm-content not found')
    const data = new DataTransfer()
    const name = `image.${fileType.slice('image/'.length).replace(/\+.*$/, '')}`
    data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], name, { type: fileType }))
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, image.toString('base64'), type)
}

/** Pastes the PNG `png` with `pasteImage`, and waits until the last
 *  section of the active tab ends with its reference, which gets the image
 *  id `id`. */
export async function pasteImageReference (browser: E2EBrowser, png: Buffer, id: string): Promise<void> {
  await pasteImage(browser, png)
  await waitForValue(browser, `reference of the image ${id}`, async () => (await threadSections(browser)).at(-1)?.text.endsWith(`](id=${id})`) ?? false, true)
}

/** The folder of the images that models and Dez tools made, in the test
 *  HOME `home`. */
export function generatedImagesDir (home: string): string {
  return appFilePath(home, 'assets', 'generated', 'images')
}
