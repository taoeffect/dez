import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../model/chat/types'
import { toolBlockText, type ToolBlockStatus } from '../../model/chat/toolBlocks'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionsEffect, setSectionThinkingEffect } from '../thread/cmEditor'
import { setStreamingSectionEffect, streamingSectionField } from '../thread/modelChip'
import { markdownToolCalls, renderedToolCalls, toolCallLabel, toolCallSummary } from './toolCalls'

function block(id: string, status: ToolBlockStatus = 'success', result = 'ok'): string {
  return toolBlockText({ id, name: 'model_list', status, arguments: { filter: 'gemini' }, result: status === 'running' ? '' : result })
}

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (section ids `s0`, `s1`, …). The first section is always `user`
 *  (`normalizeSectionModels` in cmEditor.ts). The line rules of the chips
 *  have their tests in `lineBlocks.test.ts`. */
function createState(texts: string[], roles: Role[], streaming: string | null = null): EditorState {
  return EditorState.create({
    doc: texts.join(`\n${SECTION_SEP}\n`),
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => streaming),
      markdownToolCalls(),
    ],
  })
}

/** The id, state, and source of each call that the editor shows. */
function shown(state: EditorState): [string, string, string][] {
  return renderedToolCalls(state).map((call) => [call.id, call.state, state.sliceDoc(call.from, call.to)])
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
    const state = createState(['ask', block('a', 'running'), block('b', 'running')], ['user', 'agent', 'agent'], 's2')
    expect(shown(state).map(([id, callState]) => [id, callState])).toEqual([['a', 'interrupted'], ['b', 'running']])
    const ended = state.update({ effects: setStreamingSectionEffect.of(null) }).state
    expect(shown(ended).map(([id, callState]) => [id, callState])).toEqual([['a', 'interrupted'], ['b', 'interrupted']])
  })

  it('shows and hides the chips when only the section roles change', () => {
    const state = createState(['ask', block('a')], ['user', 'user'])
    expect(shown(state)).toEqual([])
    const agent = state.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'agent' }]) }).state
    expect(shown(agent)).toEqual([['a', 'success', block('a')]])
    const user = agent.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'user' }]) }).state
    expect(shown(user)).toEqual([])
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

describe('toolCallLabel', () => {
  it('names the call, its summary, and a state that the chip shows by a word or the spinner', () => {
    expect(toolCallLabel('model_list', '"gemini"', 'success')).toBe('Tool call model_list, "gemini"')
    expect(toolCallLabel('model_list', '"gemini"', 'running')).toBe('Tool call model_list, "gemini", running')
    expect(toolCallLabel('model_list', '"gemini"', 'error')).toBe('Tool call model_list, "gemini", failed')
    expect(toolCallLabel('model_list', '', 'interrupted')).toBe('Tool call model_list, interrupted')
    expect(toolCallLabel('model_list', '', 'success')).toBe('Tool call model_list')
  })
})
