<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { EditorSelection, EditorState, Prec, type StateEffect } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import sbp from '@sbp/sbp'
import { useModelState, type Prompt } from '../modelState'
import { sectionIsEmpty } from '../../model/chat/content'
import { debounce } from 'turtledash'
import PromptAutocomplete from './PromptAutocomplete.vue'
import {
  SECTION_SEP,
  buildInitialDoc,
  encodePrompt,
  dezLanguageSupport,
  dezTheme,
  docToSections,
  initialPillMetadata,
  initialSectionModels,
  reconcileSectionModelsToDoc,
  leadingPillContentAttributes,
  linuxLineNavigationKeymap,
  mergeSectionEffect,
  pillsField,
  promptAtomicRanges,
  parseClipboardText,
  promptPillMouseHandler,
  promptPills,
  roleSeparatorAtomicRanges,
  roleSeparatorMouseHandler,
  roleSeparators,
  scanPills,
  sectionsField,
  toggleRoleEffect,
  serializeDocRangeForClipboard,
  setPillsEffect,
  setSectionsEffect,
  setShowSeparatorsEffect,
  showSeparatorsField,
  splitSectionEffect,
} from './cmEditor'

const {
  activeTabId,
  activeSections,
  activeSectionsIdentity,
  settings,
  prompts,
  activeTabStreaming,
  activeTabStreamError,
} = useModelState()

const hostRef = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let pendingPersistTabId: string | null = null
let syncingViewStructure = false

const autocompleteOpen = ref(false)
const autocompleteQuery = ref('')
const autocompleteFrom = ref(0)
const autocompleteTo = ref(0)
const autocompleteX = ref(0)
const autocompleteY = ref(0)
const autocompleteSelectedIndex = ref(0)

const isActiveTabStreaming = activeTabStreaming
const streamingError = activeTabStreamError

const showThinking = computed(() => {
  if (!isActiveTabStreaming.value) return false
  const sections = activeSections.value
  const last = sections[sections.length - 1]
  return last?.role === 'agent' && sectionIsEmpty(last)
})

const matchingPrompts = computed(() => {
  const q = autocompleteQuery.value.trim().toLowerCase()
  const sortedPrompts = prompts.value.slice().sort((a, b) => a.name.localeCompare(b.name))
  if (!q) return sortedPrompts
  return sortedPrompts.filter((p) => p.name.toLowerCase().includes(q))
})

/** Count RS occurrences in [0, pos) so we know which section the cursor is in. */
function sectionIndexAtPos(doc: string, pos: number): number {
  let n = 0
  for (let i = 0; i < pos && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 0x1e) n++
  }
  return n
}

function previousEditableLineInSection(state: EditorState, lineNumber: number) {
  if (lineNumber <= 1) return null
  const previous = state.doc.line(lineNumber - 1)
  return previous.text === SECTION_SEP ? null : previous
}

function nextEditableLineInSection(state: EditorState, lineNumber: number) {
  if (lineNumber >= state.doc.lines) return null
  const next = state.doc.line(lineNumber + 1)
  return next.text === SECTION_SEP ? null : next
}

function lastEditableLineOfPreviousSection(state: EditorState, lineNumber: number) {
  let n = lineNumber - 1
  while (n >= 1) {
    const line = state.doc.line(n)
    if (line.text !== SECTION_SEP) return line
    n--
  }
  return null
}

function firstEditableLineOfNextSection(state: EditorState, lineNumber: number) {
  const total = state.doc.lines
  let n = lineNumber + 1
  while (n <= total) {
    const line = state.doc.line(n)
    if (line.text !== SECTION_SEP) return line
    n++
  }
  return null
}

function moveCursorAcrossSeparatorLeft(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const currentLine = state.doc.lineAt(range.head)
  if (range.head !== currentLine.from) return false
  if (currentLine.number <= 1) return false
  const previous = state.doc.line(currentLine.number - 1)
  if (previous.text !== SECTION_SEP) return false
  const target = lastEditableLineOfPreviousSection(state, currentLine.number)
  if (!target) return false
  v.dispatch({
    selection: EditorSelection.cursor(target.to),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function moveCursorAcrossSeparatorRight(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const currentLine = state.doc.lineAt(range.head)
  if (range.head !== currentLine.to) return false
  if (currentLine.number >= state.doc.lines) return false
  const next = state.doc.line(currentLine.number + 1)
  if (next.text !== SECTION_SEP) return false
  const target = firstEditableLineOfNextSection(state, currentLine.number)
  if (!target) return false
  v.dispatch({
    selection: EditorSelection.cursor(target.from),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function moveCursorAcrossPromptLeft(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const pill = scanPills(state.doc.toString()).find((p) => p.to === range.head)
  if (!pill) return false
  if (state.field(pillsField).get(pill.id)?.expanded) return false
  v.dispatch({
    selection: EditorSelection.cursor(pill.from, -1),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function moveCursorAcrossPromptRight(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const pill = scanPills(state.doc.toString()).find((p) => p.from === range.head)
  if (!pill) return false
  if (state.field(pillsField).get(pill.id)?.expanded) return false
  v.dispatch({
    selection: EditorSelection.cursor(pill.to, 1),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function mergeWithPreviousSection(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const currentLine = state.doc.lineAt(range.head)
  if (range.head !== currentLine.from) return false
  if (currentLine.number <= 1) return false
  const previous = state.doc.line(currentLine.number - 1)
  if (previous.text !== SECTION_SEP) return false
  const target = lastEditableLineOfPreviousSection(state, currentLine.number)
  if (!target) return false
  const removeIndex = sectionIndexAtPos(state.doc.toString(), currentLine.from)
  v.dispatch({
    changes: { from: target.to, to: currentLine.from, insert: '' },
    selection: { anchor: target.to },
    effects: mergeSectionEffect.of({ removeIndex }),
    scrollIntoView: true,
    userEvent: 'delete.backward',
  })
  return true
}

function mergeWithNextSection(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) return false
  const currentLine = state.doc.lineAt(range.head)
  if (range.head !== currentLine.to) return false
  if (currentLine.number >= state.doc.lines) return false
  const next = state.doc.line(currentLine.number + 1)
  if (next.text !== SECTION_SEP) return false
  const target = firstEditableLineOfNextSection(state, currentLine.number)
  if (!target) return false
  const removeIndex = sectionIndexAtPos(state.doc.toString(), target.from)
  v.dispatch({
    changes: { from: currentLine.to, to: target.from, insert: '' },
    selection: { anchor: currentLine.to },
    effects: mergeSectionEffect.of({ removeIndex }),
    scrollIntoView: true,
    userEvent: 'delete.forward',
  })
  return true
}

function moveLineUpWithinSection(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) {
    v.dispatch({
      selection: EditorSelection.cursor(range.from),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }

  const currentLine = state.doc.lineAt(range.head)
  const previousLine = previousEditableLineInSection(state, currentLine.number)

  if (!previousLine) {
    const crossSectionTarget = lastEditableLineOfPreviousSection(state, currentLine.number)
    if (!crossSectionTarget) {
      v.dispatch({
        selection: EditorSelection.cursor(currentLine.from),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    const column = range.head - currentLine.from
    const target = crossSectionTarget.from + Math.min(column, crossSectionTarget.length)
    v.dispatch({
      selection: EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }

  const moved = v.moveVertically(range, false)
  const movedLine = state.doc.lineAt(moved.head)
  if (moved.head < range.head) {
    if (movedLine.number === currentLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    if (movedLine.number === previousLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
  }

  const column = range.head - currentLine.from
  const target = previousLine.from + Math.min(column, previousLine.length)
  v.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function moveLineDownWithinSection(v: EditorView): boolean {
  const { state } = v
  const range = state.selection.main
  if (!range.empty) {
    v.dispatch({
      selection: EditorSelection.cursor(range.to),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }

  const currentLine = state.doc.lineAt(range.head)
  const nextLine = nextEditableLineInSection(state, currentLine.number)

  if (!nextLine) {
    const crossSectionTarget = firstEditableLineOfNextSection(state, currentLine.number)
    if (!crossSectionTarget) {
      v.dispatch({
        selection: EditorSelection.cursor(currentLine.to),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    const column = range.head - currentLine.from
    const target = crossSectionTarget.from + Math.min(column, crossSectionTarget.length)
    v.dispatch({
      selection: EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }

  const moved = v.moveVertically(range, true)
  const movedLine = state.doc.lineAt(moved.head)
  if (moved.head > range.head) {
    if (movedLine.number === currentLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    if (movedLine.number === nextLine.number) {
      v.dispatch({
        selection: EditorSelection.create([moved]),
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
  }

  const column = range.head - currentLine.from
  const target = nextLine.from + Math.min(column, nextLine.length)
  v.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

function documentLineCursorTarget(state: EditorState, head: number, forward: boolean): number | null {
  const currentLine = state.doc.lineAt(head)
  const adjacentLine = forward
    ? nextEditableLineInSection(state, currentLine.number)
    : previousEditableLineInSection(state, currentLine.number)
  const targetLine = adjacentLine ?? (forward
    ? firstEditableLineOfNextSection(state, currentLine.number)
    : lastEditableLineOfPreviousSection(state, currentLine.number)
  )
  if (!targetLine) return null
  const column = head - currentLine.from
  return targetLine.from + Math.min(column, targetLine.length)
}

function addDocumentLineCursor(v: EditorView, forward: boolean): boolean {
  const { state } = v
  const selection = state.selection
  const ranges = selection.ranges.slice()
  for (const range of selection.ranges) {
    const target = documentLineCursorTarget(state, range.head, forward)
    if (target === null) continue
    ranges.push(EditorSelection.cursor(target, range.assoc, range.bidiLevel ?? undefined))
  }
  const nextSelection = EditorSelection.create(ranges, selection.mainIndex)
  if (nextSelection.ranges.length === selection.ranges.length) return false
  v.dispatch({
    selection: nextSelection,
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/** Flatten CM doc back into the given tab's `sections[]` using the live
 *  sectionsField for id + role preservation. */
function persistTab(tabId: string) {
  void sbp('dez.model/tabs/save', tabId)
  void sbp('dez.model/appState/save')
}

const persistPendingTab = debounce(() => {
  const tabId = pendingPersistTabId
  pendingPersistTabId = null
  if (tabId) persistTab(tabId)
}, 1000)

function flushPendingPersist() {
  persistPendingTab.flush()
}

function schedulePersistTab(tabId: string) {
  pendingPersistTabId = tabId
  persistPendingTab()
}

function sectionModelsEqual(left: ReturnType<typeof initialSectionModels>, right: ReturnType<typeof initialSectionModels>): boolean {
  return left.length === right.length && left.every((model, i) => {
    const candidate = right[i]
    return candidate && model.id === candidate.id && model.role === candidate.role
  })
}

function syncDocToTab(tabId: string, persist = false) {
  if (!view) return
  const tab = sbp('dez.model/tab', tabId)
  if (!tab) return
  const doc = view.state.doc.toString()
  const models = view.state.field(sectionsField)
  const fallbackModels = initialSectionModels(tab.sections)
  const reconciledModels = reconcileSectionModelsToDoc(models, doc, fallbackModels)
  if (!sectionModelsEqual(models, reconciledModels)) {
    view.dispatch({ effects: setSectionsEffect.of(reconciledModels) })
  }
  const meta = view.state.field(pillsField)
  const sections = docToSections(doc, reconciledModels, meta)
  sbp('dez.model/tabs/replaceSections', tabId, sections)
  if (persist) schedulePersistTab(tabId)
}

function syncDocToStore(persist = false) {
  syncDocToTab(activeTabId.value, persist)
}

function closeAutocomplete() {
  autocompleteOpen.value = false
  autocompleteQuery.value = ''
  autocompleteSelectedIndex.value = 0
}

function updatePromptAutocomplete(v: EditorView) {
  const range = v.state.selection.main
  if (!v.hasFocus || !range.empty) {
    closeAutocomplete()
    return
  }
  const line = v.state.doc.lineAt(range.head)
  const before = line.text.slice(0, range.head - line.from)
  const match = /(^|[\t ])\/prompt ([^\s]*)$/.exec(before)
  if (!match) {
    closeAutocomplete()
    return
  }
  autocompleteQuery.value = match[2]
  const from = line.from + before.length - match[0].length + match[1].length
  autocompleteFrom.value = from
  autocompleteTo.value = range.head
  const coords = v.coordsAtPos(range.head)
  autocompleteX.value = coords?.left ?? 0
  autocompleteY.value = (coords?.bottom ?? 0) + 4
  if (matchingPrompts.value.length === 0) {
    closeAutocomplete()
    return
  }
  if (autocompleteSelectedIndex.value >= matchingPrompts.value.length) {
    autocompleteSelectedIndex.value = 0
  }
  autocompleteOpen.value = true
}

function acceptPrompt(prompt?: Prompt): boolean {
  if (!view || !autocompleteOpen.value) return false
  const selected = prompt ?? matchingPrompts.value[autocompleteSelectedIndex.value]
  if (!selected) return false
  const id = crypto.randomUUID()
  const insert = encodePrompt(id, selected.content, true)
  const meta = new Map(view.state.field(pillsField))
  meta.set(id, { promptId: selected.id, name: selected.name, expanded: false })
  view.dispatch({
    changes: { from: autocompleteFrom.value, to: autocompleteTo.value, insert },
    selection: { anchor: autocompleteFrom.value + insert.length },
    effects: setPillsEffect.of(meta),
    scrollIntoView: true,
  })
  closeAutocomplete()
  return true
}

function setClipboardText(event: ClipboardEvent, text: string) {
  event.clipboardData?.setData('text/plain', text)
}

function writeSelectionToClipboard(event: ClipboardEvent, cut: boolean, v: EditorView): boolean {
  const range = v.state.selection.main
  if (range.empty) return false
  const text = serializeDocRangeForClipboard(
    v.state.doc.toString(),
    range.from,
    range.to,
    v.state.field(sectionsField),
    v.state.field(pillsField),
  )
  event.preventDefault()
  setClipboardText(event, text)
  if (cut) {
    v.dispatch({
      changes: { from: range.from, to: range.to, insert: '' },
      selection: { anchor: range.from },
      scrollIntoView: true,
    })
  }
  return true
}

function pasteClipboardText(event: ClipboardEvent, v: EditorView): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text) return false
  const parsed = parseClipboardText(text)
  let pasteText = parsed.text
  const trimmedRoles = parsed.separatorRoles.slice()
  const leadingMarker = SECTION_SEP + '\n'
  while (pasteText.startsWith(leadingMarker) && trimmedRoles.length > 0) {
    pasteText = pasteText.slice(leadingMarker.length)
    trimmedRoles.shift()
  }
  const range = v.state.selection.main
  const meta = new Map(v.state.field(pillsField))
  for (const [id, pill] of parsed.pills) meta.set(id, pill)
  const effects: StateEffect<unknown>[] = [setPillsEffect.of(meta)]
  if (trimmedRoles.length > 0 || range.from !== range.to) {
    const doc = v.state.doc.toString()
    const fromSec = sectionIndexAtPos(doc, range.from)
    const toSec = sectionIndexAtPos(doc, range.to)
    const oldModels = v.state.field(sectionsField)
    const inserted = trimmedRoles.map((role) => ({
      id: crypto.randomUUID(),
      role,
    }))
    const newModels = [
      ...oldModels.slice(0, fromSec + 1),
      ...inserted,
      ...oldModels.slice(toSec + 1),
    ]
    effects.push(setSectionsEffect.of(newModels))
  }
  v.dispatch({
    changes: { from: range.from, to: range.to, insert: pasteText },
    selection: { anchor: range.from + pasteText.length },
    effects,
    scrollIntoView: true,
  })
  event.preventDefault()
  return true
}

function buildState(): EditorState {
  const sections = activeSections.value
  const models = initialSectionModels(sections)
  const pillMeta = initialPillMetadata(sections)
  const autocompleteKeymap = Prec.highest(
    keymap.of([
      {
        key: 'ArrowDown',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          autocompleteSelectedIndex.value =
            (autocompleteSelectedIndex.value + 1) % matchingPrompts.value.length
          return true
        },
      },
      {
        key: 'ArrowUp',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          autocompleteSelectedIndex.value =
            (autocompleteSelectedIndex.value - 1 + matchingPrompts.value.length) %
            matchingPrompts.value.length
          return true
        },
      },
      {
        key: 'Tab',
        preventDefault: true,
        run: () => acceptPrompt(),
      },
      {
        key: 'Enter',
        preventDefault: true,
        run: () => acceptPrompt(),
      },
      {
        key: 'Escape',
        preventDefault: true,
        run: () => {
          if (!autocompleteOpen.value) return false
          closeAutocomplete()
          return true
        },
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => autocompleteOpen.value,
      },
    ]),
  )
  const selectionKeymap = Prec.high(
    keymap.of([
      {
        key: 'Escape',
        preventDefault: true,
        run: (v) => {
          if (v.state.selection.ranges.length <= 1) return false
          v.dispatch({
            selection: v.state.selection.asSingle(),
            scrollIntoView: true,
            userEvent: 'select',
          })
          return true
        },
      },
    ]),
  )
  const submitKeymap = Prec.high(
    keymap.of([
      {
        key: 'Ctrl-Shift-ArrowUp',
        preventDefault: true,
        run: (v) => addDocumentLineCursor(v, false),
      },
      {
        key: 'Ctrl-Shift-ArrowDown',
        preventDefault: true,
        run: (v) => addDocumentLineCursor(v, true),
      },
      ...linuxLineNavigationKeymap(),
      {
        key: 'ArrowUp',
        preventDefault: true,
        run: moveLineUpWithinSection,
      },
      {
        key: 'ArrowDown',
        preventDefault: true,
        run: moveLineDownWithinSection,
      },
      {
        key: 'Home',
        preventDefault: true,
        run: (v) => {
          v.dispatch({
            selection: EditorSelection.cursor(0),
            effects: EditorView.scrollIntoView(0, { y: 'start', yMargin: 0 }),
            userEvent: 'select',
          })
          requestAnimationFrame(() => {
            v.scrollDOM.scrollTop = 0
          })
          return true
        },
      },
      {
        key: 'End',
        preventDefault: true,
        run: (v) => {
          v.dispatch({
            selection: EditorSelection.cursor(v.state.doc.length),
            scrollIntoView: true,
            userEvent: 'select',
          })
          return true
        },
      },
      {
        key: 'ArrowLeft',
        run: (v) => moveCursorAcrossPromptLeft(v) || moveCursorAcrossSeparatorLeft(v),
      },
      {
        key: 'ArrowRight',
        run: (v) => moveCursorAcrossPromptRight(v) || moveCursorAcrossSeparatorRight(v),
      },
      {
        key: 'Backspace',
        run: mergeWithPreviousSection,
      },
      {
        key: 'Delete',
        run: mergeWithNextSection,
      },
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => {
          syncDocToStore(true)
          void sbp('dez.controller/submitTab', activeTabId.value)
          return true
        },
      },
      {
        key: 'Shift-Enter',
        preventDefault: true,
        run: (v) => {
          const { from, to } = v.state.selection.main
          const doc = v.state.doc.toString()
          const afterIndex = sectionIndexAtPos(doc, from)
          const insert = `\n${SECTION_SEP}\n`
          v.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
            effects: splitSectionEffect.of({ afterIndex }),
            scrollIntoView: true,
          })
          return true
        },
      },
    ]),
  )

  return EditorState.create({
    doc: buildInitialDoc(sections),
    extensions: [
      sectionsField.init(() => models),
      showSeparatorsField.init(() => settings.value.showPillSeparators),
      pillsField.init(() => pillMeta),
      roleSeparators,
      roleSeparatorAtomicRanges,
      roleSeparatorMouseHandler,
      leadingPillContentAttributes,
      promptPills,
      promptAtomicRanges,
      promptPillMouseHandler,
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      history(),
      autocompleteKeymap,
      selectionKeymap,
      submitKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      dezLanguageSupport(),
      dezTheme,
      EditorView.updateListener.of((update) => {
        const roleChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(toggleRoleEffect)),
        )
        if ((update.docChanged || roleChanged) && !syncingViewStructure) {
          syncDocToStore(true)
        }
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          updatePromptAutocomplete(update.view)
        }
      }),
      EditorView.domEventHandlers({
        copy: (event, v) => writeSelectionToClipboard(event, false, v),
        cut: (event, v) => writeSelectionToClipboard(event, true, v),
        paste: pasteClipboardText,
        blur: () => {
          syncDocToStore()
          flushPendingPersist()
          closeAutocomplete()
          return false
        },
      }),
    ],
  })
}

function registerActiveView() {
  if (view) sbp('dez.editor/registerActiveView', activeTabId.value, view)
}

function unregisterActiveView(tabId = activeTabId.value) {
  sbp('dez.editor/unregisterActiveView', tabId)
}

function mountView() {
  if (!hostRef.value) return
  view = new EditorView({ state: buildState(), parent: hostRef.value })
  registerActiveView()
}

function scrollViewToBottomAfterLayout(v: EditorView) {
  requestAnimationFrame(() => {
    if (view !== v) return
    v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight
  })
}

function resetViewToActiveTab(moveCursorToEnd = false) {
  if (!view) return
  const state = buildState()
  view.setState(state)
  if (moveCursorToEnd) {
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      userEvent: 'select',
    })
    scrollViewToBottomAfterLayout(view)
  }
}

function stopActiveTab() {
  void sbp('dez.stream/stop', activeTabId.value)
}

function onEditorStreamFinished(tabId: string) {
  if (tabId !== activeTabId.value) return
  nextTick(() => resetViewToActiveTab(true))
}

function syncViewStructureToStoreSections() {
  if (!view) return
  const models = initialSectionModels(activeSections.value)
  const current = view.state.field(sectionsField)
  const same =
    current.length === models.length &&
    current.every((m, i) => m.id === models[i].id && m.role === models[i].role)
  if (same) return
  syncingViewStructure = true
  try {
    if (models.length > current.length) {
      const insert = Array.from({ length: models.length - current.length }, () => `\n${SECTION_SEP}\n`).join('')
      view.dispatch({
        changes: { from: view.state.doc.length, insert },
        effects: setSectionsEffect.of(models),
        scrollIntoView: true,
      })
    } else {
      view.dispatch({ effects: setSectionsEffect.of(models) })
    }
  } finally {
    syncingViewStructure = false
  }
}

onMounted(() => {
  mountView()
  sbp('okTurtles.events/on', 'dez.editor.stream-finished', onEditorStreamFinished)
})

onBeforeUnmount(() => {
  syncDocToStore()
  flushPendingPersist()
  persistTab(activeTabId.value)
  unregisterActiveView()
  sbp('okTurtles.events/off', 'dez.editor.stream-finished', onEditorStreamFinished)
  view?.destroy()
  view = null
})

// Rebuild state when the active tab changes — the CM doc is per-tab.
watch(
  () => activeTabId.value,
  (_newId, oldId) => {
    if (oldId) {
      syncDocToTab(oldId)
      flushPendingPersist()
      persistTab(oldId)
      unregisterActiveView(oldId)
    }
    nextTick(() => {
      resetViewToActiveTab()
      registerActiveView()
    })
  },
)

// External role toggles (from elsewhere) and separator-visibility toggle.
watch(
  () => settings.value.showPillSeparators,
  (v) => {
    if (view) view.dispatch({ effects: setShowSeparatorsEffect.of(v) })
  },
)

// If the active tab's sections change identity list from elsewhere (e.g.
// streaming appended a new agent section on this tab while mounted),
// mirror that into sectionsField so ids + roles stay aligned.
watch(
  () => activeSectionsIdentity.value,
  () => {
    syncViewStructureToStoreSections()
  },
)
</script>

<template>
  <div class="editor-container">
    <div ref="hostRef" class="thread-editor" />
    <PromptAutocomplete
      v-if="autocompleteOpen && matchingPrompts.length > 0"
      :prompts="matchingPrompts"
      :selected-index="autocompleteSelectedIndex"
      :x="autocompleteX"
      :y="autocompleteY"
      @select="acceptPrompt"
      @hover="autocompleteSelectedIndex = $event"
    />
    <div v-if="showThinking" class="thinking-indicator">
      <span class="thinking-dot" />
      <span class="thinking-dot" />
      <span class="thinking-dot" />
    </div>
    <div v-if="streamingError && !isActiveTabStreaming" class="stream-error">
      {{ streamingError }}
    </div>
    <button
      v-if="isActiveTabStreaming"
      class="stop-button"
      @click="stopActiveTab"
    >
      Stop
    </button>
  </div>
</template>

<style scoped>
.editor-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
}

.thread-editor {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.thread-editor :deep(.cm-editor) {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.thread-editor :deep(.cm-scroller) {
  overflow-y: auto;
}

.thinking-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--color-text);
  opacity: 0.4;
  animation: thinking-pulse 1.4s ease-in-out infinite;
}

.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-pulse {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 0.6; transform: scale(1); }
}

.stream-error {
  padding: 8px 16px;
  max-width: 768px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  color: #e55;
  font-size: 13px;
}

.stop-button {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg, #1e1e1e);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s;
}

.stop-button:hover { opacity: 1; }
</style>
