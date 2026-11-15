import { undo } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { compactionTagText } from '../../model/chat/compaction'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP, sectionsField } from '../thread/cmEditor'
import { caretAfterCompactionTag, compactionTagRange } from './compaction'
import { deleteLineBlockBackward } from './lineBlocks'
import { PLAYER, createState, joinSections, runCommand, selectionOf } from './testing'

const TAG = compactionTagText({ count: 1, lastId: 'c', pictures: [] })
const ROLES: Role[] = ['agent', 'user']
/** A compaction section with notes, and the user message after it. */
const TEXTS = [`${TAG}\nNotes`, 'ask']
const DOC = joinSections(TEXTS)
/** The start of the notes: the first place for a caret. */
const NOTES = TAG.length + 1
/** A compaction section that is only its tag. */
const ONLY_TAG = [TAG, 'ask']

function firstSection(state: EditorState): unknown {
  return state.field(sectionsField)[0]
}

/** The selection of `state` after a transaction that sets `ranges`
 *  (`selectionOf`). */
function selected(state: EditorState, ranges: Array<number | [number, number]>): Array<number | [number, number]> {
  return state.update({ selection: selectionOf(ranges) }).state.selection.ranges.map((range) => (range.empty ? range.head : [range.anchor, range.head]))
}

describe('compactionTagRange', () => {
  it('is the first doc line when that line is a valid tag', () => {
    expect(compactionTagRange(createState(TEXTS, ROLES))).toStrictEqual([{ from: 0, to: TAG.length }])
    expect(compactionTagRange(createState(ONLY_TAG, ROLES))).toStrictEqual([{ from: 0, to: TAG.length }])
  })

  it('is empty for a first line with text next to the tag, and for a tag on a later line', () => {
    for (const text of ['Notes', `${TAG} Notes`, `Notes\n${TAG}`]) {
      expect(compactionTagRange(createState([text, 'ask'], ['user', 'user']))).toStrictEqual([])
    }
  })
})

describe('caretAfterCompactionTag', () => {
  it.each([
    ['the start of the line after the tag', `${TAG}\nNotes`, NOTES],
    ['the start of an empty line after the tag', `${TAG}\n`, NOTES],
    ['the end of the tag line in a doc with no other line', TAG, TAG.length],
    ['the end of the tag line before the separator of the next section', joinSections(ONLY_TAG), TAG.length],
  ])('is %s', (_place, doc, caret) => {
    expect(caretAfterCompactionTag(createState([doc], ['agent']).doc)).toBe(caret)
  })

  it('is null for a doc that starts with no tag', () => {
    expect(caretAfterCompactionTag(createState(['Notes', TAG], ['user', 'agent']).doc)).toBeNull()
  })
})

describe('the caret and the tag line', () => {
  it('moves a caret before the tag, in it, and at its end to the start of the notes', () => {
    const state = createState(TEXTS, ROLES, [NOTES + 2])

    expect([0, 5, TAG.length, NOTES, DOC.length].map((caret) => selected(state, [caret])))
      .toStrictEqual([[NOTES], [NOTES], [NOTES], [NOTES], [DOC.length]])
  })

  it('keeps a caret at the end of the tag line of a section that is only its tag', () => {
    const state = createState(ONLY_TAG, ROLES, [joinSections(ONLY_TAG).length])

    expect([0, TAG.length].map((caret) => selected(state, [caret]))).toStrictEqual([[TAG.length], [TAG.length]])
  })

  // Select All, and a selection that the user extends up to the doc start.
  it('keeps a selection that holds the tag, and moves only the carets of many', () => {
    const state = createState(TEXTS, ROLES, [NOTES + 2])

    expect(selected(state, [[0, DOC.length]])).toStrictEqual([[0, DOC.length]])
    expect(selected(state, [[NOTES + 2, 0]])).toStrictEqual([[NOTES + 2, 0]])
    expect(selected(state, [3, [NOTES + 1, NOTES + 3], DOC.length])).toStrictEqual([NOTES, [NOTES + 1, NOTES + 3], DOC.length])
  })

  it('leaves the caret of a doc with no tag where it is', () => {
    expect(selected(createState(['Notes', 'ask'], ['user', 'user'], [3]), [0])).toStrictEqual([0])
  })

  it('moves a caret that a change leaves before the notes', () => {
    const state = createState([`${TAG}\n\nNotes`, 'ask'], ROLES, [NOTES])
    // CodeMirror's own Backspace on the empty line after the tag.
    const next = state.update({ changes: { from: TAG.length, to: NOTES }, userEvent: 'delete.backward' }).state

    expect(next.doc.toString()).toBe(DOC)
    expect(next.selection.main.head).toBe(NOTES)
  })
})

describe('text at the tag line', () => {
  it('gives text typed at the end of the tag line its own line', () => {
    const state = createState(ONLY_TAG, ROLES, [TAG.length])
    const next = state.update({ changes: { from: TAG.length, insert: 'x' }, selection: { anchor: TAG.length + 1 }, userEvent: 'input.type' }).state

    expect(next.doc.toString()).toBe(joinSections([`${TAG}\nx`, 'ask']))
    expect(next.selection.main.head).toBe(NOTES + 1)
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  // A drop on the left part of the first pill is a drop at the doc start.
  it.each([
    ['an image', '![/home/u/.config/dez/assets/images/a.png](id=d)'],
    ['a clip, which ends with its own line break', `${PLAYER}\n`],
  ])('puts %s that is dropped before the tag after the tag line', (_what, dropped) => {
    const state = createState(TEXTS, ROLES, [NOTES])
    const next = state.update({ changes: { from: 0, insert: dropped }, selection: { anchor: dropped.length }, userEvent: 'input.drop' }).state

    expect(next.doc.toString()).toBe(joinSections([`${TAG}\n${dropped.trimEnd()}\nNotes`, 'ask']))
    expect(next.selection.main.head).toBe(NOTES + dropped.trimEnd().length)
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  // A text drag inside the doc, as CodeMirror's `dropText` makes it: the
  // dragged text moves to the drop point and stays selected.
  it('puts text that is dragged before the tag after the tag line, and keeps it selected', () => {
    const state = createState([`${TAG}\nNotes more`, 'ask'], ROLES, [NOTES])
    const from = NOTES + 'Notes'.length
    const changes = state.changes([{ from, to: from + ' more'.length }, { from: 0, insert: ' more' }])
    const next = state.update({ changes, selection: { anchor: changes.mapPos(0, -1), head: changes.mapPos(0, 1) }, userEvent: 'move.drop' }).state

    expect(next.doc.toString()).toBe(joinSections([`${TAG}\n more\nNotes`, 'ask']))
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe(' more')
  })

  it('lets text that takes the place of a selection with the tag remove the tag', () => {
    const state = createState(TEXTS, ROLES, [[0, NOTES + 'Notes'.length]])
    const next = state.update({ changes: { from: 0, to: NOTES + 'Notes'.length, insert: 'x' }, userEvent: 'input.type' }).state

    expect(next.doc.toString()).toBe(joinSections(['x', 'ask']))
    expect(firstSection(next)).toStrictEqual({ id: 's0', role: 'user' })
  })

  it('leaves a change that is no user input alone', () => {
    const state = createState(TEXTS, ROLES, [NOTES])
    const next = state.update({ changes: { from: 0, insert: 'x' } }).state

    expect(next.doc.toString()).toBe(`x${DOC}`)
  })
})

describe('Backspace at the start of the notes', () => {
  it('deletes the tag, which makes the first section a user section, and an undo brings both back', () => {
    const { handled, state } = runCommand(createState(TEXTS, ROLES, [NOTES]), deleteLineBlockBackward)

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(joinSections(['Notes', 'ask']))
    expect(state.selection.main.head).toBe(0)
    expect(firstSection(state)).toStrictEqual({ id: 's0', role: 'user' })

    const undone = runCommand(state, undo).state

    expect(undone.doc.toString()).toBe(DOC)
    expect(undone.selection.main.head).toBe(NOTES)
    expect(firstSection(undone)).toStrictEqual({ id: 's0', role: 'agent' })
  })

  it('deletes the tag of a section that is only its tag, and keeps the separator of the next section', () => {
    const { handled, state } = runCommand(createState(ONLY_TAG, ROLES, [TAG.length]), deleteLineBlockBackward)

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(`\n${SECTION_SEP}\nask`)
    expect(state.field(sectionsField).map((section) => section.role)).toStrictEqual(['user', 'user'])
  })
})
