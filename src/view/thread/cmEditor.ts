import { invertedEffects } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { ChangeSet, EditorSelection, EditorState, MapMode, StateEffect, StateField, findClusterBreak, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'
import type { ContentNode, ModelRef, Role, Section, SectionThinking } from '../../model/chat/types'
import { durationField } from '../../model/chat/duration'
import { modelRefField } from '../../model/chat/modelRef'
import { PILL_MARKER, parsePillMarkerMatch, pillMarkerText } from '../../model/chat/pillMarker'
import { thinkingField } from '../../model/chat/thinking'
import { messagesAsMarkdown, sectionTextAsMarkdown, type MarkdownMessage } from '../../model/chat/markdown'
import { SENTINEL_CHAR, normalizeContent, stripLiveSentinels, textNode } from '../../model/chat/content'
import { EDITOR_FONT_SIZE_DEFAULT, EDITOR_FONT_SIZE_PROPERTY } from '../../model/editorFontSize'
import { escapeMarkerAttribute, unescapeMarkerAttribute } from '../../utils/markerAttribute'
import { addModelToPill, modelDisplayNamesField, sameModelChip, sectionModelChips, streamingSectionField, type ModelChip } from './modelChip'
import { addDurationToPill } from './pillDuration'
import {
  hasThinking,
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
 *  unknown), its thinking (`thinking`, never doc text), and its reply
 *  duration (`durationMs`). The editor writes this field back to the store
 *  on every doc change (`syncDocToStore`), so a section field missing here is
 *  lost there. A new per-section field must also go in
 *  `initialSectionModels`, `docToSections`, `sectionModelsEqual`
 *  (ThreadEditor.vue) and `dez.model/thread/sectionsIdentity`, or the store
 *  loses it on the first streamed token. */
export interface SectionModel {
  id: string
  role: Role
  model?: ModelRef
  thinking?: SectionThinking
  durationMs?: number
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
 *  doc; its fixed User pill is the editor's `::before`. */
function normalizeSectionModels(models: SectionModel[]): SectionModel[] {
  if (models.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  if (models[0].role === 'user') return models
  const copy = models.slice()
  copy[0] = { ...copy[0], role: 'user' }
  return copy
}

/** Produce `{ id, role, model?, thinking?, durationMs? }` for each section
 *  to seed `sectionsField`. */
export function initialSectionModels(sections: Section[]): SectionModel[] {
  if (sections.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  return normalizeSectionModels(sections.map((s) => ({
    id: s.id,
    role: s.role,
    ...modelRefField(s.model),
    ...thinkingField(s.thinking),
    ...durationField(s.durationMs),
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
      ...durationField(sectionModel.durationMs),
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

/** A separator that a transaction deletes: its position in the start doc,
 *  and the index of the section that it starts there. */
export interface DeletedSeparator {
  pos: number
  index: number
}

export function deletedSeparators(tr: Transaction): DeletedSeparator[] {
  const deleted: DeletedSeparator[] = []
  // Most changes delete no separator: only those read the whole doc.
  let startDoc: string | null = null
  tr.changes.iterChanges((fromA, toA) => {
    const text = tr.startState.sliceDoc(fromA, toA)
    if (!text.includes(SECTION_SEP)) return
    startDoc ??= tr.startState.doc.toString()
    let index = sectionIndexAtOffset(startDoc, fromA)
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x1e) deleted.push({ pos: fromA + i, index: ++index })
    }
  })
  return deleted
}

/* ──────────────────────────  Effects  ────────────────────────── */

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

/** A section model that an undo or redo puts back. `pos` is the position
 *  of its separator in the doc after that undo or redo; only the order of
 *  the entries can be trusted (see `restoreSectionModelsEffect`). */
interface RestoredSectionModel {
  pos: number
  model: SectionModel
  /** A later change deleted the character after `pos`. */
  mappedAway?: boolean
}

/** Carried by an undo or redo that puts deleted separators back in the
 *  doc: their models, for `sectionsField` (see its `provide`). While the
 *  effect waits in the undo history, CodeMirror maps it in two ways:
 *  - When it joins two events, it maps the newer effect through the older
 *    event's undo, in the right doc. A mapped-away entry is then a
 *    separator that the older edit inserted: the joined undo does not put
 *    it back.
 *  - Through a doc change that is not in the history (the image trash), it
 *    maps the effect in the coordinates of the current doc, not those of
 *    the doc after the undo (`mapEvent` in `@codemirror/commands`). So
 *    `pos` can be past the end of that change, or move to a wrong place
 *    and be mapped away, but the undo still puts the separator back.
 *  So no entry is dropped here, and mapping keeps the entries' order:
 *  `withRestoredSectionModels` takes the places from the undo's changes. */
const restoreSectionModelsEffect = StateEffect.define<RestoredSectionModel[]>({
  map: (entries, mapping) => entries.map((entry) => {
    // Past the end of the change: move it with the doc end, so that it
    // stays after the entries in range.
    if (entry.pos > mapping.length) return { ...entry, pos: entry.pos - mapping.length + mapping.newLength }
    const tracked = mapping.mapPos(entry.pos, 1, MapMode.TrackAfter)
    if (tracked !== null) return { ...entry, pos: tracked }
    return { ...entry, pos: mapping.mapPos(entry.pos, 1), mappedAway: true }
  }),
})

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

/** `models` with the models that the undo or redo `tr` puts back, each at
 *  the index of the section that its separator starts in the new doc.
 *  `models` already holds, in order, the models of the new doc's other
 *  separators, so inserting in doc order puts each one at its final index.
 *  The places are those of the separators that `tr`'s changes insert,
 *  which the history maps right; the entries give only the order. */
function withRestoredSectionModels(models: SectionModel[], tr: Transaction): SectionModel[] {
  const restored = tr.effects
    .flatMap((effect) => (effect.is(restoreSectionModelsEffect) ? effect.value : []))
    .sort((a, b) => a.pos - b.pos)
  if (restored.length === 0) return models
  const inserted: number[] = []
  tr.changes.iterChanges((_fromA, _toA, fromB, _toB, text) => {
    const str = text.toString()
    for (let i = str.indexOf(SECTION_SEP); i >= 0; i = str.indexOf(SECTION_SEP, i + 1)) inserted.push(fromB + i)
  })
  // After a doc change that is not in the history, every entry has its
  // separator; after a join, only those not mapped away do (see
  // `restoreSectionModelsEffect`). With both, the entries cannot be paired
  // with the separators: put back none.
  const kept = restored.filter((entry) => !entry.mappedAway)
  const matched = [restored, kept].find((entries) => entries.length === inserted.length)
  if (!matched) return models
  const doc = tr.newDoc.toString()
  const copy = models.slice()
  matched.forEach(({ model }, i) => copy.splice(sectionIndexAtOffset(doc, inserted[i]) + 1, 0, model))
  return copy
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
        const removed = deletedSeparators(tr).map((separator) => separator.index).sort((a, b) => b - a)
        if (removed.length > 0) {
          const copy = next.slice()
          for (const index of removed) {
            if (index > 0 && index < copy.length) copy.splice(index, 1)
          }
          next = copy
        }
        next = withRestoredSectionModels(next, tr)
      }
      next = reconcileSectionModelsToDoc(next, tr.newDoc.toString())
    }
    return normalizeSectionModels(next)
  },
  // Section models are not doc text, so the undo history alone puts back
  // only the separator of a deleted section: `reconcileSectionModelsToDoc`
  // then pads a new User model at the end of the list (an Agent section
  // came back as User, and the sections after it got the wrong models).
  // So the history keeps the model of each separator that a change deletes
  // (Delete, Backspace merges, cut, paste over sections, an undo of a paste
  // or a split), and the undo or redo that puts the separator back puts the
  // model back. This runs inside the history's update: only `tr.startState`
  // holds the deleted models.
  provide: (field) => invertedEffects.of((tr) => {
    const separators = deletedSeparators(tr)
    if (separators.length === 0) return []
    const models = tr.startState.field(field)
    const restored = separators.flatMap(({ pos, index }) => (models[index] ? [{ pos, model: models[index] }] : []))
    return restored.length > 0 ? [restoreSectionModelsEffect.of(restored)] : []
  }),
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
 *  streamed tokens) skip the full-doc scan.
 *
 *  A change that starts at the end of a pill's body and deletes past the
 *  pill keeps the pill: it removes the hidden close marker, but no body
 *  text. A selection from the end of an expanded body to after the pill
 *  gives such a change (Delete, cut, typing over it), because CodeMirror
 *  only moves a selection end that is strictly inside an atomic range,
 *  and the close marker's range starts at the body end. The filter puts
 *  the marker back at the change start, before any inserted text (which
 *  can hold separators or pills that would break the pill again), so the
 *  caret stays at the body end. A change that deletes only the close
 *  marker (Backspace after it) still unwraps the pill. */
export const unwrapBrokenPills = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  let touchesSentinel = false
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    touchesSentinel ||= SENTINEL_CHAR.test(tr.startState.sliceDoc(fromA, toA)) || SENTINEL_CHAR.test(inserted.toString())
  })
  if (!touchesSentinel) return tr
  const startPills = scanPills(tr.startState.doc.toString())
  const keptCloseMarkers: { from: number; insert: string }[] = []
  tr.changes.iterChanges((fromA, toA, fromB) => {
    if (startPills.some((pill) => pill.bodyTo === fromA && toA > pill.to)) keptCloseMarkers.push({ from: fromB, insert: PILL_CLOSE })
  })
  const keep = ChangeSet.of(keptCloseMarkers, tr.newDoc.length)
  const unwrap = brokenPillMarkerChanges(keep.apply(tr.newDoc).toString())
  const specs: TransactionSpec[] = [tr]
  if (!keep.empty) specs.push({ changes: keep, sequential: true })
  if (unwrap.length > 0) specs.push({ changes: unwrap, sequential: true })
  return specs
})

/* ──────────────────────  Role separator widget  ─────────────── */

class RoleSeparatorWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly role: Role,
    readonly chip: ModelChip | null,
    /** The reply time of an agent section, or null for none. */
    readonly durationMs: number | null,
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
      sameModelChip(other.chip, this.chip) &&
      other.durationMs === this.durationMs
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
    if (this.durationMs !== null) addDurationToPill(label, this.durationMs)
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
 *  a pill is the section after it; section 0 has no separator. Only agent
 *  pills show a reply time (it is agent-only). */
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
    const nextSection = models[sectionIndex]
    const nextRole = nextSection?.role ?? 'user'
    const durationMs = nextRole === 'agent' ? nextSection?.durationMs ?? null : null
    ranges.push({
      from: i,
      to: i + 1,
      deco: Decoration.replace({
        widget: chips
          ? new RoleSeparatorWidget(sectionIndex, nextRole, chips[sectionIndex] ?? null, durationMs)
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

/** Click handler: a mousedown anywhere on an agent pill that shows a
 *  disclosure triangle, its model part and reply time too, opens or closes
 *  its thinking panel. A press on any other pill does nothing. Every pill
 *  takes the mousedown, so a press on a pill keeps the caret and the focus
 *  where they are. */
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
    const thinking = pillThinkingAt(view.state, index)
    const sectionId = view.state.field(sectionsField)[index]?.id
    if (thinking && hasThinking(thinking) && sectionId) {
      view.dispatch({ effects: toggleThinkingExpandedEffect.of(sectionId) })
    }
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
  return pillMarkerText(section ?? { role: 'user' })
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
  let out = from === 0 ? `${pillMarkerText({ role: 'user' })}\n` : ''
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
 *  markers, no thinking, agent text with no tool blocks, and each clip as a
 *  link (`sectionTextAsMarkdown`). A prompt pill, whole or in part,
 *  gives its body text. A range that holds a role pill gives its section
 *  parts as `messagesAsMarkdown` gives them, so a whole tab copies as Save
 *  As Markdown saves it (without the title): a part gets its role heading only
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
  const firstSection = sectionIndexAtOffset(doc, from)
  const texts = parts.map((text, index) => sectionTextAsMarkdown(models[firstSection + index]?.role ?? 'user', text))
  if (from > 0 && texts.length === 1) return texts[0]
  return messagesAsMarkdown(texts.map((text, index): MarkdownMessage => {
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
  separators: Pick<SectionModel, 'role' | 'model' | 'thinking' | 'durationMs'>[]
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
          ...durationField(pill.marker.durationMs ?? undefined),
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
 *  model, duration, and thinking. Markers at the very start of the paste
 *  are dropped, so the paste joins the section at the caret. In a pill
 *  body, pasted prompts and section markers would nest a pill or split this
 *  one, so the paste is plain text there. */
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
    userEvent: 'input.paste',
  }
}

/* ───────────────────────  Theme / language  ──────────────────── */

export function buildInitialDoc(sections: Section[]): string {
  return sectionsToDoc(sections)
}

/** The padding above and below the doc inside the editor scroller. */
export const SCROLLER_PADDING_PX = 16

/** Scroll positions can be fractions of a pixel: a view this close to its
 *  bottom is at its bottom. */
export const AT_BOTTOM_PX = 1

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
// (`EDITOR_FONT_SIZE_PROPERTY`, set by `dez.ui/applyEditorFontSize`), so text,
// pills, the thinking panel and tables grow and shrink together.
// `editorSize(px)` is `px` at the default font size and scales with the font
// size. The text and the spacing around it scale; hairline borders and the
// scroller padding (`SCROLLER_PADDING_PX`, `TEXT_GUTTER`) do not.
const EDITOR_FONT_SIZE_VAR = `var(${EDITOR_FONT_SIZE_PROPERTY}, ${EDITOR_FONT_SIZE_DEFAULT}px)`

function editorSize(...px: number[]): string {
  return px.map((value) => `calc(${EDITOR_FONT_SIZE_VAR} * ${value} / ${EDITOR_FONT_SIZE_DEFAULT})`).join(' ')
}

/** `editorSize(px)` as a number, at the editor font size of now, for code
 *  that needs the size in JS. It reads the inline style that
 *  `dez.ui/applyEditorFontSize` puts on `<html>`, so it causes no style
 *  recalculation. With no style yet, it is `px`, like the CSS fallback. */
export function editorSizePx(px: number): number {
  const fontSize = parseFloat(document.documentElement.style.getPropertyValue(EDITOR_FONT_SIZE_PROPERTY)) || EDITOR_FONT_SIZE_DEFAULT
  return px * fontSize / EDITOR_FONT_SIZE_DEFAULT
}

// Each heading level has its own tag (`t.heading1` to `t.heading6`), and a
// highlight style uses only the most specific rule of a tag, so each level
// rule sets the heading color and weight too. Its size is on every span of
// the heading line, hash marks included, so the whole line scales. The
// level 1 size is 1.4 times the body text; level 6 is the body size.
const HEADING_STYLE = { color: 'var(--color-text)', fontWeight: '600' }

// A block node (`Blockquote/...`, `BulletList/...`, `ATXHeading1/...`) adds
// its class to every span inside it, and every rule here has the same CSS
// specificity, so when two rules set the same property the later rule wins.
// The block rules come first so that inline code and links keep their own
// color inside lists, quotes, and headings.
export const dezHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, ...HEADING_STYLE, fontSize: editorSize(21) },
  { tag: t.heading2, ...HEADING_STYLE, fontSize: editorSize(19.5) },
  { tag: t.heading3, ...HEADING_STYLE, fontSize: editorSize(18) },
  { tag: t.heading4, ...HEADING_STYLE, fontSize: editorSize(17) },
  { tag: t.heading5, ...HEADING_STYLE, fontSize: editorSize(16) },
  { tag: t.heading6, ...HEADING_STYLE, fontSize: editorSize(15) },
  { tag: t.quote, color: 'var(--color-muted, #888)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--color-text)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--color-link, #4a9eff)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--color-link, #4a9eff)' },
  { tag: t.monospace, fontFamily: 'inherit', color: 'var(--color-code, #c792ea)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.meta, color: 'var(--color-muted, #888)' },
])

// Height of a table's delimiter row in em of the editor font. Thin, as it
// draws no text, but tall enough for a caret that the user can see.
const TABLE_DELIMITER_ROW_EM = 0.6

/** The max height of an image in the editor (`src/view/editor/images.ts`),
 *  in px at the default font size. */
export const IMAGE_MAX_HEIGHT_PX = 320

const UI_FONT_FAMILY = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

export const dezTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
    fontSize: EDITOR_FONT_SIZE_VAR,
  },
  '.cm-scroller': {
    fontFamily: MONO_FONT_FAMILY,
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
    fontFamily: UI_FONT_FAMILY,
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
    fontFamily: UI_FONT_FAMILY,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  '.dez-role-separator__label': {
    padding: editorSize(2, 10),
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    cursor: 'default',
  },
  // Only a pill with a thinking triangle does something on a click
  // (`roleSeparatorMouseHandler`): the whole pill opens or closes the panel.
  '.dez-role-separator__label:has(> .dez-role-separator__disclosure)': {
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
  // The thin divider before the model part and before the reply time.
  '.dez-role-separator__model::before, .dez-role-separator__duration::before': {
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
  // Reply time (`addDurationToPill` in pillDuration.ts) at the end of an
  // agent pill: after the model part, or after the role word in a pill with
  // no model. Muted, smaller than the model name, and set off by the same
  // divider, so it reads as secondary. Tabular numerals keep times of the
  // same form the same width. It keeps its own case and spacing in the
  // uppercase row ("4.2s", not "4.2S"). A line height of 1 keeps it inside
  // the role word's line box, so the pill is as tall as one with no time.
  // `flex: none` makes a long model name shrink first.
  '.dez-role-separator__duration': {
    display: 'inline-flex',
    alignItems: 'baseline',
    flex: 'none',
    gap: editorSize(6),
    marginLeft: editorSize(8),
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(11),
    lineHeight: '1',
    letterSpacing: 'normal',
    textTransform: 'none',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  // Left slot of an agent pill (`thinkingPill.ts`): a spinner while the
  // section streams and has no thinking yet, then a disclosure triangle
  // that opens the thinking panel. Both fit in the line box of the role
  // word, so the pill keeps its height. The triangle has padding with a
  // negative margin: a larger target that does not grow the pill. Under
  // reduced motion the spinner does not turn (see the media query below).
  // A running tool call chip (`toolCalls.ts`) has the same spinner.
  '.dez-role-separator__spinner, .dez-tool-call__spinner': {
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
  // own row below the pill. Its read-only textarea is as tall as its text,
  // so the panel scrolls past its max height, not the textarea. Where the
  // engine has `field-sizing`, the textarea sizes itself (the `@supports`
  // block below). Elsewhere (WKWebView before Safari 26.2), a hidden mirror
  // of the text and the textarea share one grid cell, so the cell, and with
  // it the textarea, is as tall as the text; both need the same font,
  // padding and wrapping rules for that. The encrypted pill, when there is
  // one, comes after the text. The separator row is uppercase,
  // letter-spaced and not selectable; the panel resets all three. The
  // result field of a tool call panel (`.dez-tool-call__result`, further
  // down) shares the field rules.
  '.dez-role-separator[data-thinking-open]': {
    flexWrap: 'wrap',
  },
  '.dez-role-separator__thinking': {
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
  // Both panels are a grid for the mirror path. This rule must come before
  // the `@supports` block below, which makes them blocks: a later rule of
  // the same weight would put the grid back, and the result would get the
  // wrong `field-sizing` height and could not scroll.
  '.dez-role-separator__thinking, .dez-tool-call__result': {
    display: 'grid',
  },
  // CM's `hideNativeSelection` paints the native selection of a focused
  // field in the editor with the OS `Highlight` color, `!important`. In
  // WebKitGTK that is a strong blue, and the muted panel text on it is
  // unreadable, so the panel uses the editor's selection color instead. One
  // more class than CM's `.cm-content :focus::selection` makes this win.
  '.cm-content .dez-role-separator__thinking-text:focus::selection, .cm-content .dez-tool-call__result-text:focus::selection': {
    backgroundColor: 'var(--color-selection, #d7d4f0) !important',
  },
  '.dez-role-separator__thinking-mirror, .dez-role-separator__thinking-text, .dez-tool-call__result-mirror, .dez-tool-call__result-text': {
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
  '.dez-role-separator__thinking-mirror, .dez-tool-call__result-mirror': {
    visibility: 'hidden',
  },
  // A text that ends in a newline shows an empty last line in the textarea,
  // but in the mirror only when something follows the newline.
  '.dez-role-separator__thinking-mirror::after, .dez-tool-call__result-mirror::after': {
    content: '" "',
  },
  '.dez-role-separator__thinking-text, .dez-tool-call__result-text': {
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
  // The encrypted pill stands in for the encrypted lines that the panel
  // leaves out. Small and muted with a rounded border, like the secondary
  // parts of the role pill, and left-aligned with the text. A block with
  // `fit-content` width keeps that shape in a grid or a block panel.
  // WebKitGTK 2.54 reads only the prefixed `user-select`.
  '.dez-role-separator__thinking-encrypted': {
    display: 'block',
    gridRow: '2',
    width: 'fit-content',
    margin: editorSize(0, 12, 8),
    padding: editorSize(1, 8),
    border: '1px solid var(--color-border, #333)',
    borderRadius: '999px',
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(11),
    lineHeight: '1.5',
    cursor: 'default',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  // One text layout where the engine has `field-sizing`: the textarea grows
  // to fit its text and the mirror gets no layout, so a panel open lays out
  // the text once, not twice. The mirror's layout was the slower one, as
  // WebKit wraps a long run with no break points slowly. The panel must be
  // a block: in a grid, `field-sizing` gave the textarea a wrong height
  // (WebKitGTK 2.54). `setPanelText` keeps the mirror's text as the record
  // of the shown text on both paths.
  '@supports (field-sizing: content)': {
    '.dez-role-separator__thinking, .dez-tool-call__result': {
      display: 'block',
    },
    '.dez-role-separator__thinking-mirror, .dez-tool-call__result-mirror': {
      display: 'none',
    },
    '.dez-role-separator__thinking-text, .dez-tool-call__result-text': {
      display: 'block',
      height: 'auto',
      fieldSizing: 'content',
    },
  },
  // Rules that move things on screen are only in this block, so they apply
  // only when the user has not asked for reduced motion. The base rules of
  // the same elements keep what does not move (fades, colors). The theme is
  // one object, which can hold this key only once, so the block also holds
  // the motion of elements styled further down.
  '@media (prefers-reduced-motion: no-preference)': {
    // "Generating" state of the pill whose response is streaming
    // (`data-streaming`): a soft ring around the pill breathes in and out,
    // and a highlight sweeps across the model name, both in the agent
    // accent. The ring is a pseudo-element that animates only its opacity.
    // The name shimmer is a gradient clipped to the text: twice the name's
    // width, so each loop is one sweep plus a pause. Streamed text tokens
    // keep the widget (`eq`), and `pillThinkingUpdater` changes the thinking
    // parts in place, so the animations run without restarts until the
    // stream ends. The left-slot spinner turns here too, and so do the
    // spinner and the name shimmer of a running tool call chip.
    '.dez-role-separator__spinner, .dez-tool-call__spinner': {
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
    '.dez-role-separator__label[data-streaming] .dez-role-separator__model-name, .dez-tool-call[data-state="running"] .dez-tool-call__name': {
      color: 'transparent',
      backgroundImage:
        'linear-gradient(90deg, var(--color-text) 40%, var(--color-link, #4a9eff) 50%, var(--color-text) 60%)',
      backgroundSize: '200% 100%',
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      animation: 'dez-role-pill-shimmer 2.4s linear infinite',
    },
    // The image toolbar (`.dez-image__overlay` below) drops into place from
    // its top-right corner as it fades in, and its trash gets a little
    // smaller while pressed.
    '.dez-image__overlay': {
      transform: `translateY(${editorSize(-4)}) scale(0.97)`,
      transformOrigin: 'top right',
    },
    '.dez-image:hover .dez-image__overlay': {
      transform: 'none',
    },
    '.dez-image__trash:active': {
      transform: 'scale(0.92)',
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
    fontFamily: UI_FONT_FAMILY,
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
  // Images (src/view/editor/images.ts). The widget's root is an inline-block
  // as big as its image, so that the overlay can sit over the image. Its
  // `max-width` keeps it inside the line, and as a shrink-to-fit box it is
  // as wide as the image's own width (limited by the max height through the
  // aspect ratio), so the image's `100%` is never wider than the line: a
  // wide image still shrinks to the line, and a tall one keeps its ratio
  // (checked in WebKitGTK 2.54). It is bottom-aligned, and the image in it
  // is a block, so the line is exactly as tall as the image.
  '.dez-image': {
    display: 'inline-block',
    position: 'relative',
    maxWidth: '100%',
    verticalAlign: 'bottom',
  },
  // Once the natural size of an image is known, the widget sets it as
  // `--dez-image-width` / `--dez-image-height`, and the box gets its size
  // from it even before the image loads (a widget drawn again): as wide as
  // the image, the line, or the width that gives the max height, whichever
  // is smallest, at the image's aspect ratio. Before that, the variables are
  // unset, so `width` and `aspect-ratio` are invalid and fall back to
  // `auto`, and the max sizes fit the image.
  '.dez-image__img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: editorSize(IMAGE_MAX_HEIGHT_PX),
    width: `min(calc(var(--dez-image-width) * 1px), 100%, calc(${editorSize(IMAGE_MAX_HEIGHT_PX)} * var(--dez-image-width) / var(--dez-image-height)))`,
    height: 'auto',
    aspectRatio: 'var(--dez-image-width) / var(--dez-image-height)',
    borderRadius: editorSize(6),
  },
  '.dez-image-missing': {
    display: 'inline-block',
    padding: editorSize(1, 8),
    borderRadius: editorSize(6),
    border: '1px dashed var(--color-border, #333)',
    color: 'var(--color-muted, #888)',
    fontFamily: UI_FONT_FAMILY,
    fontSize: editorSize(12),
    lineHeight: '1.4',
    userSelect: 'none',
  },
  // The overlay of an image (`ImageWidget`): one small floating toolbar with
  // the id badge and the trash button, shown only while the pointer is over
  // the image, and never a part of the layout, so a hover changes no size.
  // Its glass surface is dark in both themes, with white text, a hairline
  // border, and a shadow, so it reads on light, dark, and busy images.
  //
  // Over an image, it sits at the right end of a row along the image's top
  // edge, inset as far from the top as from the right, and draws over the
  // lines below. Over an image narrower than the toolbar, its auto margin
  // becomes 0: it starts at the image's left inset and hangs out on the
  // right. Images are mostly at the start of their line, where a toolbar
  // that hung out on the left would go out of the editor. Anything that
  // hangs out of the scroller on the right (a small image at a line's end in
  // a narrow window) adds a horizontal scrollbar, even while it is hidden.
  '.dez-image__overlay-row': {
    position: 'absolute',
    top: editorSize(8),
    left: editorSize(8),
    right: editorSize(8),
    zIndex: '2',
    display: 'flex',
    pointerEvents: 'none',
  },
  '.dez-image__overlay': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: editorSize(3),
    marginLeft: 'auto',
    padding: editorSize(3),
    borderRadius: editorSize(9),
    border: '1px solid var(--color-image-toolbar-border, rgba(255, 255, 255, 0.18))',
    background: 'var(--color-image-toolbar, rgba(18, 18, 22, 0.72))',
    color: '#fff',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.22), 0 6px 18px rgba(0, 0, 0, 0.24)',
    WebkitBackdropFilter: 'blur(14px) saturate(130%)',
    backdropFilter: 'blur(14px) saturate(130%)',
    fontFamily: UI_FONT_FAMILY,
    fontSize: editorSize(12.5),
    lineHeight: '1',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    pointerEvents: 'auto',
    cursor: 'default',
    opacity: '0',
    // The entrance: a fade, and a slide in the
    // `prefers-reduced-motion: no-preference` block above. That block comes
    // first in the stylesheet, so a `transition` there would lose to this
    // one. This one names `transform` too, which moves nothing when no
    // transform is set.
    transition: 'opacity 0.14s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  '.dez-image:hover .dez-image__overlay': {
    opacity: '1',
  },
  // In the "Image not found" box, the toolbar follows the text and keeps
  // its room while hidden. It is taller than the box's line; its negative
  // margins keep it from making the box taller, so it overlaps the box's
  // top and bottom edges.
  '.dez-image-missing > .dez-image__overlay': {
    margin: editorSize(-9, 0, -9, 8),
    verticalAlign: 'middle',
  },
  // The id reads as a label of the image: an image icon, then the id. The
  // `::after` is the divider in the middle of the gap before the trash.
  '.dez-image__id': {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: editorSize(5),
    boxSizing: 'border-box',
    height: editorSize(24),
    padding: editorSize(0, 8, 0, 7),
    fontWeight: '600',
    letterSpacing: '0.02em',
  },
  '.dez-image__id svg': {
    display: 'block',
    width: editorSize(14),
    height: editorSize(14),
    opacity: '0.72',
  },
  '.dez-image__id::after': {
    content: '""',
    position: 'absolute',
    top: '25%',
    bottom: '25%',
    right: `calc(${editorSize(-1.5)} - 0.5px)`,
    width: '1px',
    background: 'var(--color-image-toolbar-border, rgba(255, 255, 255, 0.18))',
  },
  // Its corners follow the toolbar's: toolbar radius minus its padding.
  '.dez-image__trash': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: editorSize(24),
    height: editorSize(24),
    margin: '0',
    padding: '0',
    border: 'none',
    borderRadius: editorSize(6),
    background: 'transparent',
    color: 'rgba(255, 255, 255, 0.92)',
    font: 'inherit',
    cursor: 'pointer',
    transition: 'background-color 0.12s ease, color 0.12s ease, transform 0.08s ease',
  },
  '.dez-image__trash svg': {
    display: 'block',
    width: editorSize(15),
    height: editorSize(15),
  },
  '.dez-image__trash:hover': {
    background: 'var(--color-error-fill, #c4302b)',
    color: '#fff',
  },
  // Pressed: the fill a little darker (and the button a little smaller, in
  // the `prefers-reduced-motion: no-preference` block above).
  '.dez-image__trash:active': {
    boxShadow: 'inset 0 0 0 999px rgba(0, 0, 0, 0.16)',
  },
  // Tool call chips (src/view/editor/toolCalls.ts). The widget is the only
  // thing on its line: a column as wide as the line, with the chip, and
  // under it the panel while open. The chip is quiet, as most calls are not
  // read: no border, a faint fill, muted text, and only the tool name in
  // the text color. The widget is not selectable (WebKitGTK 2.54 reads only
  // the prefixed `user-select`), except for the result field.
  '.dez-tool-call': {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    boxSizing: 'border-box',
    width: '100%',
    padding: editorSize(5, 0),
    verticalAlign: 'top',
    fontFamily: UI_FONT_FAMILY,
    lineHeight: '1.5',
    letterSpacing: 'normal',
    whiteSpace: 'normal',
    cursor: 'default',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.dez-tool-call__chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: editorSize(6),
    boxSizing: 'border-box',
    maxWidth: '100%',
    padding: editorSize(2, 10, 2, 8),
    borderRadius: editorSize(6),
    background: 'color-mix(in srgb, var(--color-text) 5%, transparent)',
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(13),
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: 'none',
    transition: 'background-color 0.12s ease',
  },
  '.dez-tool-call__chip:hover': {
    background: 'color-mix(in srgb, var(--color-text) 9%, transparent)',
  },
  '.dez-tool-call__chip:focus-visible': {
    boxShadow: '0 0 0 2px var(--color-link, #4a9eff)',
  },
  // The spinner shares the role pill spinner's rules (above); in the chip,
  // the gap spaces it.
  '.dez-tool-call__spinner': {
    marginRight: '0',
  },
  '.dez-tool-call__disclosure': {
    flex: 'none',
    width: editorSize(9),
    fontSize: editorSize(9),
    lineHeight: '1',
    textAlign: 'center',
  },
  '.dez-tool-call[data-open] .dez-tool-call__disclosure': {
    transform: 'rotate(90deg)',
  },
  '.dez-tool-call__icon': {
    display: 'inline-flex',
    flex: 'none',
  },
  '.dez-tool-call__icon svg': {
    display: 'block',
    width: editorSize(13),
    height: editorSize(13),
  },
  '.dez-tool-call__name': {
    flex: 'none',
    color: 'var(--color-text)',
    fontFamily: MONO_FONT_FAMILY,
    fontWeight: '600',
  },
  '.dez-tool-call__summary': {
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontFamily: MONO_FONT_FAMILY,
  },
  // Only a failed call, or a call that the app stopped while it ran
  // (`interrupted`, which requests send as an error), has a state word.
  // These show the word, the wrench, and the name in the error color.
  '.dez-tool-call__state': {
    flex: 'none',
    color: 'var(--color-error, #d9534f)',
    fontSize: editorSize(11.5),
  },
  '.dez-tool-call[data-state="error"] .dez-tool-call__icon, .dez-tool-call[data-state="error"] .dez-tool-call__name, .dez-tool-call[data-state="interrupted"] .dez-tool-call__icon, .dez-tool-call[data-state="interrupted"] .dez-tool-call__name': {
    color: 'var(--color-error, #d9534f)',
  },
  // The panel hangs from the disclosure triangle by a thin rule: the
  // parameters as name and value rows, then the result in a read-only
  // field. The field scrolls past about 16 lines.
  '.dez-tool-call__panel': {
    display: 'flex',
    flexDirection: 'column',
    alignSelf: 'stretch',
    gap: editorSize(4),
    margin: editorSize(6, 0, 4, 12),
    padding: editorSize(0, 0, 2, 13),
    borderLeft: '1px solid var(--color-border, #333)',
    color: 'var(--color-muted, #888)',
    fontSize: editorSize(13),
  },
  '.dez-tool-call__heading': {
    fontSize: editorSize(11),
    fontWeight: '600',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  '.dez-tool-call__heading:not(:first-child)': {
    marginTop: editorSize(6),
  },
  '.dez-tool-call__parameters': {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: editorSize(16),
    rowGap: editorSize(2),
    fontFamily: MONO_FONT_FAMILY,
    fontSize: editorSize(12.5),
  },
  '.dez-tool-call__parameter-value': {
    color: 'var(--color-text)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  '.dez-tool-call__result': {
    alignSelf: 'stretch',
    minWidth: '0',
    maxHeight: '24em',
    overflowY: 'auto',
    overflowAnchor: 'none',
    boxSizing: 'border-box',
    border: '1px solid var(--color-border, #333)',
    borderRadius: editorSize(8),
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-text)',
    fontFamily: MONO_FONT_FAMILY,
    fontSize: editorSize(12.5),
    lineHeight: '1.5',
    cursor: 'auto',
    userSelect: 'text',
    WebkitUserSelect: 'text',
  },
  '.dez-tool-call__result:focus-within': {
    borderColor: 'var(--color-link, #4a9eff)',
  },
  '.dez-tool-call__result[data-error]': {
    borderColor: 'var(--color-error-border, #d9534f)',
    background: 'var(--color-error-bg, rgba(217,83,79,0.08))',
    color: 'var(--color-error, #d9534f)',
  },
  // Media players (src/view/editor/media.ts). The widget is the only thing
  // on its line, as a tool call chip is. The player inside is a Vue
  // component with its own scoped CSS (src/view/media/MediaPlayer.vue),
  // which does not import this module: these two variables give it the
  // editor font scale, and the max height that an image has too.
  '.dez-media': {
    '--dez-media-unit': editorSize(1),
    '--dez-media-max-height': editorSize(IMAGE_MAX_HEIGHT_PX),
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    boxSizing: 'border-box',
    width: '100%',
    padding: editorSize(6, 0),
    verticalAlign: 'top',
    fontFamily: UI_FONT_FAMILY,
    lineHeight: '1.5',
    letterSpacing: 'normal',
    whiteSpace: 'normal',
    cursor: 'default',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  // Rendered links (src/view/editor/links.ts): only the link text shows. An
  // autolink's address has the `t.url` style of `dezHighlightStyle`, which
  // has no underline, so the underline is set here too.
  '.dez-link': {
    color: 'var(--color-link, #4a9eff)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  // CodeMirror tooltips (the link URL tooltip of links.ts and the image
  // overlay tooltips of images.ts), with the text style they share. CM's
  // base theme gives them light colors only, as Dez does not use CM's dark
  // theme flag.
  '.cm-tooltip': {
    border: '1px solid var(--color-border, #333)',
    borderRadius: editorSize(6),
    backgroundColor: 'var(--color-bg, #1e1e1e)',
    color: 'var(--color-text)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
    fontFamily: UI_FONT_FAMILY,
    fontSize: editorSize(12),
    lineHeight: '1.4',
  },
  // A long URL wraps at any char, as most URLs have no spaces.
  '.dez-link-tooltip': {
    maxWidth: `min(${editorSize(480)}, calc(100vw - 32px))`,
    padding: editorSize(3, 8),
    overflowWrap: 'anywhere',
  },
  // The tooltip of an image overlay item (images.ts): its name, then what it
  // is for. The pointer goes through it, so it never takes the hover from
  // its item.
  '.dez-image-tooltip': {
    maxWidth: `min(${editorSize(280)}, calc(100vw - 32px))`,
    padding: editorSize(6, 10, 7),
    pointerEvents: 'none',
  },
  '.dez-image-tooltip__title': {
    fontWeight: '600',
  },
  '.dez-image-tooltip__text': {
    marginTop: editorSize(2),
    opacity: '0.8',
  },
  '.dez-image-tooltip code': {
    padding: editorSize(0, 3),
    borderRadius: editorSize(3),
    background: 'rgba(127, 127, 127, 0.18)',
    fontFamily: MONO_FONT_FAMILY,
    fontSize: '0.95em',
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
  // horizontal cell padding, the hanging indent, and the column widths are
  // inline styles from `tables.ts`, as they depend on each cell's source.
  '.dez-table': {
    display: 'table',
    borderCollapse: 'separate',
    borderSpacing: '0',
    padding: `${editorSize(6)} 0`,
  },
  '.cm-line.dez-table-row': {
    display: 'table-row',
  },
  // `pre-wrap`, not CM's `break-spaces`: the space at the end of a wrapped
  // line hangs, as the hidden padding at the end of the last line does, so
  // every line of a right-aligned or centered cell lines up.
  '.dez-table-cell': {
    display: 'table-cell',
    verticalAlign: 'top',
    paddingTop: editorSize(4),
    paddingBottom: editorSize(4),
    borderRight: '1px solid var(--color-border, #333)',
    borderBottom: '1px solid var(--color-border, #333)',
    whiteSpace: 'pre-wrap',
  },
  // A cell's padding spaces take no room. The editor font is monospace, so
  // `-1ch` cancels each char's advance; the chars keep their font size, so
  // the caret in them keeps its height (`font-size: 0` gives a 0px caret).
  '.dez-table-pad': {
    letterSpacing: '-1ch',
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
  // size at line height 1. Its dashes, colons, and spaces take no room (as
  // `.dez-table-pad`), so they never widen a column or wrap, and the row
  // stays one thin line; its pipes keep their width. The `*` covers syntax
  // and find marks nested inside a cell.
  '.dez-table-row--delimiter .dez-table-cell': {
    paddingTop: '0',
    paddingBottom: '0',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    fontSize: `${TABLE_DELIMITER_ROW_EM}em`,
    lineHeight: '1',
    letterSpacing: '-1ch',
  },
  '.dez-table-row--delimiter .dez-table-pipe': {
    letterSpacing: 'normal',
  },
  '.dez-table-row--delimiter .dez-table-cell, .dez-table-row--delimiter .dez-table-cell *': {
    color: 'transparent',
  },
  // Splitting pipes keep their width (they hang into the cells' insets) but
  // are invisible. The `*` covers syntax highlight spans nested inside a
  // pipe mark.
  '.dez-table-pipe, .dez-table-pipe *': {
    color: 'transparent',
  },
})

// The editor parses all sections as one markdown text, but each section is
// its own markdown text. Without this extension an open paragraph runs on
// through a separator line into the next sections (lezer's lazy paragraph
// continuation), and so does the quote or list item that holds it: a reply
// that ends in `> quote` shows the next user message as a quote. A
// separator line ends the open paragraph (`endLeaf`); the quotes and lists
// around it then close, as the line has none of their markup. The line
// itself becomes a `SectionSeparator` block, so the next section's first
// line never joins it (a `---` there is a rule, not a setext underline).
// `findMarkdownTables` (`tables.ts`) splits sections the same way.
// An unclosed code fence or HTML block still runs into the next sections:
// lezer reads their lines in its own loop, which stops only at their end
// or at the end of a quote or list around them, never at `endLeaf`.
const sectionSeparatorMarkdown: MarkdownConfig = {
  defineNodes: [{ name: 'SectionSeparator', block: true }],
  parseBlock: [{
    name: 'SectionSeparator',
    before: 'LinkReference',
    parse(cx, line) {
      if (line.text !== SECTION_SEP) return false
      cx.addElement(cx.elt('SectionSeparator', cx.lineStart, cx.lineStart + line.text.length))
      cx.nextLine()
      return true
    },
    endLeaf: (_cx, line) => line.text === SECTION_SEP,
  }],
}

export function dezLanguageSupport(): Extension {
  return [markdown({ extensions: sectionSeparatorMarkdown }), syntaxHighlighting(dezHighlightStyle)]
}
