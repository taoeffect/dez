import type { ImageMediaType } from '../chat/images'
import { base64ToBytes } from '../../utils/base64'
import type { NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { trimTrailingSlashes, type MediaApiFormatId } from './config'
import { isRecord } from './modelParsing'
import type { ChatImagePart, GeneratedMedia, MediaKind } from './types'

// What one media request sends: the user's prompt, and the input images of
// an edit, as bytes.
export interface MediaInput {
  prompt: string
  images: readonly ChatImagePart[]
}

// The URL and the JSON body of one media request. Provider.mediaRequest adds
// the method and the headers, so a format holds no secrets.
export interface MediaWireRequest {
  url: string
  body: Record<string, unknown>
}

// Everything that differs between the media APIs that a provider can speak
// (`mediaApi.format` in config.ts). Each one takes every MediaKind.
export interface MediaFormat {
  request(kind: MediaKind, baseUrl: string, modelId: string, input: MediaInput): MediaWireRequest
  // The media of a 2xx response to a request of `kind`. Throws when the body
  // holds none.
  parseResponse(kind: MediaKind, head: NativeHttpResponseHead, body: Uint8Array): GeneratedMedia[]
}

// The first bytes of each image type that Dez stores (`isImageMediaType` in
// src/model/chat/images.ts); null matches any byte. WebP is a RIFF file (the
// 4 bytes after `RIFF` are its size) with `WEBP` at offset 8.
const IMAGE_SIGNATURES: readonly { mediaType: ImageMediaType, bytes: readonly (number | null)[] }[] = [
  { mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
]

// The type of an image comes from its bytes, not from the response: a JSON
// answer does not name it, and a server may send another type than the one
// that the request asked for.
function generatedImage(data: Uint8Array): GeneratedMedia {
  const signature = IMAGE_SIGNATURES.find(({ bytes }) =>
    data.length >= bytes.length && bytes.every((byte, index) => byte === null || data[index] === byte))
  if (!signature) throw new Error('The provider sent an image that is not a PNG, JPEG, GIF, or WebP image.')
  return { bytes: data, mediaType: signature.mediaType }
}

// Response header names are lower case (reqwest), but a test server or a
// proxy may differ.
function contentType(head: NativeHttpResponseHead): string {
  const entry = Object.entries(head.headers).find(([name]) => name.toLowerCase() === 'content-type')
  return entry?.[1].toLowerCase() ?? ''
}

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new Error('The provider sent an image response that is not valid JSON.')
  }
}

// The Venice image API (https://docs.venice.ai/api-reference). The user's
// choice for every image: no Venice watermark (it is on by default, at the
// bottom left), and safe mode off (on by default: Venice blurs images that
// it classes as adult content). These are fixed values, not settings.
const veniceFormat: MediaFormat = {
  request: (kind, baseUrl, modelId, { prompt, images }) => {
    const base = trimTrailingSlashes(baseUrl)
    switch (kind) {
      case 'image':
        // WebP is Venice's default; it is set so that the files keep one
        // type if the default changes.
        return { url: `${base}/image/generate`, body: { model: modelId, prompt, format: 'webp', hide_watermark: true, safe_mode: false } }
      case 'imageEdit':
        // This endpoint names the model `modelId`, not `model`. The first
        // image is the one to edit; the others are references. Each one
        // goes as a data URL, as Dez has no URL that a provider could fetch.
        // It has `safe_mode` but no `hide_watermark`, and its schema allows
        // no field that it does not name, so only `safe_mode` goes.
        // https://docs.venice.ai/api-reference/endpoint/image/multi-edit
        return {
          url: `${base}/image/multi-edit`,
          body: { modelId, prompt, images: images.map((image) => `data:${image.mediaType};base64,${image.data}`), safe_mode: false },
        }
    }
  },
  // `/image/generate` answers JSON `{ images: [base64, …] }` (no URL form),
  // and the edit endpoints answer the bytes of one image, with no JSON form
  // ("The edit endpoints have no `response_format` parameter").
  // https://docs.venice.ai/api-reference/endpoint/image/generate
  // https://docs.venice.ai/guides/media/image-editing
  parseResponse: (_kind, head, body) => {
    if (!contentType(head).startsWith('application/json')) return [generatedImage(body)]

    const data = jsonBody(body)
    const images = isRecord(data) && Array.isArray(data.images) ? data.images : []
    if (images.length === 0) throw new Error('The provider sent no image.')
    return images.map((image) => {
      let bytes: Uint8Array | null = null
      try {
        if (typeof image === 'string') bytes = base64ToBytes(image)
      } catch {
        // Not base64 text: the error below.
      }
      if (!bytes) throw new Error('The provider sent an image that is not base64 text.')
      return generatedImage(bytes)
    })
  },
}

export const MEDIA_FORMATS: Record<MediaApiFormatId, MediaFormat> = {
  venice: veniceFormat,
}
