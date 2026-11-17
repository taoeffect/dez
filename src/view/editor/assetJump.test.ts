import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { compactionBlockText } from '../../model/chat/compaction'
import { hiddenClip, hiddenImage, invokeBlock } from '../../model/chat/testing'
import { mentionTarget } from './assetJump'
import { shownMentions } from './mentions'
import { createState, joinSections, keptClip, keptImage, RED, SONG } from './testing'

const INVOKE = invokeBlock('j-aaaa')
const IMAGE = hiddenImage('j-aaaa')
const CLIP = hiddenClip('j-aaaa')

/** The target of each mention chip of `state`, in doc order. */
function targets(state: EditorState) {
  return shownMentions(state).map((mention) => mentionTarget(state, mention))
}

describe('mentionTarget', () => {
  it('gives an image and a clip at their own place', () => {
    const texts = [`${RED}\n${SONG}`, 'Mix @a with @b']
    const doc = joinSections(texts)

    expect(targets(createState(texts, ['user', 'user']))).toStrictEqual([
      { from: doc.indexOf(RED), holder: null },
      { from: doc.indexOf(SONG), holder: null },
    ])
  })

  it('gives the first of two references with the id', () => {
    const texts = [`${RED}\n\n${RED}\nSee @a`]

    expect(targets(createState(texts, ['user']))).toStrictEqual([{ from: 0, holder: null }])
  })

  it('gives an asset that comes after the mention in its own section', () => {
    const texts = ['Hi', `See @a\n${RED}`]
    const doc = joinSections(texts)

    expect(targets(createState(texts, ['user', 'user']))).toStrictEqual([{ from: doc.indexOf(RED), holder: null }])
  })

  it('gives no asset of a later section', () => {
    const texts = ['See @a', RED]
    const state = createState(texts, ['user', 'user'])

    expect(mentionTarget(state, { from: 4, id: 'a', kind: 'image' })).toBeNull()
  })

  it('gives no image that is shown as text: a reference on a table row line', () => {
    const texts = [['| a | b |', '| - | - |', RED].join('\n'), 'See @a']

    expect(targets(createState(texts, ['user', 'user']))).toStrictEqual([null])
  })

  it('gives a hidden image and a hidden clip in the panel of the call that started their job', () => {
    const texts = ['ask', [INVOKE, '', IMAGE, '', CLIP, '', 'Done.'].join('\n'), 'Show @b and @c']
    const doc = joinSections(texts)
    const holder = { kind: 'call', id: 'call_1', from: doc.indexOf(INVOKE) }

    expect(targets(createState(texts, ['user', 'agent', 'user']))).toStrictEqual([
      { from: doc.indexOf(IMAGE), holder },
      { from: doc.indexOf(CLIP), holder },
    ])
  })

  it('gives the call of an earlier reply when the job of the asset outlived that reply', () => {
    const texts = ['ask', [INVOKE, '', 'Working.'].join('\n'), 'Go on.', ['Done.', '', IMAGE].join('\n'), 'Show @b']
    const doc = joinSections(texts)

    expect(targets(createState(texts, ['user', 'agent', 'user', 'agent', 'user']))).toStrictEqual([
      { from: doc.indexOf(IMAGE), holder: { kind: 'call', id: 'call_1', from: doc.indexOf(INVOKE) } },
    ])
  })

  it('gives a kept asset of the compaction block as its row of the kept assets', () => {
    const notes = ['Notes.', '', keptImage('k'), '', keptClip('l'), '', keptClip('m')].join('\n')
    const block = compactionBlockText({ count: 1, lastId: 'z', pictures: [] }, notes)
    const texts = [block, 'Play @m, then @l, and show @k']
    const doc = joinSections(texts)

    expect(targets(createState(texts, ['agent', 'user']))).toStrictEqual([
      { from: doc.indexOf(keptClip('m')), holder: { kind: 'compaction', row: 2 } },
      { from: doc.indexOf(keptClip('l')), holder: { kind: 'compaction', row: 1 } },
      { from: doc.indexOf(keptImage('k')), holder: { kind: 'compaction', row: 0 } },
    ])
  })
})
