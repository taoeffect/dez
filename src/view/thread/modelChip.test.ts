import { EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, roleSeparators, sectionsField, type SectionModel } from './cmEditor'
import { modelDisplayNamesField, sectionModelChips, setModelDisplayNamesEffect, setStreamingSectionEffect, streamingSectionField } from './modelChip'
import { thinkingExpandedField } from './thinkingPill'
import type { ModelRef, Role } from '../../model/chat/types'
import type { ModelDisplayNames } from '../../model/providers/types'

const ALPHA: ModelRef = { providerId: 'mock', modelId: 'alpha' }
const BETA: ModelRef = { providerId: 'mock', modelId: 'beta' }
// Custom provider ids are UUIDs; this one has no provider config.
const DELETED: ModelRef = { providerId: '0b7c6a52-5f2e-4c1d-9a8b-3e4f5a6b7c8d', modelId: 'gpt-4o' }

const NAMES: ModelDisplayNames = {
  providers: new Map([['mock', 'Mock']]),
  models: new Map([['mock/alpha', 'Alpha One'], ['mock/beta', 'Beta Two']]),
}

/** Sections with ids `s0`, `s1`, … in order. */
function sections(...list: { role: Role; model?: ModelRef }[]) {
  return list.map((section, index) => ({ id: `s${index}`, ...section }))
}

describe('sectionModelChips', () => {
  it('gives a chip only to agent sections that have a model', () => {
    const chips = sectionModelChips(sections(
      { role: 'user' },
      { role: 'agent', model: ALPHA },
      { role: 'agent' },
      // The model is agent-only: a user section that holds one shows none.
      { role: 'user', model: BETA },
    ), NAMES, null)

    expect(chips.map((chip) => chip?.key ?? null)).toEqual([null, 'mock/alpha', null, null])
  })

  it('falls back to the model id, and shows no provider name for an unknown provider', () => {
    const chips = sectionModelChips(sections(
      { role: 'agent', model: ALPHA },
      { role: 'agent', model: { providerId: 'mock', modelId: 'unnamed/model' } },
      { role: 'agent', model: DELETED },
    ), NAMES, null)

    expect(chips.map((chip) => [chip?.modelName, chip?.providerName])).toEqual([
      ['Alpha One', 'Mock'],
      ['unnamed/model', 'Mock'],
      ['gpt-4o', null],
    ])
  })

  it('marks a switch against the nearest earlier agent section that has a model', () => {
    const chips = sectionModelChips(sections(
      { role: 'user' },
      { role: 'agent', model: ALPHA },
      { role: 'agent' },
      { role: 'user', model: BETA },
      { role: 'agent', model: ALPHA },
      { role: 'agent', model: BETA },
      { role: 'agent', model: BETA },
      { role: 'agent', model: DELETED },
      { role: 'agent', model: ALPHA },
    ), NAMES, null)

    expect(chips.map((chip) => chip?.switchedFrom)).toEqual([
      undefined,
      null,
      undefined,
      undefined,
      null,
      'Alpha One (Mock)',
      null,
      'Beta Two (Mock)',
      'gpt-4o',
    ])
  })

  it('marks only the chip of the streaming section as streaming', () => {
    const chips = sectionModelChips(sections(
      { role: 'user' },
      { role: 'agent', model: ALPHA },
      { role: 'agent', model: ALPHA },
    ), NAMES, 's2')

    expect(chips.map((chip) => chip?.streaming ?? null)).toEqual([null, false, true])
  })
})

describe('role separator model chips', () => {
  const DOC = ['hello', 'answer', 'legacy'].join(`\n${SECTION_SEP}\n`)
  const SECTIONS: SectionModel[] = [
    { id: 's1', role: 'user' },
    { id: 's2', role: 'agent', model: ALPHA },
    { id: 's3', role: 'agent' },
  ]

  function chipState(streamingSectionId: string | null = null): EditorState {
    return EditorState.create({
      doc: DOC,
      extensions: [
        sectionsField.init(() => SECTIONS),
        modelDisplayNamesField.init(() => NAMES),
        streamingSectionField.init(() => streamingSectionId),
        thinkingExpandedField,
        roleSeparators,
      ],
    })
  }

  function separatorWidgets(state: EditorState): WidgetType[] {
    const widgets: WidgetType[] = []
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      for (const cursor = source.iter(); cursor.value; cursor.next()) {
        const widget = cursor.value.spec.widget as WidgetType | undefined
        if (widget) widgets.push(widget)
      }
    }
    return widgets
  }

  // CodeMirror reuses the widget DOM while `eq` holds. A streamed token must
  // not redraw the pill; a new name must.
  it('keeps the chip widget on a text edit and replaces it when a name changes', () => {
    const state = chipState()
    const [chipWidget] = separatorWidgets(state)

    const typed = state.update({ changes: { from: state.doc.length, insert: ' more' } }).state
    const renamed = state.update({
      effects: setModelDisplayNamesEffect.of({
        providers: NAMES.providers,
        models: new Map([['mock/alpha', 'Alpha Renamed']]),
      }),
    }).state

    expect(separatorWidgets(typed)[0].eq(chipWidget)).toBe(true)
    expect(separatorWidgets(renamed)[0].eq(chipWidget)).toBe(false)
  })

  // A streamed token must not restart the pill animation; the end of the
  // stream must stop it.
  it('keeps the streaming chip widget on a token and replaces it when the stream ends', () => {
    const state = chipState('s2')
    const [chipWidget] = separatorWidgets(state)
    const answerEnd = DOC.indexOf('answer') + 'answer'.length

    const token = state.update({ changes: { from: answerEnd, insert: ' token' } }).state
    const finished = state.update({ effects: setStreamingSectionEffect.of(null) }).state

    expect(separatorWidgets(token)[0].eq(chipWidget)).toBe(true)
    expect(separatorWidgets(finished)[0].eq(chipWidget)).toBe(false)
  })
})
