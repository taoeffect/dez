import { describe, expect, it } from 'vitest'
import { newMediaIds, pastedImageIdChanges } from './mediaIds'
import { mediaTagText } from './mediaTags'

const PNG = '/home/ann/.config/dez/assets/images/5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.png'

/** The tag of a clip with this id. */
function clip(id: string, kind: 'audio' | 'video' = 'video'): string {
  return mediaTagText({ kind, id, type: `${kind}/mp4`, src: null, url: 'https://cdn.example/clip', expires: null, other: [] })
}

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

  it('never changes a media tag, also a pasted one with an id that is taken', () => {
    const before = `![${image('a')}](id=a)\n${clip('b')}\n`
    const pasted = `${clip('a')}\n${clip('b', 'audio')}\n`

    expect(paste(pasted, before)).toBe(before + pasted)
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
