import { describe, expect, it } from 'vitest'
import {
  findImageReferences,
  imageExtension,
  imageMarkdown,
  imageMediaType,
  isImageMediaType,
  isImagePath,
  labelImageReferences,
  splitImageReferences,
} from './images'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const JPG = '/home/ann/.config/dez/assets/images/a1.jpg'

describe('findImageReferences', () => {
  it('finds each reference with its offsets and path', () => {
    const text = `Look ![${PNG}]() and\n![${JPG}]()!`
    const first = text.indexOf('![')
    const second = text.indexOf('![', first + 1)

    expect(findImageReferences(text)).toEqual([
      { from: first, to: first + PNG.length + 5, path: PNG },
      { from: second, to: second + JPG.length + 5, path: JPG },
    ])
  })

  it('takes a home folder with spaces, parentheses, and non-ASCII names', () => {
    const path = '/Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp'
    expect(findImageReferences(imageMarkdown(path)).map((ref) => ref.path)).toEqual([path])
  })

  it('takes an image folder right under the root', () => {
    expect(findImageReferences('![/assets/images/x.gif]()')).toHaveLength(1)
  })

  it.each([
    ['a URL', '![https://example.com/assets/images/x.png]()'],
    ['a relative path', '![assets/images/x.png]()'],
    ['another folder', '![/home/ann/Pictures/x.png]()'],
    ['a folder name that only ends in "assets"', '![/home/ann/myassets/images/x.png]()'],
    ['a subfolder of the image folder', '![/home/ann/.config/dez/assets/images/sub/x.png]()'],
    ['a destination', `![${PNG}](${PNG})`],
    ['a broken destination', `![${PNG}](`],
    ['no `!`', `[${PNG}]()`],
    ['an unsupported extension', '![/home/ann/.config/dez/assets/images/x.bmp]()'],
    ['an upper-case extension', '![/home/ann/.config/dez/assets/images/x.PNG]()'],
    ['a dot in the file name', '![/home/ann/.config/dez/assets/images/x.y.png]()'],
    ['a line break in the path', '![/home/ann\n/.config/dez/assets/images/x.png]()'],
    ['a bracket in the path', '![/home/a]b/.config/dez/assets/images/x.png]()'],
  ])('leaves %s as plain text', (_case, text) => {
    expect(findImageReferences(text)).toEqual([])
  })

  it('does not join a bracketed text with a later reference on its line', () => {
    const reference = imageMarkdown(PNG)
    const text = `![/notes] see ${reference}`

    expect(findImageReferences(text)).toEqual([
      { from: text.indexOf(reference), to: text.length, path: PNG },
    ])
  })
})

describe('isImagePath', () => {
  it('accepts exactly the paths whose markdown the recognizer finds', () => {
    for (const path of [PNG, JPG, '/assets/images/x.jpeg']) {
      expect(isImagePath(path)).toBe(true)
      expect(findImageReferences(imageMarkdown(path)).map((ref) => ref.path)).toEqual([path])
    }
    for (const path of ['C:\\Users\\ann\\.config\\dez/assets/images/x.png', './.config/dez/assets/images/x.png', '/home/[ann]/.config/dez/assets/images/x.png', `${PNG}\n`]) {
      expect(isImagePath(path)).toBe(false)
      expect(findImageReferences(imageMarkdown(path)).map((ref) => ref.path)).not.toEqual([path])
    }
  })
})

describe('splitImageReferences', () => {
  it('gives text and image pieces in order, with no empty text pieces', () => {
    expect(splitImageReferences(`![${PNG}]()![${JPG}]() What is this?\n`)).toEqual([
      { kind: 'image', path: PNG },
      { kind: 'image', path: JPG },
      { kind: 'text', text: ' What is this?\n' },
    ])
  })

  it('keeps whitespace-only text between images', () => {
    expect(splitImageReferences(`a\n![${PNG}]()\n\n![${JPG}]()`)).toEqual([
      { kind: 'text', text: 'a\n' },
      { kind: 'image', path: PNG },
      { kind: 'text', text: '\n\n' },
      { kind: 'image', path: JPG },
    ])
  })

  it('gives a text with no reference as one piece, and an empty text as none', () => {
    expect(splitImageReferences('![x](https://example.com/x.png)')).toEqual([
      { kind: 'text', text: '![x](https://example.com/x.png)' },
    ])
    expect(splitImageReferences('')).toEqual([])
  })
})

describe('labelImageReferences', () => {
  it('replaces each reference with [image] and keeps other images', () => {
    expect(labelImageReferences(`![${PNG}]() vs ![${JPG}]() vs ![x](y.png)`))
      .toBe('[image] vs [image] vs ![x](y.png)')
  })

  it('uses a given label as plain text', () => {
    expect(labelImageReferences(`a ![${PNG}]() b`, '$&')).toBe('a $& b')
    expect(labelImageReferences(`a ![${PNG}]() b`, '')).toBe('a  b')
  })
})

describe('image media types', () => {
  it('stores PNG, JPEG, GIF, and WebP as they are, and no other type', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].filter(isImageMediaType))
      .toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    for (const type of ['image/bmp', 'image/svg+xml', 'text/plain', '', 'constructor', 'toString']) {
      expect(isImageMediaType(type)).toBe(false)
    }
  })

  it('gives each stored type an extension that maps back to the same type', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      const path = `/home/ann/.config/dez/assets/images/x.${imageExtension(type)}`
      expect(isImagePath(path)).toBe(true)
      expect(imageMediaType(path)).toBe(type)
    }
    expect(imageExtension('image/jpeg')).toBe('jpg')
  })

  it('reads the type of a path from its extension', () => {
    expect(imageMediaType('/a/assets/images/x.jpeg')).toBe('image/jpeg')
    expect(imageMediaType('/a/assets/images/x.bmp')).toBeNull()
    expect(imageMediaType('/a/assets/images/x.constructor')).toBeNull()
    expect(imageMediaType('png')).toBeNull()
  })
})
