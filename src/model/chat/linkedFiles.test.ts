import { describe, expect, it } from 'vitest'
import { imageMarkdown } from './images'
import { dropCopiesFile, holdsLinkedFile, isInFolder, pairDroppedFiles } from './linkedFiles'
import { mediaTagText } from './mediaTags'

describe('isInFolder and dropCopiesFile', () => {
  it('takes the folder itself and every path under it, with or without a trailing slash', () => {
    for (const folder of ['/tmp', '/tmp/', '/tmp//']) {
      expect(isInFolder('/tmp', folder), folder).toBe(true)
      expect(isInFolder('/tmp/a.png', folder), folder).toBe(true)
      expect(isInFolder('/tmp/sub/a.png', folder), folder).toBe(true)
    }
  })

  it('takes no path that only starts with the name of the folder', () => {
    expect(isInFolder('/tmpx/a.png', '/tmp')).toBe(false)
    expect(isInFolder('/tm', '/tmp')).toBe(false)
    expect(isInFolder('/home/u/tmp/a.png', '/tmp')).toBe(false)
  })

  it('copies a file in any of the copy folders, and only then', () => {
    const folders = ['/tmp', '/var/tmp', '/home/u/.config/dez', '/home/u/.cache/dez']
    for (const path of ['/tmp/a.png', '/var/tmp/b.mp4', '/home/u/.config/dez/assets/images/c.png', '/home/u/.cache/dez/media/d.mp3']) {
      expect(dropCopiesFile(path, folders), path).toBe(true)
    }
    for (const path of ['/home/u/Pictures/a.png', '/home/u/.config/dez2/a.png', '/var/a.png']) {
      expect(dropCopiesFile(path, folders), path).toBe(false)
    }
    expect(dropCopiesFile('/tmp/a.png', [])).toBe(false)
  })
})

describe('holdsLinkedFile', () => {
  const image = (path: string) => imageMarkdown(path, [{ key: 'id', value: 'a' }])
  const clip = (src: string | null, url: string | null = null) => mediaTagText({ kind: 'audio', id: 'b', type: 'audio/wav', src, url, expires: null, other: [] })

  it('finds a linked image reference and a clip tag with a linked src', () => {
    expect(holdsLinkedFile(`See ${image('/home/u/Pictures/My photo (1).JPG')} here`)).toBe(true)
    expect(holdsLinkedFile(`Hear\n${clip('/home/u/Music/song.wav')}`)).toBe(true)
  })

  it('takes no stored file, temp copy, URL, or text that only reads like a reference or a tag', () => {
    const texts = [
      image('/home/u/.config/dez/assets/images/a1.png'),
      image('/home/u/.config/dez/assets/generated/images/a1.png'),
      clip('/home/u/.config/dez/assets/audio/a1.wav'),
      clip('/home/u/.config/dez/assets/generated/audio/a1.wav'),
      clip('/home/u/.cache/dez/media/a1.wav', 'https://cdn.example/a1.wav'),
      clip(null, 'https://cdn.example/a1.wav'),
      `Text ${clip('/home/u/Music/song.wav')}`,
      'The file /home/u/Pictures/a.png, typed in prose.',
    ]
    for (const text of texts) expect(holdsLinkedFile(text), text).toBe(false)
  })
})

describe('pairDroppedFiles', () => {
  it('gives each file the path of the same name and size, in the order of the files', () => {
    const dragged = [
      { path: '/home/u/Pictures/b.png', size: 20 },
      { path: '/home/u/Pictures/a.png', size: 10 },
    ]
    expect(pairDroppedFiles([{ name: 'a.png', size: 10 }, { name: 'b.png', size: 20 }], dragged))
      .toStrictEqual(['/home/u/Pictures/a.png', '/home/u/Pictures/b.png'])
  })

  it('matches a name in NFC to a path in NFD, and the other way', () => {
    const nfc = 'café.png'.normalize('NFC')
    const nfd = 'café.png'.normalize('NFD')
    expect(pairDroppedFiles([{ name: nfc, size: 5 }], [{ path: `/Users/u/${nfd}`, size: 5 }])).toStrictEqual([`/Users/u/${nfd}`])
    expect(pairDroppedFiles([{ name: nfd, size: 5 }], [{ path: `/Users/u/${nfc}`, size: 5 }])).toStrictEqual([`/Users/u/${nfc}`])
  })

  it('gives null for a file with no path of the same name and a known, same size', () => {
    expect(pairDroppedFiles([{ name: 'a.png', size: 10 }], [{ path: '/home/u/a.png', size: 11 }])).toStrictEqual([null])
    expect(pairDroppedFiles([{ name: 'a.png', size: 10 }], [{ path: '/home/u/a.png', size: null }])).toStrictEqual([null])
    expect(pairDroppedFiles([{ name: 'a.png', size: 10 }], [{ path: '/home/u/A.png', size: 10 }])).toStrictEqual([null])
    expect(pairDroppedFiles([{ name: 'a.png', size: 10 }], [])).toStrictEqual([null])
  })

  it('gives null when two paths fit a file, or two files fit a path, and pairs the other files', () => {
    const twoPaths = pairDroppedFiles(
      [{ name: 'a.png', size: 10 }, { name: 'c.png', size: 30 }],
      [{ path: '/home/u/x/a.png', size: 10 }, { path: '/home/u/y/a.png', size: 10 }, { path: '/home/u/c.png', size: 30 }],
    )
    expect(twoPaths).toStrictEqual([null, '/home/u/c.png'])

    const twoFiles = pairDroppedFiles(
      [{ name: 'a.png', size: 10 }, { name: 'a.png', size: 10 }],
      [{ path: '/home/u/a.png', size: 10 }],
    )
    expect(twoFiles).toStrictEqual([null, null])
  })
})
