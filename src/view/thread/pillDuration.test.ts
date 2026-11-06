import { EditorState } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { SECTION_SEP, roleSeparators, sectionsField, setSectionsEffect, type SectionModel } from './cmEditor'
import { modelDisplayNamesField, streamingSectionField } from './modelChip'
import { longDuration, shortDuration } from './pillDuration'
import { thinkingExpandedField } from './thinkingPill'

describe('reply time forms', () => {
  it('shows tenths under 10 seconds', () => {
    expect([0, 49, 50, 420, 4213, 9949].map(shortDuration)).toEqual(['<0.1s', '<0.1s', '0.1s', '0.4s', '4.2s', '9.9s'])
    expect([0, 420, 4213, 9949].map(longDuration)).toEqual(['less than 0.1 seconds', '0.4 seconds', '4.2 seconds', '9.9 seconds'])
  })

  // A time that rounds up to the next unit shows in that unit's form.
  it('rounds once, so a time at a unit edge moves to the next form', () => {
    expect([9950, 42_300, 59_499, 59_500].map(shortDuration)).toEqual(['10s', '42s', '59s', '1m 00s'])
    expect([9950, 59_500].map(longDuration)).toEqual(['10 seconds', '1 minute'])
  })

  it('gives minutes and hours a two-digit smaller unit', () => {
    expect([65_000, 600_000, 3_599_499, 3_599_500, 3_725_000, 90_000_000].map(shortDuration))
      .toEqual(['1m 05s', '10m 00s', '59m 59s', '1h 00m', '1h 02m', '25h 00m'])
  })

  // The tooltip names every nonzero unit, the seconds of a long reply too.
  it('spells out each nonzero unit in the long form', () => {
    expect([1000, 61_000, 120_000, 3_600_000, 3_725_000, 7_201_000].map(longDuration))
      .toEqual(['1.0 seconds', '1 minute 1 second', '2 minutes', '1 hour', '1 hour 2 minutes 5 seconds', '2 hours 1 second'])
  })
})

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
