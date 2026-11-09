import { defaultKeymap, deleteCharForward, history, redo, undo, undoDepth } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  PILL_BODY,
  PILL_CLOSE,
  PILL_NL,
  PILL_OPEN,
  SECTION_SEP,
  clipboardPasteTransaction,
  cutSelectedRangesTransaction,
  deletedSeparators,
  docToSections,
  dezLanguageSupport,
  encodePrompt,
  initialSectionModels,
  keymapHasPlatformBinding,
  linuxLineNavigationKeymap,
  mergeSectionEffect,
  parseClipboardText,
  physicalLineBoundarySelection,
  pillsField,
  plainTextPasteTransaction,
  reconcileSectionModelsToDoc,
  scanPills,
  sectionsField,
  sectionsToDoc,
  serializeDocRangeForClipboard,
  serializeSelectionAsMarkdown,
  serializeSelectionForClipboard,
  setPillsEffect,
  setSectionThinkingEffect,
  splitSectionEffect,
  strictMultiCursorBackspace,
  unwrapBrokenPills,
  type PillMetadata,
  type SectionModel,
} from './cmEditor'
import { SENTINEL_CHAR, sectionVisibleText } from '../../model/chat/content'
import type { ContentNode, ModelRef, Role, Section, SectionThinking } from '../../model/chat/types'
import { toolBlockText } from '../../model/chat/toolBlocks'
import { serializeConversationAsMarkdown } from '../../model/persistence/conversationFormat'

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

  it('keeps live section metadata over the fallback when the ids match', () => {
    const doc = ['hello', 'answer'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
    ])
    const live: SectionModel[] = [fallback[0], { id: 's2', role: 'agent', durationMs: 900 }]

    expect(reconcileSectionModelsToDoc(live, doc, fallback)).toStrictEqual(live)
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

    expect(deletedSeparators(tr)).toEqual([{ pos: separatorFrom, index: 1 }])
    expect(nextState.field(sectionsField).map((model) => model.role)).toEqual(['user', 'user'])
    expect(nextState.field(sectionsField).map((model) => model.id)).toEqual(['s1', 's3'])
    expect(
      docToSections(nextState.doc.toString(), nextState.field(sectionsField), new Map()).map(
        (candidate) => candidate.role,
      ),
    ).toEqual(['user', 'user'])
  })
})

describe('section models in the undo history', () => {
  const MODEL: ModelRef = { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }
  const THINKING: SectionThinking = { text: 'plan the answer', replay: { kind: 'field', field: 'reasoning_content' } }
  const MODELS: SectionModel[] = [
    { id: 's1', role: 'user' },
    { id: 's2', role: 'agent', model: MODEL, thinking: THINKING, durationMs: 1200 },
    { id: 's3', role: 'user' },
    { id: 's4', role: 'agent', model: MODEL, durationMs: 800 },
    { id: 's5', role: 'user' },
  ]
  const DOC = ['one', 'two', 'three', 'four', 'five'].join(`\n${SECTION_SEP}\n`)
  // From inside `two` to inside `four`: the selection holds the separators
  // of sections s3 and s4.
  const MIDDLE = EditorSelection.single(DOC.indexOf('two') + 1, DOC.indexOf('four') + 1)

  function historyState(selection?: EditorSelection): EditorState {
    return EditorState.create({
      doc: DOC,
      selection,
      extensions: [history(), sectionsField.init(() => MODELS), pillsField.init(() => new Map())],
    })
  }

  it('puts back the sections that a delete in the middle of the doc removed, at their places, and removes them again on redo', () => {
    const deleted = historyState().update({ changes: { from: MIDDLE.main.from, to: MIDDLE.main.to }, userEvent: 'delete.selection' }).state
    expect(deleted.field(sectionsField).map((model) => model.id)).toEqual(['s1', 's2', 's5'])

    const undone = dispatchCommand(deleted, undo)

    expect(undone.doc.toString()).toBe(DOC)
    expect(undone.field(sectionsField)).toStrictEqual(MODELS)

    const redone = dispatchCommand(undone, redo)

    expect(redone.field(sectionsField)).toStrictEqual(deleted.field(sectionsField))
    expect(dispatchCommand(redone, undo).field(sectionsField)).toStrictEqual(MODELS)
  })

  it('puts back an agent section that Backspace at its start merged into the section before', () => {
    const separator = DOC.indexOf(SECTION_SEP)
    // The transaction of `mergeWithPreviousSection` (ThreadEditor.vue).
    const merged = historyState().update({
      changes: { from: separator - 1, to: separator + 2 },
      effects: mergeSectionEffect.of({ removeIndex: 1 }),
      userEvent: 'delete.backward',
    }).state
    expect(merged.field(sectionsField).map((model) => model.id)).toEqual(['s1', 's3', 's4', 's5'])

    expect(dispatchCommand(merged, undo).field(sectionsField)).toStrictEqual(MODELS)
  })

  // The history joins quick adjacent edits into one undo step, and moves
  // the merge's saved separator position through the typing before it.
  it('puts back a section that Delete merged right after typing, with one undo of both', () => {
    const separator = DOC.indexOf(SECTION_SEP)
    const typed = historyState().update({ changes: { from: separator - 1, insert: '!!' }, userEvent: 'input.type' }).state
    // The transaction of `mergeWithNextSection` (ThreadEditor.vue) at the
    // end of `one!!`.
    const merged = typed.update({
      changes: { from: separator + 1, to: separator + 4 },
      effects: mergeSectionEffect.of({ removeIndex: 1 }),
      userEvent: 'delete.forward',
    }).state
    expect(merged.doc.toString().startsWith('one!!two')).toBe(true)
    expect(undoDepth(merged)).toBe(1)

    const undone = dispatchCommand(merged, undo)

    expect(undone.doc.toString()).toBe(DOC)
    expect(undone.field(sectionsField)).toStrictEqual(MODELS)
  })

  it('keeps the replaced and the pasted sections through undo and redo of a paste with a section marker', () => {
    const state = historyState(MIDDLE)
    const pasted = state.update(clipboardPasteTransaction(state, `x\n<dez:pill type="agent" model="openrouter/anthropic/claude-sonnet-4.5"/>\npasted`)).state
    const pastedModels = pasted.field(sectionsField)
    expect(pastedModels.map((model) => [model.role, model.model])).toEqual([['user', undefined], ['agent', MODEL], ['agent', MODEL], ['user', undefined]])

    const undone = dispatchCommand(pasted, undo)

    expect(undone.doc.toString()).toBe(DOC)
    expect(undone.field(sectionsField)).toStrictEqual(MODELS)
    expect(dispatchCommand(undone, redo).field(sectionsField)).toStrictEqual(pastedModels)
  })

  // The image trash deletes an image reference outside the undo history.
  // The history then maps the saved separator positions in the wrong doc
  // (see `restoreSectionModelsEffect`).
  function withoutHistory(state: EditorState, from: number, to: number): EditorState {
    return state.update({ changes: { from, to }, annotations: Transaction.addToHistory.of(false) }).state
  }

  it('puts back the sections that a delete at the doc end removed, after a change outside the undo history', () => {
    const deleted = historyState().update({ changes: { from: DOC.indexOf('two') + 'two'.length, to: DOC.length }, userEvent: 'delete.selection' }).state
    const trashed = withoutHistory(deleted, 1, 3)

    const undone = dispatchCommand(trashed, undo)

    expect(undone.doc.toString()).toBe(`o${DOC.slice(3)}`)
    expect(undone.field(sectionsField)).toStrictEqual(MODELS)
  })

  it('puts back a deleted section after a change outside the undo history deletes the text at its old place', () => {
    // Deletes the separator of s3, at 10; `three` then starts at 6, and its
    // `ree` holds 10.
    const deleted = historyState().update({ changes: { from: DOC.indexOf('two') + 1, to: DOC.indexOf('three') + 1 }, userEvent: 'delete.selection' }).state
    const ree = deleted.doc.toString().indexOf('ree')
    const trashed = withoutHistory(deleted, ree, ree + 'ree'.length)

    const undone = dispatchCommand(trashed, undo)

    expect(undone.doc.toString()).toBe(DOC.replace('three', 'th'))
    expect(undone.field(sectionsField)).toStrictEqual(MODELS)
  })
})

describe('section AI models', () => {
  const MODEL: ModelRef = { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }
  const DOC = ['hello', 'answer', 'legacy'].join(`\n${SECTION_SEP}\n`)

  function modeledSections(): Section[] {
    return [
      section('s1', 'user', 'hello'),
      { ...section('s2', 'agent', 'answer'), model: MODEL },
      section('s3', 'agent', 'legacy'),
    ]
  }

  function modeledState(selection?: EditorSelection): EditorState {
    return EditorState.create({
      doc: DOC,
      selection,
      extensions: [
        sectionsField.init(() => initialSectionModels(modeledSections())),
        pillsField.init(() => new Map()),
      ],
    })
  }

  it('keeps section models from the store through the editor and back, with no key when unknown', () => {
    const state = modeledState()

    expect(docToSections(DOC, state.field(sectionsField), new Map())).toStrictEqual(modeledSections())
  })

  it('pastes copied agent sections with their models', () => {
    const copied = serializeSelectionForClipboard(modeledState(EditorSelection.single(2, DOC.length)))
    const pasteState = EditorState.create({
      doc: 'first',
      selection: EditorSelection.cursor(5),
      extensions: [
        sectionsField.init(() => [{ id: 'p1', role: 'user' }]),
        pillsField.init(() => new Map()),
      ],
    })

    const nextState = pasteState.update(clipboardPasteTransaction(pasteState, copied)).state
    const pasted = docToSections(nextState.doc.toString(), nextState.field(sectionsField), new Map())

    expect(copied).toBe([
      'llo',
      '<dez:pill type="agent" model="openrouter/anthropic/claude-sonnet-4.5"/>',
      'answer',
      '<dez:pill type="agent"/>',
      'legacy',
    ].join('\n'))
    expect(pasted.map((candidate) => [candidate.role, sectionVisibleText(candidate), candidate.model])).toEqual([
      ['user', 'firstllo', undefined],
      ['agent', 'answer', MODEL],
      ['agent', 'legacy', undefined],
    ])
    expect(pasted[2]).not.toHaveProperty('model')
  })

  it('round-trips a model id with quotes, an ampersand, and a newline through a copied marker', () => {
    const tricky: ModelRef = { providerId: 'custom', modelId: 'org/"quoted" & co\nnext' }
    const state = EditorState.create({
      doc: `hi\n${SECTION_SEP}\nreply`,
      selection: EditorSelection.single(0, `hi\n${SECTION_SEP}\nreply`.length),
      extensions: [
        sectionsField.init(() => [{ id: 's1', role: 'user' }, { id: 's2', role: 'agent', model: tricky }]),
        pillsField.init(() => new Map()),
      ],
    })

    const copied = serializeSelectionForClipboard(state)

    expect(copied.split('\n')).toEqual([
      '<dez:pill type="user"/>',
      'hi',
      '<dez:pill type="agent" model="custom/org/&quot;quoted&quot; &amp; co&#10;next"/>',
      'reply',
    ])
    expect(parseClipboardText(copied).separators).toStrictEqual([{ role: 'user' }, { role: 'agent', model: tricky }])
  })

  it('ignores a pasted model on a user marker and a model value without a provider', () => {
    const parsed = parseClipboardText([
      'a',
      '<dez:pill type="user" model="openrouter/x"/>',
      'b',
      '<dez:pill type="agent" model="no-slash"/>',
      'c',
    ].join('\n'))

    expect(parsed.text).toBe(`a\n${SECTION_SEP}\nb\n${SECTION_SEP}\nc`)
    expect(parsed.separators).toStrictEqual([{ role: 'user' }, { role: 'agent' }])
  })

  it('reads pasted marker attributes in any order and a model value that holds />', () => {
    const parsed = parseClipboardText([
      'a',
      '<dez:pill model="openrouter/x" type="agent"/>',
      'b',
      '<dez:pill  type="agent"  model="custom/v &quot;1&quot; />" />',
      'c',
      '<dez:pill type="other"/>',
    ].join('\n'))

    expect(parsed.text).toBe(`a\n${SECTION_SEP}\nb\n${SECTION_SEP}\nc\n<dez:pill type="other"/>`)
    expect(parsed.separators).toStrictEqual([
      { role: 'agent', model: { providerId: 'openrouter', modelId: 'x' } },
      { role: 'agent', model: { providerId: 'custom', modelId: 'v "1" />' } },
    ])
  })
})

describe('section thinking', () => {
  const MODEL: ModelRef = { providerId: 'zai', modelId: 'glm-5.2' }
  const THINKING: SectionThinking = { text: 'plan the answer\n', replay: { kind: 'field', field: 'reasoning_content' } }
  const DOC = ['question', 'answer', 'legacy'].join(`\n${SECTION_SEP}\n`)
  const WHOLE_DOC = EditorSelection.single(0, DOC.length)

  function thinkingSections(thinking: SectionThinking): Section[] {
    return [
      section('s1', 'user', 'question'),
      { ...section('s2', 'agent', 'answer'), model: MODEL, thinking },
      section('s3', 'agent', 'legacy'),
    ]
  }

  function thinkingState(thinking: SectionThinking = THINKING, selection?: EditorSelection): EditorState {
    return EditorState.create({
      doc: DOC,
      selection,
      extensions: [
        sectionsField.init(() => initialSectionModels(thinkingSections(thinking))),
        pillsField.init(() => new Map()),
      ],
    })
  }

  function pasteAfterFirst(copied: string): Section[] {
    const state = EditorState.create({
      doc: 'first',
      selection: EditorSelection.cursor(5),
      extensions: [
        sectionsField.init(() => [{ id: 'p1', role: 'user' }]),
        pillsField.init(() => new Map()),
      ],
    })
    const nextState = state.update(clipboardPasteTransaction(state, copied)).state
    return docToSections(nextState.doc.toString(), nextState.field(sectionsField), new Map())
  }

  // 'none' marks an entry without a `thinking` key, so `thinking: undefined`
  // fails the strict compares below.
  function storedThinking(models: { thinking?: SectionThinking }[]): (SectionThinking | 'none' | undefined)[] {
    return models.map((model) => ('thinking' in model ? model.thinking : 'none'))
  }

  it('keeps thinking from the store through the editor and back, with no key when absent', () => {
    expect(docToSections(DOC, thinkingState().field(sectionsField), new Map())).toStrictEqual(thinkingSections(THINKING))
  })

  it('keeps thinking on its own section through a split', () => {
    const splitAt = `question\n${SECTION_SEP}\nans`.length
    const split = thinkingState().update({
      changes: { from: splitAt, insert: `\n${SECTION_SEP}\n` },
      effects: splitSectionEffect.of({ afterIndex: 1 }),
    }).state
    const splitSections = docToSections(split.doc.toString(), split.field(sectionsField), new Map())

    expect(splitSections.map(sectionVisibleText)).toEqual(['question', 'ans', 'wer', 'legacy'])
    expect(storedThinking(splitSections)).toStrictEqual(['none', THINKING, 'none', 'none'])
  })

  it('sets, replaces, and removes the thinking of one section by id', () => {
    const replaced: SectionThinking = { text: 'second thoughts' }
    const set = thinkingState().update({ effects: setSectionThinkingEffect.of({ sectionId: 's3', thinking: replaced }) }).state
    const removed = set.update({ effects: setSectionThinkingEffect.of({ sectionId: 's2' }) }).state
    const unknown = removed.update({ effects: setSectionThinkingEffect.of({ sectionId: 'missing', thinking: replaced }) }).state

    expect(storedThinking(set.field(sectionsField))).toStrictEqual(['none', THINKING, replaced])
    expect(storedThinking(removed.field(sectionsField))).toStrictEqual(['none', 'none', replaced])
    expect(removed.field(sectionsField)[1]).toStrictEqual({ id: 's2', role: 'agent', model: MODEL })
    expect(unknown.field(sectionsField)).toStrictEqual(removed.field(sectionsField))
  })

  it('copies an agent section with thinking as a container and pastes it back with its replay', () => {
    const copied = serializeSelectionForClipboard(thinkingState(THINKING, WHOLE_DOC))
    const pasted = pasteAfterFirst(copied)

    expect(copied.split('\n')).toEqual([
      '<dez:pill type="user"/>',
      'question',
      '<dez:pill type="agent" model="zai/glm-5.2" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning_content&quot;}">',
      'plan the answer',
      '',
      '</dez:pill>',
      'answer',
      '<dez:pill type="agent"/>',
      'legacy',
    ])
    expect(pasted.map((candidate) => [candidate.role, sectionVisibleText(candidate), candidate.model])).toEqual([
      ['user', 'firstquestion', undefined],
      ['agent', 'answer', MODEL],
      ['agent', 'legacy', undefined],
    ])
    expect(storedThinking(pasted)).toStrictEqual(['none', THINKING, 'none'])
  })

  it('round-trips exact thinking text, a signed replay, and rounds through copy and paste', () => {
    const texts = [
      '',
      '\n',
      'trailing newlines\n\n',
      'carriage return\r',
      '\r\nwindows lines\r\n',
      'ends with </dez:pill>',
      '</dez:pill>\n</dez:pill>',
      'already escaped <\\/dez:pill> and <\\\\/dez:pill>',
      'already escaped <\\dez:pill type="user"/> and <\\\\dez:pill',
      `live sentinels ${SECTION_SEP} ${PILL_OPEN}id${PILL_BODY}body${PILL_CLOSE} ${PILL_NL}`,
      '<dez:pill type="user"/>\n<dez:pill type="agent">\nmarkers as text',
      'inline <dez:pill type="user"/> and </dez:pill',
      '<dez:prompt name="p">\nprompt markup\n</dez:prompt>',
    ]

    for (const text of texts) {
      const thinking: SectionThinking = {
        text,
        replay: {
          kind: 'anthropicBlocks',
          blocks: [{ type: 'thinking', thinking: `${text} > "q" & <x/>`, signature: 'sig' }, { type: 'redacted_thinking', data: 'opaque' }],
          prefixHash: 'h1',
        },
        rounds: [{ afterToolCall: 'call_1', from: text.length, replay: { kind: 'copilot', opaque: `${text} "&`, prefixHash: 'h2' } }],
      }
      const pasted = pasteAfterFirst(serializeSelectionForClipboard(thinkingState(thinking, WHOLE_DOC)))

      expect(storedThinking(pasted), JSON.stringify(text)).toStrictEqual(['none', thinking, 'none'])
      expect(pasted.map(sectionVisibleText), JSON.stringify(text)).toEqual(['firstquestion', 'answer', 'legacy'])
    }
  })

  it('drops the thinking of a container pasted inside a prompt body', () => {
    const pillId = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
    const state = EditorState.create({
      doc: encodePrompt(pillId, 'body', false),
      selection: EditorSelection.cursor(`${PILL_OPEN}${pillId}${PILL_BODY}bo`.length),
      extensions: [
        sectionsField.init(() => [{ id: 'p1', role: 'user' }]),
        pillsField.init(() => new Map([[pillId, { promptId: null, name: 'P', expanded: true }]])),
      ],
    })
    const copied = serializeSelectionForClipboard(thinkingState(THINKING, EditorSelection.single('question\n'.length, DOC.length)))

    const nextState = state.update(clipboardPasteTransaction(state, copied)).state

    expect(copied).toContain('plan the answer')
    expect(nextState.doc.toString()).toBe(encodePrompt(pillId, 'boanswer\nlegacydy', false))
    expect(nextState.field(sectionsField)).toStrictEqual([{ id: 'p1', role: 'user' }])
  })

  it('reads hand-made pasted containers the way conversation files read them', () => {
    const parsed = parseClipboardText([
      'a',
      '<dez:pill type="user">',
      'user body',
      '</dez:pill>',
      'b',
      '<dez:pill type="agent">',
      '</dez:pill>',
      'c',
      '<dez:pill type="other">',
      '<dez:pill type="agent">',
      'kept',
      '</dez:pill>',
      'd',
      '<dez:pill type="agent">',
      'e',
    ].join('\n'))

    expect(parsed.text).toBe(`a\n${SECTION_SEP}\nb\n${SECTION_SEP}\nc\n<dez:pill type="other">\n${SECTION_SEP}\nd\n${SECTION_SEP}\ne`)
    expect(parsed.separators).toStrictEqual([
      { role: 'user' },
      { role: 'agent', thinking: { text: '' } },
      { role: 'agent', thinking: { text: 'kept' } },
      { role: 'agent' },
    ])
  })

  it('ends a pasted opening tag with no closing tag at the next marker, also when a later container closes', () => {
    const parsed = parseClipboardText([
      'a',
      '<dez:pill type="agent" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning_content&quot;}">',
      'answer 1',
      '<dez:pill type="user"/>',
      'q2',
      '<dez:pill type="agent">',
      'thought 2',
      '</dez:pill>',
      'answer 2',
    ].join('\n'))

    expect(parsed.text).toBe(`a\n${SECTION_SEP}\nanswer 1\n${SECTION_SEP}\nq2\n${SECTION_SEP}\nanswer 2`)
    expect(parsed.separators).toStrictEqual([
      { role: 'agent' },
      { role: 'user' },
      { role: 'agent', thinking: { text: 'thought 2' } },
    ])
  })
})

describe('section durations', () => {
  const MODEL: ModelRef = { providerId: 'zai', modelId: 'glm-5.2' }
  const DOC = ['question', 'answer', 'thought', 'legacy'].join(`\n${SECTION_SEP}\n`)
  const SECTIONS: Section[] = [
    section('s1', 'user', 'question'),
    { ...section('s2', 'agent', 'answer'), model: MODEL, durationMs: 4213 },
    { ...section('s3', 'agent', 'thought'), thinking: { text: 'plan' }, durationMs: 0 },
    section('s4', 'agent', 'legacy'),
  ]

  function durationState(selection?: EditorSelection): EditorState {
    return EditorState.create({
      doc: DOC,
      selection,
      extensions: [
        sectionsField.init(() => initialSectionModels(SECTIONS)),
        pillsField.init(() => new Map()),
      ],
    })
  }

  it('keeps the duration from the store through the editor and back', () => {
    // Strict: a section without a duration must not get `durationMs: undefined`.
    expect(docToSections(DOC, durationState().field(sectionsField), new Map())).toStrictEqual(SECTIONS)
  })

  it('copies the duration in agent markers and pastes it back', () => {
    const copied = serializeSelectionForClipboard(durationState(EditorSelection.single(0, DOC.length)))
    const pasteState = EditorState.create({
      doc: 'first',
      selection: EditorSelection.cursor(5),
      extensions: [
        sectionsField.init(() => [{ id: 'p1', role: 'user' }]),
        pillsField.init(() => new Map()),
      ],
    })
    const pastedState = pasteState.update(clipboardPasteTransaction(pasteState, copied)).state
    const pasted = docToSections(pastedState.doc.toString(), pastedState.field(sectionsField), new Map())

    expect(copied.split('\n')).toEqual([
      '<dez:pill type="user"/>',
      'question',
      '<dez:pill type="agent" model="zai/glm-5.2" duration-ms="4213"/>',
      'answer',
      '<dez:pill type="agent" duration-ms="0">',
      'plan',
      '</dez:pill>',
      'thought',
      '<dez:pill type="agent"/>',
      'legacy',
    ])
    expect(pasted.map(sectionVisibleText)).toEqual(['firstquestion', 'answer', 'thought', 'legacy'])
    // 'none' marks a section without a `durationMs` key.
    expect(pasted.map((candidate) => ('durationMs' in candidate ? candidate.durationMs : 'none'))).toStrictEqual(['none', 4213, 0, 'none'])
  })

  it('pastes no duration from a user marker or a bad value', () => {
    const parsed = parseClipboardText([
      'a',
      '<dez:pill type="user" duration-ms="5"/>',
      'b',
      '<dez:pill type="agent" duration-ms="-1"/>',
      'c',
    ].join('\n'))

    expect(parsed.separators).toStrictEqual([{ role: 'user' }, { role: 'agent' }])
  })
})

describe('Linux line-navigation keymap', () => {
  it('binds Linux Ctrl+A and Ctrl+E without changing macOS Ctrl+A/Ctrl+E behavior', () => {
    const bindings = linuxLineNavigationKeymap()

    expect(keymapHasPlatformBinding(bindings, 'linux', 'Ctrl-a')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Ctrl-e')).toBe(true)
    expect(keymapHasPlatformBinding(bindings, 'linux', 'Mod-a')).toBe(false)
    expect(keymapHasPlatformBinding(bindings, 'mac', 'Ctrl-a')).toBe(false)
    expect(keymapHasPlatformBinding(bindings, 'mac', 'Ctrl-e')).toBe(false)
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
    expect(structured.separators).toEqual([{ role: 'user' }, { role: 'agent' }])
    expect(plain).toEqual({ text: 'x inner y\nz', pills: new Map(), separators: [] })
  })

  // Tool results are escaped, so a copied block pastes back as the same text
  // and its result adds no pills, prompts, or sections.
  it('copies and pastes tool blocks as the same text', () => {
    const agentText = [
      'Let me check.',
      toolBlockText({
        id: 'call_1',
        name: 'model_list',
        status: 'success',
        arguments: { filter: 'a "b"' },
        result: '<dez:pill type="user"/>\n<dez:prompt name="p">\nbody\n</dez:prompt>\n<dez:pill type="agent">\n</dez:pill>\n</dez:tool>',
      }),
      toolBlockText({ id: 'call_2', name: 'model_list', status: 'running', arguments: {}, result: '' }),
      'Done.',
    ].join('\n')
    const sections = [section('s1', 'user', 'question'), section('s2', 'agent', agentText)]
    const doc = sectionsToDoc(sections)
    const copyState = EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [sectionsField.init(() => initialSectionModels(sections)), pillsField.init(() => new Map())],
    })
    const pasteState = EditorState.create({
      doc: '',
      extensions: [sectionsField.init(() => [{ id: 'p1', role: 'user' }]), pillsField.init(() => new Map())],
    })

    const pasted = pasteState.update(clipboardPasteTransaction(pasteState, serializeSelectionForClipboard(copyState))).state

    expect(pasted.field(pillsField).size).toBe(0)
    expect(docToSections(pasted.doc.toString(), pasted.field(sectionsField), new Map()).map((candidate) => [candidate.role, sectionVisibleText(candidate)]))
      .toStrictEqual([['user', 'question'], ['agent', agentText]])
  })
})

describe('Copy Markdown', () => {
  const PILL_ID = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
  const THINKING: SectionThinking = { text: 'plan the answer', replay: { kind: 'field', field: 'reasoning_content' } }

  function markdownOf(doc: string, selection: EditorSelection, models: SectionModel[] = [{ id: 's1', role: 'user' }]): string {
    return serializeSelectionAsMarkdown(EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        sectionsField.init(() => models),
        pillsField.init(() => new Map([[PILL_ID, { promptId: 'saved', name: 'Summary', expanded: false }]])),
      ],
    }))
  }

  it('copies each selected section under its role heading, with no markers or thinking', () => {
    const doc = ['question', 'answer', 'legacy'].join(`\n${SECTION_SEP}\n`)
    const models: SectionModel[] = [
      { id: 's1', role: 'user' },
      { id: 's2', role: 'agent', model: { providerId: 'zai', modelId: 'glm-5.2' }, thinking: THINKING },
      { id: 's3', role: 'agent' },
    ]

    expect(markdownOf(doc, EditorSelection.single(0, doc.length), models))
      .toBe('## User\n\nquestion\n\n## Agent\n\nanswer\n\n## Agent\n\nlegacy\n')
  })

  it('gives a heading only to a section whose role pill is selected, and nothing for an empty section', () => {
    const doc = ['one', '', 'two\n', 'three'].join(`\n${SECTION_SEP}\n`)
    const models: SectionModel[] = [
      { id: 's1', role: 'user' },
      { id: 's2', role: 'agent' },
      { id: 's3', role: 'user' },
      { id: 's4', role: 'agent' },
    ]
    const fromFirstSeparatorLine = doc.indexOf(SECTION_SEP) - 1
    const toAfterLastSeparator = doc.lastIndexOf(SECTION_SEP) + 1
    const lastSectionText = doc.length - 'three'.length

    expect(markdownOf(doc, EditorSelection.single(0, doc.length), models))
      .toBe('## User\n\none\n\n## User\n\ntwo\n\n## Agent\n\nthree\n')
    // The first section's pill counts as selected only from doc position 0.
    expect(markdownOf(doc, EditorSelection.single(0, 'on'.length), models)).toBe('## User\n\non\n')
    expect(markdownOf(doc, EditorSelection.single(1, doc.length), models))
      .toBe('ne\n\n## User\n\ntwo\n\n## Agent\n\nthree\n')
    expect(markdownOf(doc, EditorSelection.single(fromFirstSeparatorLine, toAfterLastSeparator), models)).toBe('## User\n\ntwo\n')
    // Inside one section's text, the copy is that text as is.
    expect(markdownOf(doc, EditorSelection.single(lastSectionText, doc.length), models)).toBe('three')
  })

  it('copies a whole or partly selected prompt pill as its body text with real newlines', () => {
    const doc = `see ${encodePrompt(PILL_ID, 'line one\nline two')} end\n${SECTION_SEP}\nreply`
    const bodyFrom = doc.indexOf(PILL_BODY) + 1
    const models: SectionModel[] = [{ id: 's1', role: 'user' }, { id: 's2', role: 'agent' }]

    expect(markdownOf(doc, EditorSelection.single(0, doc.length), models))
      .toBe('## User\n\nsee line one\nline two end\n\n## Agent\n\nreply\n')
    expect(markdownOf(doc, EditorSelection.single(bodyFrom + 'line '.length, doc.indexOf(' end')))).toBe('one\nline two')
    expect(markdownOf(doc, EditorSelection.single(1, doc.indexOf(PILL_BODY)))).toBe('ee ')
  })

  it('closes a code fence that the selected part of a section leaves open', () => {
    const doc = ['question', '1. step\n\n   ```sh\n   run it\n   ```\n\ndone'].join(`\n${SECTION_SEP}\n`)
    const models: SectionModel[] = [{ id: 's1', role: 'user' }, { id: 's2', role: 'agent' }]

    expect(markdownOf(doc, EditorSelection.single(0, doc.indexOf('   run it')), models))
      .toBe('## User\n\nquestion\n\n## Agent\n\n1. step\n\n   ```sh\n   ```\n')
  })

  it('copies a whole tab as Save As Markdown saves it, without the title line', () => {
    const sections: Section[] = [
      {
        id: 's1',
        role: 'user',
        content: [
          textNode('Summarize: '),
          { kind: 'prompt', id: PILL_ID, promptId: 'saved', name: 'Summary', body: 'line one\nline two', expanded: false },
          textNode('\n'),
        ],
      },
      {
        id: 's2',
        role: 'agent',
        model: { providerId: 'zai', modelId: 'glm-5.2' },
        thinking: THINKING,
        durationMs: 4213,
        content: [textNode('Stopped in code:\n\n```ts\nconst x = 1')],
      },
      section('s3', 'agent', ' \n'),
      section('s4', 'user', 'Thanks'),
      section('s5', 'user', ''),
    ]
    const doc = sectionsToDoc(sections)
    const copied = serializeSelectionAsMarkdown(EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [
        sectionsField.init(() => initialSectionModels(sections)),
        pillsField.init(() => new Map([[PILL_ID, { promptId: 'saved', name: 'Summary', expanded: false }]])),
      ],
    }))
    const saved = serializeConversationAsMarkdown({
      id: 'c1',
      title: 'Chat',
      activeModel: null,
      created_at: 0,
      sections: sections.map((s) => ({ role: s.role, nodes: s.content })),
    })

    expect(saved.startsWith('# Chat\n\n')).toBe(true)
    expect(copied).toBe(saved.slice('# Chat\n\n'.length))
  })

  it('joins the non-empty ranges with newlines, and copies nothing without selected text', () => {
    const doc = `alpha\n${SECTION_SEP}\nbeta gamma`
    const separatorOnly = EditorSelection.range('alpha'.length, 'alpha\n'.length + `${SECTION_SEP}\n`.length)

    expect(markdownOf(doc, EditorSelection.create([
      EditorSelection.range(1, 'alpha'.length),
      separatorOnly,
      EditorSelection.range(doc.length - 'gamma'.length, doc.length),
    ]))).toBe('lpha\ngamma')
    expect(markdownOf(doc, EditorSelection.create([separatorOnly, EditorSelection.cursor(2)]))).toBe('')
  })

  it('leaves out the tool blocks of agent text, also inside one agent section, and keeps them in user text', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: {}, result: '12 models' })
    const agentText = `Let me check.\n${block}\nThere are 12.`
    const doc = [`Like this?\n${block}`, agentText].join(`\n${SECTION_SEP}\n`)
    const models: SectionModel[] = [{ id: 's1', role: 'user' }, { id: 's2', role: 'agent' }]
    const agentFrom = doc.length - agentText.length

    expect(markdownOf(doc, EditorSelection.single(0, doc.length), models))
      .toBe(`## User\n\nLike this?\n${block}\n\n## Agent\n\nLet me check.\n\nThere are 12.\n`)
    expect(markdownOf(doc, EditorSelection.single(agentFrom + 'Let '.length, doc.length - 1), models)).toBe('me check.\n\nThere are 12')
    expect(markdownOf(doc, EditorSelection.single('Like '.length, doc.indexOf(SECTION_SEP) - 1), models)).toBe(`this?\n${block}`)
  })
})

describe('broken prompt pills', () => {
  // Live pill ids are `crypto.randomUUID()` values (see `acceptPrompt`).
  const PILL_ID = 'bdbf417c-2282-4d77-991c-2ac65e1f0a11'
  const NESTED_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f'
  const BODY = 'Summarize\nthis'
  // An expanded pill (real newlines in the body).
  const PILL = encodePrompt(PILL_ID, BODY, false)
  // The pill at the doc start, then text.
  const DOC = `${PILL} tail`
  const BODY_FROM = `${PILL_OPEN}${PILL_ID}${PILL_BODY}`.length
  const BODY_TO = BODY_FROM + BODY.length
  const PILL_TO = BODY_TO + 1
  const META: PillMetadata = { promptId: 'saved', name: 'Summary', expanded: true }
  const PILL_NODE: ContentNode = { kind: 'prompt', id: PILL_ID, promptId: 'saved', name: 'Summary', body: BODY, expanded: true }

  function pillState(
    { doc = DOC, models = [{ id: 's1', role: 'user' }], selection }: { doc?: string, models?: SectionModel[], selection?: { anchor: number, head?: number } } = {},
  ): EditorState {
    return EditorState.create({
      doc,
      selection,
      extensions: [
        history(),
        sectionsField.init(() => models),
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
      // `tabTitle` builds the tab title from this text.
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

  // The issue's thread: the pill is the whole first user section, then an
  // agent reply and an empty user section. The selection holds the hidden
  // close marker, but no body text.
  const THREAD = `${PILL}\n${SECTION_SEP}\nHi!\n${SECTION_SEP}\n`
  const THREAD_MODELS: SectionModel[] = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'agent', model: { providerId: 'zai', modelId: 'glm-5.2' }, durationMs: 1500 },
    { id: 'u2', role: 'user' },
  ]

  function deleteFromBodyEndToThreadEnd(): EditorState {
    const start = pillState({ doc: THREAD, models: THREAD_MODELS, selection: { anchor: THREAD.length, head: BODY_TO } })
    return dispatchCommand(start, deleteCharForward)
  }

  it('keeps the pill when Delete removes a selection from the end of its body to the doc end', () => {
    const state = deleteFromBodyEndToThreadEnd()

    expect(state.doc.toString()).toBe(PILL)
    // The caret stays at the end of the body, inside the pill.
    expect(state.selection.main.head).toBe(BODY_TO)
    expect(docToSections(state.doc.toString(), state.field(sectionsField), state.field(pillsField)).map((section) => section.content)).toEqual([[textNode(''), PILL_NODE, textNode('')]])
    expect(undoDepth(state)).toBe(1)
    expect(dispatchCommand(state, undo).doc.toString()).toBe(THREAD)
  })

  it('brings back the removed agent section with its data on undo of that Delete, and removes it again on redo', () => {
    const undone = dispatchCommand(deleteFromBodyEndToThreadEnd(), undo)

    expect(undone.field(sectionsField)).toStrictEqual(THREAD_MODELS)

    const redone = dispatchCommand(undone, redo)

    expect(redone.doc.toString()).toBe(PILL)
    expect(redone.field(sectionsField)).toStrictEqual([THREAD_MODELS[0]])
  })

  it('keeps the pill and puts the typed text after it when typing over a selection from the end of its body', () => {
    const state = pillState().update({
      changes: { from: BODY_TO, to: PILL_TO + 2, insert: 'X' },
      selection: { anchor: BODY_TO + 1 },
    }).state

    expect(state.doc.toString()).toBe(`${PILL}Xail`)
    expect(state.selection.main.head).toBe(PILL_TO + 1)
    expect(docToSections(state.doc.toString(), state.field(sectionsField), state.field(pillsField))[0].content).toEqual([textNode(''), PILL_NODE, textNode('Xail')])
  })

  it('decodes and copies leftover broken markers as text without the pill id', () => {
    const doc = `x${PILL_CLOSE} ${PILL_OPEN}${PILL_ID}${PILL_BODY}a${PILL_NL}b${PILL_BODY}`
    const models: SectionModel[] = [{ id: 's1', role: 'user' }]

    const sections = docToSections(doc, models, new Map())
    const copied = serializeDocRangeForClipboard(doc, 0, doc.length, models, new Map())

    expect(sections.map((section) => section.content)).toEqual([[textNode('x a\nb')]])
    expect(copied).toBe('<dez:pill type="user"/>\nx a\nb')
  })
})

describe('markdown sections', () => {
  /** Each top-level block of the editor's markdown parse of `sections`:
   *  its node name and its text. */
  function topBlocks(...sections: string[]): string[] {
    const state = EditorState.create({ doc: sections.join(`\n${SECTION_SEP}\n`), extensions: [dezLanguageSupport()] })
    const blocks: string[] = []
    for (let node = ensureSyntaxTree(state, state.doc.length, 5000)!.topNode.firstChild; node; node = node.nextSibling) {
      blocks.push(`${node.name}: ${state.sliceDoc(node.from, node.to)}`)
    }
    return blocks
  }

  it('ends a quote at the end of its section', () => {
    expect(topBlocks('To finish:\n\n> "In the end we shall', 'Why do you keep cutting it off?')).toEqual([
      'Paragraph: To finish:',
      'Blockquote: > "In the end we shall',
      `SectionSeparator: ${SECTION_SEP}`,
      'Paragraph: Why do you keep cutting it off?',
    ])
  })

  it('ends a list, and a quote inside it, at the end of its section', () => {
    expect(topBlocks('*   **On Newspeak:**\n    > "In the end', 'finish the quote')).toEqual([
      'BulletList: *   **On Newspeak:**\n    > "In the end',
      `SectionSeparator: ${SECTION_SEP}`,
      'Paragraph: finish the quote',
    ])
  })

  it('never makes a setext heading out of the line before a separator', () => {
    expect(topBlocks('answer', '---', '===')).toEqual([
      'Paragraph: answer',
      `SectionSeparator: ${SECTION_SEP}`,
      'HorizontalRule: ---',
      `SectionSeparator: ${SECTION_SEP}`,
      'Paragraph: ===',
    ])
  })
})
