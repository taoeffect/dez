import { undo } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { COMPACTION_END_LINE, compactionBlockText, compactionTagText } from '../../model/chat/compaction'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP, sectionsField } from '../thread/cmEditor'
import { caretAfterCompactionBlock } from './compaction'
import { compactionBlockRange } from './compactionBlock'
import { deleteLineBlockBackward } from './lineBlocks'
import { PLAYER, createState, joinSections, runCommand, selectionOf } from './testing'

const DATA = { count: 1, lastId: 'c', pictures: [] }
const TAG = compactionTagText(DATA)
/** The tag of a conversation of an older Dez: the notes run to the end of
 *  the section. */
const OLD_TAG = `${TAG.slice(0, -1)}/>`
const BLOCK = compactionBlockText(DATA, 'Notes')
const ROLES: Role[] = ['agent', 'user']
/** A compaction section with the block and text after it, and the user
 *  message after it. */
const TEXTS = [`${BLOCK}\nMore`, 'ask']
const DOC = joinSections(TEXTS)
/** The start of the text after the block: the first place for a caret. */
const AFTER = BLOCK.length + 1
/** A compaction section that is only its block. */
const ONLY_BLOCK = [BLOCK, 'ask']

function firstSection(state: EditorState): unknown {
  return state.field(sectionsField)[0]
}

/** The selection of `state` after a transaction that sets `ranges`
 *  (`selectionOf`). */
function selected(state: EditorState, ranges: Array<number | [number, number]>): Array<number | [number, number]> {
  return state.update({ selection: selectionOf(ranges) }).state.selection.ranges.map((range) => (range.empty ? range.head : [range.anchor, range.head]))
}

describe('compactionBlockRange', () => {
  it('is the tag line to the end line', () => {
    expect(compactionBlockRange(createState(TEXTS, ROLES).doc)).toStrictEqual([{ from: 0, to: BLOCK.length }])
    expect(compactionBlockRange(createState(ONLY_BLOCK, ROLES).doc)).toStrictEqual([{ from: 0, to: BLOCK.length }])
  })

  it.each([
    ['a tag with no end line', `${TAG}\nNotes`],
    ['a tag of the old form, also over an end line', `${OLD_TAG}\nNotes\n${COMPACTION_END_LINE}\nMore`],
  ])('runs to the end of the first section for %s', (_tag, text) => {
    expect(compactionBlockRange(createState([text, 'ask'], ROLES).doc)).toStrictEqual([{ from: 0, to: text.length }])
  })

  it('never runs into the next section', () => {
    expect(compactionBlockRange(createState([`${TAG}\nNotes`, COMPACTION_END_LINE], ROLES).doc)).toStrictEqual([{ from: 0, to: TAG.length + '\nNotes'.length }])
  })

  it('is empty for a first line with text next to the tag, and for a tag on a later line', () => {
    for (const text of ['Notes', `${TAG} Notes`, `Notes\n${BLOCK}`]) {
      expect(compactionBlockRange(createState([text, 'ask'], ['user', 'user']).doc)).toStrictEqual([])
    }
  })
})

describe('caretAfterCompactionBlock', () => {
  it.each([
    ['the start of the line after the end line', `${BLOCK}\nMore`, AFTER],
    ['the start of an empty line after the end line', `${BLOCK}\n`, AFTER],
    ['the end of the block in a doc with no other line', BLOCK, BLOCK.length],
    ['the end of the block before the separator of the next section', joinSections(ONLY_BLOCK), BLOCK.length],
  ])('is %s', (_place, doc, caret) => {
    expect(caretAfterCompactionBlock(createState([doc], ['agent']).doc)).toBe(caret)
  })

  it('is null for a doc that starts with no tag', () => {
    expect(caretAfterCompactionBlock(createState(['Notes', BLOCK], ['user', 'agent']).doc)).toBeNull()
  })
})

describe('the caret and the block', () => {
  it('moves a caret before the block, in each of its lines, and at its end to the first place after it', () => {
    const state = createState(TEXTS, ROLES, [AFTER + 2])
    const carets = [0, 5, TAG.length + 2, BLOCK.length - 2, BLOCK.length, AFTER, DOC.length]

    expect(carets.map((caret) => selected(state, [caret]))).toStrictEqual([[AFTER], [AFTER], [AFTER], [AFTER], [AFTER], [AFTER], [DOC.length]])
  })

  it('keeps a caret at the end of a block that ends its section', () => {
    const state = createState(ONLY_BLOCK, ROLES, [joinSections(ONLY_BLOCK).length])

    expect([0, TAG.length + 2, BLOCK.length].map((caret) => selected(state, [caret]))).toStrictEqual([[BLOCK.length], [BLOCK.length], [BLOCK.length]])
  })

  // Select All, and a selection that the user extends up to the doc start.
  it('keeps a selection that holds the block, and moves only the carets of many', () => {
    const state = createState(TEXTS, ROLES, [AFTER + 2])

    expect(selected(state, [[0, DOC.length]])).toStrictEqual([[0, DOC.length]])
    expect(selected(state, [[AFTER + 2, 0]])).toStrictEqual([[AFTER + 2, 0]])
    expect(selected(state, [3, [AFTER + 1, AFTER + 3], DOC.length])).toStrictEqual([AFTER, [AFTER + 1, AFTER + 3], DOC.length])
  })

  it('leaves the caret of a doc with no tag where it is', () => {
    expect(selected(createState(['Notes', 'ask'], ['user', 'user'], [3]), [0])).toStrictEqual([0])
  })

  it('moves a caret that a change leaves in the block', () => {
    const state = createState([`${BLOCK}\n\nMore`, 'ask'], ROLES, [AFTER])
    // CodeMirror's own Backspace on the empty line after the block.
    const next = state.update({ changes: { from: BLOCK.length, to: AFTER }, userEvent: 'delete.backward' }).state

    expect(next.doc.toString()).toBe(DOC)
    expect(next.selection.main.head).toBe(AFTER)
  })
})

describe('text at the block', () => {
  it('gives text typed at the end of the block its own line', () => {
    const state = createState(ONLY_BLOCK, ROLES, [BLOCK.length])
    const next = state.update({ changes: { from: BLOCK.length, insert: 'x' }, selection: { anchor: BLOCK.length + 1 }, userEvent: 'input.type' }).state

    expect(next.doc.toString()).toBe(joinSections([`${BLOCK}\nx`, 'ask']))
    expect(next.selection.main.head).toBe(AFTER + 1)
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  // A drop on the left part of the first pill is a drop at the doc start.
  it.each([
    ['an image', '![/home/u/.config/dez/assets/images/a.png](id=d)'],
    ['a clip, which ends with its own line break', `${PLAYER}\n`],
  ])('puts %s that is dropped before the block after the block', (_what, dropped) => {
    const state = createState(TEXTS, ROLES, [AFTER])
    const next = state.update({ changes: { from: 0, insert: dropped }, selection: { anchor: dropped.length }, userEvent: 'input.drop' }).state

    expect(next.doc.toString()).toBe(joinSections([`${BLOCK}\n${dropped.trimEnd()}\nMore`, 'ask']))
    expect(next.selection.main.head).toBe(AFTER + dropped.trimEnd().length)
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  // A text drag inside the doc, as CodeMirror's `dropText` makes it: the
  // dragged text moves to the drop point and stays selected.
  it('puts text that is dragged before the block after the block, and keeps it selected', () => {
    const state = createState([`${BLOCK}\nMore text`, 'ask'], ROLES, [AFTER])
    const from = AFTER + 'More'.length
    const changes = state.changes([{ from, to: from + ' text'.length }, { from: 0, insert: ' text' }])
    const next = state.update({ changes, selection: { anchor: changes.mapPos(0, -1), head: changes.mapPos(0, 1) }, userEvent: 'move.drop' }).state

    expect(next.doc.toString()).toBe(joinSections([`${BLOCK}\n text\nMore`, 'ask']))
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe(' text')
  })

  it('lets text that takes the place of a selection with the block remove the block', () => {
    const state = createState(TEXTS, ROLES, [[0, AFTER + 'More'.length]])
    const next = state.update({ changes: { from: 0, to: AFTER + 'More'.length, insert: 'x' }, userEvent: 'input.type' }).state

    expect(next.doc.toString()).toBe(joinSections(['x', 'ask']))
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'user' })
  })

  it('leaves a change that is no user input alone', () => {
    const state = createState(TEXTS, ROLES, [AFTER])
    const next = state.update({ changes: { from: 0, insert: 'x' } }).state

    expect(next.doc.toString()).toBe(`x${DOC}`)
  })
})

describe('Backspace after the block', () => {
  it('deletes the block, which makes the first section a user section, and an undo brings both back', () => {
    const { handled, state } = runCommand(createState(TEXTS, ROLES, [AFTER]), deleteLineBlockBackward)

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(joinSections(['More', 'ask']))
    expect(state.selection.main.head).toBe(0)
    expect(firstSection(state)).toStrictEqual({ id: 's0', role: 'user' })

    const undone = runCommand(state, undo).state

    expect(undone.doc.toString()).toBe(DOC)
    expect(undone.selection.main.head).toBe(AFTER)
    expect(firstSection(undone)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  it('deletes the block of a section that is only its block, and keeps the separator of the next section', () => {
    const { handled, state } = runCommand(createState(ONLY_BLOCK, ROLES, [BLOCK.length]), deleteLineBlockBackward)

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(`\n${SECTION_SEP}\nask`)
    expect(state.field(sectionsField).map((section) => section.role)).toStrictEqual(['user', 'user'])
  })
})
