import { selectAll } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, WidgetType, type DecorationSet, type KeyBinding } from '@codemirror/view'
import { EditorSelection, EditorState, StateEffect, StateField, findClusterBreak, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import type { ContentNode, Role, Section } from '../../model/chat/types'
import { SENTINEL_CHAR, normalizeContent, stripLiveSentinels, textNode } from '../../model/chat/content'

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
 *  store. */
export const PILL_OPEN = '\u{E000}'
export const PILL_BODY = '\u{E001}'
export const PILL_CLOSE = '\u{E002}'
export const PILL_NL = '\u{E003}'
// `SENTINEL_CHAR` and `stripLiveSentinels` in `src/model/chat/content.ts`
// match these code points and `SECTION_SEP`; change them together.

/** Lightweight mirror of a Section kept in the CM state. The CM doc is the
 *  source of truth for text; this field just tracks per-section identity
 *  (id) and role. */
export interface SectionModel {
  id: string
  role: Role
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
    {
      linux: 'Meta-a',
      preventDefault: true,
      run: selectAll,
    },
    {
      linux: 'Alt-a',
      preventDefault: true,
      run: selectAll,
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

function normalizeSectionModels(models: SectionModel[]): SectionModel[] {
  if (models.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  if (models[0].role === 'user') return models
  const copy = models.slice()
  copy[0] = { ...copy[0], role: 'user' }
  return copy
}

/** Produce `{ id, role }` for each section to seed `sectionsField`. */
export function initialSectionModels(sections: Section[]): SectionModel[] {
  if (sections.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  return normalizeSectionModels(sections.map((s) => ({ id: s.id, role: s.role })))
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
    const model = reconciledModels[i]
    return {
      id: model.id,
      role: i === 0 ? 'user' : model.role,
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
export const setShowSeparatorsEffect = StateEffect.define<boolean>()

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

/* ──────────────────────  visibility field  ─────────────────── */

export const showSeparatorsField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setShowSeparatorsEffect)) return e.value
    }
    return value
  },
})

export const leadingPillContentAttributes = EditorView.contentAttributes.compute(
  [showSeparatorsField],
  (state) => ({ class: state.field(showSeparatorsField) ? 'dez-has-leading-pill' : '' }),
)

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
  constructor(readonly index: number, readonly role: Role) {
    super()
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof RoleSeparatorWidget &&
      other.index === this.index &&
      other.role === this.role
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'dez-role-separator'
    el.setAttribute('data-section-index', String(this.index))
    el.setAttribute('data-role', this.role)
    const label = document.createElement('span')
    label.className = 'dez-role-separator__label'
    label.textContent = this.role === 'user' ? 'User' : 'Agent'
    el.appendChild(label)
    return el
  }
  ignoreEvent(): boolean {
    // Let mousedown/click bubble to the view so our domEventHandler runs.
    return false
  }
}

/** Build the decoration set for the current doc. Each `\u001E` line is
 *  replaced with a block separator widget whose role/index come from the
 *  sectionsField. Returns an empty set when separators are hidden. */
function buildSeparatorDecorations(
  doc: string,
  models: SectionModel[],
  show: boolean,
  protectOnly = false,
): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  if (!show) return Decoration.set(ranges.map((b) => b.deco.range(b.from, b.to)), true)
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
        widget: protectOnly ? undefined : new RoleSeparatorWidget(sectionIndex, nextRole),
        inclusive: false,
      }),
    })
  }
  return Decoration.set(
    ranges.map((b) => b.deco.range(b.from, b.to)),
    true,
  )
}

export const roleSeparators = EditorView.decorations.compute(
  [sectionsField, showSeparatorsField, 'doc'],
  (state) => {
    const models = state.field(sectionsField)
    const show = state.field(showSeparatorsField)
    return buildSeparatorDecorations(state.doc.toString(), models, show)
  },
)

export const roleSeparatorAtomicRanges = EditorView.atomicRanges.of((view) =>
  buildSeparatorDecorations(
    view.state.doc.toString(),
    view.state.field(sectionsField),
    true,
    true,
  ),
)

/** Click handler: toggle the role of the section that the clicked
 *  separator precedes. */
export const roleSeparatorMouseHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null
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

function escapePromptName(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function unescapePromptName(name: string): string {
  return name.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

function escapePromptClipboardBody(body: string): string {
  return body.replace(/<\/dez:prompt>/g, '<\\/dez:prompt>')
}

function unescapePromptClipboardBody(body: string): string {
  return body.replace(/<\\\/dez:prompt>/g, '</dez:prompt>')
}

function sectionRoleForSeparator(doc: string, models: SectionModel[], pos: number): Role {
  let index = 1
  for (let i = 0; i < pos && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 0x1e) index++
  }
  return models[index]?.role ?? 'user'
}

function serializePlainDocFragment(doc: string, from: number, to: number, models: SectionModel[]): string {
  let out = ''
  for (let i = from; i < to; i++) {
    const c = doc[i]
    if (c === SECTION_SEP) {
      const role = sectionRoleForSeparator(doc, models, i)
      if (out.endsWith('\n')) out = out.slice(0, -1)
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      out += `<dez:pill type="${role}"/>\n`
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

export function serializeDocRangeForClipboard(
  doc: string,
  from: number,
  to: number,
  models: SectionModel[],
  pillsMeta: Map<string, PillMetadata>,
): string {
  if (from >= to) return ''
  const pills = scanPills(doc).filter((p) => p.to > from && p.from < to)
  let out = from === 0 ? '<dez:pill type="user"/>\n' : ''
  let cursor = from
  for (const p of pills) {
    if (cursor < Math.min(p.from, to)) {
      out += serializePlainDocFragment(doc, cursor, Math.min(p.from, to), models)
    }
    const meta = pillsMeta.get(p.id)
    const bodyFrom = Math.max(from, p.bodyFrom)
    const bodyTo = Math.min(to, p.bodyTo)
    if (from <= p.from && to >= p.to) {
      const body = doc.slice(p.bodyFrom, p.bodyTo).replace(/\u{E003}/gu, '\n')
      out += `<dez:prompt name="${escapePromptName(meta?.name ?? '')}">\n${escapePromptClipboardBody(body)}`
      if (!out.endsWith('\n')) out += '\n'
      out += '</dez:prompt>\n'
    } else if (bodyFrom < bodyTo) {
      out += doc.slice(bodyFrom, bodyTo).replace(/\u{E003}/gu, '\n')
    }
    cursor = Math.max(cursor, Math.min(p.to, to))
  }
  if (cursor < to) out += serializePlainDocFragment(doc, cursor, to, models)
  return stripLiveSentinels(out)
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
  separatorRoles: Role[]
}

/** Turn clipboard text (with `dez:` markers) into live-doc text: section
 *  markers become separators, prompt markup becomes collapsed pills. With
 *  `plainText`, the result holds no sentinels: prompt bodies are inlined
 *  and section markers dropped, for a paste inside a pill body, where a
 *  nested pill or a separator would break the pill. */
export function parseClipboardText(text: string, plainText = false): ParsedClipboardText {
  const pills = new Map<string, PillMetadata>()
  const separatorRoles: Role[] = []
  const marker = /<dez:pill\s+type="(user|agent)"\s*\/\>|<dez:prompt\s+name="([^"]*)">([\s\S]*?)<\/dez:prompt>/g
  let out = ''
  let cursor = 0
  for (const match of text.matchAll(marker)) {
    out += stripLiveSentinels(text.slice(cursor, match.index))
    let nextCursor = (match.index ?? 0) + match[0].length
    if (match[1]) {
      const role = match[1] as Role
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      if (!plainText) {
        out += `${SECTION_SEP}\n`
        separatorRoles.push(role)
      }
      if (text[nextCursor] === '\n') nextCursor++
    } else {
      const name = unescapePromptName(match[2] ?? '')
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
  return { text: out, pills, separatorRoles }
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

export const dezTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
    fontSize: '15px',
  },
  '.cm-scroller': {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: '1.6',
    padding: '16px',
  },
  '.cm-content': {
    maxWidth: '768px',
    margin: '0 auto',
    width: '100%',
    caretColor: 'var(--color-text)',
    padding: 0,
    position: 'relative',
  },
  '.cm-content.dez-has-leading-pill': {
    paddingTop: '46px',
  },
  '.cm-content.dez-has-leading-pill::before': {
    content: '"User"',
    position: 'absolute',
    top: '12px',
    left: '0',
    width: 'max-content',
    padding: '2px 10px',
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-muted, #888)',
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: '11px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-selection, rgba(100, 149, 237, 0.35))',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-selection, rgba(100, 149, 237, 0.35))',
  },
  '.cm-gutters': { display: 'none' },
  '.dez-role-separator': {
    display: 'inline-flex',
    alignItems: 'center',
    width: '100%',
    margin: '12px 0',
    padding: '0',
    userSelect: 'none',
    color: 'var(--color-muted, #888)',
    fontSize: '11px',
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  '.dez-role-separator__label': {
    padding: '2px 10px',
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    cursor: 'pointer',
  },
  '.dez-role-separator[data-role="agent"] .dez-role-separator__label': {
    color: 'var(--color-link, #4a9eff)',
    borderColor: 'var(--color-link, #4a9eff)',
  },
  '.dez-prompt-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 8px',
    margin: '0 1px',
    borderRadius: '999px',
    border: '1px solid var(--color-border, #333)',
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    color: 'var(--color-link, #4a9eff)',
    cursor: 'pointer',
    userSelect: 'none',
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontSize: '12px',
    lineHeight: '1.4',
    verticalAlign: 'baseline',
  },
  '.dez-prompt-pill__caret': {
    fontSize: '9px',
    opacity: '0.8',
  },
  '.dez-prompt-pill[data-expanded="1"]': {
    padding: '0 2px',
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
  // blue selection; the current match is stronger and outlined because the
  // selection under it looks the same focused or not.
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
  // scrolling drift. Cells draw the grid: right + bottom borders, plus top
  // on the header row and left on the first cell of each row.
  '.dez-table': {
    display: 'table',
    borderCollapse: 'separate',
    borderSpacing: '0',
    padding: '6px 0',
  },
  '.cm-line.dez-table-row': {
    display: 'table-row',
  },
  '.dez-table-cell': {
    display: 'table-cell',
    verticalAlign: 'top',
    padding: '0 0.5ch',
    borderRight: '1px solid var(--color-border, #333)',
    borderBottom: '1px solid var(--color-border, #333)',
  },
  '.dez-table-cell--first': {
    borderLeft: '1px solid var(--color-border, #333)',
  },
  '.dez-table-cell--center': { textAlign: 'center' },
  '.dez-table-cell--right': { textAlign: 'right' },
  '.dez-table-row--header .dez-table-cell': {
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
  // The `*` covers syntax and find marks nested inside a cell.
  '.dez-table-row--delimiter .dez-table-cell': {
    background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
    fontSize: '0.7em',
    lineHeight: '1.2',
  },
  '.dez-table-row--delimiter .dez-table-cell, .dez-table-row--delimiter .dez-table-cell *': {
    color: 'transparent',
  },
  // Splitting pipes keep their width (cell padding) but are invisible. The
  // `*` covers syntax highlight spans nested inside a pipe mark.
  '.dez-table-pipe, .dez-table-pipe *': {
    color: 'transparent',
  },
})

export function dezLanguageSupport(): Extension {
  return [markdown(), syntaxHighlighting(dezHighlightStyle)]
}
