import { describe, expect, it } from 'vitest'
import { newMediaIds, pastedMediaIdChanges } from './mediaIds'
import { mediaTagText } from './mediaTags'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'

/** The tag of a clip with this id. Clips with the same kind and `url` are
 *  the same clip. */
function clip(id: string, kind: 'audio' | 'video' = 'video', url = 'https://cdn.example/clip'): string {
  return mediaTagText({ kind, id, type: `${kind}/mp4`, src: null, url, expires: null, other: [] })
}

describe('pastedMediaIdChanges', () => {
  const image = (name: string) => `/home/ann/.config/dez/assets/images/${name}.png`

  /** `before` + `pasted` + `after` as the conversation after the paste,
   *  with the id changes applied. */
  function paste(pasted: string, before = '', after = ''): string {
    const text = before + pasted + after
    const changes = pastedMediaIdChanges(text, [{ from: before.length, to: before.length + pasted.length }])
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

  it('gives a pasted image with no id the id after the highest one of the images and the clips', () => {
    const before = `![${image('a')}](id=a)\n\u001E\n${clip('d')}\n\u001E\n`

    expect(paste(`![${image('new')}]()`, before)).toBe(`${before}![${image('new')}](id=e)`)
  })

  it('gives a pasted image the next id when a clip has its id, before or after the paste', () => {
    const before = `${clip('b')}\n\u001E\n`
    const after = `\n\u001E\n${clip('c', 'audio')}`

    expect(paste(`![${image('x')}](id=b) ![${image('y')}](id=c) ![${image('z')}](id=a)`, before, after))
      .toBe(`${before}![${image('x')}](id=d) ![${image('y')}](id=e) ![${image('z')}](id=a)${after}`)
  })

  it('gives a pasted clip the next id when an image or another clip has its id, and keeps its other attributes', () => {
    const before = `![${image('a')}](id=a)\n\u001E\n${clip('b')}\n\u001E\n`
    const tag = { kind: 'video', type: 'video/mp4', src: '/home/ann/.cache/dez/media/x.mp4', url: null, expires: '2026-11-11T09:30:00.000Z', other: [{ name: 'job', value: 'j "1"' }] } as const

    expect(paste(`${clip('a', 'audio')}\n${mediaTagText({ ...tag, id: 'b' })}`, before))
      .toBe(`${before}${clip('c', 'audio')}\n${mediaTagText({ ...tag, id: 'd' })}`)
  })

  it('keeps the id of a pasted copy of a clip, and a pasted id that no other image or clip has', () => {
    const before = `${clip('a')}\n`
    const pasted = `${clip('a')}\n${clip('k', 'audio')}`

    expect(paste(pasted, before)).toBe(before + pasted)
  })

  it('gives the new ids in doc order when a pasted clip and a pasted image both have a taken id', () => {
    const before = `![${image('a')}](id=a)\n${clip('b')}\n`

    expect(paste(`${clip('a', 'video', 'https://cdn.example/other')}\n![${image('x')}](id=b)`, before))
      .toBe(`${before}${clip('c', 'video', 'https://cdn.example/other')}\n![${image('x')}](id=d)`)
    expect(paste(`![${image('x')}](id=b)\n${clip('a', 'video', 'https://cdn.example/other')}`, before))
      .toBe(`${before}![${image('x')}](id=c)\n${clip('d', 'video', 'https://cdn.example/other')}`)
  })

  it('lets the first of two pasted assets keep an id that both have', () => {
    expect(paste(`![${image('x')}](id=a)\n${clip('a')}`)).toBe(`![${image('x')}](id=a)\n${clip('b')}`)
    expect(paste(`${clip('a')}\n![${image('x')}](id=a)`)).toBe(`${clip('a')}\n![${image('x')}](id=b)`)
  })

  it('changes no tag that was not pasted whole', () => {
    // A hand-made clash of two clips, and a tag that the paste only
    // completed, stay as they are.
    const before = `${clip('a')}\n${clip('a', 'audio')}\n${clip('a', 'video', 'https://cdn.example/other').slice(0, -2)}`

    expect(paste('/>', before)).toBe(`${before}/>`)
  })

  it('leaves an image reference in an attribute of a pasted tag that gets a new id', () => {
    const before = `![${image('a')}](id=a)\n`
    const nested = `![${image('n')}](id=a)`

    expect(paste(clip('a', 'video', nested), before)).toBe(before + clip('b', 'video', nested))
  })

  describe('mentions', () => {
    const before = `![${image('a')}](id=a) and @a\n`

    it('gives the pasted mentions of an id that changed the new id, before and after its image', () => {
      expect(paste(`(@a: a duck) ![${image('x')}](id=a) edit @a, not @a-team or @k`, before, '\nthen @a'))
        .toBe(`${before}(@b: a duck) ![${image('x')}](id=b) edit @b, not @a-team or @k\nthen @a`)
    })

    it('gives the pasted mentions of a clip its new id', () => {
      expect(paste(`Make @a longer.\n${clip('a')}`, before)).toBe(`${before}Make @b longer.\n${clip('b')}`)
    })

    it('keeps a pasted mention whose image keeps its id, and one of an id that the paste has no image for', () => {
      const pasted = `![${image('k')}](id=k) @k @a`

      expect(paste(pasted, before)).toBe(before + pasted)
    })

    it('takes the last pasted image of an id for its mentions', () => {
      expect(paste(`![${image('x')}](id=a) ![${image('y')}](id=a) @a`, before))
        .toBe(`${before}![${image('x')}](id=b) ![${image('y')}](id=c) @c`)
      // The last one is a copy of the conversation's own image `a`.
      expect(paste(`![${image('x')}](id=a) ![${image('a')}](id=a) @a`, before))
        .toBe(`${before}![${image('x')}](id=b) ![${image('a')}](id=a) @a`)
    })

    it('reads a pasted mention with the chars around it in the conversation', () => {
      // `bob@a` is an address and `@abc` is another word.
      expect(paste(`@a ![${image('x')}](id=a) @a`, `${before}bob`, 'bc'))
        .toBe(`${before}bob@a ![${image('x')}](id=b) @abc`)
    })

    it('changes no `@` text inside a pasted reference or tag', () => {
      const tag = clip('b', 'video', 'https://cdn.example/@a/clip')

      expect(paste(`![${image('x')}](id=a|desc=see @a)\n${tag}`, before)).toBe(`${before}![${image('x')}](id=c|desc=see @a)\n${tag}`)
    })
  })
})

describe('newMediaIds', () => {
  const image = (name: string, id: string) => `![/home/ann/.config/dez/assets/images/${name}.png](id=${id})`

  it('gives the ids after the highest one in all the texts of the conversation, in order', () => {
    expect(newMediaIds([`${image('a', 'b')} ${image('b', 'y')}`, '', `see ${image('c', 'c')}`], 3)).toStrictEqual(['z', 'aa', 'ab'])
  })

  it('starts at a when no reference has an id, and skips text that is not a reference', () => {
    expect(newMediaIds([`![${PNG}]() ![${PNG}](id=Q) ![x](id=zz)`], 2)).toStrictEqual(['a', 'b'])
    expect(newMediaIds([], 1)).toStrictEqual(['a'])
  })

  it('gives no id for a count of zero', () => {
    expect(newMediaIds([image('a', 'a')], 0)).toStrictEqual([])
  })

  it('counts the ids of the images and of the clips as one sequence', () => {
    expect(newMediaIds([image('a', 'a'), `Done.\n${clip('b')}\n${clip('c', 'audio')}`], 2)).toStrictEqual(['d', 'e'])
    expect(newMediaIds([`${clip('e')}`, image('a', 'f')], 1)).toStrictEqual(['g'])
    expect(newMediaIds([clip('z')], 1)).toStrictEqual(['aa'])
  })

  it('skips a line that only looks like a media tag', () => {
    expect(newMediaIds([`See ${clip('k')}`, '<dez:video id="K" type="video/mp4"/>', '<dez:video id="m"/>'], 1)).toStrictEqual(['a'])
  })
})
