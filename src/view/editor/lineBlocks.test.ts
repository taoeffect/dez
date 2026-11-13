import { insertNewlineAndIndent, undo } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP } from '../thread/cmEditor'
import { deleteLineBlockBackward, deleteLineBlockForward, joinsLineBlock } from './lineBlocks'
import { renderedMedia } from './media'
import { CHIP, PLAYER, createState, joinSections, runCommand } from './testing'
import { renderedToolCalls } from './toolCalls'

/** The source of each block that the editor shows, in doc order. */
function shown(state: EditorState): string[] {
  return [...renderedToolCalls(state), ...renderedMedia(state)]
    .sort((a, b) => a.from - b.from)
    .map(({ from, to }) => state.sliceDoc(from, to))
}

function insert(state: EditorState, text: string, userEvent = 'input.type'): EditorState {
  const { from, to } = state.selection.main
  return state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent }).state
}

/** A text drag inside the doc, made as CodeMirror's `dropText` makes it:
 *  the dragged range `from`–`to` moves to `dropPos` and stays selected. */
function drag(state: EditorState, from: number, to: number, dropPos: number): EditorState {
  const changes = state.changes([{ from, to }, { from: dropPos, insert: state.sliceDoc(from, to) }])
  return state.update({ changes, selection: { anchor: changes.mapPos(dropPos, -1), head: changes.mapPos(dropPos, 1) }, userEvent: 'move.drop' }).state
}

/** Whether a merge of section `index` into the section before it, which
 *  deletes the separator line and its line breaks, joins a block line to
 *  text. */
function mergeJoins(sections: string[], roles: Role[], index: number): boolean {
  const separator = joinSections(sections.slice(0, index)).length + 1
  return joinsLineBlock(createState(sections, roles), separator - 1, separator + SECTION_SEP.length + 1)
}

// Every rule holds for each kind of block, and for a player in each role
// of section.
describe.each([
  ['a tool call chip', CHIP, 'agent'],
  ['a media player', PLAYER, 'agent'],
  ['a media player of a user section', PLAYER, 'user'],
] as const)('with %s', (_kind, block, role) => {
  const texts = ['ask', ['before', block, 'after'].join('\n')]
  const roles: Role[] = ['user', role]
  const doc = joinSections(texts)
  const from = doc.indexOf(block)
  const to = from + block.length
  const withLine = (lines: string[]) => joinSections(['ask', lines.join('\n')])

  describe('deleteLineBlockBackward and deleteLineBlockForward', () => {
    it('delete the block and its line break from either side', () => {
      for (const caret of [to, to + 1]) {
        const { handled, state } = runCommand(createState(texts, roles, [caret]), deleteLineBlockBackward)
        expect(handled).toBe(true)
        expect(state.doc.toString()).toBe(withLine(['before', 'after']))
        expect(state.selection.main.head).toBe(from)
      }
      for (const caret of [from, from - 1]) {
        const { handled, state } = runCommand(createState(texts, roles, [caret]), deleteLineBlockForward)
        expect(handled).toBe(true)
        expect(state.doc.toString()).toBe(withLine(['before', 'after']))
      }
    })

    it('move the caret over the line break on the block\'s other side', () => {
      const cases: [number, (view: EditorView) => boolean, number][] = [
        [from, deleteLineBlockBackward, from - 1],
        [to, deleteLineBlockForward, to + 1],
      ]
      for (const [caret, command, moved] of cases) {
        const { handled, state } = runCommand(createState(texts, roles, [caret]), command)
        expect(handled).toBe(true)
        expect(state.doc.toString()).toBe(doc)
        expect(state.selection.main.head).toBe(moved)
      }
    })

    it('leave other carets to the next key rule', () => {
      const cases: [number[], (view: EditorView) => boolean][] = [
        [[to + 2], deleteLineBlockBackward],
        [[from - 2], deleteLineBlockForward],
        [[to, 1], deleteLineBlockBackward],
        [[from, 1], deleteLineBlockBackward],
      ]
      for (const [carets, command] of cases) {
        const { handled, state } = runCommand(createState(texts, roles, carets), command)
        expect(handled).toBe(false)
        expect(state.doc.toString()).toBe(doc)
      }
    })

    it('leave an empty line beside the block to the next key rule', () => {
      const spaced = ['ask', ['before', '', block, '', 'after'].join('\n')]
      const blockFrom = joinSections(spaced).indexOf(block)
      const blockTo = blockFrom + block.length
      const cases: [number, (view: EditorView) => boolean][] = [
        [blockTo + 1, deleteLineBlockBackward],
        [blockFrom - 1, deleteLineBlockForward],
        [blockFrom, deleteLineBlockBackward],
        [blockTo, deleteLineBlockForward],
      ]
      for (const [caret, command] of cases) {
        expect(runCommand(createState(spaced, roles, [caret]), command).handled).toBe(false)
      }
    })

    it('leave a separator beside the block to the section merge', () => {
      const start = joinSections(['ask', '']).length
      const state = (caret: number) => createState(['ask', block, 'next'], ['user', role, 'user'], [caret])
      expect(runCommand(state(start), deleteLineBlockBackward).handled).toBe(false)
      expect(runCommand(state(start + block.length), deleteLineBlockForward).handled).toBe(false)
    })

    it('take the line break before a block at the end of its section', () => {
      const end = joinSections(['ask', `before\n${block}`]).length
      const { state } = runCommand(createState(['ask', `before\n${block}`, 'next'], ['user', role, 'user'], [end]), deleteLineBlockBackward)
      expect(state.doc.toString()).toBe(joinSections(['ask', 'before', 'next']))
    })

    it('leave an empty line for a block that is the whole section', () => {
      const start = joinSections(['ask', '']).length
      const { state } = runCommand(createState(['ask', block, 'next'], ['user', role, 'user'], [start]), deleteLineBlockForward)
      expect(state.doc.toString()).toBe(joinSections(['ask', '', 'next']))
    })

    it('can be undone', () => {
      const { state } = runCommand(createState(texts, roles, [to]), deleteLineBlockBackward)
      let restored = state
      expect(undo({ state, dispatch: (tr) => { restored = tr.state } })).toBe(true)
      expect(restored.doc.toString()).toBe(doc)
      expect(shown(restored)).toEqual([block])
    })
  })

  describe('joinsLineBlock', () => {
    it('tells whether a section merge would put a block line on one line with text', () => {
      expect(mergeJoins(['ask', `before\n${block}`, 'next'], ['user', role, 'user'], 2)).toBe(true)
      expect(mergeJoins(['ask', `before\n${block}`, 'next'], ['user', role, 'user'], 1)).toBe(false)
      expect(mergeJoins(['ask', 'text', block], ['user', role, role], 2)).toBe(true)
      expect(mergeJoins(['ask', block, ''], ['user', role, 'user'], 2)).toBe(false)
      expect(mergeJoins(['ask', '', block], ['user', role, role], 2)).toBe(false)
    })
  })

  describe('text typed next to the block', () => {
    it('goes on its own line after the block', () => {
      const state = insert(createState(texts, roles, [to]), 'xy')
      expect(state.doc.toString()).toBe(withLine(['before', block, 'xy', 'after']))
      expect(state.selection.main.head).toBe(to + 3)
      expect(shown(state)).toEqual([block])
    })

    it('goes on its own line before the block', () => {
      const state = insert(createState(texts, roles, [from]), 'xy', 'input.paste')
      expect(state.doc.toString()).toBe(withLine(['before', 'xy', block, 'after']))
      expect(state.selection.main.head).toBe(from + 2)
      expect(shown(state)).toEqual([block])
    })

    it('gets no extra line break when it has one at the block', () => {
      expect(insert(createState(texts, roles, [to]), '\nxy').doc.toString()).toBe(withLine(['before', block, 'xy', 'after']))
      expect(insert(createState(texts, roles, [from]), 'xy\n').doc.toString()).toBe(withLine(['before', 'xy', block, 'after']))
    })

    it('keeps the block when Enter is pressed at either side of it', () => {
      const atEnd = runCommand(createState(texts, roles, [to]), insertNewlineAndIndent).state
      expect(atEnd.doc.toString()).toBe(withLine(['before', block, '', 'after']))
      expect(shown(atEnd)).toStrictEqual([block])
      const atStart = runCommand(createState(texts, roles, [from]), insertNewlineAndIndent).state
      expect(atStart.doc.toString()).toBe(withLine(['before', '', block, 'after']))
      expect(shown(atStart)).toStrictEqual([block])
    })

    it('goes on its own line when it is dragged to the block', () => {
      const state = createState(texts, roles)
      const afterAt = doc.indexOf('after')
      const toStart = drag(state, afterAt, afterAt + 'after'.length, from)
      expect(toStart.doc.toString()).toBe(withLine(['before', 'after', block, '']))
      expect(toStart.sliceDoc(toStart.selection.main.from, toStart.selection.main.to)).toBe('after')
      expect(shown(toStart)).toEqual([block])
      const beforeAt = doc.indexOf('before')
      const toEnd = drag(state, beforeAt, beforeAt + 'before'.length, to)
      expect(toEnd.doc.toString()).toBe(withLine(['', block, 'before', 'after']))
      expect(toEnd.sliceDoc(toEnd.selection.main.from, toEnd.selection.main.to)).toBe('before')
      expect(shown(toEnd)).toEqual([block])
    })

    it('is left alone when it is not user input, or is an IME composition', () => {
      const glued = withLine(['before', `${block}xy`, 'after'])
      expect(createState(texts, roles).update({ changes: { from: to, insert: 'xy' } }).state.doc.toString()).toBe(glued)
      expect(insert(createState(texts, roles, [to]), 'xy', 'input.type.compose').doc.toString()).toBe(glued)
    })
  })
})

describe('a tool call chip in a user section', () => {
  const texts = ['ask', ['before', CHIP, 'after'].join('\n')]
  const from = joinSections(texts).indexOf(CHIP)

  it('is text, and no block', () => {
    expect(shown(createState(texts, ['user', 'user']))).toStrictEqual([])
    for (const caret of [from, from + CHIP.length]) {
      expect(runCommand(createState(texts, ['user', 'user'], [caret]), deleteLineBlockBackward).handled).toBe(false)
    }
    expect(mergeJoins(['ask', CHIP, 'next'], ['user', 'user', 'user'], 2)).toBe(false)
  })
})

describe('a tool call chip and a media player on lines that touch', () => {
  const texts = ['ask', [CHIP, PLAYER].join('\n')]
  const doc = joinSections(texts)
  const playerFrom = doc.indexOf(PLAYER)

  it('both stay blocks when text is typed between them', () => {
    const afterChip = insert(createState(texts, ['user', 'agent'], [playerFrom - 1]), 'xy')
    expect(afterChip.doc.toString()).toBe(joinSections(['ask', [CHIP, 'xy', PLAYER].join('\n')]))
    const beforePlayer = insert(createState(texts, ['user', 'agent'], [playerFrom]), 'xy')
    expect(beforePlayer.doc.toString()).toBe(joinSections(['ask', [CHIP, 'xy', PLAYER].join('\n')]))
    expect(shown(beforePlayer)).toEqual([CHIP, PLAYER])
  })

  it('Backspace between them deletes the block before the caret', () => {
    const { state } = runCommand(createState(texts, ['user', 'agent'], [playerFrom]), deleteLineBlockBackward)
    expect(state.doc.toString()).toBe(joinSections(['ask', PLAYER]))
    expect(shown(state)).toEqual([PLAYER])
  })
})
