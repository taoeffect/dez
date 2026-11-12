import { describe, expect, it } from 'vitest'
import { mediaFileExtension, savedMediaFile, storableClip, tempMediaFile } from './mediaFiles'

const APP_DIR = '/home/ann/.config/dez'
const CACHE_DIR = '/home/ann/.cache/dez'
const NAME = '0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60'

describe('savedMediaFile', () => {
  it('gives the app-file path of a clip directly in a media folder of this app folder', () => {
    expect(savedMediaFile(`${APP_DIR}/assets/generated/video/${NAME}.mp4`, APP_DIR)).toBe(`assets/generated/video/${NAME}.mp4`)
    expect(savedMediaFile(`${APP_DIR}/assets/generated/audio/a_1.mp3`, APP_DIR)).toBe('assets/generated/audio/a_1.mp3')
    expect(savedMediaFile(`${APP_DIR}/assets/video/${NAME}.mov`, APP_DIR)).toBe(`assets/video/${NAME}.mov`)
    expect(savedMediaFile(`${APP_DIR}/assets/audio/${NAME}.wav`, APP_DIR)).toBe(`assets/audio/${NAME}.wav`)
  })

  it('gives null for any other path, so that no other file is deleted', () => {
    for (const path of [
      // The same file name in another home is another clip.
      `/home/bob/.config/dez/assets/generated/video/${NAME}.mp4`,
      `/backup${APP_DIR}/assets/generated/video/${NAME}.mp4`,
      `/home/bob/.config/dez/assets/audio/${NAME}.wav`,
      `${APP_DIR}/assets/video/2026/${NAME}.mp4`,
      `${APP_DIR}/assets/generated/video/2026/${NAME}.mp4`,
      `${APP_DIR}/assets/generated/video/../audio/${NAME}.mp3`,
      `${APP_DIR}/assets/generated/video/my clip.mp4`,
      `${APP_DIR}/assets/generated/video/${NAME}.mp4\n`,
      `${APP_DIR}/assets/generated/images/${NAME}.png`,
      `${APP_DIR}/assets/images/${NAME}.png`,
      `${APP_DIR}/app_state.json`,
      `${CACHE_DIR}/media/${NAME}.mp4`,
      `assets/generated/video/${NAME}.mp4`,
      `https://cdn.example/assets/generated/video/${NAME}.mp4`,
      '',
    ]) {
      expect(savedMediaFile(path, APP_DIR), path).toBeNull()
    }
  })
})

describe('storableClip', () => {
  it('takes the kind and the media type from the type that the system gives', () => {
    expect([
      storableClip('video/mp4', 'clip'),
      storableClip('audio/x-wav', 'voice.mp3'),
      storableClip('Audio/MPEG', 'song'),
      storableClip('video/quicktime', 'x.MOV'),
    ]).toStrictEqual([
      { kind: 'video', type: 'video/mp4' },
      { kind: 'audio', type: 'audio/wav' },
      { kind: 'audio', type: 'audio/mpeg' },
      { kind: 'video', type: 'video/quicktime' },
    ])
  })

  it('takes them from the extension when the type is empty or names no clip format', () => {
    expect([
      storableClip('', 'Song.FLAC'),
      storableClip('application/octet-stream', 'talk.m4a'),
      storableClip('', 'dance.webm'),
    ]).toStrictEqual([
      { kind: 'audio', type: 'audio/flac' },
      { kind: 'audio', type: 'audio/mp4' },
      { kind: 'video', type: 'video/webm' },
    ])
  })

  it('gives null for a file that Dez does not store as a clip', () => {
    for (const [type, name] of [['image/png', 'red.png'], ['', 'notes.txt'], ['', 'clip'], ['video/x-matroska', 'film.mkv'], ['', 'a.constructor']]) {
      expect(storableClip(type, name), name).toBeNull()
    }
  })
})

describe('tempMediaFile', () => {
  it('gives the cache-file path of a temp copy directly in the media folder of this cache root', () => {
    expect(tempMediaFile(`${CACHE_DIR}/media/${NAME}.mp4`, CACHE_DIR)).toBe(`media/${NAME}.mp4`)
    expect(tempMediaFile(`/Users/ann/Library/Caches/dez/media/${NAME}.mp3`, '/Users/ann/Library/Caches/dez')).toBe(`media/${NAME}.mp3`)
  })

  it('gives null for any other path, so that no other file is moved', () => {
    for (const path of [
      `/home/bob/.cache/dez/media/${NAME}.mp4`,
      `/backup${CACHE_DIR}/media/${NAME}.mp4`,
      `${CACHE_DIR}/media/old/${NAME}.mp4`,
      `${CACHE_DIR}/media/../${NAME}.mp4`,
      `${CACHE_DIR}/${NAME}.mp4`,
      // The temp file of a download that did not end.
      `${CACHE_DIR}/media/${NAME}.mp4.4012.7.tmp`,
      `${APP_DIR}/assets/generated/video/${NAME}.mp4`,
      `https://cdn.example/dez/media/${NAME}.mp4`,
      `media/${NAME}.mp4`,
      '',
    ]) {
      expect(tempMediaFile(path, CACHE_DIR), path).toBeNull()
    }
  })
})

describe('mediaFileExtension', () => {
  it('reads the media type, whatever its case and parameters', () => {
    expect(mediaFileExtension('video/mp4', null)).toBe('mp4')
    expect(mediaFileExtension('Video/WebM; codecs="vp9, opus"', null)).toBe('webm')
    expect(mediaFileExtension('video/quicktime', null)).toBe('mov')
    expect(mediaFileExtension(' audio/mpeg ', null)).toBe('mp3')
    expect(mediaFileExtension('audio/x-wav', null)).toBe('wav')
    expect(mediaFileExtension('audio/ogg', null)).toBe('ogg')
    expect(mediaFileExtension('audio/flac', null)).toBe('flac')
    expect(mediaFileExtension('audio/mp4', null)).toBe('m4a')
  })

  it('takes the media type before the URL', () => {
    expect(mediaFileExtension('audio/mpeg', 'https://cdn.example/clip.wav')).toBe('mp3')
  })

  it('reads the path of the URL when the type names no format', () => {
    expect(mediaFileExtension('application/octet-stream', 'https://cdn.example/out/clip.mp4?sig=1.png#t=2.wav')).toBe('mp4')
    expect(mediaFileExtension('', 'https://cdn.example/CLIP.MOV')).toBe('mov')
  })

  it('gives null when neither names a format that Dez saves', () => {
    for (const [type, url] of [
      ['application/octet-stream', null],
      ['video/x-unknown', 'https://cdn.example/clip'],
      ['application/json', 'https://cdn.example/clip.json'],
      ['binary/octet-stream', 'https://cdn.example/setup.exe'],
      // Only the path names a file: not the host, the query, or the fragment.
      ['', 'https://cdn.mp4'],
      ['', 'https://cdn.example/clip?name=clip.mp4'],
      ['', 'https://cdn.example/clip#clip.mp4'],
      ['', 'clip.mp4'],
      // Not a key of the type list, but a property of every object.
      ['constructor', null],
    ] as const) {
      expect(mediaFileExtension(type, url), `${type} ${url}`).toBeNull()
    }
  })
})
