import { describe, expect, it } from 'vitest'
import { formatName } from './formatName'

describe('formatName', () => {
  it('names a file type as people write it', () => {
    expect(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].map(formatName))
      .toStrictEqual(['PNG', 'JPEG', 'JPEG', 'GIF', 'WebP', 'SVG', 'MP4', 'WebM', 'MOV', 'MP3', 'WAV', 'Ogg', 'FLAC', 'M4A', 'AAC', 'Opus'])
  })

  it('takes an extension in any case', () => {
    expect(['PNG', 'WebM', 'JPG'].map(formatName)).toStrictEqual(['PNG', 'WebM', 'JPEG'])
  })

  it('gives an unknown extension in capitals, and no name of an object key', () => {
    expect(['heic', 'constructor', 'toString'].map(formatName)).toStrictEqual(['HEIC', 'CONSTRUCTOR', 'TOSTRING'])
  })
})
