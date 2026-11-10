import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../utils/base64'
import type { NativeHttpResponseHead } from '../../utils/protocol/nativeHttp'
import { MEDIA_FORMATS } from './mediaFormats'
import type { ChatImagePart } from './types'

const venice = MEDIA_FORMATS.venice

// The first bytes of each stored image type, and a few more.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
const GIF = new TextEncoder().encode('GIF89a\x01\x00')
const WEBP = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WEBPVP8 ')
// A RIFF file that is not an image.
const WAV = new TextEncoder().encode('RIFF\x0c\x00\x00\x00WAVEfmt ')

const head = (contentType: string): NativeHttpResponseHead => ({ status: 200, headers: { 'content-type': contentType } })
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('venice media requests', () => {
  it('asks /image/generate for a WebP image', () => {
    expect(venice.request('image', 'https://api.venice.ai/api/v1/', 'z-image-turbo', { prompt: 'A red fox', images: [] })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/generate',
      body: { model: 'z-image-turbo', prompt: 'A red fox', format: 'webp' },
    })
  })

  it('sends an edit to /image/multi-edit with `modelId` and the images as data URLs, in order', () => {
    const images: ChatImagePart[] = [
      { type: 'image', mediaType: 'image/png', data: bytesToBase64(PNG) },
      { type: 'image', mediaType: 'image/jpeg', data: bytesToBase64(JPEG) },
    ]

    expect(venice.request('imageEdit', 'https://api.venice.ai/api/v1', 'qwen-image-2-1-turbo-edit', { prompt: 'Make it blue', images })).toStrictEqual({
      url: 'https://api.venice.ai/api/v1/image/multi-edit',
      body: {
        modelId: 'qwen-image-2-1-turbo-edit',
        prompt: 'Make it blue',
        images: [`data:image/png;base64,${bytesToBase64(PNG)}`, `data:image/jpeg;base64,${bytesToBase64(JPEG)}`],
      },
    })
  })
})

describe('venice media responses', () => {
  it('reads every image of a JSON answer, each with the type of its bytes', () => {
    const body = json({ id: 'generate-1', images: [bytesToBase64(WEBP), bytesToBase64(PNG)], timing: {} })

    expect(venice.parseResponse('image', head('application/json; charset=utf-8'), body)).toStrictEqual([
      { bytes: WEBP, mediaType: 'image/webp' },
      { bytes: PNG, mediaType: 'image/png' },
    ])
  })

  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ] as const)('takes a binary answer as one %s image', (mediaType, bytes) => {
    expect(venice.parseResponse('imageEdit', head(mediaType), bytes)).toStrictEqual([{ bytes, mediaType }])
  })

  it('takes the type of a binary answer from its bytes, not from its header', () => {
    expect(venice.parseResponse('imageEdit', head('image/png'), JPEG)).toStrictEqual([{ bytes: JPEG, mediaType: 'image/jpeg' }])
    expect(venice.parseResponse('imageEdit', { status: 200, headers: {} }, PNG)).toStrictEqual([{ bytes: PNG, mediaType: 'image/png' }])
  })

  it.each([
    ['a JSON answer with no images', head('application/json'), json({ id: 'generate-1', images: [] }), 'The provider sent no image.'],
    ['a JSON answer with no images list', head('application/json'), json({ error: 'busy' }), 'The provider sent no image.'],
    ['a JSON answer that does not parse', head('application/json'), new TextEncoder().encode('{"images": ['), 'not valid JSON'],
    ['an image that is not base64', head('application/json'), json({ images: [`data:image/png;base64,${bytesToBase64(PNG)}`] }), 'not base64 text'],
    ['an image that is not a string', head('application/json'), json({ images: [{ url: 'https://example.com/a.png' }] }), 'not base64 text'],
    ['a JSON image of a type that Dez does not store', head('application/json'), json({ images: [bytesToBase64(WAV)] }), 'not a PNG, JPEG, GIF, or WebP image'],
    ['a binary answer that is not an image', head('audio/wav'), WAV, 'not a PNG, JPEG, GIF, or WebP image'],
    ['an empty binary answer', head('image/png'), new Uint8Array(), 'not a PNG, JPEG, GIF, or WebP image'],
  ])('refuses %s', (_name, responseHead, body, message) => {
    expect(() => venice.parseResponse('image', responseHead, body)).toThrow(message)
  })
})
