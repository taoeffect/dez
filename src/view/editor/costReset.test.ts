import { redo, selectAll, undo } from '@codemirror/commands'
import { StateEffect, type EditorState, type StateCommand, type Transaction, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { compactionBlockText } from '../../model/chat/compaction'
import type { TabCostNumbers } from '../../model/chat/conversationCost'
import type { Role } from '../../model/chat/types'
import { cutSelectedRangesTransaction, sectionsField } from '../thread/cmEditor'
import { costChange, costReset, tabCostSource } from './costReset'
import { createState, joinSections } from './testing'

// A user message, a reply, and the next user message.
const TEXTS = ['ask', 'reply', 'next']
const ROLES: Role[] = ['user', 'agent', 'user']
const DOC = joinSections(TEXTS)

const FIRST: TabCostNumbers = { cost: { usd: 0.5, requests: 2, unpriced: 0 }, agentTextEdited: true }
const SECOND: TabCostNumbers = { cost: { usd: 0.75, requests: 3, unpriced: 1 } }

// The numbers that the source of the states gives; a test changes them.
let numbers: TabCostNumbers = FIRST

function costState(texts = TEXTS, roles = ROLES, ranges: Array<number | [number, number]> = []): EditorState {
  return createState(texts, roles, ranges).update({
    effects: StateEffect.appendConfig.of([costReset(), tabCostSource.of(() => numbers)]),
  }).state
}

// Runs a command of the state, and gives its transaction.
function commandStep(state: EditorState, command: StateCommand): Transaction {
  let step: Transaction | undefined
  expect(command({ state, dispatch: (tr) => { step = tr } })).toBe(true)
  return step as Transaction
}

// Select All, then Backspace: the delete of the selection.
function deleteAll(state: EditorState): Transaction {
  const selected = commandStep(state, selectAll).state
  return selected.update({ changes: { from: 0, to: selected.selection.main.to }, userEvent: 'delete.selection' })
}

describe('costReset', () => {
  it('resets at Select All, then a delete or a cut, which leave the doc of one empty user section', () => {
    const deleted = deleteAll(costState())
    const selected = commandStep(costState(), selectAll).state
    const cut = selected.update(cutSelectedRangesTransaction(selected) as TransactionSpec)

    for (const tr of [deleted, cut]) {
      expect(costChange(tr)).toBe('reset')
      expect(tr.state.doc.toString()).toBe('')
      expect(tr.state.field(sectionsField).map((section) => section.role)).toStrictEqual(['user'])
    }
  })

  it('does not reset for a change that is not a delete of the whole doc by the user', () => {
    const end = DOC.length
    const lastCharacter = costState(['a'], ['user'], [1]).update({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' })
    const typedOver = costState(TEXTS, ROLES, [[0, end]]).update({ changes: { from: 0, to: end, insert: 'x' }, userEvent: 'input.type' })
    const programWrite = costState(TEXTS, ROLES, [[0, end]]).update({ changes: { from: 0, to: end } })
    const emptyDoc = costState([''], ['user'], [[0, 0]]).update({ changes: { from: 0, to: 0 }, userEvent: 'delete.selection' })
    const allButSeparator = costState(['a', 'b'], ['user', 'agent'], [[0, joinSections(['a', 'b']).length]]).update({
      changes: [{ from: 0, to: 1 }, { from: joinSections(['a', '']).length, to: joinSections(['a', 'b']).length }],
      userEvent: 'delete.selection',
    })

    for (const tr of [lastCharacter, typedOver, programWrite, emptyDoc, allButSeparator]) expect(costChange(tr)).toBeNull()
    expect(allButSeparator.state.doc.length).toBeGreaterThan(0)
  })

  // The source reads the tab at each inverse: a redo can remove other
  // numbers than the first delete did.
  it('restores the numbers of the source at an undo, resets again at a redo, and restores the newer numbers at the next undo', () => {
    numbers = FIRST
    const deleted = deleteAll(costState())

    const undone = commandStep(deleted.state, undo)
    expect(costChange(undone)).toStrictEqual({ restore: FIRST })
    expect(undone.state.doc.toString()).toBe(DOC)
    expect(undone.state.field(sectionsField).map((section) => section.role)).toStrictEqual(ROLES)

    numbers = SECOND
    const redone = commandStep(undone.state, redo)
    expect(costChange(redone)).toBe('reset')
    expect(redone.state.doc.toString()).toBe('')

    const undoneAgain = commandStep(redone.state, undo)
    expect(costChange(undoneAgain)).toStrictEqual({ restore: SECOND })
    expect(undoneAgain.state.doc.toString()).toBe(DOC)
    numbers = FIRST
  })

  it('keeps typing right after the delete out of its undo step', () => {
    const deleted = deleteAll(costState())
    const typed = deleted.state.update({ changes: { from: 0, insert: 'new' }, userEvent: 'input.type' })

    const undone = commandStep(typed.state, undo)
    expect(costChange(undone)).toBeNull()
    expect(undone.state.doc.toString()).toBe('')
  })

  it('resets at Select All and a delete in a compacted doc', () => {
    const block = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, 'Notes')
    const deleted = deleteAll(costState([`${block}\nMore`, 'ask'], ['agent', 'user']))

    expect(costChange(deleted)).toBe('reset')
    expect(deleted.state.doc.toString()).toBe('')
  })
})
