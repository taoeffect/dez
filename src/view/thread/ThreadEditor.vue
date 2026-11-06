<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap, type Command, type KeyBinding } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, redo, selectAll, undo } from '@codemirror/commands'
import sbp from '@sbp/sbp'
import { useModelState, type Prompt } from '../modelState'
import { sectionIsEmpty } from '../../model/chat/content'
import { sameModelRef } from '../../model/chat/modelRef'
import { sameThinking } from '../../model/chat/thinking'
import type { ShortcutIdOfScope } from '../../model/shortcuts'
import { debounce, throttle } from 'turtledash'
import PromptAutocomplete from './PromptAutocomplete.vue'
import FindDropdown from './FindDropdown.vue'
import {
  SECTION_SEP,
  buildInitialDoc,
  clipboardPasteTransaction,
  cutSelectedRangesTransaction,
  encodePrompt,
  dezLanguageSupport,
  dezTheme,
  docToSections,
  initialPillMetadata,
  initialSectionModels,
  reconcileSectionModelsToDoc,
  linuxLineNavigationKeymap,
  mergeSectionEffect,
  strictMultiCursorBackspace,
  pillsField,
  promptAtomicRanges,
  promptPillMouseHandler,
  promptPills,
  roleSeparatorAtomicRanges,
  roleSeparatorMouseHandler,
  roleSeparators,
  scanPills,
  sectionsField,
  serializeSelectionForClipboard,
  TEXT_GUTTER,
  toggleRoleEffect,
  setPillsEffect,
  setSectionsEffect,
  splitSectionEffect,
  unwrapBrokenPills,
} from './cmEditor'
import { modelDisplayNamesField, setModelDisplayNamesEffect, setStreamingSectionEffect, streamingSectionField } from './modelChip'
import { thinkingExpandedField } from './thinkingPill'
import { measureTextSize } from './editorMeasure'
import { findExtension, findMatchStatus, findNextMatch, findQueryField, selectMatchSpec, setFindQueryEffect } from '../editor/find'
import { markdownTables } from '../editor/tables'
import { focusKeepingScrollOnMouseDown } from '../editor/focus'
import { activeFindQuery, findState } from '../editor/findState'
import { isModalOpen } from '../composables/useKeyboardShortcuts'

const {
  activeTabId,
  activeConversationId,
  activeSections,
  activeSectionsIdentity,
  modelDisplayNames,
  prompts,
  activeTabStreaming,
  activeTabStreamingSectionId,
  settings,
  shortcuts,
} = useModelState()

const hostRef = ref<HTMLDivElement | null>(null)
// The one CodeMirror view of the thread. Its doc is the active tab's
// sections as flat text with sentinels; `cmEditor.ts` converts it to and
// from store sections. Fix editor behavior through CodeMirror state and
// extensions, not by changing its DOM.
let view: EditorView | null = null
// The tab whose content the view's state holds.
let viewTabId: string | null = null
// The conversation of that tab.
let viewConversationId: string | null = null
let pendingPersistTabId: string | null = null
let syncingViewStructure = false

// Where the view was in each conversation that it left, so that it shows
// the same place on a return: a tab switch, File › Reopen Closed Tab (the
// reopened tab has a new tab id but the same conversation id), or History.
// The selection comes back too: a caret left at the doc start would scroll
// the view back up at the first key press. Session-only. The restore
// scrolls the view as a user scroll does, on purpose: a place at the very
// bottom of a tab whose reply still streams starts the stream follow again
// (`handleVisibleScroll` in `src/view/editor/selectors.ts`).
interface ViewPlace {
  scroll: ReturnType<EditorView['scrollSnapshot']>
  selection: EditorSelection
}
const viewPlaces = new Map<string, ViewPlace>()

function rememberViewPlace() {
  if (!view || !viewConversationId) return
  viewPlaces.set(viewConversationId, { scroll: view.scrollSnapshot(), selection: view.state.selection })
}

// A stream that ended while the tab was in the background can make the doc
// shorter (a failed reply drops its empty agent section), so the saved
// selection may point past the end.
function selectionWithin(selection: EditorSelection, length: number): EditorSelection {
  return EditorSelection.create(
    selection.ranges.map((range) => EditorSelection.range(Math.min(range.anchor, length), Math.min(range.head, length))),
    selection.mainIndex,
  )
}

const autocompleteOpen = ref(false)
const autocompleteQuery = ref('')
const autocompleteFrom = ref(0)
const autocompleteTo = ref(0)
const autocompleteX = ref(0)
const autocompleteY = ref(0)
const autocompleteSelectedIndex = ref(0)
const findDropdownRef = ref<InstanceType<typeof FindDropdown> | null>(null)

const isActiveTabStreaming = activeTabStreaming

// The three dots under the editor while the stream has not written text
// yet.
const showBusyIndicator = computed(() => {
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

// Compares every `SectionModel` field the store also holds, so a store-side
// change on an existing section id (a model stamp at stream start, thinking
// or a duration cleared on a reused section, a duration stamped at the
// stream end) still reaches the editor's `sectionsField`. Thinking is
// compared by value: the store and the editor keep separate copies of it.
function sectionModelsEqual(left: ReturnType<typeof initialSectionModels>, right: ReturnType<typeof initialSectionModels>): boolean {
  return left.length === right.length && left.every((model, i) => {
    const candidate = right[i]
    return candidate &&
      model.id === candidate.id &&
      model.role === candidate.role &&
      sameModelRef(model.model, candidate.model) &&
      sameThinking(model.thinking, candidate.thinking) &&
      model.durationMs === candidate.durationMs
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

/** Recount matches for the find dropdown status. */
function refreshFindStatus() {
  if (!view) return
  const query = view.state.field(findQueryField)
  findState.status = query?.valid ? findMatchStatus(view.state, query) : null
}

// A recount scans the whole doc (~10 ms for 200 KB), and streamed tokens
// change the doc many times a second. While edits keep coming, recount at
// most every 250 ms (throttle), then once more after they stop (debounce)
// so the final count is right.
const refreshFindStatusThrottled = throttle(refreshFindStatus, 250)
const refreshFindStatusDebounced = debounce(refreshFindStatus, 250)

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
  // Pills do not nest (`scanPills` rejects a pill inside a pill body), so
  // accepting a prompt inside a pill would break that pill. Typing
  // `/prompt ` in an expanded pill body offers nothing.
  if (scanPills(v.state.doc.toString()).some((pill) => pill.from < range.head && from < pill.to)) {
    closeAutocomplete()
    return
  }
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
  const text = serializeSelectionForClipboard(v.state)
  if (!text) return false
  event.preventDefault()
  setClipboardText(event, text)
  if (cut) {
    const transaction = cutSelectedRangesTransaction(v.state)
    if (transaction) v.dispatch(v.state.update(transaction))
  }
  return true
}

function pasteClipboardText(event: ClipboardEvent, v: EditorView): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text) return false
  v.dispatch(clipboardPasteTransaction(v.state, text))
  event.preventDefault()
  return true
}

// The editor's editable shortcuts (`src/model/shortcuts.ts`), by id.
const editorShortcutCommands: Record<ShortcutIdOfScope<'editor'>, Command> = {
  submit: () => {
    // An open prompt autocomplete takes the Submit key and does nothing
    // with it.
    if (autocompleteOpen.value) return true
    syncDocToStore(true)
    void sbp('dez.controller/submitTab', activeTabId.value)
    return true
  },
  // A modal takes Esc first: the event bubbles on to the global handler,
  // which closes the modal, and the stream goes on.
  stop: () => {
    if (isModalOpen() || !isActiveTabStreaming.value) return false
    void sbp('dez.stream/stop', activeTabId.value)
    return true
  },
  newMessage: (v) => {
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
  addCursorAbove: (v) => addDocumentLineCursor(v, false),
  addCursorBelow: (v) => addDocumentLineCursor(v, true),
  undo,
  redo,
  selectAll,
}

// Undo and Redo are editable shortcuts, so they leave `historyKeymap`. Its
// selection undo and redo (Mod-u, Alt-u) stay fixed.
const fixedHistoryKeymap = historyKeymap.filter((binding) => binding.run !== undo && binding.run !== redo)

// Holds the editor shortcuts' keymap, so that a key change can replace it
// in the live view.
const editorShortcuts = new Compartment()

// One binding per key of each editor shortcut. In `buildState` it is listed
// after the autocomplete and find keymaps at the same precedence, so Esc
// closes those first and is the Stop key only when neither is open; Stop
// runs before the multi-cursor and selection Esc bindings, which do nothing
// while it stops. Stop returns false when there is no stream, so Esc goes on
// to them; every other action takes its key even when it does nothing (an
// Undo with no history), as CodeMirror's history keys do.
function editorShortcutKeymap(): Extension {
  const bindings = shortcuts.value.flatMap((shortcut): KeyBinding[] => {
    if (!Object.hasOwn(editorShortcutCommands, shortcut.id)) return []
    const run = editorShortcutCommands[shortcut.id as ShortcutIdOfScope<'editor'>]
    return shortcut.keys.map((key) => ({ key, run, preventDefault: shortcut.id !== 'stop' }))
  })
  return Prec.highest(keymap.of(bindings))
}

/** A new editor state for the active tab. `expandedThinking` is the set of
 *  open thinking panels to keep; without it, all start closed. */
function buildState(expandedThinking: ReadonlySet<string> = new Set()): EditorState {
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
    ]),
  )
  // Listed after autocompleteKeymap at the same precedence, so an open prompt
  // autocomplete takes Esc first. Returns false while find is closed so
  // multi-cursor Esc and selection collapse still run. While a modal is open,
  // Esc must close only the modal: the event still bubbles to the global
  // handler (CM does not stop it), which closes the modal, and returning true
  // keeps the default Esc binding from collapsing the current match.
  const findKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Escape',
        run: () => {
          if (!findState.open) return false
          if (!isModalOpen()) sbp('dez.editor/closeFind')
          return true
        },
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
  // Fixed cursor moves and deletes: the Linux line navigation, and the keys
  // that know about the section separators and the prompt pills.
  const sectionKeymap = Prec.high(
    keymap.of([
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
        run: (v) => mergeWithPreviousSection(v) || strictMultiCursorBackspace(v),
      },
      {
        key: 'Delete',
        run: mergeWithNextSection,
      },
    ]),
  )

  return EditorState.create({
    doc: buildInitialDoc(sections),
    extensions: [
      sectionsField.init(() => models),
      modelDisplayNamesField.init(() => modelDisplayNames.value),
      streamingSectionField.init(() => activeTabStreamingSectionId.value),
      pillsField.init(() => pillMeta),
      thinkingExpandedField.init(() => expandedThinking),
      roleSeparators,
      roleSeparatorAtomicRanges,
      roleSeparatorMouseHandler,
      promptPills,
      promptAtomicRanges,
      promptPillMouseHandler,
      focusKeepingScrollOnMouseDown,
      unwrapBrokenPills,
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      history(),
      autocompleteKeymap,
      findKeymap,
      editorShortcuts.of(editorShortcutKeymap()),
      selectionKeymap,
      sectionKeymap,
      keymap.of([...defaultKeymap, ...fixedHistoryKeymap]),
      EditorView.lineWrapping,
      dezLanguageSupport(),
      dezTheme,
      findExtension(activeFindQuery()),
      markdownTables(),
      // The find dropdown floats over the top of the scroller. Count it as
      // hidden space so matches (and anything else CM scrolls to) are not
      // scrolled under it.
      EditorView.scrollMargins.of(() => {
        const dropdown = findDropdownRef.value?.$el as HTMLElement | undefined
        return dropdown ? { top: dropdown.offsetTop + dropdown.offsetHeight } : null
      }),
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
        const findQuery = update.state.field(findQueryField)
        if (findQuery !== update.startState.field(findQueryField) || (findQuery && update.selectionSet)) {
          refreshFindStatus()
        } else if (findQuery && update.docChanged) {
          refreshFindStatusThrottled()
          refreshFindStatusDebounced()
        }
        // Typing in the find field searches from where the user last put the
        // selection; find's own selections ('select.search') keep the origin.
        if (findQuery && update.transactions.some((tr) => tr.selection && !tr.isUserEvent('select.search'))) {
          findState.origin = update.state.selection.main.from
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
  viewTabId = activeTabId.value
  viewConversationId = activeConversationId.value
  registerActiveView()
}

function scrollViewToBottomAfterLayout(v: EditorView) {
  requestAnimationFrame(() => {
    if (view !== v) return
    v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight
  })
}

// `streamEnd` is set for the rebuild at the end of a stream. It puts the
// caret at the doc end, then scrolls to the bottom when the view still
// followed the stream, or keeps the scroll position that the user chose.
function resetViewToActiveTab(streamEnd?: { followBottom: boolean }) {
  if (!view) return
  // The autocomplete range points into the old doc; accepting it after the
  // swap would insert a pill at a wrong position.
  closeAutocomplete()
  // A rebuild of the same tab, such as the reset at the end of each
  // stream, keeps the open thinking panels; another tab starts with all
  // closed.
  const sameTab = viewTabId === activeTabId.value
  // The new state has no line heights yet, so its scrollTop would show
  // other lines. The snapshot holds the top line and its offset instead.
  const scrollSnapshot = streamEnd && !streamEnd.followBottom ? view.scrollSnapshot() : null
  const state = buildState(sameTab ? view.state.field(thinkingExpandedField) : undefined)
  view.setState(state)
  viewTabId = activeTabId.value
  viewConversationId = activeConversationId.value
  const place = sameTab ? undefined : viewPlaces.get(viewConversationId)
  if (streamEnd) {
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      ...(scrollSnapshot && { effects: scrollSnapshot }),
      userEvent: 'select',
    })
    if (streamEnd.followBottom) scrollViewToBottomAfterLayout(view)
  } else if (place) {
    // The update listener also does the find bookkeeping for this
    // selection.
    view.dispatch({
      selection: selectionWithin(place.selection, view.state.doc.length),
      effects: place.scroll,
      userEvent: 'select',
    })
  } else if (findState.open) {
    // setState runs no update listeners, so redo the find bookkeeping that
    // the listener does for the dispatches above.
    findState.origin = view.state.selection.main.from
    refreshFindStatus()
  }
}

function onEditorStreamFinished(tabId: string, followBottom: boolean) {
  if (tabId !== activeTabId.value) return
  nextTick(() => resetViewToActiveTab({ followBottom }))
}

function syncViewStructureToStoreSections() {
  if (!view) return
  const models = initialSectionModels(activeSections.value)
  const current = view.state.field(sectionsField)
  if (sectionModelsEqual(current, models)) return
  // The store has fewer sections than the view only right before a rebuild
  // of the whole view state from the store, in the same microtask run, so no
  // input event comes between: a failed or stopped stream removed its empty
  // agent section (the stream-end rebuild follows), or the active tab changed.
  // Until then the view keeps the models that match its doc; fewer models
  // would leave a separator without one.
  if (models.length < current.length) return
  syncingViewStructure = true
  try {
    if (models.length > current.length) {
      const insert = Array.from({ length: models.length - current.length }, () => `\n${SECTION_SEP}\n`).join('')
      // No scroll: a view that follows a stream scrolls to the new bottom
      // in the next frame, and any other view stays where the user put it.
      view.dispatch({
        changes: { from: view.state.doc.length, insert },
        effects: setSectionsEffect.of(models),
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
  refreshFindStatusDebounced.clear()
  view?.destroy()
  view = null
})

// Rebuild state when the active tab changes — the CM doc is per-tab.
watch(
  () => activeTabId.value,
  (_newId, oldId) => {
    if (oldId) {
      rememberViewPlace()
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

// Model names on agent pills follow provider renames and model-list
// refreshes.
watch(
  () => modelDisplayNames.value,
  (names) => {
    if (view) view.dispatch({ effects: setModelDisplayNamesEffect.of(names) })
  },
)

// The agent pill of the streaming response shows a "generating" state while
// the stream runs. `buildState` seeds the same value, so a state rebuilt on
// a tab switch or at the end of a stream shows the right pill at once.
watch(
  () => activeTabStreamingSectionId.value,
  (sectionId) => {
    if (view) view.dispatch({ effects: setStreamingSectionEffect.of(sectionId) })
  },
)

// A font size change (`dez.ui/applyEditorFontSize` sets the CSS variable in
// the same tick) resizes every line, but CodeMirror sees no change of the
// doc or of the editor's size, so it would keep the old line heights.
watch(
  () => settings.value.editorFontSize,
  () => {
    if (view) measureTextSize(view)
  },
)

// A shortcut key change applies to the live view at once; `buildState`
// reads the current keys for the next tab.
watch(shortcuts, () => {
  if (view) view.dispatch({ effects: editorShortcuts.reconfigure(editorShortcutKeymap()) })
})

// Search as the user types: install the query, which drives the match
// marks, and select the first match at or after `findState.origin`. With no
// match the selection stays where it is. Closing is handled by
// `dez.editor/closeFind`. The getter tracks every `findState` field that
// the query reads and returns a new query each run, so any query input
// change re-runs this.
watch(activeFindQuery, (query) => {
  if (!view || !query) return
  const { state } = view
  const match = query.valid ? findNextMatch(state, query, Math.min(findState.origin, state.doc.length)) : null
  if (!match) {
    view.dispatch({ effects: setFindQueryEffect.of(query) })
    return
  }
  view.dispatch(selectMatchSpec(match, [setFindQueryEffect.of(query)]))
})

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
    <FindDropdown v-if="findState.open" ref="findDropdownRef" />
    <PromptAutocomplete
      v-if="autocompleteOpen && matchingPrompts.length > 0"
      :prompts="matchingPrompts"
      :selected-index="autocompleteSelectedIndex"
      :x="autocompleteX"
      :y="autocompleteY"
      @select="acceptPrompt"
      @hover="autocompleteSelectedIndex = $event"
    />
    <div v-if="showBusyIndicator" class="busy-indicator">
      <span class="busy-dot" />
      <span class="busy-dot" />
      <span class="busy-dot" />
    </div>
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

/* Its dots line up with the text's left edge: the side padding is the
   editor scroller's (`TEXT_GUTTER` in cmEditor.ts). */
.busy-indicator {
  display: flex;
  gap: 4px;
  padding: 8px v-bind(TEXT_GUTTER);
  width: 100%;
  box-sizing: border-box;
}

.busy-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--color-text);
  opacity: 0.4;
  animation: busy-pulse 1.4s ease-in-out infinite;
}

.busy-dot:nth-child(2) { animation-delay: 0.2s; }
.busy-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes busy-pulse {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 0.6; transform: scale(1); }
}
</style>
