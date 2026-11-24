import { EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, roleSeparators, sectionsField, setSectionsEffect, type SectionModel } from './cmEditor'
import { modelDisplayNamesField, streamingSectionField } from './modelChip'
import { thinkingExpandedField } from './thinkingPill'

describe('role separator reply time', () => {
  const DOC = ['question', 'answer'].join(`\n${SECTION_SEP}\n`)
  const STREAMING: SectionModel[] = [
    { id: 's1', role: 'user' },
    { id: 's2', role: 'agent', model: { providerId: 'mock', modelId: 'alpha' } },
  ]

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

  // CodeMirror keeps the pill DOM while `eq` holds, so the time stamped at
  // the stream end must replace the widget, and a later edit must not.
  it('replaces the pill widget when the reply time arrives, and keeps it on an edit', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: [
        sectionsField.init(() => STREAMING),
        modelDisplayNamesField,
        streamingSectionField,
        thinkingExpandedField,
        roleSeparators,
      ],
    })
    const stamped = state.update({
      effects: setSectionsEffect.of([STREAMING[0], { ...STREAMING[1], durationMs: 4213 }]),
    }).state
    const typed = stamped.update({ changes: { from: stamped.doc.length, insert: ' more' } }).state

    expect(separatorWidgets(stamped)[0].eq(separatorWidgets(state)[0])).toBe(false)
    expect(separatorWidgets(typed)[0].eq(separatorWidgets(stamped)[0])).toBe(true)
  })
})
