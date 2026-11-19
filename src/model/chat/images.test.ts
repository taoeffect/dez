import { describe, expect, it } from 'vitest'
import {
  findImageReferences,
  IMAGE_KEPT_KEY,
  imageExtension,
  imageIdChange,
  imageMarkdown,
  imageMediaType,
  imageReferenceTextWithKeptMark,
  isImageMediaType,
  isImagePath,
  isKeptImage,
  isLinkedImagePath,
  KEPT_MARK_VALUE,
  labelImageReferences,
  splitImageReferences,
  storedImageFile,
} from './images'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const JPG = '/home/ann/.config/dez/assets/images/a1.jpg'
const GENERATED = '/home/ann/.config/dez/assets/generated/images/0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60.webp'

describe('findImageReferences', () => {
  it('finds each reference with its offsets, path, and id', () => {
    const text = `Look ![id=a](${PNG}) and\n![](${JPG})!`
    const first = text.indexOf('![')
    const second = text.indexOf('![', first + 1)

    expect(findImageReferences(text, 'agent')).toEqual([
      { from: first, to: first + PNG.length + 9, path: PNG, linked: false, id: 'a', metadata: [{ key: 'id', value: 'a' }] },
      { from: second, to: second + JPG.length + 5, path: JPG, linked: false, id: null, metadata: [] },
    ])
  })

  it('reads the metadata items in order, with unknown keys and escaped values', () => {
    const text = String.raw`![desc=a \| b (c) \[d\] \\ e=f|id=zz|alt_2-x=](${PNG})`
    const [reference] = findImageReferences(text, 'agent')

    expect(reference.to).toBe(text.length)
    expect(reference.id).toBe('zz')
    expect(reference.metadata).toEqual([
      { key: 'desc', value: String.raw`a | b (c) [d] \ e=f` },
      { key: 'id', value: 'zz' },
      { key: 'alt_2-x', value: '' },
    ])
  })

  it('builds references whose metadata reads back the same', () => {
    const metadata = [{ key: 'id', value: 'b' }, { key: 'desc', value: String.raw`my (great) [image] | \ ok` }]
    const text = imageMarkdown(PNG, metadata)

    expect(findImageReferences(text, 'agent')).toEqual([{ from: 0, to: text.length, path: PNG, linked: false, id: 'b', metadata }])
    expect(imageMarkdown(PNG)).toBe(`![](${PNG})`)
  })

  it('writes a path with a space or a paren in <…>, and reads a path in either form', () => {
    const spaced = '/Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp'
    const parens = '/home/ann/Trip(2024)/x.png'

    expect(imageMarkdown(spaced, [{ key: 'id', value: 'a' }])).toBe(`![id=a](<${spaced}>)`)
    expect(imageMarkdown(parens)).toBe(`![](<${parens}>)`)
    expect(findImageReferences(imageMarkdown(spaced), 'agent').map((ref) => ref.path)).toEqual([spaced])
    expect(findImageReferences(imageMarkdown(parens), 'user').map((ref) => ref.path)).toEqual([parens])
    expect(findImageReferences(`![id=a](<${PNG}>)`, 'agent').map((ref) => ref.path)).toEqual([PNG])
  })

  it('takes an image folder right under the root', () => {
    expect(findImageReferences('![](/assets/images/x.gif)', 'agent')).toHaveLength(1)
  })

  it('takes an image directly in the generated image folder', () => {
    expect(findImageReferences(`![id=b](${GENERATED})`, 'agent').map((ref) => ref.path)).toEqual([GENERATED])
  })

  // In a user section these are linked references (see 'linked
  // references' below); in an agent section they are plain text.
  it.each([
    ['another folder', '![](/home/ann/Pictures/x.png)'],
    ['a folder name that only ends in "assets"', '![](/home/ann/myassets/images/x.png)'],
    ['a subfolder of the image folder', '![](/home/ann/.config/dez/assets/images/sub/x.png)'],
    ['the generated folder itself', '![](/home/ann/.config/dez/assets/generated/x.png)'],
    ['a subfolder of the generated image folder', '![](/home/ann/.config/dez/assets/generated/images/sub/x.png)'],
    ['the generated video folder', '![](/home/ann/.config/dez/assets/generated/video/x.png)'],
    ['a generated folder outside assets', '![](/home/ann/.config/dez/generated/images/x.png)'],
    ['an upper-case extension', '![](/home/ann/.config/dez/assets/images/x.PNG)'],
    ['a dot in the file name', '![](/home/ann/.config/dez/assets/images/x.y.png)'],
  ])('leaves %s as plain text in an agent section', (_case, text) => {
    expect(findImageReferences(text, 'agent')).toEqual([])
    expect(findImageReferences(text, 'user')).toHaveLength(1)
  })

  it.each([
    ['a URL', '![](https://example.com/assets/images/x.png)'],
    ['a relative path', '![](assets/images/x.png)'],
    ['the old form, with the path in the alt text', `![${PNG}](id=a)`],
    ['a broken destination', `![](${PNG}`],
    ['a `<` with no `>`', `![](<${PNG})`],
    ['no `!`', `[](${PNG})`],
    ['a space in a bare path', '![](/home/ann/my files/.config/dez/assets/images/x.png)'],
    ['a paren in a bare path', '![](/home/ann/a(1)/.config/dez/assets/images/x.png)'],
    ['a `<` in the path', '![](</home/a<b/.config/dez/assets/images/x.png>)'],
    ['a `>` in the path', '![](/home/a>b/.config/dez/assets/images/x.png)'],
    ['an unsupported extension', '![](/home/ann/.config/dez/assets/images/x.bmp)'],
    ['a line break in the path', '![](</home/ann\n/.config/dez/assets/images/x.png>)'],
    ['a bracket in the path', '![](/home/a]b/.config/dez/assets/images/x.png)'],
    ['an item with no `=`', `![id](${PNG})`],
    ['an upper-case key', `![ID=a](${PNG})`],
    ['an empty item', `![id=a|](${PNG})`],
    ['a key given twice', `![id=a|id=b](${PNG})`],
    ['an id with an upper-case letter', `![id=A](${PNG})`],
    ['an id with a digit', `![id=a1](${PNG})`],
    ['an empty id', `![id=](${PNG})`],
    ['an unescaped bracket in a value', `![desc=a[b]](${PNG})`],
    ['a backslash that escapes nothing', String.raw`![desc=a\(b\)](${PNG})`],
    ['a line break in the metadata', `![id=a\n](${PNG})`],
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

  it('finds a reference right after one that is not valid', () => {
    const valid = `![id=b](${JPG})`
    const text = `![id=A](${PNG})${valid}`

    expect(findImageReferences(text, 'agent').map((ref) => text.slice(ref.from, ref.to))).toEqual([valid])
  })

  describe('in Markdown code', () => {
    const reference = `![id=a](${PNG})`
    const ids = (text: string, rule: 'user' | 'agent', inCode?: boolean) => findImageReferences(text, rule, { inCode }).map((ref) => text.slice(ref.from, ref.to))

    it.each([
      ['a fence', `\`\`\`\n${reference}\n\`\`\``],
      ['a fence with no closer', `Look:\n\n~~~\n${reference}`],
      ['a code span', `Type \`${reference}\` to show it.`],
      ['an indented block', `Type:\n\n    ${reference}`],
    ])('leaves a reference in %s as plain text, unless code is asked for', (_case, text) => {
      expect(ids(text, 'user')).toStrictEqual([])
      expect(ids(text, 'agent')).toStrictEqual([])
      expect(ids(text, 'user', true)).toStrictEqual([reference])
    })

    it('finds the reference after the closer', () => {
      const after = `![id=b](${JPG})`

      expect(ids(`\`\`\`\n${reference}\n\`\`\`\n${after}`, 'user')).toStrictEqual([after])
    })

    it('ends the code of a reply at a line of Dez, and not the code of a user text', () => {
      const text = `\`\`\`\nx\n<dez:audio id="b" type="audio/wav"/>\n${reference}`

      expect(ids(text, 'agent')).toStrictEqual([reference])
      expect(ids(text, 'user')).toStrictEqual([])
    })
  })
})

describe('imageIdChange', () => {
  const changed = (text: string, id: string) => {
    const [reference] = findImageReferences(text, 'user')
    const change = imageIdChange(reference, id)
    return text.slice(0, change.from) + change.insert + text.slice(change.to)
  }

  it('changes only the alt text, with its escapes, and keeps the destination as it is', () => {
    expect(changed(String.raw`See ![desc=a \| \[b\] (c) \\|id=c](<${PNG}>) now`, 'f')).toBe(String.raw`See ![desc=a \| \[b\] (c) \\|id=f](<${PNG}>) now`)
    expect(changed('![](/home/ann/x.png)', 'g')).toBe('![id=g](/home/ann/x.png)')
    expect(changed(`![x=1](${PNG})`, 'h')).toBe(`![id=h|x=1](${PNG})`)
  })
})

describe('isImagePath', () => {
  it('accepts exactly the paths whose markdown the recognizer finds in an agent section', () => {
    for (const path of [PNG, JPG, GENERATED, '/assets/images/x.jpeg', '/Users/Zoë Ann (work)/.config/dez/assets/images/x.png']) {
      expect(isImagePath(path)).toBe(true)
      expect(findImageReferences(imageMarkdown(path), 'agent').map((ref) => ref.path)).toEqual([path])
    }
    for (const path of [
      'C:\\Users\\ann\\.config\\dez/assets/images/x.png',
      './.config/dez/assets/images/x.png',
      '/home/[ann]/.config/dez/assets/images/x.png',
      '/home/<ann>/.config/dez/assets/images/x.png',
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

  it('counts a linked path in a user section only, with parens in its path and any letter case', () => {
    const text = `See ![id=c](<${LINKED}>) and ![id=a](${PNG})`

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
      '/home/<ann>/x.png',
      '/home/ann\n/x.png',
      '/home/ann/x\uE000.png',
    ]) {
      expect(isLinkedImagePath(path), path).toBe(false)
    }
  })

  it('splits and labels a linked reference only in a user section', () => {
    const reference = `![](<${LINKED}>)`
    const text = `a ${reference} b`

    expect(splitImageReferences(text, 'user')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'image', path: LINKED, source: reference },
      { kind: 'text', text: ' b' },
    ])
    expect(labelImageReferences(text, 'user')).toBe('a [image] b')
    expect(labelImageReferences(text, 'agent')).toBe(text)
  })

  // The rule of a compaction block: only the paths of its `linked` list.
  it('counts a linked path for a set of paths only when the set holds it', () => {
    const other = '/home/ann/Pictures/other.png'
    const text = `![id=c](<${LINKED}>) ![](${other}) ![id=a](${PNG})`

    expect(findImageReferences(text, new Set([LINKED])).map(({ path, linked }) => ({ path, linked }))).toEqual([
      { path: LINKED, linked: true },
      { path: PNG, linked: false },
    ])
    expect(findImageReferences(text, new Set()).map((ref) => ref.path)).toEqual([PNG])
    expect(labelImageReferences(text, new Set([other]))).toBe(`![id=c](<${LINKED}>) [image] [image]`)
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
    expect(splitImageReferences(`![id=a](${PNG})![](${JPG}) What is this?\n`, 'agent')).toEqual([
      { kind: 'image', path: PNG, source: `![id=a](${PNG})` },
      { kind: 'image', path: JPG, source: `![](${JPG})` },
      { kind: 'text', text: ' What is this?\n' },
    ])
  })

  it('keeps whitespace-only text between images', () => {
    expect(splitImageReferences(`a\n![](${PNG})\n\n![](${JPG})`, 'agent')).toEqual([
      { kind: 'text', text: 'a\n' },
      { kind: 'image', path: PNG, source: `![](${PNG})` },
      { kind: 'text', text: '\n\n' },
      { kind: 'image', path: JPG, source: `![](${JPG})` },
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
    expect(labelImageReferences(`![id=a](${PNG}) vs ![](${JPG}) vs ![x](y.png) vs ![id=A](${PNG})`, 'user'))
      .toBe(`[image] vs [image] vs ![x](y.png) vs ![id=A](${PNG})`)
  })

  it('uses a given label as plain text', () => {
    expect(labelImageReferences(`a ![](${PNG}) b`, 'agent', '$&')).toBe('a $& b')
    expect(labelImageReferences(`a ![](${PNG}) b`, 'agent', '')).toBe('a  b')
  })
})

describe('imageReferenceTextWithKeptMark and isKeptImage', () => {
  const kept = { key: IMAGE_KEPT_KEY, value: KEPT_MARK_VALUE }

  it('adds the kept mark after the other items, and only once', () => {
    for (const metadata of [[{ key: 'id', value: 'a' }, { key: 'tool', value: 'image' }], [kept, { key: 'id', value: 'a' }, { key: 'tool', value: 'image' }]]) {
      const [reference] = findImageReferences(imageMarkdown(PNG, metadata), 'agent')
      const [marked] = findImageReferences(imageReferenceTextWithKeptMark(reference, true), 'agent')

      expect(marked.path).toBe(PNG)
      expect(marked.metadata).toStrictEqual([{ key: 'id', value: 'a' }, { key: 'tool', value: 'image' }, kept])
      expect(isKeptImage(marked)).toBe(true)
    }
  })

  it('removes the kept mark and keeps the other items in their order', () => {
    const [reference] = findImageReferences(imageMarkdown(PNG, [{ key: 'id', value: 'a' }, kept, { key: 'desc', value: 'a (red) | b' }]), 'agent')
    const [plain] = findImageReferences(imageReferenceTextWithKeptMark(reference, false), 'agent')

    expect(isKeptImage(reference)).toBe(true)
    expect(plain.metadata).toStrictEqual([{ key: 'id', value: 'a' }, { key: 'desc', value: 'a (red) | b' }])
    expect(isKeptImage(plain)).toBe(false)
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
