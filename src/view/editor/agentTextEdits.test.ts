import { undo } from '@codemirror/commands'
import type { Transaction, TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../model/chat/types'
import { mergeSectionEffect, toggleSectionRoleEffect } from '../thread/cmEditor'
import { editsAgentText } from './agentTextEdits'
import { createState, joinSections } from './testing'

// A user message, a reply, and the next user message.
const TEXTS = ['ask', 'reply', 'next']
const ROLES: Role[] = ['user', 'agent', 'user']
const REPLY_FROM = joinSections(['ask', '']).length
const REPLY_TO = REPLY_FROM + 'reply'.length
const NEXT_FROM = joinSections(['ask', 'reply', '']).length

function edits(spec: TransactionSpec, texts = TEXTS, roles = ROLES): boolean {
  return editsAgentText(createState(texts, roles).update(spec))
}

const typed = (pos: number): TransactionSpec => ({ changes: { from: pos, insert: '!' }, userEvent: 'input.type' })

describe('editsAgentText', () => {
  it('counts a user change of a reply, also at its start and at its end', () => {
    expect(edits(typed(REPLY_FROM))).toBe(true)
    expect(edits(typed(REPLY_TO))).toBe(true)
    expect(edits({ changes: { from: REPLY_FROM + 1, to: REPLY_FROM + 2 }, userEvent: 'delete.backward' })).toBe(true)
  })

  it('does not count a change of a user message, also right before and right after a reply', () => {
    expect(edits(typed(0))).toBe(false)
    expect(edits(typed('ask'.length))).toBe(false)
    expect(edits(typed(NEXT_FROM))).toBe(false)
  })

  // The stream and the tools write replies, and a clip Save rewrites a tag.
  it('does not count a change of a reply that the user did not make', () => {
    expect(edits({ changes: { from: REPLY_TO, insert: ' more' } })).toBe(false)
  })

  it('counts a delete that removes a reply with its separator', () => {
    expect(edits({ changes: { from: 1, to: REPLY_FROM + 2 }, userEvent: 'delete.selection' })).toBe(true)
  })

  it('counts an undo of a change of a reply', () => {
    const changed = createState(TEXTS, ROLES).update(typed(REPLY_TO)).state
    let undone: Transaction | undefined
    expect(undo({ state: changed, dispatch: (tr) => { undone = tr } })).toBe(true)

    expect(editsAgentText(undone as Transaction)).toBe(true)
  })

  it('counts a role switch of a section with text, to user or to agent, and not of an empty reply', () => {
    const toggle = (id: string): TransactionSpec => ({ effects: toggleSectionRoleEffect.of({ id }), userEvent: 'input.role' })

    expect(edits(toggle('s1'))).toBe(true)
    expect(edits(toggle('s2'))).toBe(true)
    expect(edits(toggle('s1'), ['ask', '', 'next'])).toBe(false)
  })

  // The Backspace at the start of a message (`mergeWithPreviousSection` in
  // ThreadEditor.vue).
  it('counts a merge of a message into the reply before it only when the message has text', () => {
    const merge: TransactionSpec = {
      changes: { from: REPLY_TO, to: NEXT_FROM },
      effects: mergeSectionEffect.of({ removeIndex: 2 }),
      userEvent: 'delete.backward',
    }

    expect(edits(merge)).toBe(true)
    expect(edits(merge, ['ask', 'reply', ''])).toBe(false)
  })
})
