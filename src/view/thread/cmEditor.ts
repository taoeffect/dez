import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { EditorSelection, EditorState, StateEffect, StateField, findClusterBreak, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import type { ContentNode, ModelRef, Role, Section, SectionThinking } from '../../model/chat/types'
import { modelRefField } from '../../model/chat/modelRef'
import { PILL_MARKER, parsePillMarkerMatch, pillMarkerText } from '../../model/chat/pillMarker'
import { thinkingField } from '../../model/chat/thinking'
import { messagesAsMarkdown, type MarkdownMessage } from '../../model/chat/markdown'
import { SENTINEL_CHAR, normalizeContent, stripLiveSentinels, textNode } from '../../model/chat/content'
import { EDITOR_FONT_SIZE_DEFAULT } from '../../model/editorFontSize'
import { escapeMarkerAttribute, unescapeMarkerAttribute } from '../../utils/markerAttribute'
import { addModelToPill, modelDisplayNamesField, sameModelChip, sectionModelChips, streamingSectionField, type ModelChip } from './modelChip'
import {
  isThinkingPanelEvent,
  renderPillThinking,
  sameThinkingView,
  sectionThinkingView,
  thinkingExpandedField,
  toggleThinkingExpandedEffect,
  type PillThinkingView,
} from './thinkingPill'

/** ASCII Record Separator; never typeable, never on-disk, used in-buffer to
 *  encode a section boundary. The char sits alone on its own line and the
 *  whole line is replaced with a block widget (the role separator pill). */
export const SECTION_SEP = '\u001E'

/** Private-use codepoints that bracket a prompt pill in the buffer:
 *  `PILL_OPEN<id>PILL_BODY<body>PILL_CLOSE`. The whole marker sequence is
 *  replaced with a single atomic widget (collapsed pill in STEP-4).
 *
 *  `PILL_NL` is an in-doc newline escape used inside the body slot. CM's
 *  inline `Decoration.replace` does NOT collapse lines when the replaced
 *  range spans a line break — the widget renders on the first line and the
 *  remaining lines leak through as empty `cm-line`s where the caret gets
 *  stuck. By escaping `\n` → `\u{E003}` inside the body the marker sequence
 *  always stays on a single line, so the atomic replace behaves correctly.
 *  Newlines are restored in `decodeSectionContent` when we sync back to the
 *  store. Only collapsed pills escape newlines: the body of an expanded pill
 *  holds real newlines, so the user edits it as normal lines. */
export const PILL_OPEN = '\u{E000}'
export const PILL_BODY = '\u{E001}'
export const PILL_CLOSE = '\u{E002}'
export const PILL_NL = '\u{E003}'
// `SENTINEL_CHAR` and `stripLiveSentinels` in `src/model/chat/content.ts`
// match these code points and `SECTION_SEP`; change them together.
// All of them live only in the editor doc. Files, clipboard text and titles
// must never hold them: `docToSections`, the clipboard serializers and
// `stripLiveSentinels` keep them out.

/** Lightweight mirror of a Section kept in the CM state. The CM doc is the
 *  source of truth for text; this field just tracks per-section identity
 *  (id), role, the AI model that wrote the section (`model`, absent when
 *  unknown), and its thinking (`thinking`, never doc text). The editor
 *  writes this field back to the store on every doc change
 *  (`syncDocToTab`), so a section field missing here is lost there. A new
 *  per-section field must also go in `initialSectionModels`,
 *  `docToSections`, `sectionModelsEqual` (ThreadEditor.vue) and
 *  `dez.model/thread/sectionsIdentity`, or the store loses it on the first
 *  streamed token. */
export interface SectionModel {
  id: string
  role: Role
  model?: ModelRef
  thinking?: SectionThinking
  generated?: boolean
}

/** Metadata for a prompt pill, keyed by the in-doc pill id. The doc carries
 *  only the pill id + body text; name / promptId / expanded live here. */
export interface PillMetadata {
  promptId: string | null
  name: string
  expanded: boolean
}

export function physicalLineBoundarySelection(state: EditorState, end: boolean): EditorSelection {
  return EditorSelection.create(
    state.selection.ranges.map((range) => {
      const line = state.doc.lineAt(range.head)
      return EditorSelection.cursor(end ? line.to : line.from, end ? -1 : 1, range.bidiLevel ?? undefined)
    }),
    state.selection.mainIndex,
  )
}

export function cursorPhysicalLineStart(view: EditorView): boolean {
  const selection = physicalLineBoundarySelection(view.state, false)
  if (!selection.eq(view.state.selection, true)) {
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' })
  }
  return true
}

export function cursorPhysicalLineEnd(view: EditorView): boolean {
  const selection = physicalLineBoundarySelection(view.state, true)
  if (!selection.eq(view.state.selection, true)) {
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' })
  }
  return true
}

export function strictMultiCursorBackspace(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection
  if (selection.ranges.length <= 1) return false
  if (selection.ranges.some((range) => !range.empty)) return false
  const doc = state.doc.toString()
  const pills = scanPills(doc)
  const targets = new Map(selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head)
    if (range.head <= line.from || line.text === SECTION_SEP) return [range, null] as const
    const target = findClusterBreak(line.text, range.head - line.from, false, true) + line.from
    if (target === range.head) return [range, null] as const
    const deleted = doc.slice(target, range.head)
    const touchesSentinel = deleted.includes(SECTION_SEP) ||
      deleted.includes(PILL_OPEN) ||
      deleted.includes(PILL_BODY) ||
      deleted.includes(PILL_CLOSE) ||
      deleted.includes(PILL_NL)
    const touchesPill = pills.some((pill) => target < pill.to && range.head > pill.from)
    return [range, touchesSentinel || touchesPill ? null : target] as const
  }))
  if (selection.ranges.some((range) => targets.get(range) === null)) return false
  const changes = state.changeByRange((range) => {
    const target = targets.get(range)
    if (target === undefined || target === null) return { range }
    return { changes: { from: target, to: range.head }, range: EditorSelection.cursor(target, -1) }
  })
  if (changes.changes.empty) return false
  view.dispatch(state.update(changes, {
    scrollIntoView: true,
    userEvent: 'delete.backward',
  }))
  return true
}

export function linuxLineNavigationKeymap(): KeyBinding[] {
  return [
    {
      linux: 'Ctrl-a',
      preventDefault: true,
      run: cursorPhysicalLineStart,
    },
    {
      linux: 'Ctrl-e',
      preventDefault: true,
      run: cursorPhysicalLineEnd,
    },
  ]
}

export function keymapHasPlatformBinding(
  bindings: readonly KeyBinding[],
  platform: 'linux' | 'mac' | 'win',
  key: string,
): boolean {
  return bindings.some((binding) => binding[platform] === key)
}

/** The first section is always `user`. It has no separator line in the
 *  doc, so it has no role pill that could toggle it. */
function normalizeSectionModels(models: SectionModel[]): SectionModel[] {
  if (models.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  if (models[0].role === 'user') return models
  const copy = models.slice()
  copy[0] = { ...copy[0], role: 'user' }
  return copy
}

/** Produce `{ id, role, model?, thinking? }` for each section to seed
 *  `sectionsField`. */
export function initialSectionModels(sections: Section[]): SectionModel[] {
  if (sections.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  return normalizeSectionModels(sections.map((s) => ({
    id: s.id,
    role: s.role,
    ...modelRefField(s.model),
    ...thinkingField(s.thinking),
  })))
}

/** Walk all sections and collect the per-pill metadata map to seed
 *  `pillsField`. */
export function initialPillMetadata(sections: Section[]): Map<string, PillMetadata> {
  const m = new Map<string, PillMetadata>()
  for (const s of sections) {
    for (const n of s.content) {
      if (n.kind === 'prompt') {
        m.set(n.id, { promptId: n.promptId, name: n.name, expanded: n.expanded })
      }
    }
  }
  return m
}

/** Encode a single prompt pill as the `OPEN id BODY body CLOSE` marker
 *  sequence. Newlines in `body` are escaped to `PILL_NL` so the marker
 *  sequence always fits on one line (see `PILL_NL` doc). */
export function encodePrompt(id: string, body: string, escapeNewlines = true): string {
  const encodedBody = escapeNewlines ? body.replace(/\n/g, PILL_NL) : body
  return PILL_OPEN + id + PILL_BODY + encodedBody + PILL_CLOSE
}

/** Encode a section's content nodes as a single string: text nodes verbatim,
 *  prompt nodes as marker sequences. */
export function encodeSection(section: Section): string {
  let out = ''
  for (const n of section.content) {
    if (n.kind === 'text') out += n.text
    else out += encodePrompt(n.id, n.body, !n.expanded)
  }
  return out
}

/** Encode `Section[]` as a single string: encoded sections joined with
 *  `\n\u001E\n`. No trailing separator (streaming appends to the end). */
export function sectionsToDoc(sections: Section[]): string {
  if (sections.length === 0) return ''
  return sections.map(encodeSection).join(`\n${SECTION_SEP}\n`)
}

/** Split a doc string into per-section text fragments by `\u001E`. The
 *  separator is always on its own line so we also strip the leading/trailing
 *  newline that frames it. */
export function splitDocBySeparator(doc: string): string[] {
  const parts = doc.split(SECTION_SEP)
  if (parts.length === 1) return parts
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i]
    if (i > 0) p = p.replace(/^[\t ]*\n/, '')
    if (i < parts.length - 1) p = p.replace(/\n[\t ]*$/, '')
    out.push(p)
  }
  return out
}

export interface PillLocation {
  id: string
  from: number
  bodyFrom: number
  bodyTo: number
  to: number
}

/** Index of the `PILL_BODY` that ends the pill header (`PILL_OPEN` + id)
 *  starting at `from`, or -1 when there is no header there. An id never
 *  holds a newline, a section separator, or another open/close marker.
 *  `stripLiveSentinels` in `src/model/chat/content.ts` removes broken
 *  headers with the same rule; the two must agree. */
function pillHeaderBodyIndex(doc: string, from: number): number {
  for (let j = from + 1; j < doc.length; j++) {
    const c = doc[j]
    if (c === PILL_BODY) return j
    if (c === PILL_OPEN || c === PILL_CLOSE || c === '\n' || c === SECTION_SEP) return -1
  }
  return -1
}

/** Scan a string for well-formed prompt marker sequences. Malformed
 *  sequences (missing BODY or CLOSE, empty id, or a nested OPEN) are
 *  skipped so CM never crashes on partial edits; `brokenPillMarkerChanges`
 *  removes what is left of them. A pill never spans a section separator:
 *  `docToSections` decodes each section on its own, so a pill that a
 *  separator split is broken there and must be broken here too. */
export function scanPills(doc: string): PillLocation[] {
  const out: PillLocation[] = []
  let i = 0
  while (i < doc.length) {
    if (doc[i] !== PILL_OPEN) { i++; continue }
    const from = i
    const bodyAt = pillHeaderBodyIndex(doc, from)
    if (bodyAt < 0) { i = from + 1; continue }
    let k = bodyAt + 1
    let closeAt = -1
    while (k < doc.length) {
      const c = doc[k]
      if (c === PILL_OPEN || c === SECTION_SEP) break
      if (c === PILL_CLOSE) { closeAt = k; break }
      k++
    }
    if (closeAt < 0) { i = from + 1; continue }
    const id = doc.slice(from + 1, bodyAt)
    if (id.length === 0) { i = from + 1; continue }
    out.push({
      id,
      from,
      bodyFrom: bodyAt + 1,
      bodyTo: closeAt,
      to: closeAt + 1,
    })
    i = closeAt + 1
  }
  return out
}

/** Changes that unwrap every broken prompt pill in `doc`, sorted by
 *  position. A pill breaks when an edit removes or splits one of its
 *  markers (e.g. Backspace over the hidden close marker of an expanded
 *  pill, Shift+Enter in its body, or a pill nested in its body). Every
 *  marker outside a well-formed pill is removed; an open marker that still
 *  starts a header is removed with its id, so the id never becomes visible
 *  text (it was the source of UUID tab titles). `PILL_NL` outside a pill
 *  becomes a real newline. The body text stays as plain text. Removing all
 *  of them at once cannot pair up new pills: only the markers of the
 *  well-formed pills remain. */
export function brokenPillMarkerChanges(doc: string): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = []
  const pills = scanPills(doc)
  let pillIndex = 0
  let i = 0
  while (i < doc.length) {
    const pill = pills[pillIndex]
    if (pill && i === pill.from) {
      i = pill.to
      pillIndex++
      continue
    }
    const c = doc[i]
    if (c === PILL_OPEN) {
      const bodyAt = pillHeaderBodyIndex(doc, i)
      const to = bodyAt < 0 ? i + 1 : bodyAt + 1
      changes.push({ from: i, to, insert: '' })
      i = to
      continue
    }
    if (c === PILL_BODY || c === PILL_CLOSE) changes.push({ from: i, to: i + 1, insert: '' })
    else if (c === PILL_NL) changes.push({ from: i, to: i + 1, insert: '\n' })
    i++
  }
  return changes
}

/** Decode a section fragment into interleaved text + prompt content nodes.
 *  Metadata (name / promptId / expanded) is looked up in `pillsMeta` by id;
 *  missing metadata degrades to empty name / null promptId / collapsed.
 *  Markers of broken pills never reach a text node: the editor unwraps
 *  broken pills (`unwrapBrokenPills`), and `stripLiveSentinels` removes any
 *  that are left, with their ids. */
function decodeSectionContent(
  fragment: string,
  pillsMeta: Map<string, PillMetadata>,
): ContentNode[] {
  const pills = scanPills(fragment)
  if (pills.length === 0) return normalizeContent([textNode(stripLiveSentinels(fragment))])
  const out: ContentNode[] = []
  let cursor = 0
  for (const p of pills) {
    out.push(textNode(stripLiveSentinels(fragment.slice(cursor, p.from))))
    const meta = pillsMeta.get(p.id)
    out.push({
      kind: 'prompt',
      id: p.id,
      promptId: meta?.promptId ?? null,
      name: meta?.name ?? '',
      body: fragment.slice(p.bodyFrom, p.bodyTo).replace(/\u{E003}/gu, '\n'),
      expanded: meta?.expanded ?? false,
    })
    cursor = p.to
  }
  out.push(textNode(stripLiveSentinels(fragment.slice(cursor))))
  return normalizeContent(out)
}

/** Reconstruct a `Section[]` for the store given the current doc and the
 *  live `SectionModel[]` (for id + role preservation). When the field got
 *  out of sync (e.g. raw deletion of a separator), we truncate / pad with
 *  default user roles to match the fragment count. */
export function docToSections(
  doc: string,
  models: SectionModel[],
  pillsMeta: Map<string, PillMetadata>,
  fallbackModels: SectionModel[] = [],
): Section[] {
  const fragments = splitDocBySeparator(doc)
  const reconciledModels = reconcileSectionModelsToDoc(models, doc, fallbackModels)
  return fragments.map((text, i) => {
    const sectionModel = reconciledModels[i]
    return {
      id: sectionModel.id,
      role: i === 0 ? 'user' : sectionModel.role,
      ...modelRefField(sectionModel.model),
      ...thinkingField(sectionModel.thinking),
      content: decodeSectionContent(text, pillsMeta),
    }
  })
}

/** Count `\u001E` occurrences in a text (used for reconciliation). */
function countSeparators(doc: string): number {
  let n = 0
  for (let i = 0; i < doc.length; i++) if (doc.charCodeAt(i) === 0x1e) n++
  return n
}

function sectionIndexAtOffset(doc: string, pos: number): number {
  let index = 0
  for (let i = 0; i < pos && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 0x1e) index++
  }
  return index
}

export function removedSeparatorModelIndexes(tr: Transaction): number[] {
  const oldDoc = tr.startState.doc.toString()
  const indexes: number[] = []
  tr.changes.iterChanges((fromA, toA) => {
    let removeIndex = sectionIndexAtOffset(oldDoc, fromA) + 1
    for (let i = fromA; i < toA; i++) {
      if (oldDoc.charCodeAt(i) === 0x1e) indexes.push(removeIndex++)
    }
  })
  return indexes
}

/* ──────────────────────────  Effects  ────────────────────────── */

export const toggleRoleEffect = StateEffect.define<{ index: number }>()
export const splitSectionEffect = StateEffect.define<{
  afterIndex: number
  newId?: string
  newRole?: Role
}>()
export const mergeSectionEffect = StateEffect.define<{ removeIndex: number }>()
export const setSectionsEffect = StateEffect.define<SectionModel[]>()
/** Sets the thinking of the section with `sectionId`, or removes it when
 *  `thinking` is absent. Thinking is not doc text, so this changes no doc
 *  text and no section structure. */
export const setSectionThinkingEffect = StateEffect.define<{ sectionId: string; thinking?: SectionThinking }>()

export const setPillsEffect = StateEffect.define<Map<string, PillMetadata>>()
export const updatePillMetaEffect = StateEffect.define<{
  id: string
  patch: Partial<PillMetadata>
}>()
export const togglePillExpandedEffect = StateEffect.define<{ id: string }>()

/* ──────────────────────  sectionsField  ─────────────────────── */

export function reconcileSectionModelsToDoc(
  models: SectionModel[],
  doc: string,
  fallbackModels: SectionModel[] = [],
): SectionModel[] {
  const expected = countSeparators(doc) + 1
  const reconciled: SectionModel[] = []
  for (let i = 0; i < expected; i++) {
    const model = models[i]
    const fallback = fallbackModels[i]
    if (model) {
      reconciled.push(model.generated && fallback && model.id !== fallback.id ? fallback : model)
    } else if (fallback) {
      reconciled.push(fallback)
    } else {
      reconciled.push({ id: crypto.randomUUID(), role: 'user', generated: true })
    }
  }
  return normalizeSectionModels(reconciled)
}

export const sectionsField = StateField.define<SectionModel[]>({
  create: () => [{ id: crypto.randomUUID(), role: 'user' }],
  update(value, tr: Transaction) {
    let next = value
    let sectionModelsManagedByEffect = false
    for (const e of tr.effects) {
      if (e.is(setSectionsEffect)) {
        next = e.value.slice()
        sectionModelsManagedByEffect = true
      } else if (e.is(toggleRoleEffect)) {
        if (e.value.index > 0 && e.value.index < next.length) {
          const copy = next.slice()
          const old = copy[e.value.index]
          copy[e.value.index] = { ...old, role: old.role === 'user' ? 'agent' : 'user' }
          next = copy
        }
      } else if (e.is(splitSectionEffect)) {
        const { afterIndex, newId, newRole } = e.value
        const insertAt = Math.max(0, Math.min(afterIndex + 1, next.length))
        const copy = next.slice()
        copy.splice(insertAt, 0, {
          id: newId ?? crypto.randomUUID(),
          role: newRole ?? 'user',
        })
        next = copy
        sectionModelsManagedByEffect = true
      } else if (e.is(mergeSectionEffect)) {
        const { removeIndex } = e.value
        if (removeIndex > 0 && removeIndex < next.length) {
          const copy = next.slice()
          copy.splice(removeIndex, 1)
          next = copy
        }
        sectionModelsManagedByEffect = true
      } else if (e.is(setSectionThinkingEffect)) {
        const index = next.findIndex((model) => model.id === e.value.sectionId)
        if (index >= 0) {
          const { thinking: _replaced, ...section } = next[index]
          const copy = next.slice()
          // The value is the store's object, a reactive proxy. Keep a plain
          // copy: `structuredClone` refuses proxies.
          copy[index] = { ...section, ...thinkingField(e.value.thinking) }
          next = copy
        }
      }
    }
    if (tr.docChanged) {
      if (!sectionModelsManagedByEffect) {
        const removed = removedSeparatorModelIndexes(tr).sort((a, b) => b - a)
        if (removed.length > 0) {
          const copy = next.slice()
          for (const index of removed) {
            if (index > 0 && index < copy.length) copy.splice(index, 1)
          }
          next = copy
        }
      }
      next = reconcileSectionModelsToDoc(next, tr.newDoc.toString())
    }
    return normalizeSectionModels(next)
  },
})

/* ──────────────────────────  pillsField  ───────────────────── */

/** Pill metadata by in-doc pill id. Entries stay after their pill leaves
 *  the doc, so an undo that brings a pill back also brings back its name
 *  and expanded state (an expanded body holds real newlines, and drawing it
 *  as a collapsed pill breaks the single-line pill decoration). The view
 *  state, and with it this map, is rebuilt from the tab on tab switch. */
export const pillsField = StateField.define<Map<string, PillMetadata>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setPillsEffect)) {
        next = new Map(e.value)
      } else if (e.is(updatePillMetaEffect)) {
        const cur = next.get(e.value.id)
        if (cur) {
          const copy = new Map(next)
          copy.set(e.value.id, { ...cur, ...e.value.patch })
          next = copy
        }
      } else if (e.is(togglePillExpandedEffect)) {
        const cur = next.get(e.value.id)
        if (cur) {
          const copy = new Map(next)
          copy.set(e.value.id, { ...cur, expanded: !cur.expanded })
          next = copy
        }
      }
    }
    return next
  },
})

/** Unwraps the prompt pills that a transaction broke, in that same
 *  transaction, so one undo step restores the pill. Every edit path can
 *  break a pill (Backspace/Delete over a hidden marker, typing over a
 *  selection, paste, Shift+Enter, default keymap commands), so the repair
 *  is a filter and not a check in each key handler. A pill only breaks
 *  when a sentinel is deleted or inserted, so other edits (typing,
 *  streamed tokens) skip the full-doc scan. */
export const unwrapBrokenPills = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  let touchesSentinel = false
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    touchesSentinel ||= SENTINEL_CHAR.test(tr.startState.sliceDoc(fromA, toA)) || SENTINEL_CHAR.test(inserted.toString())
  })
  if (!touchesSentinel) return tr
  const changes = brokenPillMarkerChanges(tr.newDoc.toString())
  return changes.length === 0 ? tr : [tr, { changes, sequential: true }]
})

/* ──────────────────────  Role separator widget  ─────────────── */

class RoleSeparatorWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly role: Role,
    readonly chip: ModelChip | null,
  ) {
    super()
  }
  // Thinking is left out on purpose: see `pillThinkingUpdater`. Every other
  // part that `toDOM` draws must be compared here, or CodeMirror keeps
  // stale pill DOM.
  eq(other: WidgetType): boolean {
    return (
      other instanceof RoleSeparatorWidget &&
      other.index === this.index &&
      other.role === this.role &&
      sameModelChip(other.chip, this.chip)
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'dez-role-separator'
    el.setAttribute('data-section-index', String(this.index))
    el.setAttribute('data-role', this.role)
    const label = document.createElement('span')
    label.className = 'dez-role-separator__label'
    label.textContent = this.role === 'user' ? 'User' : 'Agent'
    el.appendChild(label)
    if (this.chip) addModelToPill(label, this.chip)
    renderPillThinking(el, label, pillThinkingAt(view.state, this.index), view)
    return el
  }
  ignoreEvent(event: Event): boolean {
    // Events in the thinking panel belong to its text field. CodeMirror and
    // `roleSeparatorMouseHandler` leave them alone, so mouse selection,
    // select all and copy work there natively. All other events reach the
    // view, so a mousedown on the pill runs `roleSeparatorMouseHandler`.
    return isThinkingPanelEvent(event)
  }
}

/** The thinking parts of the pill of section `index` in `state`. */
function pillThinkingAt(state: EditorState, index: number): PillThinkingView | null {
  return sectionThinkingView(state.field(sectionsField)[index], state.field(thinkingExpandedField), state.field(streamingSectionField))
}

// Changes the thinking parts of the drawn pills in place (a thinking token,
// the panel opened or closed, the spinner turned into the triangle).
// CodeMirror draws a changed widget into a new line element, even when the
// widget's `updateDOM` keeps its DOM. That move takes the focus from the
// thinking text field, drops its selection, scrolls the panel back to the
// top, and restarts the pill's busy animations, at every thinking token.
// So `RoleSeparatorWidget.eq` ignores thinking, CodeMirror leaves the pill
// alone, and this plugin changes it. `toDOM` reads the thinking from the
// state, so a pill that CodeMirror draws again is up to date. A change of
// the pill's height in place must call `measureLineHeights`
// (`editorMeasure.ts`), as `renderPillThinking` does.
const pillThinkingUpdater = ViewPlugin.define(() => ({
  update({ startState, state, view }: ViewUpdate) {
    if (
      startState.field(sectionsField) === state.field(sectionsField) &&
      startState.field(thinkingExpandedField) === state.field(thinkingExpandedField) &&
      startState.field(streamingSectionField) === state.field(streamingSectionField)
    ) return
    for (const separator of view.contentDOM.querySelectorAll<HTMLElement>('.dez-role-separator')) {
      const index = Number(separator.dataset.sectionIndex)
      const thinking = pillThinkingAt(state, index)
      if (sameThinkingView(pillThinkingAt(startState, index), thinking)) continue
      const label = separator.firstElementChild
      if (label instanceof HTMLElement) renderPillThinking(separator, label, thinking, view)
    }
  },
}))

/** Build the decoration set for the current doc. Each `\u001E` line is
 *  replaced with a block separator widget whose role/index come from the
 *  sectionsField and whose model part comes from `chips` (by section
 *  index). With `chips` null, the ranges have no widget (atomic ranges
 *  only). Separator n (counting from 1) starts section n, so the index of
 *  a pill is the section after it; section 0 has no separator. */
function buildSeparatorDecorations(
  doc: string,
  models: SectionModel[],
  chips: readonly (ModelChip | null)[] | null,
): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  let sectionIndex = 0
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) !== 0x1e) continue
    sectionIndex += 1
    const lineStart = doc.lastIndexOf('\n', i - 1) + 1
    const nextNewline = doc.indexOf('\n', i + 1)
    const lineEnd = nextNewline === -1 ? doc.length : nextNewline
    const lineText = doc.slice(lineStart, lineEnd)
    if (lineText.trim() !== SECTION_SEP) continue
    const nextRole = models[sectionIndex]?.role ?? 'user'
    ranges.push({
      from: i,
      to: i + 1,
      deco: Decoration.replace({
        widget: chips
          ? new RoleSeparatorWidget(sectionIndex, nextRole, chips[sectionIndex] ?? null)
          : undefined,
        inclusive: false,
      }),
    })
  }
  return Decoration.set(
    ranges.map((b) => b.deco.range(b.from, b.to)),
    true,
  )
}

/** The role separator pills. The states that use them need
 *  `thinkingExpandedField` and `streamingSectionField`. */
export const roleSeparators: Extension = [
  EditorView.decorations.compute(
    [sectionsField, modelDisplayNamesField, streamingSectionField, 'doc'],
    (state) => {
      const models = state.field(sectionsField)
      const chips = sectionModelChips(models, state.field(modelDisplayNamesField), state.field(streamingSectionField))
      return buildSeparatorDecorations(state.doc.toString(), models, chips)
    },
  ),
  pillThinkingUpdater,
]

export const roleSeparatorAtomicRanges = EditorView.atomicRanges.of((view) =>
  buildSeparatorDecorations(
    view.state.doc.toString(),
    view.state.field(sectionsField),
    null,
  ),
)

/** Click handler: a mousedown on the disclosure triangle of a role pill
 *  opens or closes its thinking panel. A mousedown anywhere else on the
 *  pill, its model part too, toggles the role of the section that the
 *  separator precedes. */
export const roleSeparatorMouseHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as Element | null
    if (!target) return false
    const label = target.closest('.dez-role-separator__label') as HTMLElement | null
    if (!label) return false
    const sep = label.closest('.dez-role-separator') as HTMLElement | null
    if (!sep) return false
    const idxStr = sep.getAttribute('data-section-index')
    if (!idxStr) return false
    const index = Number(idxStr)
    if (!Number.isFinite(index)) return false
    event.preventDefault()
    if (target.closest('.dez-role-separator__disclosure')) {
      const sectionId = view.state.field(sectionsField)[index]?.id
      if (sectionId) view.dispatch({ effects: toggleThinkingExpandedEffect.of(sectionId) })
      return true
    }
    view.dispatch({ effects: toggleRoleEffect.of({ index }) })
    return true
  },
})

/* ──────────────────────  Prompt pill widget  ───────────────── */

class HiddenPromptMarkerWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof HiddenPromptMarkerWidget
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'dez-hidden-prompt-marker'
    return el
  }
}

class PromptPillWidget extends WidgetType {
  constructor(
    readonly pillId: string,
    readonly name: string,
    readonly expanded: boolean,
  ) {
    super()
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof PromptPillWidget &&
      other.pillId === this.pillId &&
      other.name === this.name &&
      other.expanded === this.expanded
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'dez-prompt-pill'
    el.setAttribute('data-pill-id', this.pillId)
    el.setAttribute('data-expanded', this.expanded ? '1' : '0')
    const caret = document.createElement('span')
    caret.className = 'dez-prompt-pill__caret'
    caret.textContent = this.expanded ? '▼' : '▶'
    const label = document.createElement('span')
    label.className = 'dez-prompt-pill__name'
    label.textContent = this.name || '(unnamed)'
    el.appendChild(caret)
    el.appendChild(document.createTextNode(' '))
    el.appendChild(label)
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

function buildPromptDecorations(
  doc: string,
  meta: Map<string, PillMetadata>,
): DecorationSet {
  const pills = scanPills(doc)
  if (pills.length === 0) return Decoration.none
  const ranges = pills.map((p) => {
    const m = meta.get(p.id)
    if (m?.expanded) {
      return [
        Decoration.replace({
          widget: new PromptPillWidget(p.id, m.name, true),
          inclusive: false,
        }).range(p.from, p.bodyFrom),
        Decoration.mark({ class: 'dez-prompt-body' }).range(p.bodyFrom, p.bodyTo),
        Decoration.replace({
          widget: new HiddenPromptMarkerWidget(),
          inclusive: false,
        }).range(p.bodyTo, p.to),
      ]
    }
    return Decoration.replace({
      widget: new PromptPillWidget(p.id, m?.name ?? '', false),
      inclusive: false,
    }).range(p.from, p.to)
  }).flat()
  return Decoration.set(ranges, true)
}

export const promptPills = EditorView.decorations.compute(
  [pillsField, 'doc'],
  (state) => buildPromptDecorations(state.doc.toString(), state.field(pillsField)),
)

function buildPromptAtomicDecorations(
  doc: string,
  meta: Map<string, PillMetadata>,
): DecorationSet {
  const pills = scanPills(doc)
  if (pills.length === 0) return Decoration.none
  const ranges = pills.map((p) => {
    const m = meta.get(p.id)
    if (m?.expanded) {
      return [
        Decoration.replace({
          widget: new HiddenPromptMarkerWidget(),
          inclusive: false,
        }).range(p.from, p.bodyFrom),
        Decoration.replace({
          widget: new HiddenPromptMarkerWidget(),
          inclusive: false,
        }).range(p.bodyTo, p.to),
      ]
    }
    return Decoration.replace({
      widget: new HiddenPromptMarkerWidget(),
      inclusive: false,
    }).range(p.from, p.to)
  }).flat()
  return Decoration.set(ranges, true)
}

export const promptAtomicRanges = EditorView.atomicRanges.of((view) =>
  buildPromptAtomicDecorations(view.state.doc.toString(), view.state.field(pillsField)),
)

export const promptPillMouseHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null
    if (!target) return false
    const pill = target.closest('.dez-prompt-pill') as HTMLElement | null
    if (!pill) return false
    const id = pill.getAttribute('data-pill-id')
    if (!id) return false
    const loc = scanPills(view.state.doc.toString()).find((p) => p.id === id)
    if (!loc) return false
    const meta = view.state.field(pillsField).get(id)
    const body = view.state.sliceDoc(loc.bodyFrom, loc.bodyTo)
    event.preventDefault()
    view.dispatch({
      changes: {
        from: loc.bodyFrom,
        to: loc.bodyTo,
        insert: meta?.expanded ? body.replace(/\n/g, PILL_NL) : body.replace(/\u{E003}/gu, '\n'),
      },
      effects: togglePillExpandedEffect.of({ id }),
    })
    return true
  },
})

function escapePromptClipboardBody(body: string): string {
  return body.replace(/<\/dez:prompt>/g, '<\\/dez:prompt>')
}

function unescapePromptClipboardBody(body: string): string {
  return body.replace(/<\\\/dez:prompt>/g, '</dez:prompt>')
}

// The clipboard marker of the section that starts at the separator at `pos`.
function clipboardSectionMarker(doc: string, models: SectionModel[], pos: number): string {
  const section = models[sectionIndexAtOffset(doc, pos) + 1]
  return pillMarkerText(section?.role ?? 'user', section?.model, section?.thinking)
}

// Every sentinel in the range is turned into a marker or a newline, or is
// skipped, so the doc text in the result holds no sentinels.
function serializePlainDocFragment(doc: string, from: number, to: number, models: SectionModel[]): string {
  let out = ''
  for (let i = from; i < to; i++) {
    const c = doc[i]
    if (c === SECTION_SEP) {
      const marker = clipboardSectionMarker(doc, models, i)
      if (out.endsWith('\n')) out = out.slice(0, -1)
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      out += `${marker}\n`
      if (i + 1 < to && doc[i + 1] === '\n') i++
    } else if (c === PILL_NL) {
      out += '\n'
    } else if (c === PILL_OPEN) {
      // Callers pass ranges outside well-formed pills, so a header here is
      // what is left of a broken pill. Its id is not text: skip it.
      const bodyAt = pillHeaderBodyIndex(doc, i)
      if (bodyAt >= 0 && bodyAt < to) i = bodyAt
    } else if (c !== PILL_BODY && c !== PILL_CLOSE) {
      out += c
    }
  }
  return out
}

/** Clipboard text of one doc range, with `dez:` markers. Live sentinels are
 *  removed piece by piece, from doc text and prompt parts only: a section
 *  marker can be a container that holds thinking text, which must stay
 *  exact (the `field` replay sends it back to the provider). */
export function serializeDocRangeForClipboard(
  doc: string,
  from: number,
  to: number,
  models: SectionModel[],
  pillsMeta: Map<string, PillMetadata>,
): string {
  if (from >= to) return ''
  const pills = scanPills(doc).filter((p) => p.to > from && p.from < to)
  let out = from === 0 ? `${pillMarkerText('user')}\n` : ''
  let cursor = from
  for (const p of pills) {
    if (cursor < Math.min(p.from, to)) {
      out += serializePlainDocFragment(doc, cursor, Math.min(p.from, to), models)
    }
    const meta = pillsMeta.get(p.id)
    const bodyFrom = Math.max(from, p.bodyFrom)
    const bodyTo = Math.min(to, p.bodyTo)
    if (from <= p.from && to >= p.to) {
      const name = stripLiveSentinels(meta?.name ?? '')
      const body = stripLiveSentinels(doc.slice(p.bodyFrom, p.bodyTo))
      out += `<dez:prompt name="${escapeMarkerAttribute(name)}">\n${escapePromptClipboardBody(body)}`
      if (!out.endsWith('\n')) out += '\n'
      out += '</dez:prompt>\n'
    } else if (bodyFrom < bodyTo) {
      out += stripLiveSentinels(doc.slice(bodyFrom, bodyTo))
    }
    cursor = Math.max(cursor, Math.min(p.to, to))
  }
  if (cursor < to) out += serializePlainDocFragment(doc, cursor, to, models)
  return out
}

export function serializeSelectionForClipboard(state: EditorState): string {
  const ranges = state.selection.ranges.filter((range) => !range.empty)
  if (ranges.length === 0) return ''
  const doc = state.doc.toString()
  const models = state.field(sectionsField)
  const pillsMeta = state.field(pillsField)
  return ranges.map((range) => serializeDocRangeForClipboard(
    doc,
    range.from,
    range.to,
    models,
    pillsMeta,
  )).join('\n')
}

/** Copy Markdown text of one doc range: what the model reads, with no `dez:`
 *  markers and no thinking. A prompt pill, whole or in part, gives its body
 *  text. A range that holds a role pill gives its section parts as
 *  `messagesAsMarkdown` gives them, so a whole tab copies as Save As
 *  Markdown saves it (without the title): a part gets its role heading only
 *  when its pill is in the range, and an empty part gives nothing. The pill
 *  of a later section is its separator line; the first section's pill is
 *  the editor's `::before`, so it counts as selected when the range starts
 *  at doc position 0 (as in `serializeDocRangeForClipboard`). A range inside
 *  one section's text gives that text as is: a copied word gets no heading
 *  and no newline. A pill never spans a separator (`scanPills`), so the text
 *  between pills holds every separator. */
function serializeDocRangeAsMarkdown(doc: string, from: number, to: number, models: SectionModel[]): string {
  const parts = ['']
  const appendDocText = (fragmentFrom: number, fragmentTo: number) => {
    splitDocBySeparator(doc.slice(fragmentFrom, fragmentTo)).forEach((part, index) => {
      if (index > 0) parts.push('')
      parts[parts.length - 1] += stripLiveSentinels(part)
    })
  }
  let cursor = from
  for (const p of scanPills(doc).filter((pill) => pill.to > from && pill.from < to)) {
    if (cursor < p.from) appendDocText(cursor, p.from)
    parts[parts.length - 1] += stripLiveSentinels(doc.slice(Math.max(from, p.bodyFrom), Math.min(to, p.bodyTo)))
    cursor = Math.min(p.to, to)
  }
  if (cursor < to) appendDocText(cursor, to)
  if (from > 0 && parts.length === 1) return parts[0]
  const firstSection = sectionIndexAtOffset(doc, from)
  return messagesAsMarkdown(parts.map((text, index): MarkdownMessage => {
    if (index > 0) return { role: models[firstSection + index]?.role ?? 'user', text }
    return from === 0 ? { role: 'user', text } : { text }
  }))
}

/** The selection for Copy Markdown (`dez.editor/copyMarkdown`): each range as
 *  `serializeDocRangeAsMarkdown` gives it, joined by newlines. Ranges that
 *  give no text are left out, so an empty result means nothing to copy. */
export function serializeSelectionAsMarkdown(state: EditorState): string {
  const doc = state.doc.toString()
  const models = state.field(sectionsField)
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => serializeDocRangeAsMarkdown(doc, range.from, range.to, models))
    .filter((text) => text !== '')
    .join('\n')
}

export function cutSelectedRangesTransaction(state: EditorState): TransactionSpec | null {
  const ranges = state.selection.ranges
  if (ranges.every((range) => range.empty)) return null
  const mainNonEmptyIndex = Math.max(0, ranges.slice(0, state.selection.mainIndex + 1).filter((range) => !range.empty).length - 1)
  const changes = state.changeByRange((range) => {
    if (range.empty) return { range: EditorSelection.cursor(range.from) }
    return {
      changes: { from: range.from, to: range.to, insert: '' },
      range: EditorSelection.cursor(range.from),
    }
  })
  if (changes.changes.empty) return null
  const selection = EditorSelection.create(
    ranges.filter((range) => !range.empty).map((range) => {
      return EditorSelection.cursor(changes.changes.mapPos(range.from))
    }),
    mainNonEmptyIndex,
  )
  return {
    ...changes,
    selection,
    scrollIntoView: true,
    userEvent: 'delete.cut',
  }
}

export function plainTextPasteTransaction(state: EditorState, text: string): TransactionSpec {
  const ranges = state.selection.ranges
  const paste = state.toText(text)
  let index = 1
  const changes = paste.lines === ranges.length
    ? state.changeByRange((range) => {
      const line = paste.line(index++)
      return {
        changes: { from: range.from, to: range.to, insert: line.text },
        range: EditorSelection.cursor(range.from + line.length),
      }
    })
    : state.replaceSelection(paste)
  return {
    ...changes,
    scrollIntoView: true,
    userEvent: 'input.paste',
  }
}

export interface ParsedClipboardText {
  text: string
  pills: Map<string, PillMetadata>
  /** One entry per `SECTION_SEP` in `text`, in order. */
  separators: Pick<SectionModel, 'role' | 'model' | 'thinking'>[]
}

/** Turn clipboard text (with `dez:` markers) into live-doc text: section
 *  markers become separators, prompt markup becomes collapsed pills, and the
 *  body of an agent container becomes the separator's thinking. With
 *  `plainText`, the result holds no sentinels: prompt bodies are inlined
 *  and section markers (with their thinking) dropped, for a paste inside a
 *  pill body, where a nested pill or a separator would break the pill. A
 *  `model` on a user marker, or one that is not a `provider/model` value, is
 *  ignored. A pill marker without a valid `type` stays text. */
export function parseClipboardText(text: string, plainText = false): ParsedClipboardText {
  const pills = new Map<string, PillMetadata>()
  const separators: ParsedClipboardText['separators'] = []
  const marker = new RegExp(String.raw`(${PILL_MARKER.source})|<dez:prompt\s+name="([^"]*)">([\s\S]*?)<\/dez:prompt>`, 'g')
  let out = ''
  let cursor = 0
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const pill = match[1] === undefined ? null : parsePillMarkerMatch(match[1])
    // A pill marker with no valid `type` is not a marker. `cursor` does not
    // move, so a later slice copies it as plain text. The scan goes on just
    // after its `<`, so markers in the body of such a container still count,
    // as they do in conversation files.
    if (match[1] !== undefined && !pill) {
      marker.lastIndex = match.index + 1
      continue
    }
    out += stripLiveSentinels(text.slice(cursor, match.index))
    let nextCursor = match.index + match[0].length
    if (pill) {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      if (!plainText) {
        out += `${SECTION_SEP}\n`
        separators.push({
          role: pill.marker.role,
          ...modelRefField(pill.marker.model ?? undefined),
          ...thinkingField(pill.thinking),
        })
      }
      if (text[nextCursor] === '\n') nextCursor++
    } else {
      const name = unescapeMarkerAttribute(match[2] ?? '')
      let body = match[3] ?? ''
      if (body.startsWith('\n')) body = body.slice(1)
      if (body.endsWith('\n')) body = body.slice(0, -1)
      body = unescapePromptClipboardBody(stripLiveSentinels(body))
      if (plainText) {
        out += body
      } else {
        const id = crypto.randomUUID()
        out += encodePrompt(id, body, true)
        pills.set(id, { promptId: null, name, expanded: false })
      }
    }
    cursor = nextCursor
  }
  out += stripLiveSentinels(text.slice(cursor))
  return { text: out, pills, separators }
}

/** The transaction for a paste of clipboard text with `dez:` markers. Each
 *  pasted section marker starts a new section with the marker's role,
 *  model, and thinking. Markers at the very start of the paste are dropped,
 *  so the paste joins the section at the caret. In a pill body, pasted
 *  prompts and section markers would nest a pill or split this one, so the
 *  paste is plain text there. */
export function clipboardPasteTransaction(state: EditorState, text: string): TransactionSpec {
  const doc = state.doc.toString()
  const pills = scanPills(doc)
  const insidePillBody = state.selection.ranges.some((range) =>
    pills.some((pill) => pill.bodyFrom <= range.from && range.to <= pill.bodyTo),
  )
  const parsed = parseClipboardText(text, insidePillBody)
  let pasteText = parsed.text
  const separators = parsed.separators.slice()
  const leadingMarker = SECTION_SEP + '\n'
  while (pasteText.startsWith(leadingMarker) && separators.length > 0) {
    pasteText = pasteText.slice(leadingMarker.length)
    separators.shift()
  }
  if (parsed.separators.length === 0 && parsed.pills.size === 0) {
    return plainTextPasteTransaction(state, pasteText)
  }
  const range = state.selection.main
  const meta = new Map(state.field(pillsField))
  for (const [id, pill] of parsed.pills) meta.set(id, pill)
  const effects: StateEffect<unknown>[] = [setPillsEffect.of(meta)]
  if (separators.length > 0 || range.from !== range.to) {
    const oldModels = state.field(sectionsField)
    const inserted: SectionModel[] = separators.map((separator) => ({ id: crypto.randomUUID(), ...separator }))
    effects.push(setSectionsEffect.of([
      ...oldModels.slice(0, sectionIndexAtOffset(doc, range.from) + 1),
      ...inserted,
      ...oldModels.slice(sectionIndexAtOffset(doc, range.to) + 1),
    ]))
  }
  return {
    changes: { from: range.from, to: range.to, insert: pasteText },
    selection: { anchor: range.from + pasteText.length },
    effects,
    scrollIntoView: true,
  }
}

/* ───────────────────────  Theme / language  ──────────────────── */

export function buildInitialDoc(sections: Section[]): string {
  return sectionsToDoc(sections)
}

export const dezHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: 'var(--color-text)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--color-link, #4a9eff)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--color-link, #4a9eff)' },
  { tag: t.monospace, fontFamily: 'inherit', color: 'var(--color-code, #c792ea)' },
  { tag: t.quote, color: 'var(--color-muted, #888)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--color-text)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.meta, color: 'var(--color-muted, #888)' },
])

/** The padding above and below the doc inside the editor scroller. */
export const SCROLLER_PADDING_PX = 16

// The side gutter of the text column: the scroller's left and right
// padding. The column has no max width (the user wants the window to
// decide how wide the text is), so the gutter grows with the editor width
// instead: today's 16px at the 600px minimum window, 40px at the 900px
// default, and at most 80px from 1400px up, so text on a wide window does
// not run close to its edges. A padding percentage resolves against the
// width of the containing block, which is the editor's width for both the
// scroller and the busy indicator (`ThreadEditor.vue`), so both get the
// same gutter from this one value.
export const TEXT_GUTTER = `clamp(${SCROLLER_PADDING_PX}px, calc(8% - 32px), 80px)`

// Every size in the editor follows the user's editor font size
// (`--dez-editor-font-size`, set by `dez.ui/applyEditorFontSize`), so text,
// pills, the thinking panel and tables grow and shrink together.
// `editorSize(px)` is `px` at the default font size and scales with the font
// size. The text and the spacing around it scale; hairline borders and the
// scroller padding (`SCROLLER_PADDING_PX`, `TEXT_GUTTER`) do not.
const EDITOR_FONT_SIZE_VAR = `var(--dez-editor-font-size, ${EDITOR_FONT_SIZE_DEFAULT}px)`

function editorSize(...px: number[]): string {
  return px.map((value) => `calc(${EDITOR_FONT_SIZE_VAR} * ${value} / ${EDITOR_FONT_SIZE_DEFAULT})`).join(' ')
}

// Height of a table's delimiter row in em of the editor font. Thin, as it
// draws no text, but tall enough for a caret that the user can see.
const TABLE_DELIMITER_ROW_EM = 0.6

export const dezTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
    fontSize: EDITOR_FONT_SIZE_VAR,
  },
  '.cm-scroller': {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: '1.6',
    padding: `${SCROLLER_PADDING_PX}px ${TEXT_GUTTER}`,
  },
  '.cm-content': {
    width: '100%',
    caretColor: 'var(--color-text)',
    // Room for the pill of the first section, which `::before` draws: the
    // first section has no separator line in the doc to put a widget on.
    padding: `${editorSize(46)} 0 0`,
    position: 'relative',
  },
  '.cm-content::before': {
    content: '"User"',
    position: 'absolute',
    top: editorSize(12),
    left: '0',
    width: 'max-content',
    padding: editorSize(2, 10),
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-muted, #888)',
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: editorSize(11),
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
  // Colors are theme variables (App.vue). The focused rule must be as
  // specific as CM's base-theme rule `&light.cm-focused > .cm-scroller >
  // .cm-selectionLayer .cm-selectionBackground`, or that rule's light
  // lavender wins in both app themes: this theme has no `dark` flag, so CM
  // always styles the editor as light. The inactive color shows while focus
  // is elsewhere, e.g. in the find field after Find Next.
  '.cm-selectionBackground': {
    backgroundColor: 'var(--color-selection-inactive, rgba(100, 149, 237, 0.35))',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-selection, #d7d4f0)',
  },
  '.cm-gutters': { display: 'none' },
  '.dez-role-separator': {
    display: 'inline-flex',
    alignItems: 'center',
    width: '100%',
    margin: `${editorSize(12)} 0`,
    padding: '0',
    userSelect: 'none',
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(11),
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  '.dez-role-separator__label': {
    padding: editorSize(2, 10),
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    cursor: 'pointer',
  },
  '.dez-role-separator[data-role="agent"] .dez-role-separator__label': {
    color: 'var(--color-link, #4a9eff)',
    borderColor: 'var(--color-link, #4a9eff)',
  },
  // Agent pill with a model (`addModelToPill` in modelChip.ts): one pill
  // holds the role word, a thin divider, the model name, and the provider
  // name, in the agent accent for every model. The model part has a smaller
  // line height than the role word, so the pill keeps the height and
  // baseline of the other role pills, and a separator does not move when a
  // stream stamps a model on it. The separator row is uppercase and
  // letter-spaced; model names keep their case. Only the model name shrinks
  // (with an ellipsis) and the provider name has a cap, so a long model id
  // never wraps the separator row. `nowrap` keeps the role word whole: the
  // editor's line wrapping (`overflow-wrap: anywhere`) would let the pill
  // break it into letters when it shrinks.
  '.dez-role-separator__label[data-model-key]': {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'baseline',
    minWidth: '0',
    whiteSpace: 'nowrap',
  },
  '.dez-role-separator__model': {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: editorSize(6),
    minWidth: '0',
    marginLeft: editorSize(8),
    color: 'var(--color-text)',
    fontSize: editorSize(12),
    lineHeight: '1.25',
    letterSpacing: 'normal',
    textTransform: 'none',
  },
  '.dez-role-separator__model::before': {
    content: '""',
    alignSelf: 'center',
    flex: 'none',
    width: '1px',
    height: editorSize(11),
    marginRight: editorSize(2),
    background: 'var(--color-link, #4a9eff)',
    opacity: '0.45',
  },
  '.dez-role-separator__switch': {
    alignSelf: 'center',
    flex: 'none',
    width: editorSize(12),
    height: editorSize(12),
    color: 'var(--color-link, #4a9eff)',
  },
  '.dez-role-separator__model-name': {
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: '600',
  },
  '.dez-role-separator__model-provider': {
    flex: 'none',
    maxWidth: '14em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: editorSize(11),
    opacity: '0.55',
  },
  '.dez-role-separator__model-provider::before': {
    content: '"·"',
    marginRight: editorSize(6),
  },
  // Left slot of an agent pill (`thinkingPill.ts`): a spinner while the
  // section streams and has no thinking yet, then a disclosure triangle
  // that opens the thinking panel. Both fit in the line box of the role
  // word, so the pill keeps its height. The triangle has padding with a
  // negative margin: a larger target that does not grow the pill. Under
  // reduced motion the spinner does not turn (see the media query below).
  '.dez-role-separator__spinner': {
    display: 'inline-block',
    flex: 'none',
    alignSelf: 'center',
    verticalAlign: 'middle',
    boxSizing: 'border-box',
    width: editorSize(9),
    height: editorSize(9),
    marginRight: editorSize(6),
    border: '1.5px solid currentColor',
    borderRightColor: 'transparent',
    borderRadius: '50%',
  },
  '.dez-role-separator__disclosure': {
    display: 'inline-block',
    flex: 'none',
    alignSelf: 'center',
    verticalAlign: 'middle',
    padding: editorSize(2, 4),
    margin: editorSize(-2, 2, -2, -4),
    fontSize: editorSize(9),
    lineHeight: '1',
    letterSpacing: 'normal',
  },
  '.dez-role-separator__disclosure[aria-expanded="true"]': {
    transform: 'rotate(90deg)',
  },
  // The thinking panel (`renderPillThinking` in thinkingPill.ts) takes its
  // own row below the pill. A hidden mirror of the text and the read-only
  // textarea share one grid cell, so the cell, and with it the textarea, is
  // as tall as the text. Both need the same font, padding and wrapping
  // rules for that. Past its max height the panel scrolls. The separator
  // row is uppercase, letter-spaced and not selectable; the panel resets
  // all three.
  '.dez-role-separator[data-thinking-open]': {
    flexWrap: 'wrap',
  },
  '.dez-role-separator__thinking': {
    display: 'grid',
    flex: '1 0 100%',
    minWidth: '0',
    maxHeight: '20em',
    marginTop: editorSize(6),
    overflowY: 'auto',
    overflowAnchor: 'none',
    boxSizing: 'border-box',
    border: '1px solid var(--color-border, #333)',
    borderRadius: editorSize(8),
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(13),
    lineHeight: '1.5',
    letterSpacing: 'normal',
    textTransform: 'none',
    cursor: 'auto',
    userSelect: 'text',
  },
  '.dez-role-separator__thinking:focus-within': {
    borderColor: 'var(--color-link, #4a9eff)',
  },
  // CM's `hideNativeSelection` paints the native selection of a focused
  // field in the editor with the OS `Highlight` color, `!important`. In
  // WebKitGTK that is a strong blue, and the muted panel text on it is
  // unreadable, so the panel uses the editor's selection color instead. One
  // more class than CM's `.cm-content :focus::selection` makes this win.
  '.cm-content .dez-role-separator__thinking-text:focus::selection': {
    backgroundColor: 'var(--color-selection, #d7d4f0) !important',
  },
  '.dez-role-separator__thinking-mirror, .dez-role-separator__thinking-text': {
    gridArea: '1 / 1',
    boxSizing: 'border-box',
    minWidth: '0',
    margin: '0',
    padding: editorSize(8, 12),
    border: 'none',
    font: 'inherit',
    letterSpacing: 'inherit',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'normal',
  },
  '.dez-role-separator__thinking-mirror': {
    visibility: 'hidden',
  },
  // A text that ends in a newline shows an empty last line in the textarea,
  // but in the mirror only when something follows the newline.
  '.dez-role-separator__thinking-mirror::after': {
    content: '" "',
  },
  '.dez-role-separator__thinking-text': {
    width: '100%',
    height: '100%',
    minHeight: '0',
    resize: 'none',
    overflow: 'hidden',
    outline: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'text',
  },
  // "Generating" state of the pill whose response is streaming
  // (`data-streaming`): a soft ring around the pill breathes in and out,
  // and a highlight sweeps across the model name, both in the agent accent.
  // All of it is motion, so it applies only when the user has not asked for
  // reduced motion. The ring is a pseudo-element that animates only its
  // opacity. The name shimmer is a gradient clipped to the text: twice the
  // name's width, so each loop is one sweep plus a pause. Streamed text
  // tokens keep the widget (`eq`), and `pillThinkingUpdater` changes the
  // thinking parts in place, so the animations run without restarts until
  // the stream ends. The left-slot spinner turns only here too.
  '@media (prefers-reduced-motion: no-preference)': {
    '.dez-role-separator__spinner': {
      animation: 'dez-role-pill-spin 0.9s linear infinite',
    },
    '.dez-role-separator__label[data-streaming]::after': {
      content: '""',
      position: 'absolute',
      top: '-1px',
      right: '-1px',
      bottom: '-1px',
      left: '-1px',
      borderRadius: 'inherit',
      boxShadow: '0 0 0 3px var(--color-link, #4a9eff)',
      opacity: '0',
      pointerEvents: 'none',
      animation: 'dez-role-pill-glow 1.8s ease-in-out infinite',
    },
    '.dez-role-separator__label[data-streaming] .dez-role-separator__model-name': {
      color: 'transparent',
      backgroundImage:
        'linear-gradient(90deg, var(--color-text) 40%, var(--color-link, #4a9eff) 50%, var(--color-text) 60%)',
      backgroundSize: '200% 100%',
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      animation: 'dez-role-pill-shimmer 2.4s linear infinite',
    },
  },
  '@keyframes dez-role-pill-glow': {
    '0%, 100%': { opacity: '0' },
    '50%': { opacity: '0.3' },
  },
  '@keyframes dez-role-pill-shimmer': {
    '0%': { backgroundPosition: '200% 0' },
    '100%': { backgroundPosition: '0 0' },
  },
  '@keyframes dez-role-pill-spin': {
    to: { transform: 'rotate(360deg)' },
  },
  '.dez-prompt-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: editorSize(4),
    padding: editorSize(1, 8),
    margin: `0 ${editorSize(1)}`,
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-link, #4a9eff)',
    cursor: 'pointer',
    userSelect: 'none',
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: editorSize(12),
    lineHeight: '1.4',
    verticalAlign: 'baseline',
  },
  '.dez-prompt-pill__caret': {
    fontSize: editorSize(9),
    opacity: '0.8',
  },
  '.dez-prompt-pill[data-expanded="1"]': {
    padding: `0 ${editorSize(2)}`,
    margin: '0',
    border: 'none',
    background: 'transparent',
    borderRadius: '0',
  },
  '.dez-prompt-pill[data-expanded="1"] .dez-prompt-pill__name': {
    display: 'none',
  },
  '.dez-prompt-body': {
    color: 'var(--color-text)',
  },
  // Find highlights (src/view/editor/find.ts). Amber, so they differ from the
  // blue selection. They are text backgrounds, so they draw over the
  // selection layer, and their translucent colors mix with it: a selected
  // match still looks selected. The current match is always the main
  // selection; its stronger color and outline set it apart from the other
  // matches that a selection covers.
  '.dez-find-match': {
    backgroundColor: 'var(--color-find-match, rgba(255, 190, 60, 0.35))',
    borderRadius: '2px',
  },
  '.dez-find-match.dez-find-match--current': {
    backgroundColor: 'var(--color-find-match-current, rgba(255, 150, 0, 0.6))',
    outline: '1px solid var(--color-find-match-outline, rgba(230, 120, 0, 0.95))',
  },
  // GFM tables (src/view/editor/tables.ts): the source text laid out as a
  // table. CM's height map counts only the space inside the wrapper's border
  // box above the first row and below the last one, so the space around the
  // table is wrapper padding (not margin) and rows touch: no border-spacing,
  // no border-collapse overlap, no row margins. Otherwise clicks and
  // scrolling drift. Space inside a row is cell padding, which CM measures
  // as part of the line. Cells draw the grid: right + bottom borders, plus
  // top on the header row and left on the first cell of each row; the
  // corner cells round the table's corners like the thinking panel. The
  // horizontal cell padding and the hanging indent are inline styles from
  // `tables.ts`, as they depend on each cell's source.
  '.dez-table': {
    display: 'table',
    borderCollapse: 'separate',
    borderSpacing: '0',
    padding: `${editorSize(6)} 0`,
  },
  '.cm-line.dez-table-row': {
    display: 'table-row',
  },
  '.dez-table-cell': {
    display: 'table-cell',
    verticalAlign: 'top',
    paddingTop: editorSize(4),
    paddingBottom: editorSize(4),
    borderRight: '1px solid var(--color-border, #333)',
    borderBottom: '1px solid var(--color-border, #333)',
  },
  '.dez-table-cell--first': {
    borderLeft: '1px solid var(--color-border, #333)',
  },
  '.dez-table-cell--center': { textAlign: 'center' },
  '.dez-table-cell--right': { textAlign: 'right' },
  '.dez-table-row--header .dez-table-cell--first': { borderTopLeftRadius: editorSize(8) },
  '.dez-table-row--header .dez-table-cell--last': { borderTopRightRadius: editorSize(8) },
  '.dez-table-row--last .dez-table-cell--first': { borderBottomLeftRadius: editorSize(8) },
  '.dez-table-row--last .dez-table-cell--last': { borderBottomRightRadius: editorSize(8) },
  // The header row and the delimiter row under it are one band on the
  // header background. The header's top padding equals the delimiter row's
  // height, so the header text sits in the middle of the band, not on top
  // of an empty strip.
  '.dez-table-row--header .dez-table-cell': {
    paddingTop: `${TABLE_DELIMITER_ROW_EM}em`,
    paddingBottom: '0',
    borderTop: '1px solid var(--color-border, #333)',
    borderBottom: 'none',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    fontWeight: '600',
  },
  // The delimiter row stays a real, editable line, so its dashes keep their
  // caret positions, but the text is invisible (the user asked for no
  // dashes under the header). The thin row on the header's background, with
  // its bottom border, reads as the rule under the header. The caret and
  // the selection are drawn in their own layers, so they still show in it.
  // Its height is `TABLE_DELIMITER_ROW_EM` of the editor font: the font
  // size at line height 1. The `*` covers syntax and find marks nested
  // inside a cell.
  '.dez-table-row--delimiter .dez-table-cell': {
    paddingTop: '0',
    paddingBottom: '0',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    fontSize: `${TABLE_DELIMITER_ROW_EM}em`,
    lineHeight: '1',
  },
  '.dez-table-row--delimiter .dez-table-cell, .dez-table-row--delimiter .dez-table-cell *': {
    color: 'transparent',
  },
  // Splitting pipes keep their width (they fill the cells' pipe slots) but
  // are invisible. The `*` covers syntax highlight spans nested inside a
  // pipe mark.
  '.dez-table-pipe, .dez-table-pipe *': {
    color: 'transparent',
  },
})

export function dezLanguageSupport(): Extension {
  return [markdown(), syntaxHighlighting(dezHighlightStyle)]
}
