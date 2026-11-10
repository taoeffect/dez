import { describe, expect, it } from 'vitest'
import { findImageMentions } from './imageMentions'

const ids = (text: string) => findImageMentions(text).map((mention) => mention.id)

describe('findImageMentions', () => {
  it('finds each mention with its offsets and id, in order', () => {
    const text = '@a: put the hat of @bc on it (@zz).\n@d'

    const mentions = findImageMentions(text)

    expect(mentions).toStrictEqual([
      { from: 0, to: 2, id: 'a' },
      { from: 19, to: 22, id: 'bc' },
      { from: 30, to: 33, id: 'zz' },
      { from: 36, to: 38, id: 'd' },
    ])
    expect(mentions.map(({ from, to }) => text.slice(from, to))).toStrictEqual(['@a', '@bc', '@zz', '@d'])
  })

  it.each([
    ['punctuation after the id', 'Edit @a, then @b. Is @c\'s sky blue? "@d" @e-f', ['a', 'b', 'c', 'd', 'e']],
    ['punctuation before the `@`', '(@a) [@b] ,@c /@d', ['a', 'b', 'c', 'd']],
    ['a second `@` before the mention', '@@a', ['a']],
    ['a char outside the BMP before the `@`', '🦊@a', ['a']],
  ])('takes %s', (_name, text, expected) => {
    expect(ids(text)).toStrictEqual(expected)
  })

  it('gives the offsets of a mention after a char outside the BMP', () => {
    expect(findImageMentions('🦊@a')).toStrictEqual([{ from: 2, to: 4, id: 'a' }])
  })

  it('takes the letters after the `@` as one whole id', () => {
    expect(ids('@about @a')).toStrictEqual(['about', 'a'])
  })

  it('takes only the first of two mentions with nothing between them', () => {
    expect(ids('@a@b')).toStrictEqual(['a'])
  })

  it.each([
    ['an e-mail address', 'bob@a.com'],
    ['a letter of another script before the `@`', 'é@a ж@b 字@c'],
    ['a digit or `_` before the `@`', '1@a _@b'],
    ['a digit, `_`, or an upper-case letter after the id', '@a1 @b_ @cD @E'],
    ['a letter of another script after the id', '@aé @bж'],
    ['a combining mark after the id', '@a\u0301'],
    ['an `@` with no id', '@ a, @., @'],
  ])('finds no mention in %s', (_name, text) => {
    expect(ids(text)).toStrictEqual([])
  })
})
