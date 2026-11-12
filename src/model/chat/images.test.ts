import { describe, expect, it } from 'vitest'
import {
  findImageReferences,
  imageExtension,
  imageMarkdown,
  imageMediaType,
  isImageMediaType,
  isImagePath,
  isLinkedImagePath,
  labelImageReferences,
  splitImageReferences,
  storedImageFile,
} from './images'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const JPG = '/home/ann/.config/dez/assets/images/a1.jpg'
const GENERATED = '/home/ann/.config/dez/assets/generated/images/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.webp'

describe('findImageReferences', () => {
  it('finds each reference with its offsets, path, and id', () => {
    const text = `Look ![${PNG}](id=a) and\n![${JPG}]()!`
    const first = text.indexOf('![')
    const second = text.indexOf('![', first + 1)

    expect(findImageReferences(text, 'agent')).toEqual([
      { from: first, to: first + PNG.length + 9, path: PNG, linked: false, id: 'a', metadata: [{ key: 'id', value: 'a' }] },
      { from: second, to: second + JPG.length + 5, path: JPG, linked: false, id: null, metadata: [] },
    ])
  })

  it('reads the metadata items in order, with unknown keys and escaped values', () => {
    const text = String.raw`![${PNG}](desc=a \| b \(c\) \\ d=e|id=zz|alt_2-x=)`
    const [reference] = findImageReferences(text, 'agent')

    expect(reference.to).toBe(text.length)
    expect(reference.id).toBe('zz')
    expect(reference.metadata).toEqual([
      { key: 'desc', value: String.raw`a | b (c) \ d=e` },
      { key: 'id', value: 'zz' },
      { key: 'alt_2-x', value: '' },
    ])
  })

  it('builds references whose metadata reads back the same', () => {
    const metadata = [{ key: 'id', value: 'b' }, { key: 'desc', value: String.raw`my (great) image | \ ok` }]
    const text = imageMarkdown(PNG, metadata)

    expect(findImageReferences(text, 'agent')).toEqual([{ from: 0, to: text.length, path: PNG, linked: false, id: 'b', metadata }])
    expect(imageMarkdown(PNG)).toBe(`![${PNG}]()`)
  })

  it('takes a home folder with spaces, parentheses, and non-ASCII names', () => {
    const path = '/Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp'
    expect(findImageReferences(imageMarkdown(path), 'agent').map((ref) => ref.path)).toEqual([path])
  })

  it('takes an image folder right under the root', () => {
    expect(findImageReferences('![/assets/images/x.gif]()', 'agent')).toHaveLength(1)
  })

  it('takes an image directly in the generated image folder', () => {
    expect(findImageReferences(`![${GENERATED}](id=b)`, 'agent').map((ref) => ref.path)).toEqual([GENERATED])
  })

  // In a user section these are linked references (see 'linked
  // references' below); in an agent section they are plain text.
  it.each([
    ['another folder', '![/home/ann/Pictures/x.png]()'],
    ['a folder name that only ends in "assets"', '![/home/ann/myassets/images/x.png]()'],
    ['a subfolder of the image folder', '![/home/ann/.config/dez/assets/images/sub/x.png]()'],
    ['the generated folder itself', '![/home/ann/.config/dez/assets/generated/x.png]()'],
    ['a subfolder of the generated image folder', '![/home/ann/.config/dez/assets/generated/images/sub/x.png]()'],
    ['the generated video folder', '![/home/ann/.config/dez/assets/generated/video/x.png]()'],
    ['a generated folder outside assets', '![/home/ann/.config/dez/generated/images/x.png]()'],
    ['an upper-case extension', '![/home/ann/.config/dez/assets/images/x.PNG]()'],
    ['a dot in the file name', '![/home/ann/.config/dez/assets/images/x.y.png]()'],
  ])('leaves %s as plain text in an agent section', (_case, text) => {
    expect(findImageReferences(text, 'agent')).toEqual([])
    expect(findImageReferences(text, 'user')).toHaveLength(1)
  })

  it.each([
    ['a URL', '![https://example.com/assets/images/x.png]()'],
    ['a relative path', '![assets/images/x.png]()'],
    ['a destination', `![${PNG}](${PNG})`],
    ['a broken destination', `![${PNG}](`],
    ['no `!`', `[${PNG}]()`],
    ['an unsupported extension', '![/home/ann/.config/dez/assets/images/x.bmp]()'],
    ['a line break in the path', '![/home/ann\n/.config/dez/assets/images/x.png]()'],
    ['a bracket in the path', '![/home/a]b/.config/dez/assets/images/x.png]()'],
    ['an item with no `=`', `![${PNG}](id)`],
    ['an upper-case key', `![${PNG}](ID=a)`],
    ['an empty item', `![${PNG}](id=a|)`],
    ['a key given twice', `![${PNG}](id=a|id=b)`],
    ['an id with an upper-case letter', `![${PNG}](id=A)`],
    ['an id with a digit', `![${PNG}](id=a1)`],
    ['an empty id', `![${PNG}](id=)`],
    ['an unescaped paren in a value', `![${PNG}](desc=a(b))`],
    ['a backslash that escapes nothing', String.raw`![${PNG}](desc=a\b)`],
    ['a line break in the metadata', `![${PNG}](id=a\n)`],
  ])('leaves %s as plain text in any section', (_case, text) => {
    expect(findImageReferences(text, 'agent')).toEqual([])
    expect(findImageReferences(text, 'user')).toEqual([])
  })

  it('does not join a bracketed text with a later reference on its line', () => {
    const reference = imageMarkdown(PNG)
    const text = `![/notes] see ${reference}`

    expect(findImageReferences(text, 'user')).toEqual([
      { from: text.indexOf(reference), to: text.length, path: PNG, linked: false, id: null, metadata: [] },
    ])
  })

  it('finds a reference that starts in the metadata of one that is not valid', () => {
    const inner = '![/a)/assets/images/b.png]()'
    const text = `![${PNG}](id=A|x=${inner}`

    expect(findImageReferences(text, 'agent').map((ref) => text.slice(ref.from, ref.to))).toEqual([inner])
  })
})

describe('isImagePath', () => {
  it('accepts exactly the paths whose markdown the recognizer finds in an agent section', () => {
    for (const path of [PNG, JPG, GENERATED, '/assets/images/x.jpeg']) {
      expect(isImagePath(path)).toBe(true)
      expect(findImageReferences(imageMarkdown(path), 'agent').map((ref) => ref.path)).toEqual([path])
    }
    for (const path of [
      'C:\\Users\\ann\\.config\\dez/assets/images/x.png',
      './.config/dez/assets/images/x.png',
      '/home/[ann]/.config/dez/assets/images/x.png',
      `${PNG}\n`,
      '/home/ann/.config/dez/assets/generated/audio/x.mp3',
      '/home/ann/.config/dez/assets/generated/video/x.mp4',
      '/home/ann/.cache/dez/media/x.png',
    ]) {
      expect(isImagePath(path)).toBe(false)
      expect(findImageReferences(imageMarkdown(path), 'agent').map((ref) => ref.path)).not.toEqual([path])
    }
  })
})

describe('linked references', () => {
  const LINKED = '/home/ann/Pictures/Trip (2024)/IMG_0001.JPG'

  it('counts a linked path in a user section only, with a `)` in its path and any letter case', () => {
    const text = `See ![${LINKED}](id=c) and ![${PNG}](id=a)`

    expect(findImageReferences(text, 'user').map(({ path, linked, id }) => ({ path, linked, id }))).toEqual([
      { path: LINKED, linked: true, id: 'c' },
      { path: PNG, linked: false, id: 'a' },
    ])
    expect(findImageReferences(text, 'agent').map((ref) => ref.path)).toEqual([PNG])
  })

  it('tells a linked path from a stored path and from a path that is no image', () => {
    for (const path of [LINKED, '/x.webp', '/home/ann/a.b/c.svg']) expect(isLinkedImagePath(path), path).toBe(true)
    for (const path of [
      PNG,
      GENERATED,
      'Pictures/x.png',
      '/home/ann/x.bmp',
      '/home/ann/x.png/',
      '/home/[ann]/x.png',
      '/home/ann\n/x.png',
      '/home/ann/x\uE000.png',
    ]) {
      expect(isLinkedImagePath(path), path).toBe(false)
    }
  })

  it('splits and labels a linked reference only in a user section', () => {
    const reference = `![${LINKED}]()`
    const text = `a ${reference} b`

    expect(splitImageReferences(text, 'user')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'image', path: LINKED, source: reference },
      { kind: 'text', text: ' b' },
    ])
    expect(labelImageReferences(text, 'user')).toBe('a [image] b')
    expect(labelImageReferences(text, 'agent')).toBe(text)
  })
})

describe('storedImageFile', () => {
  const appDir = '/home/ann/.config/dez'

  it('gives the app-file path of an image directly in an image folder of this app folder', () => {
    expect(storedImageFile(PNG, appDir)).toBe('assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png')
    expect(storedImageFile(JPG, appDir)).toBe('assets/images/a1.jpg')
    expect(storedImageFile(GENERATED, appDir)).toBe('assets/generated/images/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.webp')
  })

  it('gives null for any other path, so that no other file is read or deleted', () => {
    for (const path of [
      '/home/bob/.config/dez/assets/images/a1.jpg',
      '/home/ann/.config/dez2/assets/images/a1.jpg',
      '/home/ann/.config/dez/x/.config/dez/assets/images/a1.jpg',
      '/home/ann/.config/dez/assets/images/../assets/images/a1.jpg',
      '/home/ann/.config/dez/assets/images/sub/a1.jpg',
      '/home/bob/.config/dez/assets/generated/images/a1.jpg',
      '/home/ann/.config/dez/assets/generated/images/../../images/a1.jpg',
      '/home/ann/.config/dez/assets/images/generated/images/a1.jpg',
      '/home/ann/.config/dez/assets/generated/a1.jpg',
      '/home/ann/.config/dez/assets/images/.a1.jpg',
      '/home/ann/.config/dez/assets/images/a1.bmp',
      '/home/ann/.config/dez/app_state.json',
      'assets/images/a1.jpg',
    ]) {
      expect(storedImageFile(path, appDir), path).toBeNull()
    }
  })
})

describe('splitImageReferences', () => {
  it('gives text and image pieces in order, with no empty text pieces', () => {
    expect(splitImageReferences(`![${PNG}](id=a)![${JPG}]() What is this?\n`, 'agent')).toEqual([
      { kind: 'image', path: PNG, source: `![${PNG}](id=a)` },
      { kind: 'image', path: JPG, source: `![${JPG}]()` },
      { kind: 'text', text: ' What is this?\n' },
    ])
  })

  it('keeps whitespace-only text between images', () => {
    expect(splitImageReferences(`a\n![${PNG}]()\n\n![${JPG}]()`, 'agent')).toEqual([
      { kind: 'text', text: 'a\n' },
      { kind: 'image', path: PNG, source: `![${PNG}]()` },
      { kind: 'text', text: '\n\n' },
      { kind: 'image', path: JPG, source: `![${JPG}]()` },
    ])
  })

  it('gives a text with no reference as one piece, and an empty text as none', () => {
    expect(splitImageReferences('![x](https://example.com/x.png)', 'user')).toEqual([
      { kind: 'text', text: '![x](https://example.com/x.png)' },
    ])
    expect(splitImageReferences('', 'user')).toEqual([])
  })
})

describe('labelImageReferences', () => {
  it('replaces each reference with [image] and keeps other images', () => {
    expect(labelImageReferences(`![${PNG}](id=a) vs ![${JPG}]() vs ![x](y.png) vs ![${PNG}](id=A)`, 'user'))
      .toBe(`[image] vs [image] vs ![x](y.png) vs ![${PNG}](id=A)`)
  })

  it('uses a given label as plain text', () => {
    expect(labelImageReferences(`a ![${PNG}]() b`, 'agent', '$&')).toBe('a $& b')
    expect(labelImageReferences(`a ![${PNG}]() b`, 'agent', '')).toBe('a  b')
  })
})

describe('image media types', () => {
  it('stores PNG, JPEG, GIF, WebP, and SVG as they are, and no other type', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].filter(isImageMediaType))
      .toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
    for (const type of ['image/bmp', 'image/svg', 'image/avif', 'text/plain', '', 'constructor', 'toString']) {
      expect(isImageMediaType(type)).toBe(false)
    }
  })

  it('gives each stored type an extension that maps back to the same type', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const) {
      const path = `/home/ann/.config/dez/assets/images/x.${imageExtension(type)}`
      expect(isImagePath(path)).toBe(true)
      expect(imageMediaType(path)).toBe(type)
    }
    expect(imageExtension('image/jpeg')).toBe('jpg')
    expect(imageExtension('image/svg+xml')).toBe('svg')
  })

  it('reads the type of a path from its extension', () => {
    expect(imageMediaType('/a/assets/images/x.jpeg')).toBe('image/jpeg')
    expect(imageMediaType('/a/assets/generated/images/x.svg')).toBe('image/svg+xml')
    expect(imageMediaType('/a/assets/images/x.bmp')).toBeNull()
    expect(imageMediaType('/a/assets/images/x.constructor')).toBeNull()
    expect(imageMediaType('/home/ann/Photos/IMG_0001.JPG')).toBe('image/jpeg')
    expect(imageMediaType('/home/ann/Photos/x.Png')).toBe('image/png')
    expect(imageMediaType('png')).toBeNull()
  })
})
