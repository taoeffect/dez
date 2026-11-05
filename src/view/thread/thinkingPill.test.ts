import { EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, roleSeparators, sectionsField, setSectionThinkingEffect, type SectionModel } from './cmEditor'
import { modelDisplayNamesField, streamingSectionField } from './modelChip'
import { sectionThinkingView, thinkingExpandedField, toggleThinkingExpandedEffect } from './thinkingPill'
import type { SectionThinking } from '../../model/chat/types'

const REPLAY_ONLY: SectionThinking = { text: '', replay: { kind: 'copilot', opaque: 'opaque', prefixHash: 'hash' } }

describe('sectionThinkingView', () => {
  const open = new Set(['u', 'a', 'r', 'e', 's'])

  // A section toggled to user keeps its thinking in memory; its pill must
  // not show it.
  it('gives thinking parts only to agent sections that have thinking', () => {
    expect(sectionThinkingView({ id: 'u', role: 'user', thinking: { text: 'kept after a role toggle' } }, open, null)).toBeNull()
    expect(sectionThinkingView({ id: 'a', role: 'agent', thinking: { text: 'plan' } }, open, null))
      .toStrictEqual({ text: 'plan', hasReplay: false, expanded: true, streaming: false })
    expect(sectionThinkingView({ id: 'b', role: 'agent' }, open, null)).toBeNull()
    expect(sectionThinkingView(undefined, open, null)).toBeNull()
  })

  it('counts a replay without text as thinking, and empty text without a replay as none', () => {
    expect(sectionThinkingView({ id: 'r', role: 'agent', thinking: REPLAY_ONLY }, open, null))
      .toStrictEqual({ text: '', hasReplay: true, expanded: true, streaming: false })
    expect(sectionThinkingView({ id: 'e', role: 'agent', thinking: { text: '' } }, open, null)).toBeNull()
  })

  // The spinner shows for every streaming section, and a panel cannot be
  // open before there is thinking to show.
  it('gives a streaming section without thinking closed parts', () => {
    expect(sectionThinkingView({ id: 's', role: 'agent' }, open, 's'))
      .toStrictEqual({ text: '', hasReplay: false, expanded: false, streaming: true })
    expect(sectionThinkingView({ id: 't', role: 'agent', thinking: { text: 'done' } }, open, 's'))
      .toStrictEqual({ text: 'done', hasReplay: false, expanded: false, streaming: false })
  })
})

describe('thinkingExpandedField', () => {
  it('opens and closes the panel of one section per toggle', () => {
    const state = EditorState.create({ extensions: [thinkingExpandedField] })
    const opened = state.update({
      effects: [toggleThinkingExpandedEffect.of('a'), toggleThinkingExpandedEffect.of('b')],
    }).state
    const closed = opened.update({ effects: toggleThinkingExpandedEffect.of('a') }).state

    expect([...opened.field(thinkingExpandedField)]).toStrictEqual(['a', 'b'])
    expect([...closed.field(thinkingExpandedField)]).toStrictEqual(['b'])
  })
})

describe('role separator thinking', () => {
  const DOC = ['question', 'answer'].join(`\n${SECTION_SEP}\n`)
  const SECTIONS: SectionModel[] = [
    { id: 's1', role: 'user' },
    { id: 's2', role: 'agent', thinking: { text: 'first' } },
  ]

  function thinkingState(): EditorState {
    return EditorState.create({
      doc: DOC,
      extensions: [
        sectionsField.init(() => SECTIONS),
        modelDisplayNamesField,
        streamingSectionField.init(() => 's2'),
        thinkingExpandedField,
        roleSeparators,
      ],
    })
  }

  function separatorWidget(state: EditorState): WidgetType {
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      const widget = source.iter().value?.spec.widget as WidgetType | undefined
      if (widget) return widget
    }
    throw new Error('no separator widget')
  }

  // When the widget changes, CodeMirror moves the pill into a new line
  // element. The move would take the focus from the thinking text field and
  // scroll its panel to the top at every thinking token. So no thinking
  // change may change the widget; the thinking parts change in place.
  it('keeps the pill widget through thinking changes', () => {
    const state = thinkingState()
    const pill = separatorWidget(state)

    const changed = [
      setSectionThinkingEffect.of({ sectionId: 's2', thinking: { text: 'first, then' } }),
      setSectionThinkingEffect.of({ sectionId: 's2', thinking: { text: 'first', replay: { kind: 'field', field: 'reasoning_content' } } }),
      setSectionThinkingEffect.of({ sectionId: 's2' }),
      toggleThinkingExpandedEffect.of('s2'),
    ].map((effects) => state.update({ effects }).state)

    for (const next of changed) expect(separatorWidget(next).eq(pill)).toBe(true)
  })
})
