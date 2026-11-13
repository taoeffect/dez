import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { namedMentions } from '../../model/chat/assetMentions'
import { sectionPlainText } from '../../model/chat/content'
import { imageMarkdown } from '../../model/chat/images'
import { mediaTagText } from '../../model/chat/mediaTags'
import { docToSections, encodePrompt, pillsField, sectionsField, setSectionsEffect } from '../thread/cmEditor'
import { mentionAt, mentionChips, shownMentions } from './mentions'
import { createState, joinSections } from './testing'

const RED = imageMarkdown('/home/u/.config/dez/assets/images/red.png', [{ key: 'id', value: 'a' }])
const LINKED = imageMarkdown('/home/u/Pictures/cat.png', [{ key: 'id', value: 'a' }])
const SONG = mediaTagText({ kind: 'audio', id: 'b', type: 'audio/mpeg', src: null, url: 'https://cdn.example/s.mp3', expires: null, other: [] })
const DANCE = mediaTagText({ kind: 'video', id: 'c', type: 'video/mp4', src: null, url: 'https://cdn.example/d.mp4', expires: null, other: [] })
const PILL = { promptId: null, name: 'Style' }

/** The chips of `state`: the doc text that each one covers, and its kind. */
function chips(state: EditorState): string[] {
  return shownMentions(state).map(({ from, to, kind }) => `${state.sliceDoc(from, to)}=${kind}`)
}

describe('shownMentions', () => {
  it('gives the doc range, the id, and the kind of each mention that names an asset', () => {
    const texts = [`${RED}\nMake @a blue`, `Done:\n${SONG}`, 'Mix (@b) with @a, not @zz']
    const state = createState(texts, ['user', 'agent', 'user'])
    const doc = joinSections(texts)

    expect(shownMentions(state)).toStrictEqual([
      { from: doc.indexOf('@a'), to: doc.indexOf('@a') + 2, id: 'a', kind: 'image' },
      { from: doc.indexOf('@b'), to: doc.indexOf('@b') + 2, id: 'b', kind: 'audio' },
      { from: doc.lastIndexOf('@a'), to: doc.lastIndexOf('@a') + 2, id: 'a', kind: 'image' },
    ])
  })

  it('ends a chip after the id: a dot, a comma, or a bracket next to the mention is outside it', () => {
    const text = `${RED}\n@a.foo and @a, hello (@a)`
    const state = createState([text], ['user'])
    const doc = joinSections([text])
    const starts = [doc.indexOf('@a.foo'), doc.indexOf('@a, hello'), doc.indexOf('@a)')]

    expect(shownMentions(state).map(({ from, to }) => [from, to])).toStrictEqual(starts.map((from) => [from, from + 2]))
  })

  it('shows the chips of user and agent sections, for the assets of their own and earlier sections only', () => {
    const state = createState([`@a and @c\n${RED}`, `I made @a brighter, see @c:\n${DANCE}`, 'Thanks for @c'], ['user', 'agent', 'user'])

    expect(chips(state)).toStrictEqual(['@a=image', '@a=image', '@c=video', '@c=video'])
  })

  it('shows no chip for a word that is no mention', () => {
    expect(chips(createState([`${RED}\nbob@a.com, @a-team, @ab, @A, and @b`], ['user']))).toStrictEqual([])
  })

  it('reads a linked image only in a user section, and follows a role change', () => {
    const state = createState(['Hi', `${LINKED}\nSee @a`], ['user', 'user'])
    const asAgent = state.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'agent' }]) }).state

    expect([chips(state), chips(asAgent)]).toStrictEqual([['@a=image'], []])
  })

  it('follows the doc: a chip comes with its asset and goes with it', () => {
    const broken = RED.slice(0, -1)
    const state = createState([`${broken}\nMake @a blue`], ['user'])
    const mended = state.update({ changes: { from: broken.length, insert: ')' } }).state
    const cut = mended.update({ changes: { from: 0, to: RED.length } }).state

    expect([chips(state), chips(mended), chips(cut)]).toStrictEqual([[], ['@a=image'], []])
  })

  it('reads the body of a prompt pill, collapsed or expanded, as the text of its section', () => {
    const body = 'Paint @a\nin the style of @c'
    for (const expanded of [false, true]) {
      const pill = encodePrompt('p1', body, !expanded)
      const state = createState([`${RED}\n${DANCE}\n${pill} then @a`], ['user'], [], { p1: { ...PILL, expanded } })

      expect(chips(state)).toStrictEqual(['@a=image', '@c=video', '@a=image'])
    }
  })

  it('shows a mention next to a pill marker, but none that a marker splits', () => {
    const state = createState([`${RED}\n${encodePrompt('p1', 'see ')}@a ${encodePrompt('p2', 'and @')}a`], ['user'], [], { p1: { ...PILL, expanded: false }, p2: { ...PILL, expanded: false } })
    const doc = state.doc.toString()

    expect(shownMentions(state).map(({ from }) => from)).toStrictEqual([doc.indexOf('@a ')])
  })

  // The chips must be the mentions of the sections that a request reads:
  // the store gets its sections from the doc with `docToSections`.
  it('shows the mentions of the sections that the store gets from the doc', () => {
    const texts = [
      `${RED}\n${encodePrompt('p1', 'Paint @a\nwith @b', false)} and @a`,
      `${SONG}\nHere is @b for @a`,
      `${encodePrompt('p2', 'Mix @b')} under @c\n${DANCE}`,
    ]
    const state = createState(texts, ['user', 'agent', 'user'], [], { p1: { ...PILL, expanded: true }, p2: { ...PILL, expanded: false } })
    const sections = docToSections(state.doc.toString(), state.field(sectionsField), state.field(pillsField))
    const sources = sections.map((section) => ({ role: section.role, text: sectionPlainText(section) }))
    const named = namedMentions(sources).flatMap((mentions, index) => mentions.map(({ from, to, kind }) => `${sources[index].text.slice(from, to)}=${kind}`))

    expect(chips(state)).toStrictEqual(named)
    expect(named).toStrictEqual(['@a=image', '@a=image', '@b=audio', '@a=image', '@b=audio', '@c=video'])
  })

  it('shows no chip in a state with no sections', () => {
    const state = EditorState.create({ doc: `${RED}\nMake @a blue`, extensions: mentionChips() })

    expect(shownMentions(state)).toStrictEqual([])
  })
})

describe('mentionAt', () => {
  const text = `${RED}\nx @a y`
  const state = createState([text], ['user'])
  const from = text.indexOf('@a')

  it('finds the chip that holds a position, and at its ends only from the inside', () => {
    const found = (pos: number, side: -1 | 1) => mentionAt(state, pos, side)?.id ?? null

    expect([found(from + 1, -1), found(from + 1, 1), found(from, 1), found(from + 2, -1)]).toStrictEqual(['a', 'a', 'a', 'a'])
    expect([found(from, -1), found(from + 2, 1), found(from - 1, 1), found(0, 1)]).toStrictEqual([null, null, null, null])
  })
})
