import { defaultKeymap, selectAll } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  PILL_BODY,
  PILL_CLOSE,
  PILL_OPEN,
  SECTION_SEP,
  docToSections,
  initialSectionModels,
  keymapHasPlatformBinding,
  linuxLineNavigationKeymap,
  physicalLineBoundarySelection,
  reconcileSectionModelsToDoc,
  removedSeparatorModelIndexes,
  sectionsField,
  strictMultiCursorBackspace,
  type SectionModel,
} from './cmEditor'
import type { ContentNode, Role, Section } from '../../model/chat/types'

function textNode(text: string): ContentNode {
  return { kind: 'text', text }
}

function section(id: string, role: Role, text: string): Section {
  return { id, role, content: [textNode(text)] }
}

function dispatchCommand(state: EditorState, command: (view: EditorView) => boolean): EditorState {
  let nextState = state
  const view = {
    get state() {
      return nextState
    },
    dispatch(...specs: [Transaction] | [readonly Transaction[]] | TransactionSpec[]) {
      if (specs.length === 1 && Array.isArray(specs[0])) {
        for (const tr of specs[0]) nextState = tr.state
      } else if (specs.length === 1 && 'startState' in specs[0]) {
        nextState = specs[0].state
      } else {
        nextState = nextState.update(...specs as TransactionSpec[]).state
      }
    },
  } as EditorView
  expect(command(view)).toBe(true)
  return nextState
}

describe('CodeMirror section role reconciliation', () => {
  it('uses fallback section metadata when live metadata is missing', () => {
    const doc = ['hello', 'answer', 'next'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
      section('s3', 'user', 'next'),
    ])

    const reconciled = reconcileSectionModelsToDoc([fallback[0]], doc, fallback)

    expect(reconciled.map((model) => model.role)).toEqual(['user', 'agent', 'user'])
    expect(reconciled.map((model) => model.id)).toEqual(['s1', 's2', 's3'])
  })

  it('replaces generated placeholder models with matching fallback store metadata', () => {
    const doc = ['hello', 'answer'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
    ])
    const generated: SectionModel[] = [
      fallback[0],
      { id: 'generated-agent-slot', role: 'user', generated: true },
    ]

    const sections = docToSections(doc, generated, new Map(), fallback)

    expect(sections.map((candidate) => candidate.role)).toEqual(['user', 'agent'])
    expect(sections.map((candidate) => candidate.id)).toEqual(['s1', 's2'])
  })

  it('preserves explicit role toggles when live model ids match the fallback ids', () => {
    const doc = ['hello', 'answer'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
    ])
    const toggled = [fallback[0], { id: 's2', role: 'user' as const }]

    const reconciled = reconcileSectionModelsToDoc(toggled, doc, fallback)

    expect(reconciled.map((model) => model.role)).toEqual(['user', 'user'])
    expect(reconciled.map((model) => model.id)).toEqual(['s1', 's2'])
  })

  it('removes the metadata model for a deleted non-trailing separator', () => {
    const doc = ['hello', 'answer', 'next'].join(`\n${SECTION_SEP}\n`)
    const models = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
      section('s3', 'user', 'next'),
    ])
    const state = EditorState.create({ doc, extensions: [sectionsField.init(() => models)] })
    const separatorFrom = 'hello\n'.length
    const separatorTo = 'hello\n'.length + `${SECTION_SEP}\nanswer\n`.length
    const tr = state.update({ changes: { from: separatorFrom, to: separatorTo, insert: '' } })
    const nextState = tr.state

    expect(removedSeparatorModelIndexes(tr)).toEqual([1])
    expect(nextState.field(sectionsField).map((model) => model.role)).toEqual(['user', 'user'])
    expect(nextState.field(sectionsField).map((model) => model.id)).toEqual(['s1', 's3'])
    expect(
      docToSections(nextState.doc.toString(), nextState.field(sectionsField), new Map()).map(
        (candidate) => candidate.role,
      ),
    ).toEqual(['user', 'user'])
  })
})

describe('Linux line-navigation keymap', () => {
  it('binds Linux Ctrl+A and Ctrl+E without changing macOS Ctrl+A/Ctrl+E behavior', () => {
    const bindings = linuxLineNavigationKeymap()

    expect(keymapHasPlatformBinding(bindings, 'linux', 'Ctrl-a')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Ctrl-e')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Meta-a')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Mod-a')).toBe(false)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Alt-a')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'mac', 'Ctrl-a')).toBe(false)
    expect(keymapHasPlatformBinding(bindings, 'mac', 'Ctrl-e')).toBe(false)
    expect(bindings.find((binding) => binding.linux === 'Meta-a')?.run).toBe(selectAll)
    expect(bindings.find((binding) => binding.linux === 'Alt-a')?.run).toBe(selectAll)
  })

  it('consumes Linux Ctrl+A at physical line start before default select-all can run', () => {
    let state = EditorState.create({
      doc: 'alpha\nbeta',
      selection: EditorSelection.cursor(0),
      extensions: [keymap.of([...linuxLineNavigationKeymap(), ...defaultKeymap])],
    })
    const view = {
      get state() {
        return state
      },
      dispatch(...specs: [Transaction] | [readonly Transaction[]] | TransactionSpec[]) {
        if (specs.length === 1 && Array.isArray(specs[0])) {
          for (const tr of specs[0]) state = tr.state
        } else if (specs.length === 1 && 'startState' in specs[0]) {
          state = specs[0].state
        } else {
          state = state.update(...specs as TransactionSpec[]).state
        }
      },
    } as EditorView
    const event = {
      key: 'a',
      keyCode: 65,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as KeyboardEvent

    expect(runScopeHandlers(view, event, 'editor')).toBe(true)
    expect(state.selection.ranges).toHaveLength(1)
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(0)
  })

  it('moves every selection range to its physical document-line boundaries', () => {
    const state = EditorState.create({
      doc: 'alpha\nbeta\ngamma',
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(8),
        EditorSelection.range(15, 12),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })
    const lineStarts = physicalLineBoundarySelection(state, false)
    const lineEnds = physicalLineBoundarySelection(state, true)

    expect(lineStarts.ranges.map((range) => range.head)).toEqual([0, 6, 11])
    expect(lineEnds.ranges.map((range) => range.head)).toEqual([5, 10, 16])
    expect(lineStarts.mainIndex).toBe(1)
    expect(lineEnds.mainIndex).toBe(1)
  })
})

describe('multi-cursor Backspace', () => {
  it('deletes one character before every cursor after line-start prefix insertion', () => {
    const state = EditorState.create({
      doc: '- asdf\n- asdf\n- asdf',
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(9),
        EditorSelection.cursor(16),
      ], 2),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })

    const nextState = dispatchCommand(state, strictMultiCursorBackspace)

    expect(nextState.doc.toString()).toBe('-asdf\n-asdf\n-asdf')
    expect(nextState.selection.ranges.map((range) => range.head)).toEqual([1, 7, 13])
    expect(nextState.selection.mainIndex).toBe(2)
  })

  it('falls through for single cursors, physical line starts, and prompt pills', () => {
    const singleCursorState = EditorState.create({
      doc: '- asdf',
      selection: EditorSelection.cursor(2),
    })
    const lineStartState = EditorState.create({
      doc: 'alpha\nbeta',
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(6),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })
    const promptDoc = `x${PILL_OPEN}p1${PILL_BODY}body${PILL_CLOSE}y`
    const promptState = EditorState.create({
      doc: promptDoc,
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(promptDoc.length - 1),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })

    expect(strictMultiCursorBackspace({ state: singleCursorState } as EditorView)).toBe(false)
    expect(strictMultiCursorBackspace({ state: lineStartState } as EditorView)).toBe(false)
    expect(strictMultiCursorBackspace({ state: promptState } as EditorView)).toBe(false)
  })
})
