import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../model/chat/types'
import { toolBlockText, type ToolBlockStatus } from '../../model/chat/toolBlocks'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionThinkingEffect } from '../thread/cmEditor'
import { setStreamingSectionEffect, streamingSectionField } from '../thread/modelChip'
import { deleteToolCallBackward, deleteToolCallForward, joinsToolCallLine, markdownToolCalls, renderedToolCalls, toolCallSummary } from './toolCalls'

function block(id: string, status: ToolBlockStatus = 'success', result = 'ok'): string {
  return toolBlockText({ id, name: 'model_list', status, arguments: { filter: 'gemini' }, result: status === 'running' ? '' : result })
}

function joinSections(texts: string[]): string {
  return texts.join(`\n${SECTION_SEP}\n`)
}

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (section ids `s0`, `s1`, …), and carets at `carets`. The first
 *  section is always `user` (`normalizeSectionModels` in cmEditor.ts). */
function createState(texts: string[], roles: Role[], options: { carets?: number[]; streaming?: string } = {}): EditorState {
  const carets = options.carets ?? []
  return EditorState.create({
    doc: joinSections(texts),
    selection: carets.length ? EditorSelection.create(carets.map((pos) => EditorSelection.cursor(pos))) : undefined,
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => options.streaming ?? null),
      markdownToolCalls(),
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
}

/** The id, state, and source of each call that the editor shows. */
function shown(state: EditorState): [string, string, string][] {
  return renderedToolCalls(state).map((call) => [call.id, call.state, state.sliceDoc(call.from, call.to)])
}

/** Runs a key command on a fake view; the next state is unchanged when the
 *  command does not handle the key. */
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

function insert(state: EditorState, text: string, userEvent = 'input.type'): EditorState {
  const { from, to } = state.selection.main
  return state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent }).state
}

describe('renderedToolCalls', () => {
  it('shows blocks of agent sections only, at their doc offsets', () => {
    const state = createState([`user\n${block('u')}`, `${block('a')}\nafter`, block('u2'), `before\n${block('b', 'error', 'boom')}`], ['user', 'agent', 'user', 'agent'])
    expect(shown(state)).toEqual([
      ['a', 'success', block('a')],
      ['b', 'error', block('b', 'error', 'boom')],
    ])
  })

  it('never pairs an opening line with a closing line of a later section', () => {
    const opening = block('a').split('\n')[0]
    const state = createState(['ask', opening, 'text\n</dez:tool>'], ['user', 'agent', 'agent'])
    expect(shown(state)).toEqual([])
  })

  it('leaves a block that holds a sentinel as text', () => {
    const state = createState(['ask', `<dez:tool id="a" name="model_list">\nx ${PILL_OPEN} y\n</dez:tool>`], ['user', 'agent'])
    expect(shown(state)).toEqual([])
  })

  it('shows a running block as running only in the streaming section', () => {
    const state = createState(['ask', block('a', 'running'), block('b', 'running')], ['user', 'agent', 'agent'], { streaming: 's2' })
    expect(shown(state).map(([id, state]) => [id, state])).toEqual([['a', 'interrupted'], ['b', 'running']])
    const ended = state.update({ effects: setStreamingSectionEffect.of(null) }).state
    expect(shown(ended).map(([id, state]) => [id, state])).toEqual([['a', 'interrupted'], ['b', 'interrupted']])
  })

  it('keeps the same array until a change can change the chips', () => {
    const state = createState(['ask', block('a')], ['user', 'agent'])
    const calls = renderedToolCalls(state)
    const moved = state.update({ selection: { anchor: 0 } }).state
    expect(renderedToolCalls(moved)).toBe(calls)
    const thought = moved.update({ effects: setSectionThinkingEffect.of({ sectionId: 's1', thinking: { text: 'hmm' } }) }).state
    expect(renderedToolCalls(thought)).toBe(calls)
    const typed = thought.update({ changes: { from: 0, insert: 'x' } }).state
    expect(renderedToolCalls(typed)).not.toBe(calls)
    expect(renderedToolCalls(typed)[0].from).toBe(calls[0].from + 1)
  })
})

describe('toolCallSummary', () => {
  it('shows the first argument on one line, a string in quotes', () => {
    expect(toolCallSummary({})).toBe('')
    expect(toolCallSummary({ filter: '  gem\n\tini ', other: 'x' })).toBe('"gem ini"')
    expect(toolCallSummary({ count: 3 })).toBe('3')
    expect(toolCallSummary({ all: false })).toBe('false')
  })

  it('cuts a long value at 40 characters, the ellipsis included', () => {
    expect(toolCallSummary({ filter: 'a'.repeat(40) })).toBe(`"${'a'.repeat(40)}"`)
    expect(toolCallSummary({ filter: 'a'.repeat(41) })).toBe(`"${'a'.repeat(39)}…"`)
    expect(toolCallSummary({ filter: '😀'.repeat(41) })).toBe(`"${'😀'.repeat(39)}…"`)
  })
})

describe('deleteToolCallBackward and deleteToolCallForward', () => {
  const call = block('a')
  const texts = ['ask', ['before', call, 'after'].join('\n')]
  const doc = joinSections(texts)
  const from = doc.indexOf(call)
  const to = from + call.length
  const withoutCall = joinSections(['ask', 'before\nafter'])

  it('delete the block and its line break from either side', () => {
    for (const caret of [to, to + 1]) {
      const { handled, state } = runCommand(createState(texts, ['user', 'agent'], { carets: [caret] }), deleteToolCallBackward)
      expect(handled).toBe(true)
      expect(state.doc.toString()).toBe(withoutCall)
      expect(state.selection.main.head).toBe(from)
    }
    for (const caret of [from, from - 1]) {
      const { handled, state } = runCommand(createState(texts, ['user', 'agent'], { carets: [caret] }), deleteToolCallForward)
      expect(handled).toBe(true)
      expect(state.doc.toString()).toBe(withoutCall)
    }
  })

  it('move the caret over the line break on the chip\'s other side', () => {
    const cases: [number, (view: EditorView) => boolean, number][] = [
      [from, deleteToolCallBackward, from - 1],
      [to, deleteToolCallForward, to + 1],
    ]
    for (const [caret, command, moved] of cases) {
      const { handled, state } = runCommand(createState(texts, ['user', 'agent'], { carets: [caret] }), command)
      expect(handled).toBe(true)
      expect(state.doc.toString()).toBe(doc)
      expect(state.selection.main.head).toBe(moved)
    }
  })

  it('leave other carets to the next key rule', () => {
    const cases: [number[], (view: EditorView) => boolean][] = [
      [[to + 2], deleteToolCallBackward],
      [[from - 2], deleteToolCallForward],
      [[to, 1], deleteToolCallBackward],
      [[from, 1], deleteToolCallBackward],
    ]
    for (const [carets, command] of cases) {
      const { handled, state } = runCommand(createState(texts, ['user', 'agent'], { carets }), command)
      expect(handled).toBe(false)
      expect(state.doc.toString()).toBe(doc)
    }
    for (const caret of [from, to]) {
      expect(runCommand(createState(texts, ['user', 'user'], { carets: [caret] }), deleteToolCallBackward).handled).toBe(false)
    }
  })

  it('leave an empty line beside the chip to the next key rule', () => {
    const spaced = ['ask', ['before', '', call, '', 'after'].join('\n')]
    const spacedDoc = joinSections(spaced)
    const callFrom = spacedDoc.indexOf(call)
    const callTo = callFrom + call.length
    const cases: [number, (view: EditorView) => boolean][] = [
      [callTo + 1, deleteToolCallBackward],
      [callFrom - 1, deleteToolCallForward],
      [callFrom, deleteToolCallBackward],
      [callTo, deleteToolCallForward],
    ]
    for (const [caret, command] of cases) {
      expect(runCommand(createState(spaced, ['user', 'agent'], { carets: [caret] }), command).handled).toBe(false)
    }
  })

  it('leave a separator beside the chip to the section merge', () => {
    const start = joinSections(['ask', '']).length
    const state = (caret: number) => createState(['ask', call, 'next'], ['user', 'agent', 'user'], { carets: [caret] })
    expect(runCommand(state(start), deleteToolCallBackward).handled).toBe(false)
    expect(runCommand(state(start + call.length), deleteToolCallForward).handled).toBe(false)
  })

  it('take the line break before a block at the end of its section', () => {
    const end = joinSections(['ask', `before\n${call}`]).length
    const { state } = runCommand(createState(['ask', `before\n${call}`, 'next'], ['user', 'agent', 'user'], { carets: [end] }), deleteToolCallBackward)
    expect(state.doc.toString()).toBe(joinSections(['ask', 'before', 'next']))
  })

  it('leave an empty line for a block that is the whole section', () => {
    const start = joinSections(['ask', '']).length
    const { state } = runCommand(createState(['ask', call, 'next'], ['user', 'agent', 'user'], { carets: [start] }), deleteToolCallForward)
    expect(state.doc.toString()).toBe(joinSections(['ask', '', 'next']))
  })

  it('can be undone', () => {
    const { state } = runCommand(createState(texts, ['user', 'agent'], { carets: [to] }), deleteToolCallBackward)
    let restored = state
    expect(undo({ state, dispatch: (tr) => { restored = tr.state } })).toBe(true)
    expect(restored.doc.toString()).toBe(doc)
    expect(shown(restored).map(([id]) => id)).toEqual(['a'])
  })
})

describe('joinsToolCallLine', () => {
  const call = block('a')

  /** Whether a merge of section `index` into the section before it, which
   *  deletes the separator line and its line breaks, joins a chip line to
   *  text. */
  function mergeJoins(texts: string[], roles: Role[], index: number): boolean {
    const separator = joinSections(texts.slice(0, index)).length + 1
    return joinsToolCallLine(createState(texts, roles), separator - 1, separator + SECTION_SEP.length + 1)
  }

  it('tells whether a section merge would put a chip line on one line with text', () => {
    expect(mergeJoins(['ask', `before\n${call}`, 'next'], ['user', 'agent', 'user'], 2)).toBe(true)
    expect(mergeJoins(['ask', `before\n${call}`, 'next'], ['user', 'agent', 'user'], 1)).toBe(false)
    expect(mergeJoins(['ask', 'text', call], ['user', 'agent', 'agent'], 2)).toBe(true)
    expect(mergeJoins(['ask', call, ''], ['user', 'agent', 'user'], 2)).toBe(false)
    expect(mergeJoins(['ask', '', call], ['user', 'agent', 'agent'], 2)).toBe(false)
    expect(mergeJoins(['ask', call, 'next'], ['user', 'user', 'user'], 2)).toBe(false)
  })
})

describe('text typed next to a chip', () => {
  const call = block('a')
  const texts = ['ask', ['before', call, 'after'].join('\n')]
  const doc = joinSections(texts)
  const from = doc.indexOf(call)
  const to = from + call.length
  const withLine = (lines: string[]) => joinSections(['ask', lines.join('\n')])

  it('goes on its own line after the chip', () => {
    const state = insert(createState(texts, ['user', 'agent'], { carets: [to] }), 'xy')
    expect(state.doc.toString()).toBe(withLine(['before', call, 'xy', 'after']))
    expect(state.selection.main.head).toBe(to + 3)
    expect(shown(state).map(([id]) => id)).toEqual(['a'])
  })

  it('goes on its own line before the chip', () => {
    const state = insert(createState(texts, ['user', 'agent'], { carets: [from] }), 'xy', 'input.paste')
    expect(state.doc.toString()).toBe(withLine(['before', 'xy', call, 'after']))
    expect(state.selection.main.head).toBe(from + 2)
    expect(shown(state).map(([id]) => id)).toEqual(['a'])
  })

  it('gets no extra line break when it has one at the chip', () => {
    expect(insert(createState(texts, ['user', 'agent'], { carets: [to] }), '\nxy').doc.toString()).toBe(withLine(['before', call, 'xy', 'after']))
    expect(insert(createState(texts, ['user', 'agent'], { carets: [from] }), 'xy\n').doc.toString()).toBe(withLine(['before', 'xy', call, 'after']))
  })

  it('is left alone when it is not user input, or is an IME composition', () => {
    const glued = withLine(['before', `${call}xy`, 'after'])
    expect(createState(texts, ['user', 'agent']).update({ changes: { from: to, insert: 'xy' } }).state.doc.toString()).toBe(glued)
    expect(insert(createState(texts, ['user', 'agent'], { carets: [to] }), 'xy', 'input.type.compose').doc.toString()).toBe(glued)
  })
})
