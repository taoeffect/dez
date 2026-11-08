import { describe, expect, it } from 'vitest'
import {
  findImageReferences,
  holdsImagePath,
  imageExtension,
  imageMarkdown,
  imageMediaType,
  isImageMediaType,
  isImagePath,
  labelImageReferences,
  pastedImageIdChanges,
  splitImageReferences,
  storedImageFile,
  withoutImagePaths,
} from './images'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'
const JPG = '/home/ann/.config/dez/assets/images/a1.jpg'

describe('findImageReferences', () => {
  it('finds each reference with its offsets, path, and id', () => {
    const text = `Look ![${PNG}](id=a) and\n![${JPG}]()!`
    const first = text.indexOf('![')
    const second = text.indexOf('![', first + 1)

    expect(findImageReferences(text)).toEqual([
      { from: first, to: first + PNG.length + 9, path: PNG, id: 'a', metadata: [{ key: 'id', value: 'a' }] },
      { from: second, to: second + JPG.length + 5, path: JPG, id: null, metadata: [] },
    ])
  })

  it('reads the metadata items in order, with unknown keys and escaped values', () => {
    const text = String.raw`![${PNG}](desc=a \| b \(c\) \\ d=e|id=zz|alt_2-x=)`
    const [reference] = findImageReferences(text)

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

    expect(findImageReferences(text)).toEqual([{ from: 0, to: text.length, path: PNG, id: 'b', metadata }])
    expect(imageMarkdown(PNG)).toBe(`![${PNG}]()`)
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
  ])('leaves %s as plain text', (_case, text) => {
    expect(findImageReferences(text)).toEqual([])
  })

  it('does not join a bracketed text with a later reference on its line', () => {
    const reference = imageMarkdown(PNG)
    const text = `![/notes] see ${reference}`

    expect(findImageReferences(text)).toEqual([
      { from: text.indexOf(reference), to: text.length, path: PNG, id: null, metadata: [] },
    ])
  })

  it('finds a reference that starts in the metadata of one that is not valid', () => {
    const inner = '![/a)/assets/images/b.png]()'
    const text = `![${PNG}](id=A|x=${inner}`

    expect(findImageReferences(text).map((ref) => text.slice(ref.from, ref.to))).toEqual([inner])
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

describe('storedImageFile', () => {
  const appDir = '/home/ann/.config/dez'

  it('gives the app-file path of an image directly in the image folder of this app folder', () => {
    expect(storedImageFile(PNG, appDir)).toBe('assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png')
    expect(storedImageFile(JPG, appDir)).toBe('assets/images/a1.jpg')
  })

  it('gives null for any other path, so that no other file is read or deleted', () => {
    for (const path of [
      '/home/bob/.config/dez/assets/images/a1.jpg',
      '/home/ann/.config/dez2/assets/images/a1.jpg',
      '/home/ann/.config/dez/x/.config/dez/assets/images/a1.jpg',
      '/home/ann/.config/dez/assets/images/../assets/images/a1.jpg',
      '/home/ann/.config/dez/assets/images/sub/a1.jpg',
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
    expect(splitImageReferences(`![${PNG}](id=a)![${JPG}]() What is this?\n`)).toEqual([
      { kind: 'image', path: PNG, source: `![${PNG}](id=a)` },
      { kind: 'image', path: JPG, source: `![${JPG}]()` },
      { kind: 'text', text: ' What is this?\n' },
    ])
  })

  it('keeps whitespace-only text between images', () => {
    expect(splitImageReferences(`a\n![${PNG}]()\n\n![${JPG}]()`)).toEqual([
      { kind: 'text', text: 'a\n' },
      { kind: 'image', path: PNG, source: `![${PNG}]()` },
      { kind: 'text', text: '\n\n' },
      { kind: 'image', path: JPG, source: `![${JPG}]()` },
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
    expect(labelImageReferences(`![${PNG}](id=a) vs ![${JPG}]() vs ![x](y.png) vs ![${PNG}](id=A)`))
      .toBe(`[image] vs [image] vs ![x](y.png) vs ![${PNG}](id=A)`)
  })

  it('uses a given label as plain text', () => {
    expect(labelImageReferences(`a ![${PNG}]() b`, '$&')).toBe('a $& b')
    expect(labelImageReferences(`a ![${PNG}]() b`, '')).toBe('a  b')
  })
})

describe('withoutImagePaths', () => {
  it.each([
    ['empty parens', `![${PNG}]()`, '![image]()'],
    ['an id', `![${PNG}](id=a)`, '![image](id=a)'],
    ['unknown keys and escaped values', String.raw`![${PNG}](id=b|desc=a \| b \(c\) \\ d|x=)`, String.raw`![image](id=b|desc=a \| b \(c\) \\ d|x=)`],
    ['a home folder with spaces, parentheses, and non-ASCII names', '![/Users/Zoë Ann (work)/.config/dez/assets/images/x_1-2.webp](id=a)', '![image](id=a)'],
  ])('sends a reference with %s as ![image] and its metadata as it is', (_case, text, sent) => {
    expect(withoutImagePaths(text)).toBe(sent)
  })

  it.each([
    ['the source that the Backspace rule leaves', `![${PNG}](id=a`, '![image](id=a'],
    ['the link that the Delete rule leaves', `[${PNG}](id=a)`, '[image](id=a)'],
    ['a reference with an id that is not valid', `![${PNG}](id=A)`, '![image](id=A)'],
    ['a reference with a key given twice', `![${PNG}](id=a|id=b)`, '![image](id=a|id=b)'],
    ['a bare path', `see ${PNG} now`, 'see image now'],
  ])('takes the path out of %s', (_case, text, sent) => {
    expect(withoutImagePaths(text)).toBe(sent)
  })

  it('takes the paths in metadata values and every path on a line, also of another home', () => {
    expect(withoutImagePaths(`![${PNG}](id=a|desc=a /home/bob/.config/dez/assets/images/b.png) and ![${JPG}](id=b)`))
      .toBe('![image](id=a|desc=a image) and ![image](id=b)')
  })

  it.each(['jpg', 'jpeg', 'gif', 'webp'])('takes a path with the extension %s', (extension) => {
    expect(withoutImagePaths(`![/home/ann/.config/dez/assets/images/x.${extension}](id=a)`)).toBe('![image](id=a)')
  })

  it('leaves no part of a path in prose, also when it takes the prose before it', () => {
    for (const text of [`Compare a/b with ${PNG}.`, `See https://example.com/x and ${JPG}`, `file://${PNG}`, `${PNG}\n${JPG}`]) {
      const sent = withoutImagePaths(text)
      expect(sent, text).not.toContain('assets/images')
      expect(sent, text).not.toContain('/home/ann')
    }
  })

  it('gives a text with no image path back as it is', () => {
    for (const text of ['', 'Hi\n', '![x](https://example.com/x.png)', '/home/ann/Pictures/x.png', 'assets/images/x.png']) {
      expect(withoutImagePaths(text)).toBe(text)
    }
  })

  // Many web projects have an `assets/images` folder; only Dez's own folder
  // is private.
  it('leaves the paths of an assets/images folder that is not Dez\'s as they are', () => {
    for (const text of [
      'import logo from \'../assets/images/logo.png\'',
      'cp ~/Downloads/hero.jpg app/assets/images/hero.jpg',
      '<link href="/css/main.css"><img src="/assets/images/logo.png" alt="logo">',
      'my logo at src/assets/images/logo.png doesn\'t load',
      'https://example.com/assets/images/logo.png',
      '/home/ann/.config/dez2/assets/images/a1.jpg',
    ]) {
      expect(withoutImagePaths(text)).toBe(text)
    }
  })

  // A regex that rescans a line from each `/` takes seconds on a long line,
  // and every send scrubs every message.
  it('takes linear time on a long line with many slashes', () => {
    const line = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(16 * 1024)
    const started = performance.now()
    const sent = withoutImagePaths(`${line} ${PNG}`)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(sent).toBe(`${line.slice(0, line.indexOf('/'))}image`)
  })
})

describe('holdsImagePath', () => {
  it('finds an image path in a reference, in prose, and in JSON, on every call', () => {
    for (let call = 0; call < 2; call++) {
      expect(holdsImagePath(`a ![${PNG}](id=a)`)).toBe(true)
      expect(holdsImagePath(`a [${PNG}](id=a)`)).toBe(true)
      expect(holdsImagePath(JSON.stringify({ thinking: `The user sent\n${JPG}` }))).toBe(true)
    }
  })

  it('finds no path in other text', () => {
    expect(holdsImagePath('/home/ann/Pictures/x.png and assets/images/x.png')).toBe(false)
    expect(holdsImagePath(JSON.stringify({ thinking: 'The logo is in /var/www/app/assets/images/logo.png' }))).toBe(false)
  })
})

describe('pastedImageIdChanges', () => {
  const image = (name: string) => `/home/ann/.config/dez/assets/images/${name}.png`

  /** `before` + `pasted` + `after` as the conversation after the paste,
   *  with the id changes applied. */
  function paste(pasted: string, before = '', after = ''): string {
    const text = before + pasted + after
    const changes = pastedImageIdChanges(text, [{ from: before.length, to: before.length + pasted.length }])
    return changes.reduceRight((result, { from, to, insert }) => result.slice(0, from) + insert + result.slice(to), text)
  }

  it('gives pasted images with no id the ids after the highest one in the conversation, and keeps their other items', () => {
    const before = `![${image('a')}](id=a) ![${image('c')}](id=c)\n`

    expect(paste(`![${image('d')}]()\n![${image('e')}](desc=x)`, before))
      .toBe(`${before}![${image('d')}](id=d)\n![${image('e')}](id=e|desc=x)`)
  })

  it('keeps a pasted id that no other image has, and the id of the same image', () => {
    const before = `![${image('a')}](id=a) `
    const pasted = `![${image('a')}](id=a) ![${image('k')}](id=k)`

    expect(paste(pasted, before)).toBe(before + pasted)
  })

  it('gives a pasted image the next id when another image has its id, in the conversation or earlier in the paste', () => {
    const before = `![${image('a')}](id=a) `

    expect(paste(`![${image('x')}](desc=x|id=a) ![${image('y')}](id=c) ![${image('z')}](id=c)`, before))
      .toBe(`${before}![${image('x')}](desc=x|id=d) ![${image('y')}](id=c) ![${image('z')}](id=e)`)
  })

  it.each([
    [['b'], 'c'],
    [['z'], 'aa'],
    [['ab'], 'ac'],
    [['az'], 'ba'],
    [['zz'], 'aaa'],
    [['y', 'ab'], 'ac'],
  ])('counts ids like spreadsheet columns: after %j comes %s', (ids, next) => {
    const before = ids.map((id, index) => `![${image(`old${index}`)}](id=${id})\n`).join('')

    expect(paste(`![${image('new')}]()`, before)).toBe(`${before}![${image('new')}](id=${next})`)
  })

  it('changes no reference that was not pasted whole', () => {
    // An old reference with no id, a reference that the paste only
    // completed, and a hand-edited clash all stay as they are.
    const before = `![${image('a')}]() ![${image('b')}](id=x) ![${image('c')}](id=x) ![${image('d')}](`

    expect(paste(')', before)).toBe(`${before})`)
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
