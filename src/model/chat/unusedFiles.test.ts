import { describe, expect, it } from 'vitest'
import { imageMarkdown } from './images'
import { mediaTagText } from './mediaTags'
import { STORED_FILE_FOLDERS, UNUSED_FILE_MIN_AGE_MS, oldStoredFiles, removeNamedFiles, storedFilePath } from './unusedFiles'

const APP_DIR = '/home/ann/.config/dez'
const PNG = '5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const WEBP = '0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.webp'
const MP4 = 'a_1-b.mp4'
const NOW = 1_800_000_000_000
const OLD = NOW - UNUSED_FILE_MIN_AGE_MS

// The names of `names` that `text` does not hold.
function notNamed(text: string, names: string[] = [PNG, WEBP, MP4]): string[] {
  const left = new Set(names)
  removeNamedFiles(left, text)
  return [...left]
}

describe('STORED_FILE_FOLDERS', () => {
  it('holds the folder of each kind of stored file', () => {
    expect([...STORED_FILE_FOLDERS].sort()).toEqual([
      'assets/generated/audio',
      'assets/generated/images',
      'assets/generated/video',
      'assets/images',
    ])
  })
})

describe('storedFilePath', () => {
  it.each([
    `assets/images/${PNG}`,
    `assets/generated/images/${WEBP}`,
    `assets/generated/video/${MP4}`,
    'assets/generated/audio/speech.mp3',
  ])('gives the app-file path of %s', (file) => {
    expect(storedFilePath(`${APP_DIR}/${file}`, APP_DIR)).toBe(file)
  })

  it.each([
    // The temp file of a download that runs.
    `${APP_DIR}/assets/generated/video/${MP4}.4012.7.tmp`,
    // Not an image type that Dez stores.
    `${APP_DIR}/assets/images/notes.txt`,
    // A folder below a stored-file folder.
    `${APP_DIR}/assets/images/more/${PNG}`,
    // Another Dez folder.
    `/home/bob/.config/dez/assets/images/${PNG}`,
    `${APP_DIR}/conversations/${PNG}`,
  ])('gives null for %s', (path) => {
    expect(storedFilePath(path, APP_DIR)).toBeNull()
  })
})

describe('oldStoredFiles', () => {
  it('gives the stored files that are old enough, with their sizes', () => {
    const files = oldStoredFiles('assets/images', [
      { name: PNG, updatedAt: OLD, size: 10 },
      { name: 'b.jpg', updatedAt: 0, size: 2_000_000 },
      { name: 'one-ms-young.gif', updatedAt: OLD + 1, size: 3 },
      { name: 'new.png', updatedAt: NOW, size: 4 },
      // A clock that went back must not make a new file look old.
      { name: 'future.png', updatedAt: NOW + 86_400_000, size: 5 },
      { name: 'notes.txt', updatedAt: 0, size: 6 },
      { name: `${PNG}.4012.7.tmp`, updatedAt: 0, size: 7 },
    ], APP_DIR, NOW)

    expect(files).toStrictEqual([
      { path: `assets/images/${PNG}`, size: 10 },
      { path: 'assets/images/b.jpg', size: 2_000_000 },
    ])
  })

  // As the two trash rules: an image folder holds only the image types that
  // Dez stores, and a clip folder holds a clip of any file type.
  it('takes the files that the trash of the folder can delete', () => {
    const entries = [{ name: MP4, updatedAt: 0, size: 1 }, { name: PNG, updatedAt: 0, size: 2 }]

    expect(oldStoredFiles('assets/generated/images', entries, APP_DIR, NOW)).toStrictEqual([{ path: `assets/generated/images/${PNG}`, size: 2 }])
    expect(oldStoredFiles('assets/generated/video', entries, APP_DIR, NOW)).toStrictEqual([
      { path: `assets/generated/video/${MP4}`, size: 1 },
      { path: `assets/generated/video/${PNG}`, size: 2 },
    ])
  })

  it('gives no file for a Dez folder whose path the recognizers refuse', () => {
    expect(oldStoredFiles('assets/images', [{ name: PNG, updatedAt: 0, size: 1 }], './.config/dez', NOW)).toEqual([])
  })
})

describe('removeNamedFiles', () => {
  it('takes out the file of an image reference', () => {
    const text = `Look: ${imageMarkdown(`${APP_DIR}/assets/images/${PNG}`, [{ key: 'id', value: 'a' }])} and more`

    expect(notNamed(text)).toEqual([WEBP, MP4])
  })

  it('takes out the file of a media tag', () => {
    const tag = mediaTagText({ kind: 'video', id: 'b', type: 'video/mp4', src: `${APP_DIR}/assets/generated/video/${MP4}`, url: null, expires: null, other: [] })

    expect(notNamed(`A clip:\n${tag}\n`)).toEqual([PNG, WEBP])
  })

  it('takes out a file that plain text names, with any route to its folder', () => {
    expect(notNamed(`See ~/.config/dez/assets/generated/images/../images/${WEBP}, please.`)).toEqual([PNG, MP4])
    expect(notNamed(`The file ${PNG}`)).toEqual([WEBP, MP4])
    expect(notNamed(`${MP4} is the file`)).toEqual([PNG, WEBP])
    expect(notNamed(`"${PNG}"${WEBP}:${MP4}`)).toEqual([])
  })

  it('takes out a name that follows another name part', () => {
    expect(notNamed(`copy.of.${PNG}`)).toEqual([WEBP, MP4])
    expect(notNamed(`${PNG}.bak and ${MP4}-old`)).toEqual([WEBP])
  })

  it('keeps a name that is only a part of another name', () => {
    expect(notNamed(`x${PNG} ${WEBP}s _${MP4}`)).toEqual([PNG, WEBP, MP4])
    expect(notNamed(`${PNG.slice(0, -4)} .png ${PNG.replace('.', ' .')}`)).toEqual([PNG, WEBP, MP4])
  })

  it('keeps every name for a text with no name', () => {
    expect(notNamed('')).toEqual([PNG, WEBP, MP4])
    expect(notNamed('.')).toEqual([PNG, WEBP, MP4])
    expect(notNamed('No file here. None... at all.')).toEqual([PNG, WEBP, MP4])
  })

  // A regex for a file name took seconds on such a text.
  it('reads a long run of name characters in a short time', () => {
    const run = 'A'.repeat(2_000_000)
    const start = performance.now()

    expect(notNamed(`${run}${PNG}.${run} /${WEBP}`)).toEqual([PNG, MP4])
    expect(performance.now() - start).toBeLessThan(1000)
  })
})
