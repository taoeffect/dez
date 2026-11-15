import { describe, expect, it } from 'vitest'
import { reply, user } from '../streams/testing'
import {
  CARRIED_USER_ASSETS_LABEL,
  compactionMessageEnd,
  compactionTagText,
  contentCompactionTag,
  firstSectionRole,
  isCarriedUserAssets,
  readCompactionTag,
  sectionCompactionTag,
  withoutCompactionTag,
} from './compaction'
import { promptNode, textNode } from './content'
import type { ShownPicture } from './shownPictures'
import type { Section } from './types'

const PICTURES: ShownPicture[] = [
  { file: '5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.jpg', label: 'Frames of @c: "take 2" & more\nat 0 s, 2 s', width: 1568, height: 882, bytes: 120_000 },
  { file: 'wave.png', label: 'Wave of @d' },
]

function section(role: Section['role'], ...content: Section['content']): Section {
  return { id: 's', role, content }
}

describe('compactionTagText and readCompactionTag', () => {
  it('reads back what the writer wrote, with the text after the tag line', () => {
    const tag = compactionTagText({ count: 12, lastId: 'ab', pictures: PICTURES })
    const text = `${tag}\nSummary`

    expect(tag).not.toContain('\n')
    expect(readCompactionTag(text)).toEqual({ count: 12, lastId: 'ab', pictures: PICTURES, to: tag.length, textFrom: tag.length + 1 })
    expect(text.slice(tag.length + 1)).toBe('Summary')
  })

  it('writes only the attributes that have a value', () => {
    expect(compactionTagText({ count: 1, lastId: null, pictures: [] })).toBe('<dez:compaction count="1"/>')
    expect(readCompactionTag('<dez:compaction count="1"/>')).toEqual({ count: 1, lastId: null, pictures: [], to: 27, textFrom: 27 })
  })

  it('keeps live sentinels out of the tag, so it stays one line of one section in the editor doc', () => {
    const tag = compactionTagText({ count: 1, lastId: null, pictures: [{ file: 'a.png', label: 'One\u001Etwo\uE000' }] })

    expect(tag).not.toMatch(/[\u001E\uE000-\uE003]/)
    expect(readCompactionTag(tag)).toMatchObject({ count: 1, to: tag.length })
  })

  it.each([
    ['no count', '<dez:compaction last-id="a"/>'],
    ['a count of 0', '<dez:compaction count="0"/>'],
    ['a count with a leading 0', '<dez:compaction count="01"/>'],
    ['a count that is no whole number', '<dez:compaction count="1.5"/>'],
    ['a count that is too large', '<dez:compaction count="9007199254740993"/>'],
    ['a last id that is no id', '<dez:compaction count="1" last-id="A1"/>'],
    ['text after the tag on its line', '<dez:compaction count="1"/> Summary'],
    ['text before the tag', ' <dez:compaction count="1"/>'],
    ['a tag that is not closed', '<dez:compaction count="1">'],
    ['another tag name', '<dez:compactions count="1"/>'],
    ['a tag on the second line', 'Summary\n<dez:compaction count="1"/>'],
  ])('takes %s as plain text', (_what, text) => {
    expect(readCompactionTag(text)).toBeNull()
    expect(withoutCompactionTag(text, 0, 'agent')).toBe(text)
  })

  it('reads a tag with pictures that are not valid as a tag with none', () => {
    expect(readCompactionTag('<dez:compaction count="3" last-id="" pictures="[{&quot;file&quot;:&quot;../keys.json&quot;,&quot;label&quot;:&quot;x&quot;}]"/>\nText'))
      .toMatchObject({ count: 3, lastId: null, pictures: [] })
  })
})

describe('withoutCompactionTag', () => {
  it('removes the tag line of a compaction section and keeps the rest as it is', () => {
    expect(withoutCompactionTag('<dez:compaction count="2" last-id="c"/>\n\nSummary\n', 0, 'agent')).toBe('\nSummary\n')
    expect(withoutCompactionTag('<dez:compaction count="2"/>', 0, 'agent')).toBe('')
  })

  // There the tag is plain text, which the user sees and typed or pasted.
  it('keeps the tag line of a first user section and of a later agent section', () => {
    const text = '<dez:compaction count="2"/>\nSummary'

    expect([withoutCompactionTag(text, 0, 'user'), withoutCompactionTag(text, 1, 'agent')]).toStrictEqual([text, text])
  })
})

describe('firstSectionRole', () => {
  it('is agent only for a first doc line that is a valid tag', () => {
    expect(firstSectionRole('<dez:compaction count="1" last-id="b"/>')).toBe('agent')
    expect(firstSectionRole('<dez:compaction count="0"/>')).toBe('user')
    expect(firstSectionRole('Hello')).toBe('user')
    expect(firstSectionRole('')).toBe('user')
    // A prompt pill on the line of the tag.
    expect(firstSectionRole('<dez:compaction count="1"/>\uE000p1\uE001Body\uE002')).toBe('user')
  })
})

describe('contentCompactionTag and sectionCompactionTag', () => {
  const tag = '<dez:compaction count="1"/>'

  it('finds the tag only at the start of the first text node', () => {
    expect(contentCompactionTag([textNode(`${tag}\nSummary`)])).toMatchObject({ count: 1 })
    expect(contentCompactionTag([textNode(tag)])).toMatchObject({ count: 1 })
    expect(contentCompactionTag([textNode(''), promptNode({ promptId: null, name: 'P', body: `${tag}\nSummary` }), textNode('')])).toBeNull()
    expect(contentCompactionTag([])).toBeNull()
  })

  it('follows the editor doc: a prompt pill on the line of the tag makes it no tag', () => {
    const pill = promptNode({ promptId: null, name: 'P', body: 'Body' })

    expect(contentCompactionTag([textNode(tag), pill, textNode('')])).toBeNull()
    expect(contentCompactionTag([textNode(`${tag}\n`), pill, textNode('')])).toMatchObject({ count: 1 })
  })

  it('takes only an agent section as a compaction section', () => {
    expect(sectionCompactionTag(section('agent', textNode(`${tag}\nSummary`)))).toMatchObject({ count: 1, textFrom: tag.length + 1 })
    expect(sectionCompactionTag(section('user', textNode(`${tag}\nSummary`)))).toBeNull()
    expect(sectionCompactionTag(section('agent', textNode('Summary')))).toBeNull()
  })
})

describe('isCarriedUserAssets', () => {
  it('is true only for a text whose whole first line is the label', () => {
    expect(isCarriedUserAssets(`${CARRIED_USER_ASSETS_LABEL}\n![/home/u/.config/dez/assets/images/red.png](id=a)`)).toBe(true)
    expect(isCarriedUserAssets(CARRIED_USER_ASSETS_LABEL)).toBe(true)
    expect(isCarriedUserAssets(`Here:\n${CARRIED_USER_ASSETS_LABEL}`)).toBe(false)
    expect(isCarriedUserAssets(`${CARRIED_USER_ASSETS_LABEL} And more.\nText`)).toBe(false)
  })
})

describe('compactionMessageEnd', () => {
  const tag = compactionTagText({ count: 1, lastId: 'b', pictures: [] })
  const compacted = reply('c', `${tag}\n## Summary\n\nNotes.`)

  it('is 0 for a conversation with no compaction section', () => {
    expect(compactionMessageEnd([])).toBe(0)
    expect(compactionMessageEnd([user('u1', 'Hi'), reply('a1', 'Hello')])).toBe(0)
    expect(compactionMessageEnd([user('u1', `${tag}\nNotes.`), reply('a1', 'Hello')])).toBe(0)
  })

  it('ends at the first later agent section that is not empty, past an empty one', () => {
    const sections = [compacted, user('u1', 'Make a fox film.'), reply('a0', ' \n'), user('u2', 'Go on.'), reply('a1', 'Done.'), user('u3', 'Thanks.'), reply('a2', 'Welcome.')]

    expect(compactionMessageEnd(sections)).toBe(4)
  })

  it('is the count of the sections when no reply follows', () => {
    expect(compactionMessageEnd([compacted, user('u1', 'Make a fox film.'), reply('a0', '')])).toBe(3)
    expect(compactionMessageEnd([compacted])).toBe(1)
  })
})
