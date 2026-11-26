<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { Compartment, EditorSelection, EditorState, Prec, type Extension, type SelectionRange } from '@codemirror/state'
import { EditorView, drawSelection, keymap, tooltips, type BlockInfo, type Command, type KeyBinding } from '@codemirror/view'
import { copyLineDown, copyLineUp, deleteLine, history, historyKeymap, defaultKeymap, redo, selectAll, undo } from '@codemirror/commands'
import sbp from '@sbp/sbp'
import { useModelState, type Prompt } from '../modelState'
import { sameModelRef } from '../../model/chat/modelRef'
import type { TabCostNumbers } from '../../model/chat/conversationCost'
import { sameThinking } from '../../model/chat/thinking'
import type { ShortcutIdOfScope } from '../../model/shortcuts'
import type { LiveTimes } from '../../model/streams/types'
import { debounce, throttle } from 'turtledash'
import PromptAutocomplete from './PromptAutocomplete.vue'
import FindDropdown from './FindDropdown.vue'
import {
  AT_BOTTOM_PX,
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
  toggleSectionRoleEffect,
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
import { deleteImageBang, deleteImageParen, markdownImages } from '../editor/images'
import { markdownToolCalls, openToolCalls } from '../editor/toolCalls'
import { liveTimesSource } from '../editor/liveTimes'
import { markdownMedia } from '../editor/media'
import { carriedAppRuns, markdownApps, syncAppFrames, type CarriedAppRun } from '../editor/apps'
import { removeAppFrames } from '../apps/appFrameHost'
import { caretAfterCompactionBlock, compactionBlockRules } from '../editor/compaction'
import { compactionChip, openCompactionChips, type CompactionChipsOpen } from '../editor/compactionChip'
import { deleteLineBlockBackward, deleteLineBlockForward, joinsLineBlock } from '../editor/lineBlocks'
import { revealHiddenLineBackward, revealHiddenLineForward } from '../editor/hiddenAssets'
import { deleteLines, duplicateLines, outsideAtoms, viewAtoms } from '../editor/lineCommands'
import { filePasteAndDrop } from '../editor/imageInsert'
import { markdownLinks } from '../editor/links'
import { mentionChips } from '../editor/mentions'
import { pasteMentions, recordCopy } from '../editor/mentionPaste'
import { focusKeepingScrollOnMouseDown } from '../editor/focus'
import { activeFindQuery, findState } from '../editor/findState'
import { applyCostChanges, costReset, tabCostSource } from '../editor/costReset'
import { isModalOpen } from '../composables/useKeyboardShortcuts'
import { putViewTop, readViewPlace, showViewPlace } from '../editor/viewPlace'
import type { StoredViewPlace } from '../../model/persistence/types'

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
// The tab whose content the view's state holds. Right after a tab switch it
// is still the old tab for a tick, until the `activeTabId` watcher rebuilds
// the view from the store. So the view writes back only to this tab, and
// takes section models only from it.
let viewTabId: string | null = null
// The conversation of that tab.
let viewConversationId: string | null = null
let pendingPersistTabId: string | null = null
let syncingViewStructure = false

// Where the view was in each conversation that it left in this session, so
// that it shows the same place on a return: a tab switch, File › Reopen
// Closed Tab (the reopened tab has a new tab id but the same conversation
// id), or History. A conversation with no place here can have the stored
// place of the last session (`reportViewPlace`); else it starts at the top
// (`resetViewToActiveTab`). The selection comes back too: a caret left at
// the doc start would scroll the view back up at the first key press.
// The restore scrolls the view as a user scroll does, on purpose: a place
// at the very bottom of a tab whose reply still streams starts the stream
// follow again (`handleVisibleScroll` in `src/view/editor/selectors.ts`).
interface ViewPlace {
  scroll: ReturnType<EditorView['scrollSnapshot']>
  selection: EditorSelection
}
const viewPlaces = new Map<string, ViewPlace>()

// Tells the model where the view of its tab is, so that the next start of
// Dez shows that place (`app_state.json`, `src/view/editor/viewPlace.ts`).
// No code of Dez runs at a quit, so the place is saved while the user
// works, after the view stops for 500 ms (the time of the window tracker,
// `src/controller/window.ts`): a scroll in the last half second before a
// quit can be lost. `viewTabId`, not the active tab: the view holds the
// old tab for a tick after a switch.
const reportViewPlace = debounce(() => {
  if (!view || !viewTabId || !viewConversationId) return
  sbp('dez.model/viewPlace/set', pendingViewPlace ?? readViewPlace(view, viewConversationId))
}, 500)

// The stored place that the start of Dez showed (within the doc), until
// the user moves the view. After the show, an image or a player gets its
// height when it loads, the editor font loads, and the parts of the window
// around the editor get their sizes. Such a change can leave the view off
// its place: a top edge inside a block that grows, or a place near the doc
// end that a view of another height could not reach. CodeMirror's scroll
// anchor then keeps the wrong place. So each change of the heights or of
// the editor size puts the view at the place again (the update listener).
// A doc change, a new selection, each rebuild, and the first input of the
// user in the editor end it (`mountView`). While it is set, it is the
// place that a report gives.
let pendingViewPlace: StoredViewPlace | null = null

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
  // A line block (a tool call chip, a media player) at the join keeps its
  // own line. The caret stays before the text that it was before.
  const lineBreak = joinsLineBlock(state, target.to, currentLine.from) ? '\n' : ''
  v.dispatch({
    changes: { from: target.to, to: currentLine.from, insert: lineBreak },
    selection: { anchor: target.to + lineBreak.length },
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
  // A line block at the join keeps its own line.
  v.dispatch({
    changes: { from: currentLine.to, to: target.from, insert: joinsLineBlock(state, currentLine.to, target.from) ? '\n' : '' },
    selection: { anchor: currentLine.to },
    effects: mergeSectionEffect.of({ removeIndex }),
    scrollIntoView: true,
    userEvent: 'delete.forward',
  })
  return true
}

/** Selects `caret`, moved out of any widget that a caret cannot be inside
 *  (`outsideAtoms`): a dispatch, unlike CodeMirror's own commands, does
 *  not skip atomic ranges. */
function selectCaret(v: EditorView, caret: SelectionRange): boolean {
  const head = outsideAtoms(v.state.doc, viewAtoms(v), caret.head)
  v.dispatch({
    selection: EditorSelection.create([head === caret.head ? caret : EditorSelection.cursor(head, 0, undefined, caret.goalColumn)]),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/** A caret on the first (`forward`) or last visual row of the row line
 *  `row`, at the x of the caret `range`: its goal column during a run of
 *  presses, else its own x, read as CodeMirror's `moveVertically` reads
 *  it. The result keeps that goal column, so the next press keeps the x
 *  too. Null when the view has no coordinates for it (a place out of the
 *  viewport), or gives a place off the row (a line of no height). */
function caretOnRowAtGoal(v: EditorView, range: SelectionRange, row: BlockInfo, forward: boolean): SelectionRange | null {
  const contentLeft = v.contentDOM.getBoundingClientRect().left
  let goal = range.goalColumn
  if (goal === undefined) {
    const caret = v.coordsAtPos(range.head, range.assoc || (forward ? 1 : -1))
    if (!caret) return null
    goal = caret.left - contentLeft
  }
  const rowCoords = forward ? v.coordsAtPos(row.from, 1) : v.coordsAtPos(row.to, -1)
  if (!rowCoords) return null
  const target = v.posAndSideAtCoords({ x: contentLeft + goal, y: (rowCoords.top + rowCoords.bottom) / 2 }, false)
  if (target.pos < row.from || target.pos > row.to) return null
  return EditorSelection.cursor(target.pos, target.assoc, undefined, goal)
}

/** Up and Down. They move by row lines, the lines that the user sees
 *  (`lineBlockAt`): a tool chip is one row line, however many doc lines
 *  its block has, so a key never walks the hidden text of a chip. A key
 *  moves one visual row inside the caret's row line first, as
 *  CodeMirror's own move does, so a wrapped line next to a role pill is
 *  walked row by row. With no row left there, it goes to the next row
 *  line of the section, or across the role pill to the nearest row of the
 *  row line on the other side (its last row going up, its first going
 *  down) at the caret's x; CodeMirror's own move would stop on the pill's
 *  line. A line of no height (a blank line between two chips, the line of
 *  a hidden asset) is a row line too: CodeMirror's move skips it, so the
 *  key puts the caret on it, where it shows (`collapsedLines`,
 *  toolCalls.ts). At the doc edges it goes to the row line's start or
 *  end. A selection collapses first. */
function moveCaretByRow(v: EditorView, forward: boolean): boolean {
  const { state } = v
  const { doc } = state
  const range = state.selection.main
  if (!range.empty) return selectCaret(v, EditorSelection.cursor(forward ? range.to : range.from))

  const row = v.lineBlockAt(range.head)
  // A place on the next row line, past the line break between the two.
  const beyond = forward ? row.to + 1 : row.from - 1
  const beyondLine = beyond >= 0 && beyond <= doc.length ? doc.lineAt(beyond) : null
  const adjacentRow = beyondLine && beyondLine.text !== SECTION_SEP ? v.lineBlockAt(beyond) : null
  const moved = v.moveVertically(range, forward)
  const movedRow = v.lineBlockAt(moved.head)
  const movedOn = forward ? moved.head > range.head : moved.head < range.head
  if (movedOn && (movedRow.from === row.from || movedRow.from === adjacentRow?.from)) return selectCaret(v, moved)

  const column = range.head - doc.lineAt(range.head).from
  const caretAtColumn = (target: BlockInfo) => EditorSelection.cursor(target.from + Math.min(column, target.length))
  if (adjacentRow) return selectCaret(v, caretOnRowAtGoal(v, range, adjacentRow, forward) ?? caretAtColumn(adjacentRow))
  const rowLine = doc.lineAt(forward ? row.to : row.from).number
  const otherSectionLine = forward
    ? firstEditableLineOfNextSection(state, rowLine)
    : lastEditableLineOfPreviousSection(state, rowLine)
  if (!otherSectionLine) return selectCaret(v, EditorSelection.cursor(forward ? row.to : row.from))
  const otherRow = v.lineBlockAt(otherSectionLine.from)
  return selectCaret(v, caretOnRowAtGoal(v, range, otherRow, forward) ?? caretAtColumn(otherRow))
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

// Writes the view's doc back into the sections of `viewTabId`, with the ids,
// roles and data of `sectionsField`. Never into `activeTabId`: right after a
// tab switch, that is a tab whose doc the view does not hold.
function syncDocToStore(persist = false) {
  if (!view || !viewTabId) return
  const tab = sbp('dez.model/tab', viewTabId)
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
  sbp('dez.model/tabs/replaceSections', viewTabId, sections)
  if (persist) schedulePersistTab(viewTabId)
}

// Writes the view's doc back into `viewTabId` and saves that tab now: the
// view is about to drop its doc (tab switch, unmount).
function saveViewTabNow() {
  syncDocToStore()
  flushPendingPersist()
  if (viewTabId) persistTab(viewTabId)
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
    userEvent: 'input.complete',
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
  recordCopy(v.state, text, viewConversationId)
  if (cut) {
    const transaction = cutSelectedRangesTransaction(v.state)
    if (transaction) v.dispatch(v.state.update(transaction))
  }
  return true
}

function pasteClipboardText(event: ClipboardEvent, v: EditorView): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!text) return false
  event.preventDefault()
  if (!pasteMentions(v, text, viewConversationId)) v.dispatch(clipboardPasteTransaction(v.state, text))
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
      userEvent: 'input',
    })
    return true
  },
  addCursorAbove: (v) => addDocumentLineCursor(v, false),
  addCursorBelow: (v) => addDocumentLineCursor(v, true),
  undo,
  redo,
  selectAll,
  deleteLine: deleteLines,
  duplicateLine: duplicateLines,
}

// Undo and Redo are editable shortcuts, so they leave `historyKeymap`. Its
// selection undo and redo (Mod-u, Alt-u) stay fixed.
const fixedHistoryKeymap = historyKeymap.filter((binding) => binding.run !== undo && binding.run !== redo)

// CodeMirror's own line keys (Shift-Mod-k deletes a line, Shift-Alt-ArrowUp
// and Shift-Alt-ArrowDown copy one) do not know sections, pills, or line
// blocks; Delete Line and Duplicate Line take their place.
const lineSafeDefaultKeymap = defaultKeymap.filter((binding) =>
  binding.run !== deleteLine && binding.run !== copyLineUp && binding.run !== copyLineDown)

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

/** What a new editor state keeps of the state before it: the open panels
 *  (without them, all start closed), and the apps that run (without them,
 *  each app stops). `thinking` holds section ids, `toolCalls` call ids, and
 *  `compaction` tells which panels of the compaction chips are open. */
interface CarriedState {
  thinking: ReadonlySet<string>
  toolCalls: ReadonlySet<string>
  compaction: CompactionChipsOpen
  appRuns: readonly CarriedAppRun[]
}

/** A new editor state for the active tab, with what `carried` keeps of the
 *  state before it. Its caret is at the first place for text: the doc
 *  start, or the place after the compaction block of a compaction section
 *  (the rule of `compactionBlockRules` applies only to a transaction). */
function buildState(carried?: CarriedState): EditorState {
  const sections = activeSections.value
  const models = initialSectionModels(sections)
  const pillMeta = initialPillMetadata(sections)
  // The tab that this state shows, for good: `viewTabId` can name another
  // tab for a tick after a switch.
  const stateTabId = activeTabId.value
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
  // that know about the section separators, the prompt pills, and the
  // images. It runs before the markdown and default keymaps.
  const sectionKeymap = Prec.high(
    keymap.of([
      ...linuxLineNavigationKeymap(),
      {
        key: 'ArrowUp',
        preventDefault: true,
        run: (v) => moveCaretByRow(v, false),
      },
      {
        key: 'ArrowDown',
        preventDefault: true,
        run: (v) => moveCaretByRow(v, true),
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
      // A key next to the line of a hidden asset first shows that line
      // (`revealHiddenLineBackward`), before a rule that deletes.
      {
        key: 'Backspace',
        run: (v) => mergeWithPreviousSection(v)
          || revealHiddenLineBackward(v)
          || deleteLineBlockBackward(v)
          || deleteImageParen(v)
          || strictMultiCursorBackspace(v),
      },
      {
        key: 'Delete',
        run: (v) => revealHiddenLineForward(v) || deleteImageBang(v) || deleteLineBlockForward(v) || mergeWithNextSection(v),
      },
    ]),
  )

  const state = EditorState.create({
    doc: buildInitialDoc(sections),
    extensions: [
      sectionsField.init(() => models),
      modelDisplayNamesField.init(() => modelDisplayNames.value),
      streamingSectionField.init(() => activeTabStreamingSectionId.value),
      liveTimesSource.of(() => sbp('dez.model/streams/liveTimes', stateTabId) as LiveTimes | null),
      tabCostSource.of(() => sbp('dez.model/tabs/costNumbers', stateTabId) as TabCostNumbers),
      pillsField.init(() => pillMeta),
      thinkingExpandedField.init(() => carried?.thinking ?? new Set()),
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
      costReset(),
      autocompleteKeymap,
      findKeymap,
      editorShortcuts.of(editorShortcutKeymap()),
      selectionKeymap,
      sectionKeymap,
      keymap.of([...lineSafeDefaultKeymap, ...fixedHistoryKeymap]),
      EditorView.lineWrapping,
      dezLanguageSupport(),
      dezTheme,
      // Tooltips (link URLs, image overlay items) stay across the text
      // column (`contentDOM`) and a little in from the scroller's top and
      // bottom. CM's default space is the whole window, where a tooltip can
      // touch the window's side, cover the scrollbar, or go up under the tab
      // bar, which hides its top (a tooltip above an image on the first
      // line). With no room above, CM shows it below its item.
      tooltips({
        tooltipSpace: (v) => {
          const { left, right } = v.contentDOM.getBoundingClientRect()
          const { top, bottom } = v.scrollDOM.getBoundingClientRect()
          const gap = 8
          return { left, right, top: top + gap, bottom: bottom - gap }
        },
      }),
      findExtension(activeFindQuery()),
      markdownTables(),
      markdownImages(),
      markdownToolCalls(carried?.toolCalls),
      markdownMedia(),
      markdownApps(carried?.appRuns),
      compactionBlockRules(),
      compactionChip(carried?.compaction),
      markdownLinks(),
      mentionChips(),
      filePasteAndDrop(),
      // The find dropdown floats over the top of the scroller. Count it as
      // hidden space so matches (and anything else CM scrolls to) are not
      // scrolled under it.
      EditorView.scrollMargins.of(() => {
        const dropdown = findDropdownRef.value?.$el as HTMLElement | undefined
        return dropdown ? { top: dropdown.offsetTop + dropdown.offsetHeight } : null
      }),
      EditorView.updateListener.of((update) => {
        // A role toggle changes no doc text, but the store and the
        // conversation file need the new role: else the next store-to-view
        // sync puts the old role back.
        const roleToggled = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(toggleSectionRoleEffect)) &&
          tr.state.field(sectionsField) !== tr.startState.field(sectionsField),
        )
        if ((update.docChanged || roleToggled) && !syncingViewStructure) {
          // Before the sync, whose save then holds the new numbers. The
          // view's own tab: the active tab can be another one for a tick
          // after a switch.
          if (viewTabId) applyCostChanges(viewTabId, update.transactions)
          syncDocToStore(true)
        }
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          updatePromptAutocomplete(update.view)
        }
        if (update.docChanged || update.selectionSet) {
          pendingViewPlace = null
          // A change above the top line moves the place with no scroll event.
          reportViewPlace()
        } else if (pendingViewPlace && update.geometryChanged) {
          putViewTop(update.view, pendingViewPlace)
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
          // A quit through a menu takes the focus first.
          reportViewPlace.flush()
          closeAutocomplete()
          return false
        },
      }),
    ],
  })
  const caret = caretAfterCompactionBlock(state.doc)
  return caret === null ? state : state.update({ selection: { anchor: caret } }).state
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
  // `load` and `loadedmetadata` do not bubble, so the scroller hears the
  // loads of its images and videos in the capture phase.
  view.scrollDOM.addEventListener('load', onScrollerLateLoad, true)
  view.scrollDOM.addEventListener('loadedmetadata', onScrollerLateLoad, true)
  view.scrollDOM.addEventListener('scroll', checkScrollUp)
  view.scrollDOM.addEventListener('scroll', () => reportViewPlace())
  // Only the user moves the view with these. The scroll events cannot tell
  // a move of the user: the writes of Dez and CodeMirror's scroll anchor
  // send them too. A press on the scroll bar is a `pointerdown` of the
  // scroller.
  for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
    view.dom.addEventListener(type, () => { pendingViewPlace = null }, { capture: true, passive: true })
  }
  registerActiveView()
}

// After a reply that the view followed to its end, the rebuild scrolls the
// view to its bottom, often before the reply's new image has loaded: the
// image has no size yet, so its line is short. The load makes the line
// taller, and CodeMirror then keeps the top line in place: it keeps the
// bottom only when the view is at its bottom when it measures, and the
// image moved the bottom before that. So while this is set, each image
// load in the view scrolls to the bottom again. A scroll up by the user
// and every other rebuild end it. A video is the same: its player gets the
// video's height when the metadata loads (`MediaPlayer.vue`).
// `tests/e2e/image-generation.e2e.ts` covers this for an image.
let keepBottomOnLateLoad = false
// The scroller's scrollTop at the last `checkScrollUp`.
let lastScrollerTop = 0
const KEEP_BOTTOM_MEASURE_KEY = 'dez-keep-bottom-on-late-load'
// The frame of `scrollViewToBottomAfterLayout`. Every rebuild cancels it:
// a tab change keeps the same view, so a frame that comes after one would
// scroll the next tab to its bottom.
let bottomScrollFrame = 0

function onScrollerLateLoad(event: Event) {
  if (!view || !(event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement)) return
  checkScrollUp()
  if (!keepBottomOnLateLoad) return
  // The line gets its new height after this handler: from the image's own
  // load handler (`images.ts`), or when Vue draws the player again. Both
  // come before CodeMirror's next measure. The write runs after the read
  // phase of that measure, so CodeMirror's scroll anchoring does not undo
  // it.
  view.requestMeasure({
    key: KEEP_BOTTOM_MEASURE_KEY,
    read: () => {
      checkScrollUp()
      return keepBottomOnLateLoad
    },
    write: (keepBottom, v) => {
      if (keepBottom) v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight
    },
  })
}

// Ends `keepBottomOnLateLoad` after a scroll up by the user. Only the user
// moves the view up while it is not at its bottom (see `handleVisibleScroll`
// in `editor/selectors.ts`), and a taller doc does not move it, so a growing
// image does not end it. This runs on scroll events, and at once before a
// late load scrolls: a scroll and a load can come before the scroll event.
function checkScrollUp() {
  if (!view) return
  const scroll = view.scrollDOM
  const movedUp = scroll.scrollTop < lastScrollerTop
  lastScrollerTop = scroll.scrollTop
  if (movedUp && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > AT_BOTTOM_PX) {
    keepBottomOnLateLoad = false
  }
}

function scrollViewToBottomAfterLayout(v: EditorView) {
  bottomScrollFrame = requestAnimationFrame(() => {
    if (view !== v) return
    v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight
    // Set here, not before the frame: scroll events of the rebuild come
    // before this frame and could end it at once.
    lastScrollerTop = v.scrollDOM.scrollTop
    keepBottomOnLateLoad = true
  })
}

// `streamEnd` is set for the rebuild at the end of a stream, and for the
// rebuild after a compaction of a reply that runs. It puts the caret at
// the doc end, then scrolls to the bottom when the view still followed the
// stream, or keeps the scroll position that the user chose.
function resetViewToActiveTab(streamEnd?: { followBottom: boolean }) {
  if (!view) return
  // The autocomplete range points into the old doc; accepting it after the
  // swap would insert a pill at a wrong position.
  closeAutocomplete()
  keepBottomOnLateLoad = false
  pendingViewPlace = null
  cancelAnimationFrame(bottomScrollFrame)
  // A rebuild of the same tab, such as the reset at the end of each
  // stream, keeps the open thinking, tool call, and compaction panels, and
  // the apps that run; another tab starts with all closed, and its apps do
  // not run.
  const sameTab = viewTabId === activeTabId.value
  // The new state has no line heights yet, so its scrollTop would show
  // other lines. The snapshot holds the top line and its offset instead.
  const scrollSnapshot = streamEnd && !streamEnd.followBottom ? view.scrollSnapshot() : null
  const state = buildState(sameTab
    ? { thinking: view.state.field(thinkingExpandedField), toolCalls: openToolCalls(view.state), compaction: openCompactionChips(view.state), appRuns: carriedAppRuns(view.state) }
    : undefined)
  view.setState(state)
  // setState runs no update listeners, so the frames of the apps would
  // stay as the state before had them: the frame of an app that does not
  // run in the new state goes now, and each frame that stays gets its
  // place in the new text.
  syncAppFrames(view)
  viewTabId = activeTabId.value
  viewConversationId = activeConversationId.value
  const place = sameTab ? undefined : viewPlaces.get(viewConversationId)
  const storedPlace = sameTab || place ? null : sbp('dez.model/viewPlace/get', viewConversationId) as StoredViewPlace | null
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
  } else if (storedPlace) {
    // The place of the last session, at the start of Dez. Its dispatch
    // also runs the find bookkeeping of the update listener.
    pendingViewPlace = showViewPlace(view, storedPlace)
  } else {
    // CodeMirror's setState keeps the scroller's scrollTop, so another tab
    // with no saved place (a new tab, or a conversation not shown yet in
    // this session) would open at the scroll of the tab before it. It
    // starts at the top, where its caret (the doc start) is.
    if (!sameTab) view.scrollDOM.scrollTop = 0
    if (findState.open) {
      // setState runs no update listeners, so redo the find bookkeeping
      // that the listener does for the dispatches above.
      findState.origin = view.state.selection.main.from
      refreshFindStatus()
    }
  }
  // The view now holds another doc, or another place in it: without a
  // report, the stored place would stay that of the tab before.
  reportViewPlace()
}

function onEditorStreamFinished(tabId: string, followBottom: boolean) {
  if (tabId !== activeTabId.value) return
  nextTick(() => resetViewToActiveTab({ followBottom }))
}

// A compaction put new sections in the place of the sections of `tabId`
// while its reply runs (`dez.editor/rebuildIfVisible`). The view drops its
// doc in this tick, with no `nextTick`: the doc is the old text, and each
// write of it into the store would undo the compaction (a doc change, or
// the structure sync below, which would add separators for the new
// sections to the old doc). The new state has no undo history, so no undo
// brings the old text back: compactionFiles.ts deletes files of that text
// at once because of this.
function onEditorRebuild(tabId: string, followBottom: boolean) {
  if (tabId !== viewTabId) return
  if (tabId === activeTabId.value) {
    resetViewToActiveTab({ followBottom })
    return
  }
  // Right after a tab switch the view still holds the doc of `tabId`, and
  // the `activeTabId` watcher is about to write it back (`saveViewTabNow`).
  // So the view holds no tab until the rebuild of that watcher.
  viewTabId = null
  viewConversationId = null
}

function syncViewStructureToStoreSections() {
  // Right after a tab switch the view still holds the old tab's doc. The
  // active tab's models do not belong to it: with them, the next write-back
  // would give the old tab the other tab's section ids, roles, models and
  // thinking, and extra empty sections. A switch that also adds a tab
  // (History, Reopen Closed Tab, New Tab) runs this watcher before the
  // `activeTabId` watcher. The rebuild a tick later reads the store anyway.
  if (!view || viewTabId !== activeTabId.value) return
  const models = initialSectionModels(activeSections.value)
  const current = view.state.field(sectionsField)
  if (sectionModelsEqual(current, models)) return
  // The store has fewer sections than the view only right before a rebuild
  // of the whole view state from the store, in the same microtask run, so no
  // input event comes between: a failed or stopped stream removed its empty
  // agent section (the stream-end rebuild follows). Until then the view
  // keeps the models that match its doc; fewer models would leave a
  // separator without one.
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
  sbp('okTurtles.events/on', 'dez.editor.rebuild', onEditorRebuild)
})

onBeforeUnmount(() => {
  saveViewTabNow()
  unregisterActiveView()
  sbp('okTurtles.events/off', 'dez.editor.stream-finished', onEditorStreamFinished)
  sbp('okTurtles.events/off', 'dez.editor.rebuild', onEditorRebuild)
  refreshFindStatusDebounced.clear()
  reportViewPlace.clear()
  if (view) removeAppFrames(view)
  view?.destroy()
  view = null
})

// Rebuild state when the active tab changes — the CM doc is per-tab. Until
// the rebuild, the view holds the old tab (`viewTabId`): save it first.
watch(
  () => activeTabId.value,
  (_newId, oldId) => {
    // A report that is still due would read the old doc for the new tab.
    reportViewPlace.clear()
    if (oldId) {
      rememberViewPlace()
      saveViewTabNow()
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
    <!-- The busy sign of the whole reply, as the Stop button: tool rounds,
         job waits, and the wait for open jobs at the end can show no new
         text for minutes. -->
    <div v-if="isActiveTabStreaming" class="busy-indicator">
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
