import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../model/chat/types'
import { toolBlockText, type ToolBlockStatus } from '../../model/chat/toolBlocks'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionsEffect, setSectionThinkingEffect } from '../thread/cmEditor'
import { setStreamingSectionEffect, streamingSectionField } from '../thread/modelChip'
import { PLAYER } from './testing'
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

describe('the spacing of the chip lines', () => {
  const SPACE = '(the space of a blank line)'
  const COLLAPSED = '(a blank line of no height)'

  /** The lines of `state` as the editor spaces them, top to bottom: a chip
   *  as `chip <id>`, `SPACE` where the line of a chip has extra space,
   *  `COLLAPSED` for a blank line that takes no height, and any other line
   *  as its text. Read from the decorations that the editor draws. */
  function rows(state: EditorState): string[] {
    const classes = new Map<number, string[]>()
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      for (const cursor = source.iter(); cursor.value; cursor.next()) {
        const name: unknown = cursor.value.spec.class
        if (typeof name === 'string') classes.set(cursor.from, [...(classes.get(cursor.from) ?? []), name])
      }
    }
    const calls = renderedToolCalls(state)
    const result: string[] = []
    for (let pos = 0; pos <= state.doc.length;) {
      const line = state.doc.lineAt(pos)
      const call = calls.find(({ from }) => from === line.from)
      const names = classes.get(line.from) ?? []
      if (names.includes('dez-tool-call-line--after-content')) result.push(SPACE)
      result.push(call ? `chip ${call.id}` : names.includes('dez-tool-call-gap') ? COLLAPSED : line.text)
      if (names.includes('dez-tool-call-line--before-content')) result.push(SPACE)
      pos = (call ? call.to : line.to) + 1
    }
    return result
  }

  /** `rows` of an agent section with the lines `lines`, after a user
   *  section; the rows of the agent section only. `caret` puts a caret at
   *  the start of that line of the agent section (0 is its first). */
  function agentRows(lines: string[], caret?: number): string[] {
    let state = createState(['ask', lines.join('\n')], ['user', 'agent'])
    const start = state.doc.length - lines.join('\n').length
    if (caret !== undefined) state = state.update({ selection: { anchor: start + lines.slice(0, caret).join('\n').length + (caret > 0 ? 1 : 0) } }).state
    return rows(state).slice(2)
  }

  it('gives the chips of one group no extra space', () => {
    expect(agentRows([block('a'), block('b'), block('c')])).toEqual(['chip a', 'chip b', 'chip c'])
  })

  it('gives the blank lines between two chips no height', () => {
    expect(agentRows([block('a'), '', block('b'), block('c'), '', ' \t', block('d')])).toEqual([
      'chip a', COLLAPSED, 'chip b', 'chip c', COLLAPSED, COLLAPSED, 'chip d',
    ])
  })

  it('gives a chip the space of a blank line next to content on a line that touches it', () => {
    expect(agentRows(['before', block('a'), 'after'])).toEqual(['before', SPACE, 'chip a', SPACE, 'after'])
    expect(agentRows(['before', block('a'), block('b'), '', block('c'), 'after'])).toEqual([
      'before', SPACE, 'chip a', 'chip b', COLLAPSED, 'chip c', SPACE, 'after',
    ])
    const image = '![/home/u/.config/dez/assets/images/red.png](id=a)'
    expect(agentRows([image, block('a'), PLAYER])).toEqual([image, SPACE, 'chip a', SPACE, PLAYER])
  })

  it('leaves a chip with a blank line between it and content as it is', () => {
    expect(agentRows(['before', '', block('a'), ' ', 'after'])).toEqual(['before', '', 'chip a', ' ', 'after'])
    expect(agentRows([block('a'), '', 'between', '', block('b')])).toEqual(['chip a', '', 'between', '', 'chip b'])
    expect(agentRows([block('a'), '', 'between', block('b')])).toEqual(['chip a', '', 'between', SPACE, 'chip b'])
  })

  it('gives no space at the start and the end of a section, and keeps the blank lines there', () => {
    expect(agentRows([block('a')])).toEqual(['chip a'])
    expect(agentRows(['', block('a'), ''])).toEqual(['', 'chip a', ''])
    const sections = createState(['ask', block('a'), `${block('b')}\n`, 'next'], ['user', 'agent', 'agent', 'user'])
    expect(rows(sections)).toEqual(['ask', SECTION_SEP, 'chip a', SECTION_SEP, 'chip b', '', SECTION_SEP, 'next'])
  })

  it('counts a block that stays text as content', () => {
    const pillBlock = `<dez:tool id="p" name="model_list">\nx ${PILL_OPEN} y\n</dez:tool>`
    expect(agentRows([block('a'), pillBlock, block('b')])).toEqual(['chip a', SPACE, ...pillBlock.split('\n'), SPACE, 'chip b'])
    const user = createState(['ask', ['before', block('a'), '', block('b')].join('\n')], ['user', 'user'])
    expect(rows(user)).toEqual(['ask', SECTION_SEP, 'before', ...block('a').split('\n'), '', ...block('b').split('\n')])
  })

  it('shows a blank line between two chips while a caret is on it', () => {
    const lines = [block('a'), '', '', block('b')]
    expect(agentRows(lines, 1)).toEqual(['chip a', '', COLLAPSED, 'chip b'])
    expect(agentRows(lines, 2)).toEqual(['chip a', COLLAPSED, '', 'chip b'])
    expect(agentRows(lines, 3)).toEqual(['chip a', COLLAPSED, COLLAPSED, 'chip b'])
    // A selection that is not empty draws no caret.
    const state = createState(['ask', lines.join('\n')], ['user', 'agent'])
    const selected = state.update({ selection: EditorSelection.single(0, state.doc.length - block('b').length - 1) }).state
    expect(rows(selected).slice(2)).toEqual(['chip a', COLLAPSED, COLLAPSED, 'chip b'])
  })
})

describe('toolCallSummary', () => {
  it('shows the first argument on one line, a string in quotes', () => {
    expect(toolCallSummary('model_list', {})).toBe('')
    expect(toolCallSummary('model_list', { filter: '  gem\n\tini ', other: 'x' })).toBe('"gem ini"')
    expect(toolCallSummary('model_list', { count: 3 })).toBe('3')
    expect(toolCallSummary('model_list', { all: false })).toBe('false')
  })

  it('cuts a long value at 40 characters, the ellipsis included', () => {
    expect(toolCallSummary('model_list', { filter: 'a'.repeat(40) })).toBe(`"${'a'.repeat(40)}"`)
    expect(toolCallSummary('model_list', { filter: 'a'.repeat(41) })).toBe(`"${'a'.repeat(39)}…"`)
    expect(toolCallSummary('model_list', { filter: '😀'.repeat(41) })).toBe(`"${'😀'.repeat(39)}…"`)
  })

  it('shows nothing for a tool that Dez does not have', () => {
    expect(toolCallSummary('crop_scale_image', { image: 'a', width: '10' })).toBe('')
    expect(toolCallSummary('Model_List', { filter: 'gemini' })).toBe('')
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

  it('says that Dez does not have the tool, as the chip does', () => {
    expect(toolCallLabel('crop_scale_image', '', 'success')).toBe('Tool call, old/unrecognized tool: crop_scale_image')
    expect(toolCallLabel('web_search', '', 'error')).toBe('Tool call, old/unrecognized tool: web_search, failed')
  })
})
