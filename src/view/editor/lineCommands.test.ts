import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { mediaTagText } from '../../model/chat/mediaTags'
import { toolBlockText } from '../../model/chat/toolBlocks'
import type { Role } from '../../model/chat/types'
import {
  SECTION_SEP,
  encodePrompt,
  pillsField,
  promptAtomicRanges,
  scanPills,
  sectionsField,
  unwrapBrokenPills,
  type PillMetadata,
} from '../thread/cmEditor'
import { streamingSectionField } from '../thread/modelChip'
import { deleteLines, duplicateLines } from './lineCommands'
import { markdownMedia } from './media'
import { markdownToolCalls } from './toolCalls'

const CHIP = toolBlockText({ id: 'a', name: 'model_list', status: 'success', arguments: { filter: 'gemini' }, result: 'ok' })
const PLAYER = mediaTagText({ kind: 'video', id: 'a', type: 'video/webm', src: 'https://cdn.example/v.webm', url: 'https://cdn.example/v.webm', expires: null, other: [] })
const GREET: PillMetadata = { promptId: 'greet', name: 'Greet', expanded: false }

function joinSections(texts: string[]): string {
  return texts.join(`\n${SECTION_SEP}\n`)
}

/** Where `text` starts in the doc of `texts`, plus `offset`. */
function pos(texts: string[], text: string, offset = 0): number {
  const index = joinSections(texts).indexOf(text)
  if (index < 0) throw new Error(`pos: ${JSON.stringify(text)} is not in the doc`)
  return index + offset
}

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (the first is always `user`), the selection `ranges` (a number
 *  is a caret, a pair is an anchor and a head), and the prompt pill
 *  metadata `pills`. */
function createState(texts: string[], roles: Role[], ranges: Array<number | [number, number]>, pills: Record<string, PillMetadata> = {}): EditorState {
  return EditorState.create({
    doc: joinSections(texts),
    selection: EditorSelection.create(ranges.map((range) =>
      typeof range === 'number' ? EditorSelection.cursor(range) : EditorSelection.range(range[0], range[1]))),
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => null),
      pillsField.init(() => new Map(Object.entries(pills))),
      unwrapBrokenPills,
      promptAtomicRanges,
      markdownToolCalls(),
      markdownMedia(),
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
}

/** Runs a key command on a fake view. */
function runCommand(state: EditorState, command: (view: EditorView) => boolean): { handled: boolean, state: EditorState } {
  let next = state
  const view = {
    get state() {
      return next
    },
    dispatch(...specs: [Transaction] | TransactionSpec[]) {
      next = 'startState' in specs[0] ? specs[0].state : next.update(...specs as TransactionSpec[]).state
    },
  } as EditorView
  const handled = command(view)
  return { handled, state: next }
}

function heads(state: EditorState): number[] {
  return state.selection.ranges.map((range) => range.head)
}

describe('deleteLines', () => {
  it('deletes the line of the caret and puts the caret on the next line, at the same column', () => {
    const texts = ['alpha\nbravo\ncharlie']
    const { handled, state } = runCommand(createState(texts, ['user'], [pos(texts, 'bravo', 2)]), deleteLines)
    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe('alpha\ncharlie')
    expect(heads(state)).toEqual(['alpha\nch'.length])
  })

  it('puts the caret on the line above when the last line of a section goes, at most at its end', () => {
    const texts = ['ab\nlonger line', 'reply']
    const { state } = runCommand(createState(texts, ['user', 'agent'], [pos(texts, 'longer line', 8)]), deleteLines)
    expect(state.doc.toString()).toBe(joinSections(['ab', 'reply']))
    expect(heads(state)).toEqual(['ab'.length])
  })

  it('leaves one empty line for the only text of a section, so the sections stay', () => {
    const texts = ['ask', 'reply']
    const { state } = runCommand(createState(texts, ['user', 'agent'], [pos(texts, 'reply', 2)]), deleteLines)
    expect(state.doc.toString()).toBe(joinSections(['ask', '']))
    expect(state.field(sectionsField).map((section) => section.role)).toEqual(['user', 'agent'])
    expect(heads(state)).toEqual([state.doc.length])
  })

  it('deletes the lines of each selection range in one undo step, with one caret for each group of lines', () => {
    const texts = ['one\ntwo\nthree\nfour\nfive']
    const start = createState(texts, ['user'], [[pos(texts, 'one', 1), pos(texts, 'two', 1)], pos(texts, 'four', 2)])
    const { state } = runCommand(start, deleteLines)
    expect(state.doc.toString()).toBe('three\nfive')
    expect(heads(state)).toEqual([1, 'three\nfi'.length])
    expect(runCommand(state, undo).state.doc.toString()).toBe(texts[0])
  })

  it('leaves out the line where a selection ends at its start, and joins carets on lines next to each other', () => {
    const texts = ['one\ntwo\nthree\nfour']
    const endsAtLineStart = runCommand(createState(texts, ['user'], [[pos(texts, 'one'), pos(texts, 'three')]]), deleteLines).state
    expect(endsAtLineStart.doc.toString()).toBe('three\nfour')
    const nextToEachOther = runCommand(createState(texts, ['user'], [pos(texts, 'one', 1), pos(texts, 'two', 1)]), deleteLines).state
    expect(nextToEachOther.doc.toString()).toBe('three\nfour')
    expect(heads(nextToEachOther)).toEqual([1])
  })

  it('deletes an expanded prompt pill whole from its first or last line, and only the line of its body text', () => {
    const texts = [`before\n${encodePrompt('p1', 'x\ny\nz', false)}\nafter`]
    const pills = { p1: { ...GREET, expanded: true } }
    for (const line of ['x', 'z']) {
      const { state } = runCommand(createState(texts, ['user'], [pos(texts, line)], pills), deleteLines)
      expect(state.doc.toString(), line).toBe('before\nafter')
    }
    const { state } = runCommand(createState(texts, ['user'], [pos(texts, 'y')], pills), deleteLines)
    expect(state.doc.toString()).toBe(`before\n${encodePrompt('p1', 'x\nz', false)}\nafter`)
  })

  it('changes nothing when a line is a section separator, and still takes the key', () => {
    const texts = ['one', 'two']
    const across = createState(texts, ['user', 'agent'], [[pos(texts, 'one', 1), pos(texts, 'two', 1)]])
    const onSeparator = createState(texts, ['user', 'agent'], [pos(texts, 'one', 1), pos(texts, SECTION_SEP)])
    for (const start of [across, onSeparator]) {
      const { handled, state } = runCommand(start, deleteLines)
      expect(handled).toBe(true)
      expect(state.doc.toString()).toBe(joinSections(texts))
    }
  })
})

// A tool call chip of an agent section, and a player of any section.
describe.each([
  ['a tool call chip', CHIP, 'agent'],
  ['a media player', PLAYER, 'agent'],
  ['a media player of a user section', PLAYER, 'user'],
] as const)('deleteLines with %s', (_kind, block, role) => {
  const texts = ['ask', ['before', block, 'after'].join('\n')]
  const roles: Role[] = ['user', role]
  const from = pos(texts, block)
  const to = from + block.length

  it('deletes the whole block from a line that it is on, and from a selection that reaches it', () => {
    for (const ranges of [[from], [to], [[pos(texts, 'before', 2), from + 1]]] as Array<Array<number | [number, number]>>) {
      const { state } = runCommand(createState(texts, roles, ranges), deleteLines)
      const kept = ranges.length === 1 && typeof ranges[0] !== 'number' ? ['after'] : ['before', 'after']
      expect(state.doc.toString(), JSON.stringify(ranges)).toBe(joinSections(['ask', kept.join('\n')]))
    }
  })

  it('puts the caret beside the block, never inside it, when the line next to it goes', () => {
    const below = runCommand(createState(texts, roles, [pos(texts, 'before', 3)]), deleteLines).state
    expect(below.doc.toString()).toBe(joinSections(['ask', [block, 'after'].join('\n')]))
    expect(heads(below)).toEqual([pos(['ask', block], block)])
    const above = runCommand(createState(texts, roles, [pos(texts, 'after', 3)]), deleteLines).state
    const blockFrom = pos(['ask', `before\n${block}`], block)
    expect(above.doc.toString()).toBe(joinSections(['ask', ['before', block].join('\n')]))
    expect([blockFrom, blockFrom + block.length]).toContain(above.selection.main.head)
  })
})

describe('duplicateLines', () => {
  it('puts a copy of the lines above them and moves the selection down with its text, in one undo step', () => {
    const texts = ['one\ntwo\nthree']
    const caret = runCommand(createState(texts, ['user'], [pos(texts, 'two', 2)]), duplicateLines)
    expect(caret.handled).toBe(true)
    expect(caret.state.doc.toString()).toBe('one\ntwo\ntwo\nthree')
    expect(heads(caret.state)).toEqual(['one\ntwo\ntw'.length])
    const range = runCommand(createState(texts, ['user'], [[pos(texts, 'one', 1), pos(texts, 'two', 1)]]), duplicateLines).state
    expect(range.doc.toString()).toBe('one\ntwo\none\ntwo\nthree')
    expect(range.selection.main.anchor).toBe('one\ntwo\no'.length)
    expect(range.selection.main.head).toBe('one\ntwo\none\nt'.length)
    expect(runCommand(range, undo).state.doc.toString()).toBe(texts[0])
  })

  it('copies a player as it is, with its clip id', () => {
    const texts = ['ask', ['before', PLAYER, 'after'].join('\n')]
    const { state } = runCommand(createState(texts, ['user', 'agent'], [[pos(texts, 'before', 2), pos(texts, PLAYER, 1)]]), duplicateLines)
    expect(state.doc.toString()).toBe(joinSections(['ask', ['before', PLAYER, 'before', PLAYER, 'after'].join('\n')]))
  })

  it('gives each copied prompt pill a new id with a copy of its metadata', () => {
    const collapsed = [`a ${encodePrompt('p1', 'body')} b`]
    const expanded = [`before\n${encodePrompt('p1', 'x\ny', false)}\nafter`]
    const cases: Array<[string[], number, PillMetadata, (id: string) => string]> = [
      [collapsed, 0, GREET, (id) => `a ${encodePrompt(id, 'body')} b\n${collapsed[0]}`],
      [expanded, pos(expanded, 'x'), { ...GREET, expanded: true }, (id) => `before\n${encodePrompt(id, 'x\ny', false)}\n${encodePrompt('p1', 'x\ny', false)}\nafter`],
    ]
    for (const [texts, caret, meta, expected] of cases) {
      const { state } = runCommand(createState(texts, ['user'], [caret], { p1: meta }), duplicateLines)
      const [copy, original] = scanPills(state.doc.toString())
      expect(original.id).toBe('p1')
      expect(copy.id).not.toBe('p1')
      expect(state.doc.toString()).toBe(expected(copy.id))
      expect(state.field(pillsField).get(copy.id)).toEqual(meta)
      expect(state.field(pillsField).get('p1')).toEqual(meta)
    }
  })

  it('copies nothing when a line holds a tool call of an agent section; in a user section a tool call is text', () => {
    const texts = ['ask', ['before', CHIP, 'after'].join('\n')]
    const agent = runCommand(createState(texts, ['user', 'agent'], [pos(texts, CHIP)]), duplicateLines)
    expect(agent.handled).toBe(true)
    expect(agent.state.doc.toString()).toBe(joinSections(texts))
    const user = runCommand(createState(texts, ['user', 'user'], [pos(texts, CHIP)]), duplicateLines)
    const firstLine = CHIP.split('\n')[0]
    expect(user.state.doc.toString()).toBe(joinSections(['ask', ['before', firstLine, CHIP, 'after'].join('\n')]))
  })

  it('changes nothing when a line is a section separator, and still takes the key', () => {
    const texts = ['one', 'two']
    const { handled, state } = runCommand(createState(texts, ['user', 'agent'], [[pos(texts, 'one', 1), pos(texts, 'two', 1)]]), duplicateLines)
    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe(joinSections(texts))
  })
})
