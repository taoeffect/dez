import type { NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { trimTrailingSlashes, type MediaApiFormatId } from './config'
import { generatedBase64Image, generatedImage } from './generatedImages'
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
    return images.map((image) => generatedBase64Image(image))
  },
}

export const MEDIA_FORMATS: Record<MediaApiFormatId, MediaFormat> = {
  venice: veniceFormat,
}
