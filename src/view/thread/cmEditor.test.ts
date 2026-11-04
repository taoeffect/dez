import { defaultKeymap, history, selectAll, undo, undoDepth } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  PILL_BODY,
  PILL_CLOSE,
  PILL_NL,
  PILL_OPEN,
  SECTION_SEP,
  cutSelectedRangesTransaction,
  docToSections,
  encodePrompt,
  initialSectionModels,
  keymapHasPlatformBinding,
  linuxLineNavigationKeymap,
  parseClipboardText,
  physicalLineBoundarySelection,
  pillsField,
  plainTextPasteTransaction,
  reconcileSectionModelsToDoc,
  removedSeparatorModelIndexes,
  scanPills,
  sectionsField,
  serializeDocRangeForClipboard,
  serializeSelectionForClipboard,
  setPillsEffect,
  splitSectionEffect,
  strictMultiCursorBackspace,
  unwrapBrokenPills,
  type PillMetadata,
  type SectionModel,
} from './cmEditor'
import { SENTINEL_CHAR, sectionVisibleText } from '../../model/chat/content'
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

describe('clipboard helpers', () => {
  it('builds plain-text paste transactions for every selection range', () => {
    const state = EditorState.create({
      doc: 'one\ntwo\nthree',
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.range(4, 7),
        EditorSelection.cursor(13),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })

    const nextState = state.update(plainTextPasteTransaction(state, 'X')).state

    expect(nextState.doc.toString()).toBe('Xone\nX\nthreeX')
    expect(nextState.selection.ranges).toHaveLength(3)
    expect(nextState.selection.mainIndex).toBe(1)
  })

  it('pastes matching copied plain-text ranges into matching cursors', () => {
    const copyState = EditorState.create({
      doc: '_asdf\nasdf\nasdf',
      selection: EditorSelection.create([
        EditorSelection.range(1, 5),
        EditorSelection.range(6, 10),
        EditorSelection.range(11, 15),
      ], 1),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        sectionsField.init(() => initialSectionModels([
          section('s1', 'user', '_asdf\nasdf\nasdf'),
        ])),
        pillsField.init(() => new Map()),
      ],
    })
    const pasteState = EditorState.create({
      doc: 'asdf\nasdf\nasdf',
      selection: EditorSelection.create([
        EditorSelection.cursor(4),
        EditorSelection.cursor(9),
        EditorSelection.cursor(14),
      ], 1),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })

    const copied = serializeSelectionForClipboard(copyState)
    const nextState = pasteState.update(plainTextPasteTransaction(pasteState, copied)).state

    expect(copied).toBe('asdf\nasdf\nasdf')
    expect(nextState.doc.toString()).toBe('asdfasdf\nasdfasdf\nasdfasdf')
    expect(nextState.selection.ranges.map((range) => range.head)).toEqual([8, 17, 26])
    expect(nextState.selection.mainIndex).toBe(1)
  })

  it('serializes and cuts every non-empty selected range', () => {
    const state = EditorState.create({
      doc: 'alpha\nbeta\ngamma',
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.cursor(6),
        EditorSelection.range(11, 16),
      ], 2),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        sectionsField.init(() => initialSectionModels([
          section('s1', 'user', 'alpha\nbeta\ngamma'),
        ])),
        pillsField.init(() => new Map()),
      ],
    })

    expect(serializeSelectionForClipboard(state)).toBe('<dez:pill type="user"/>\nalpha\ngamma')
    const cut = cutSelectedRangesTransaction(state)
    expect(cut).not.toBeNull()
    const nextState = state.update(cut!).state

    expect(nextState.doc.toString()).toBe('\nbeta\n')
    expect(nextState.selection.ranges.map((range) => range.head)).toEqual([0, 6])
    expect(nextState.selection.mainIndex).toBe(1)
  })

  it('parses copied prompts and sections as plain text for a paste inside a pill body', () => {
    const copied = [
      '<dez:pill type="user"/>',
      'x <dez:prompt name="Inner">',
      'inner',
      '</dez:prompt> y',
      '<dez:pill type="agent"/>',
      'z',
    ].join('\n')

    const structured = parseClipboardText(copied)
    const plain = parseClipboardText(copied, true)

    expect(structured.pills.size).toBe(1)
    expect(structured.separatorRoles).toEqual(['user', 'agent'])
    expect(plain).toEqual({ text: 'x inner y\nz', pills: new Map(), separatorRoles: [] })
  })
})

describe('broken prompt pills', () => {
  // Live pill ids are `crypto.randomUUID()` values (see `acceptPrompt`).
  const PILL_ID = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
  const NESTED_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
  const BODY = 'Summarize\nthis'
  // An expanded pill (real newlines in the body) at the doc start, then text.
  const DOC = `${encodePrompt(PILL_ID, BODY, false)} tail`
  const BODY_FROM = `${PILL_OPEN}${PILL_ID}${PILL_BODY}`.length
  const BODY_TO = BODY_FROM + BODY.length
  const PILL_TO = BODY_TO + 1
  const META: PillMetadata = { promptId: 'saved', name: 'Summary', expanded: true }

  function pillState(): EditorState {
    return EditorState.create({
      doc: DOC,
      extensions: [
        history(),
        sectionsField.init(() => [{ id: 's1', role: 'user' }]),
        pillsField.init(() => new Map([[PILL_ID, META]])),
        unwrapBrokenPills,
      ],
    })
  }

  const edits: Array<{ name: string, spec: TransactionSpec, sections: ContentNode[][] }> = [
    {
      name: 'Backspace after the hidden close marker deletes only it',
      spec: { changes: { from: BODY_TO, to: PILL_TO } },
      sections: [[textNode('Summarize\nthis tail')]],
    },
    {
      name: 'typing over a selection from the body to past the pill',
      spec: { changes: { from: BODY_FROM + 3, to: PILL_TO + 2, insert: 'X' } },
      sections: [[textNode('SumXail')]],
    },
    {
      name: 'Shift+Enter inside the body splits the section',
      spec: {
        changes: { from: BODY_FROM + 'Summarize'.length, insert: `\n${SECTION_SEP}\n` },
        effects: splitSectionEffect.of({ afterIndex: 0 }),
      },
      sections: [[textNode('Summarize')], [textNode('\nthis tail')]],
    },
    {
      name: 'a prompt accepted inside the body nests a pill',
      spec: {
        changes: { from: BODY_FROM + 'Summarize'.length, insert: encodePrompt(NESTED_ID, 'inner') },
        effects: setPillsEffect.of(new Map([
          [PILL_ID, META],
          [NESTED_ID, { promptId: 'other', name: 'Inner', expanded: false }],
        ])),
      },
      sections: [[
        textNode('Summarize'),
        { kind: 'prompt', id: NESTED_ID, promptId: 'other', name: 'Inner', body: 'inner', expanded: false },
        textNode('\nthis tail'),
      ]],
    },
    {
      name: 'Backspace at the body start deletes the header',
      spec: { changes: { from: 0, to: BODY_FROM } },
      sections: [[textNode('Summarize\nthis tail')]],
    },
  ]

  for (const edit of edits) {
    it(`unwraps the pill and keeps its id out of the text: ${edit.name}`, () => {
      const state = pillState().update(edit.spec).state
      const doc = state.doc.toString()
      const sections = docToSections(doc, state.field(sectionsField), state.field(pillsField))
      const markerChars = Array.from(doc).filter((c) => c === PILL_OPEN || c === PILL_BODY || c === PILL_CLOSE)

      expect(doc).not.toContain(PILL_ID)
      // Every marker char left in the doc belongs to a well-formed pill.
      expect(markerChars).toHaveLength(3 * scanPills(doc).length)
      expect(sections.map((section) => section.content)).toEqual(edit.sections)
      // `firstUserTitle` builds the tab title from this text.
      expect(sectionVisibleText(sections[0])).not.toMatch(SENTINEL_CHAR)
    })

    it(`restores the pill with one undo: ${edit.name}`, () => {
      const state = pillState().update(edit.spec).state
      expect(undoDepth(state)).toBe(1)

      const restored = dispatchCommand(state, undo)

      expect(restored.doc.toString()).toBe(DOC)
      expect(restored.field(pillsField).get(PILL_ID)).toEqual(META)
    })
  }

  it('decodes and copies leftover broken markers as text without the pill id', () => {
    const doc = `x${PILL_CLOSE} ${PILL_OPEN}${PILL_ID}${PILL_BODY}a${PILL_NL}b${PILL_BODY}`
    const models: SectionModel[] = [{ id: 's1', role: 'user' }]

    const sections = docToSections(doc, models, new Map())
    const copied = serializeDocRangeForClipboard(doc, 0, doc.length, models, new Map())

    expect(sections.map((section) => section.content)).toEqual([[textNode('x a\nb')]])
    expect(copied).toBe('<dez:pill type="user"/>\nx a\nb')
  })
})
