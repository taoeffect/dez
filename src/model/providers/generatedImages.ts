import type { ImageMediaType } from '../chat/images'
import { base64ToBytes } from '../../utils/base64'
import type { GeneratedMedia } from './types'

// The first bytes of each image type that Dez stores (`isImageMediaType` in
// src/model/chat/images.ts); null matches any byte. WebP is a RIFF file (the
// 4 bytes after `RIFF` are its size) with `WEBP` at offset 8.
const IMAGE_SIGNATURES: readonly { mediaType: ImageMediaType, bytes: readonly (number | null)[] }[] = [
  { mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
]

// The start of a base64 `data:` URL, up to its data. The media type is not
// read (`generatedImage`).
const BASE64_DATA_URL_HEAD = /^data:[^,]*;base64,/i

/** An image that a model made, from its bytes. The type of an image comes
 *  from its bytes, not from the response: a JSON answer does not name it,
 *  and a server may send another type than the one that it names. Throws
 *  for bytes that are not an image of a type that Dez stores. */
export function generatedImage(data: Uint8Array): GeneratedMedia {
  const signature = IMAGE_SIGNATURES.find(({ bytes }) =>
    data.length >= bytes.length && bytes.every((byte, index) => byte === null || data[index] === byte))
  if (!signature) throw new Error('The provider sent an image that is not a PNG, JPEG, GIF, or WebP image.')
  return { bytes: data, mediaType: signature.mediaType }
}

/** An image that a model made, from a JSON value that must be the standard
 *  base64 text of its bytes. */
export function generatedBase64Image(text: unknown): GeneratedMedia {
  let bytes: Uint8Array | null = null
  try {
    if (typeof text === 'string') bytes = base64ToBytes(text)
  } catch {
    // Not base64 text: the error below.
  }
  if (!bytes) throw new Error('The provider sent an image that is not base64 text.')
  return generatedImage(bytes)
}

/** An image that a chat reply holds as a URL (the `image` event of a stream
 *  parser): a base64 `data:` URL is decoded, and an http(s) URL is read
 *  with `fetchBytes`. Throws for any other URL. */
export async function generatedImageFromUrl(url: string, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<GeneratedMedia> {
  const dataUrlHead = BASE64_DATA_URL_HEAD.exec(url)
  if (dataUrlHead) return generatedBase64Image(url.slice(dataUrlHead[0].length))
  if (/^https?:\/\//i.test(url)) return generatedImage(await fetchBytes(url))
  throw new Error('The provider sent an image that is neither a base64 data URL nor an http(s) URL.')
}
