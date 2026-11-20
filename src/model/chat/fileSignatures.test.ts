import { describe, expect, it } from 'vitest'
import { imageTypeOfBytes, storedTypeOfBytes } from './fileSignatures'

const bytes = (hex: string) => Uint8Array.from(hex.split(/\s+/).filter((byte) => byte !== '').map((byte) => Number.parseInt(byte, 16)))
const text = (value: string) => new TextEncoder().encode(value)

// The first bytes of files that the ffmpeg of Dez wrote.
const STARTS = {
  png: '89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52 00 00 00 08 00 00 00 08 08 02 00 00',
  jpeg: 'ff d8 ff e0 00 10 4a 46 49 46 00 01 02 00 00 01 00 01 00 00 ff fe 00 0f 4c 61 76 63',
  gif: '47 49 46 38 39 61 08 00 08 00 f7 1f 31 00 00 00 24 00 00 48 00 00 6c 00 00 90 00 00',
  mp4: '00 00 00 20 66 74 79 70 69 73 6f 6d 00 00 02 00 69 73 6f 6d 69 73 6f 32 61 76 63 31',
  mov: '00 00 00 14 66 74 79 70 71 74 20 20 00 00 02 00 71 74 20 20 00 00 00 08 77 69 64 65',
  m4a: '00 00 00 1c 66 74 79 70 4d 34 41 20 00 00 02 00 4d 34 41 20 69 73 6f 6d 69 73 6f 32',
  webm: '1a 45 df a3 9f 42 86 81 01 42 f7 81 01 42 f2 81 04 42 f3 81 08 42 82 84 77 65 62 6d 42 87 81 02',
  matroska: '1a 45 df a3 a3 42 86 81 01 42 f7 81 01 42 f2 81 04 42 f3 81 08 42 82 88 6d 61 74 72 6f 73 6b 61',
  wav: '52 49 46 46 2e 45 00 00 57 41 56 45 66 6d 74 20 10 00 00 00 01 00 01 00 44 ac 00 00',
  flac: '66 4c 61 43 00 00 00 22 04 00 04 00 00 01 21 00 01 84 0a c4 40 f0 00 00 22 74 b4 f2',
  oggFlac: '4f 67 67 53 00 02 00 00 00 00 00 00 00 00 8f e2 f4 73 00 00 00 00 37 c0 ef af 01 33 7f 46 4c 41 43 01',
  opus: '4f 67 67 53 00 02 00 00 00 00 00 00 00 00 33 28 b2 29 00 00 00 00 f3 1e 4e 16 01 13 4f 70 75 73 48 65 61 64 01 01',
  mp3WithTag: '49 44 33 04 00 00 00 00 00 22 54 53 53 45 00 00 00 0e 00 00 03 4c 61 76 66 36 33 2e',
  mp3: 'ff fb 50 c4 00 00 0a 2c 43 2e 55 94 80 01 81 15 66 23 3a d0 00 07 aa c3 8e 33 85 d3',
  aac: 'ff f1 50 40 20 ff fc dc 00 4c 61 76 63 36 33 2e 31 2e 31 30 32 00 02 60 ac 5b a9 50',
}

describe('storedTypeOfBytes', () => {
  it.each([
    ['a PNG image', STARTS.png, { kind: 'image', type: 'image/png', extension: 'png' }],
    ['a JPEG image', STARTS.jpeg, { kind: 'image', type: 'image/jpeg', extension: 'jpg' }],
    ['a GIF image', STARTS.gif, { kind: 'image', type: 'image/gif', extension: 'gif' }],
    ['a WebP image', '52 49 46 46 24 00 00 00 57 45 42 50 56 50 38 20', { kind: 'image', type: 'image/webp', extension: 'webp' }],
    ['an MP4 video', STARTS.mp4, { kind: 'video', type: 'video/mp4', extension: 'mp4' }],
    ['a QuickTime video', STARTS.mov, { kind: 'video', type: 'video/quicktime', extension: 'mov' }],
    ['a WebM video', STARTS.webm, { kind: 'video', type: 'video/webm', extension: 'webm' }],
    ['MP4 audio with an audio brand', STARTS.m4a, { kind: 'audio', type: 'audio/mp4', extension: 'm4a' }],
    ['a WAV sound', STARTS.wav, { kind: 'audio', type: 'audio/wav', extension: 'wav' }],
    ['a FLAC sound', STARTS.flac, { kind: 'audio', type: 'audio/flac', extension: 'flac' }],
    ['an Ogg sound', STARTS.oggFlac, { kind: 'audio', type: 'audio/ogg', extension: 'ogg' }],
    ['an Opus sound', STARTS.opus, { kind: 'audio', type: 'audio/opus', extension: 'opus' }],
    ['an MP3 sound with an ID3 tag', STARTS.mp3WithTag, { kind: 'audio', type: 'audio/mpeg', extension: 'mp3' }],
    ['an MP3 sound with no tag', STARTS.mp3, { kind: 'audio', type: 'audio/mpeg', extension: 'mp3' }],
    ['an AAC sound', STARTS.aac, { kind: 'audio', type: 'audio/aac', extension: 'aac' }],
  ])('tells %s by its first bytes', (_case, start, type) => {
    expect(storedTypeOfBytes(bytes(start))).toStrictEqual(type)
  })

  it('tells an SVG image by the start of its text', () => {
    expect(storedTypeOfBytes(text('<?xml version="1.0"?>\n<!-- a chart -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')))
      .toStrictEqual({ kind: 'image', type: 'image/svg+xml', extension: 'svg' })
  })

  // A script names its file as it likes, so a type that Dez does not store
  // must not pass for one that looks like it.
  it.each([
    ['an empty file', ''],
    ['a Matroska file, which has the header of a WebM file', STARTS.matroska],
    ['an EBML header with no doctype', '1a 45 df a3 9f 42 86 81 01 42 f7 81 01'],
    ['a HEIC picture, which has the box of an MP4 file', '00 00 00 18 66 74 79 70 68 65 69 63 00 00 00 00 6d 69 66 31 68 65 69 63'],
    ['an AVIF picture', '00 00 00 1c 66 74 79 70 61 76 69 66 00 00 00 00 61 76 69 66 6d 69 66 31'],
    ['an `ftyp` box with no brand', '00 00 00 08 66 74 79 70'],
    ['a RIFF file that is no sound and no picture (AVI)', '52 49 46 46 24 00 00 00 41 56 49 20 4c 49 53 54'],
    ['a UTF-16 text, whose byte order mark starts as a frame of sound', 'ff fe 61 00 62 00 63 00'],
    ['a frame header with a reserved sample rate', 'ff fb 5c c4 00 00'],
    ['a ZIP file', '50 4b 03 04 14 00 00 00 08 00'],
    ['a program', '7f 45 4c 46 02 01 01 00 00 00 00 00'],
  ])('gives no type for %s', (_case, start) => {
    expect(storedTypeOfBytes(bytes(start))).toBeNull()
  })

  it.each([
    ['a JSON text', '{"type": "image/png"}'],
    ['an HTML page with a picture', '<!doctype html><html><body><svg/></body></html>'],
    ['a text that names a type', 'RIFF and WAVE and ftyp'],
  ])('gives no type for %s', (_case, value) => {
    expect(storedTypeOfBytes(text(value))).toBeNull()
  })
})

describe('imageTypeOfBytes', () => {
  it('gives no type for a clip', () => {
    for (const start of [STARTS.mp4, STARTS.webm, STARTS.wav, STARTS.mp3]) expect(imageTypeOfBytes(bytes(start))).toBeNull()
  })
})
