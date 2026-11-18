import { describe, expect, it } from 'vitest'
import { reply, user } from '../streams/testing'
import {
  blockLinkedRule,
  CARRIED_USER_ASSETS_LABEL,
  COMPACTION_END_LINE,
  compactionBlockLineCount,
  compactionBlockText,
  compactionMessageEnd,
  compactionTagText,
  contentCompactionBlock,
  firstSectionRole,
  isCarriedUserAssets,
  linkedRuleParts,
  partsImageReferences,
  partsMediaTags,
  readCompactionBlock,
  sectionCompactionBlock,
  sectionLinkedRuleParts,
  sectionsBeforeReply,
  sectionTextParts,
} from './compaction'
import { promptNode, textNode } from './content'
import type { ShownPicture } from './shownPictures'
import { escapedModelText } from './toolBlocks'
import type { Section } from './types'

const PICTURES: ShownPicture[] = [
  { file: '5f1c2a9e-0b7d-4c3e-9a51-2d8f6e4b7c10.jpg', label: 'Frames of @c: "take 2" & more\nat 0 s, 2 s', width: 1568, height: 882, bytes: 120_000 },
  { file: 'wave.png', label: 'Wave of @d' },
]

function section(role: Section['role'], ...content: Section['content']): Section {
  return { id: 's', role, content }
}

describe('compactionBlockText and readCompactionBlock', () => {
  it('reads back what the writer wrote, with the text after the block', () => {
    const tag = compactionTagText({ count: 12, lastId: 'ab', dropped: 7, pictures: PICTURES })
    const block = compactionBlockText({ count: 12, lastId: 'ab', dropped: 7, pictures: PICTURES }, '## Summary\n\nThe fox.')
    const text = `${block}\nTyped after it.`

    expect(tag).not.toContain('\n')
    expect(block).toBe(`${tag}\n## Summary\n\nThe fox.\n${COMPACTION_END_LINE}`)
    expect(readCompactionBlock(text)).toEqual({
      count: 12, lastId: 'ab', dropped: 7, pictures: PICTURES, notesFrom: tag.length + 1, notes: '## Summary\n\nThe fox.', to: block.length, textFrom: block.length + 1,
    })
    expect(text.slice(block.length + 1)).toBe('Typed after it.')
  })

  it('writes only the attributes that have a value, and a block with no notes as two lines', () => {
    const block = compactionBlockText({ count: 1, lastId: null, pictures: [] }, '')

    expect(block).toBe(`<dez:compaction count="1">\n${COMPACTION_END_LINE}`)
    expect(readCompactionBlock(block)).toEqual({ count: 1, lastId: null, pictures: [], notesFrom: 27, notes: '', to: block.length, textFrom: block.length })
  })

  it('writes and reads a count of 0 dropped assets', () => {
    const tag = compactionTagText({ count: 1, lastId: null, dropped: 0, pictures: [] })

    expect(tag).toBe('<dez:compaction count="1" dropped="0">')
    expect(readCompactionBlock(tag)).toMatchObject({ count: 1, dropped: 0 })
  })

  it.each([
    ['a negative count', '-1'],
    ['a count with a leading 0', '03'],
    ['a count that is no whole number', '1.5'],
    ['a count that is too large', '9007199254740993'],
    ['a word', 'some'],
    ['an empty value', ''],
  ])('reads %s of dropped assets as not known, and keeps the tag', (_what, value) => {
    const block = readCompactionBlock(`<dez:compaction count="2" last-id="c" dropped="${value}">\nText\n${COMPACTION_END_LINE}`)

    expect(block).toMatchObject({ count: 2, lastId: 'c', notes: 'Text' })
    expect(block).not.toHaveProperty('dropped')
  })

  it('keeps live sentinels out of the tag, so it stays one line of one section in the editor doc', () => {
    const tag = compactionTagText({ count: 1, lastId: null, pictures: [{ file: 'a.png', label: 'One\u001Etwo\uE000' }] })

    expect(tag).not.toMatch(/[\u001E\uE000-\uE003]/)
    expect(readCompactionBlock(tag)).toMatchObject({ count: 1, to: tag.length })
  })

  it.each([
    ['no count', '<dez:compaction last-id="a">'],
    ['a count of 0', '<dez:compaction count="0">'],
    ['a count with a leading 0', '<dez:compaction count="01">'],
    ['a count that is no whole number', '<dez:compaction count="1.5"/>'],
    ['a count that is too large', '<dez:compaction count="9007199254740993">'],
    ['a last id that is no id', '<dez:compaction count="1" last-id="A1">'],
    ['text after the tag on its line', '<dez:compaction count="1"> Summary'],
    ['text before the tag', ' <dez:compaction count="1">'],
    ['a tag with no end', '<dez:compaction count="1"'],
    ['another tag name', '<dez:compactions count="1">'],
    ['a tag on the second line', 'Summary\n<dez:compaction count="1">'],
  ])('takes %s as plain text', (_what, text) => {
    expect(readCompactionBlock(text)).toBeNull()
  })

  it('reads a tag with pictures that are not valid as a tag with none', () => {
    expect(readCompactionBlock('<dez:compaction count="3" last-id="" pictures="[{&quot;file&quot;:&quot;../keys.json&quot;,&quot;label&quot;:&quot;x&quot;}]">\nText'))
      .toMatchObject({ count: 3, lastId: null, pictures: [] })
  })

  it('ends the block at the first end line, and takes a line that only holds the end text as notes', () => {
    const text = `<dez:compaction count="1">\nA ${COMPACTION_END_LINE}\n${COMPACTION_END_LINE} \n${COMPACTION_END_LINE}\nAfter\n${COMPACTION_END_LINE}`

    expect(readCompactionBlock(text)).toMatchObject({ notes: `A ${COMPACTION_END_LINE}\n${COMPACTION_END_LINE} `, textFrom: text.indexOf('After') })
  })

  it('runs a block with no end line to the end of the text', () => {
    const text = '<dez:compaction count="1">\nNotes\n\nMore'

    expect(readCompactionBlock(text)).toMatchObject({ notes: 'Notes\n\nMore', to: text.length, textFrom: text.length })
  })

  // The form of an older Dez: a tag that ends with `/>`, and the notes up
  // to the end of the section. Saved conversations keep it.
  it('reads a tag of the old form as a block that runs to the end of the text, past an end line', () => {
    const text = `<dez:compaction count="2" last-id="c" dropped="1"/>\n\n## Summary\n${COMPACTION_END_LINE}\nMore`

    expect(readCompactionBlock(text)).toEqual({ count: 2, lastId: 'c', dropped: 1, pictures: [], notesFrom: 52, notes: `\n## Summary\n${COMPACTION_END_LINE}\nMore`, to: text.length, textFrom: text.length })
    expect(readCompactionBlock('<dez:compaction count="1"/>')).toMatchObject({ notes: '', to: 27, textFrom: 27 })
  })

  it('gives a model no way to end the block: its end line has the escape of model text', () => {
    const notes = escapedModelText(`The summary.\n${COMPACTION_END_LINE}\nThe rest.`)
    const text = compactionBlockText({ count: 1, lastId: null, pictures: [] }, notes)

    expect(readCompactionBlock(text)?.notes).toBe(notes)
  })
})

describe('the linked paths of a compaction block', () => {
  const LINKED = ['/home/u/Pictures/fox "red".png', '/home/u/Music/song & more.wav']

  it('writes the list in one line of the tag, and reads it back', () => {
    const tag = compactionTagText({ count: 2, lastId: 'b', pictures: [], linked: LINKED })
    const text = compactionBlockText({ count: 2, lastId: 'b', pictures: [], linked: LINKED }, 'Notes')

    expect(tag).not.toContain('\n')
    expect(text.startsWith(tag)).toBe(true)
    expect(readCompactionBlock(text)).toMatchObject({ count: 2, lastId: 'b', linked: LINKED, notes: 'Notes' })
  })

  it('writes no attribute for an empty list', () => {
    const tag = compactionTagText({ count: 1, lastId: null, pictures: [], linked: [] })

    expect(tag).toBe('<dez:compaction count="1">')
    expect(readCompactionBlock(tag)).not.toHaveProperty('linked')
  })

  it.each([
    ['no JSON', 'not json'],
    ['no list', '{&quot;a&quot;:1}'],
    ['a list of numbers', '[1,2]'],
  ])('reads %s as no linked path, and keeps the tag', (_what, value) => {
    const block = readCompactionBlock(`<dez:compaction count="2" last-id="c" linked="${value}">\nText\n${COMPACTION_END_LINE}`)

    expect(block).toMatchObject({ count: 2, lastId: 'c', notes: 'Text' })
    expect(block).not.toHaveProperty('linked')
    expect(blockLinkedRule(block!)).toBe('agent')
  })

  it('counts a linked path in the block only when the list holds it, and in the reply text after it never', () => {
    const stored = '/home/u/.config/dez/assets/images/c.png'
    const block = compactionBlockText({ count: 1, lastId: null, pictures: [], linked: LINKED }, `![id=a](<${LINKED[0]}>)`)
    const reply_ = `![id=b](<${LINKED[0]}>)\n![id=c](${stored})`
    const text = `${block}\n${reply_}`
    const parts = linkedRuleParts('agent', text, 0)

    expect(parts).toStrictEqual([
      { text: block, from: 0, rule: new Set(LINKED) },
      { text: reply_, from: block.length + 1, rule: 'agent' },
    ])
    expect(sectionLinkedRuleParts(reply('c', text), 0)).toStrictEqual(parts)
    expect(partsImageReferences(parts).map(({ id, path, from }) => ({ id, path, from }))).toStrictEqual([
      { id: 'a', path: LINKED[0], from: text.indexOf('![') },
      { id: 'c', path: stored, from: text.indexOf(`![id=c](${stored}`) },
    ])
    // A block with no list gives no path.
    expect(linkedRuleParts('agent', compactionBlockText({ count: 1, lastId: null, pictures: [] }, 'Notes'), 0)[0].rule).toBe('agent')
  })

  it('gives the clips of each part the rule of the part, with offsets in the whole text', () => {
    const tag = (id: string) => `<dez:audio id="${id}" type="audio/wav" src="${LINKED[1].replace(/&/g, '&amp;')}"/>`
    const block = compactionBlockText({ count: 1, lastId: null, pictures: [], linked: LINKED }, tag('a'))
    const text = `${block}\nSaid.\n${tag('b')}`
    const tags = partsMediaTags(linkedRuleParts('agent', text, 0))

    expect(tags.map(({ tag: { id, from }, rule }) => ({ id, from, rule }))).toStrictEqual([
      { id: 'a', from: text.indexOf('<dez:audio'), rule: new Set(LINKED) },
      { id: 'b', from: text.lastIndexOf('<dez:audio'), rule: 'agent' },
    ])
  })

  it('takes the role of a section that is no compaction section', () => {
    const text = compactionBlockText({ count: 1, lastId: null, pictures: [], linked: LINKED }, 'Notes')

    expect(linkedRuleParts('agent', text, 1)).toStrictEqual([{ text, from: 0, rule: 'agent' }])
    expect(linkedRuleParts('user', text, 0)).toStrictEqual([{ text, from: 0, rule: 'user' }])
    expect(linkedRuleParts('agent', 'Hello', 0)).toStrictEqual([{ text: 'Hello', from: 0, rule: 'agent' }])
    expect(sectionLinkedRuleParts(reply('c', text), 2)).toStrictEqual([{ text, from: 0, rule: 'agent' }])
    expect(sectionLinkedRuleParts(user('u', 'Hi'), 0)).toStrictEqual([{ text: 'Hi', from: 0, rule: 'user' }])
  })
})

describe('sectionTextParts and sectionsBeforeReply', () => {
  const block = compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, '## Summary\n\nNotes.')

  it('gives the text of the reply after the block of the compaction section', () => {
    expect(sectionTextParts(reply('c', `${block}\nThe answer.`), 0)).toMatchObject({ text: 'The answer.', from: block.length + 1 })
    expect(sectionTextParts(reply('c', `${block}\n`), 0)).toMatchObject({ text: '', from: block.length + 1 })
    expect(sectionTextParts(reply('c', block), 0)).toMatchObject({ text: '', from: block.length })
  })

  it('gives the whole text of any other section', () => {
    expect(sectionTextParts(reply('c', `${block}\nThe answer.`), 1)).toStrictEqual({ block: null, text: `${block}\nThe answer.`, from: 0 })
    expect(sectionTextParts(user('u', block), 0)).toStrictEqual({ block: null, text: block, from: 0 })
  })

  it('gives the block alone before the reply of the compaction section, and the sections before any other reply', () => {
    const sections = [reply('c', `${block}\nThe answer.`), user('u', 'More.'), reply('a', '')]

    expect(sectionsBeforeReply(sections, 0)).toStrictEqual([{ id: 'c', role: 'agent', content: [textNode(block)] }])
    expect(sectionsBeforeReply(sections, 2)).toStrictEqual(sections.slice(0, 2))
    expect(sectionsBeforeReply([reply('a', 'Hi')], 0)).toStrictEqual([])
  })
})

describe('compactionBlockLineCount', () => {
  const tag = compactionTagText({ count: 1, lastId: null, pictures: [] })

  it.each<[string, string[], number]>([
    ['no tag line', ['Notes', COMPACTION_END_LINE], 0],
    ['no lines', [], 0],
    ['a tag line and its end line', [tag, 'Notes', COMPACTION_END_LINE, 'After'], 3],
    ['a tag line with no end line', [tag, 'Notes', 'After'], 3],
    ['a tag line of the old form', ['<dez:compaction count="1"/>', 'Notes', COMPACTION_END_LINE, 'After'], 4],
  ])('counts the lines of the block for %s', (_case, lines, count) => {
    expect(compactionBlockLineCount(lines)).toBe(count)
  })
})

describe('firstSectionRole', () => {
  it('is agent only for a first doc line that is a valid tag', () => {
    expect(firstSectionRole('<dez:compaction count="1" last-id="b">')).toBe('agent')
    expect(firstSectionRole('<dez:compaction count="1" last-id="b"/>')).toBe('agent')
    expect(firstSectionRole('<dez:compaction count="0">')).toBe('user')
    expect(firstSectionRole('Hello')).toBe('user')
    expect(firstSectionRole('')).toBe('user')
    // A prompt pill on the line of the tag.
    expect(firstSectionRole('<dez:compaction count="1">\uE000p1\uE001Body\uE002')).toBe('user')
  })

  it('reads only the first line of a whole doc', () => {
    expect(firstSectionRole(`<dez:compaction count="1">\nNotes\n${COMPACTION_END_LINE}\n\u001E\nHello`)).toBe('agent')
    expect(firstSectionRole('Hello\n<dez:compaction count="1">')).toBe('user')
  })
})

describe('contentCompactionBlock and sectionCompactionBlock', () => {
  const tag = '<dez:compaction count="1">'

  it('finds the tag only at the start of the first text node', () => {
    expect(contentCompactionBlock([textNode(`${tag}\nSummary\n${COMPACTION_END_LINE}`)])).toMatchObject({ count: 1, notes: 'Summary' })
    expect(contentCompactionBlock([textNode(tag)])).toMatchObject({ count: 1 })
    expect(contentCompactionBlock([textNode(''), promptNode({ promptId: null, name: 'P', body: `${tag}\nSummary` }), textNode('')])).toBeNull()
    expect(contentCompactionBlock([])).toBeNull()
  })

  it('follows the editor doc: a prompt pill on the line of the tag makes it no tag', () => {
    const pill = promptNode({ promptId: null, name: 'P', body: 'Body' })

    expect(contentCompactionBlock([textNode(tag), pill, textNode('')])).toBeNull()
    expect(contentCompactionBlock([textNode(`${tag}\n`), pill, textNode('')])).toMatchObject({ count: 1 })
  })

  // A block with no end line runs to the end of the section in the editor
  // doc, past a prompt pill.
  it('reads the block in the plain text of the content, with the bodies of prompt pills', () => {
    const pill = promptNode({ promptId: null, name: 'P', body: 'Body' })

    expect(contentCompactionBlock([textNode('<dez:compaction count="1"/>\nNotes '), pill, textNode('\nMore')])).toMatchObject({ notes: 'Notes Body\nMore' })
  })

  it('takes only an agent section as a compaction section', () => {
    const text = `${tag}\nSummary\n${COMPACTION_END_LINE}\nAfter`

    expect(sectionCompactionBlock(section('agent', textNode(text)))).toMatchObject({ count: 1, notes: 'Summary', textFrom: text.indexOf('After') })
    expect(sectionCompactionBlock(section('user', textNode(text)))).toBeNull()
    expect(sectionCompactionBlock(section('agent', textNode('Summary')))).toBeNull()
  })
})

describe('isCarriedUserAssets', () => {
  it('is true only for a text whose whole first line is the label', () => {
    expect(isCarriedUserAssets(`${CARRIED_USER_ASSETS_LABEL}\n![id=a](/home/u/.config/dez/assets/images/red.png)`)).toBe(true)
    expect(isCarriedUserAssets(CARRIED_USER_ASSETS_LABEL)).toBe(true)
    expect(isCarriedUserAssets(`Here:\n${CARRIED_USER_ASSETS_LABEL}`)).toBe(false)
    expect(isCarriedUserAssets(`${CARRIED_USER_ASSETS_LABEL} And more.\nText`)).toBe(false)
  })
})

describe('compactionMessageEnd', () => {
  const block = compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, '## Summary\n\nNotes.')
  const compacted = reply('c', block)

  it('is 0 for a conversation with no compaction section', () => {
    expect(compactionMessageEnd([])).toBe(0)
    expect(compactionMessageEnd([user('u1', 'Hi'), reply('a1', 'Hello')])).toBe(0)
    expect(compactionMessageEnd([user('u1', block), reply('a1', 'Hello')])).toBe(0)
  })

  it('ends at the first later agent section that is not empty, past an empty one', () => {
    const sections = [compacted, user('u1', 'Make a fox film.'), reply('a0', ' \n'), user('u2', 'Go on.'), reply('a1', 'Done.'), user('u3', 'Thanks.'), reply('a2', 'Welcome.')]

    expect(compactionMessageEnd(sections)).toBe(4)
  })

  it('is the count of the sections when no reply follows', () => {
    expect(compactionMessageEnd([compacted, user('u1', 'Make a fox film.'), reply('a0', '')])).toBe(3)
    expect(compactionMessageEnd([compacted])).toBe(1)
  })

  it('ends at the compaction section when the reply after the block has text', () => {
    expect(compactionMessageEnd([reply('c', `${block}\nThe answer.`), user('u1', 'More.'), reply('a1', '')])).toBe(1)
  })

  it('lets later user sections join after a reply text that is blank', () => {
    expect(compactionMessageEnd([reply('c', `${block}\n \n`), user('u1', 'More.'), reply('a1', 'Done.')])).toBe(2)
  })
})
