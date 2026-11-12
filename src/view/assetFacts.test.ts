import { describe, expect, it } from 'vitest'
import { assetFactsText, clipLengthText, formatName } from './assetFacts'

describe('assetFactsText', () => {
  it('gives the pixels, the format, and the file size of an image', () => {
    expect(assetFactsText({ pixels: { width: 1024, height: 768 }, extension: 'png', bytes: 1.2 * 1024 ** 2 })).toBe('1024 × 768 · PNG · 1.2 MB')
  })

  it('gives the length, the format, and the file size of a clip', () => {
    expect(assetFactsText({ seconds: 2.04, extension: 'webm', bytes: 48 * 1024 })).toBe('0:02 · WebM · 48 KB')
  })

  it('leaves out each fact that is not known', () => {
    expect(assetFactsText({ seconds: 2, extension: 'wav', bytes: null })).toBe('0:02 · WAV')
    expect(assetFactsText({ pixels: null, extension: 'jpg', bytes: null })).toBe('JPEG')
    expect(assetFactsText({ seconds: null, extension: null, bytes: null })).toBe('')
  })

  it('gives the size of an empty file and the length of an empty clip', () => {
    expect(assetFactsText({ seconds: 0, extension: 'mp3', bytes: 0 })).toBe('0:00 · MP3 · 0 B')
  })
})

describe('clipLengthText', () => {
  it('shows whole seconds as the player does', () => {
    expect([0, 0.99, 2.5, 59.99, 61, 600].map(clipLengthText)).toStrictEqual(['0:00', '0:00', '0:02', '0:59', '1:01', '10:00'])
  })

  it('shows hours from one hour on', () => {
    expect([3599.9, 3600, 3661, 36_000].map(clipLengthText)).toStrictEqual(['59:59', '1:00:00', '1:01:01', '10:00:00'])
  })
})

describe('formatName', () => {
  it('names a file type as people write it', () => {
    expect(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].map(formatName))
      .toStrictEqual(['PNG', 'JPEG', 'JPEG', 'GIF', 'WebP', 'MP4', 'WebM', 'MOV', 'MP3', 'WAV', 'Ogg', 'FLAC', 'M4A', 'AAC', 'Opus'])
  })

  it('takes an extension in any case', () => {
    expect(['PNG', 'WebM', 'JPG'].map(formatName)).toStrictEqual(['PNG', 'WebM', 'JPEG'])
  })

  it('gives an unknown extension in capitals, and no name of an object key', () => {
    expect(['heic', 'constructor', 'toString'].map(formatName)).toStrictEqual(['HEIC', 'CONSTRUCTOR', 'TOSTRING'])
  })
})
