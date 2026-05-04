import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import type { ContentNode, Role, Section } from '../types/chat'
import { normalizeContent, textNode } from '../types/content'

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

/** Lightweight mirror of a Section kept in the CM state. The CM doc is the
 *  source of truth for text; this field just tracks per-section identity
 *  (id) and role. */
export interface SectionModel {
  id: string
  role: Role
}

/** Metadata for a prompt pill, keyed by the in-doc pill id. The doc carries
 *  only the pill id + body text; name / promptId / expanded live here. */
export interface PillMetadata {
  promptId: string | null
  name: string
  expanded: boolean
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
    if (i > 0 && p.startsWith('\n')) p = p.slice(1)
    if (i < parts.length - 1 && p.endsWith('\n')) p = p.slice(0, -1)
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

/** Scan a string for well-formed prompt marker sequences. Malformed
 *  sequences (missing BODY or CLOSE, or a nested OPEN) are silently skipped
 *  so CM never crashes on partial edits. */
export function scanPills(doc: string): PillLocation[] {
  const out: PillLocation[] = []
  let i = 0
  while (i < doc.length) {
    if (doc[i] !== PILL_OPEN) { i++; continue }
    const from = i
    let j = from + 1
    let bodyAt = -1
    while (j < doc.length) {
      const c = doc[j]
      if (c === PILL_OPEN || c === PILL_CLOSE || c === '\n') break
      if (c === PILL_BODY) { bodyAt = j; break }
      j++
    }
    if (bodyAt < 0) { i = from + 1; continue }
    let k = bodyAt + 1
    let closeAt = -1
    while (k < doc.length) {
      const c = doc[k]
      if (c === PILL_OPEN) break
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

/** Decode a section fragment into interleaved text + prompt content nodes.
 *  Metadata (name / promptId / expanded) is looked up in `pillsMeta` by id;
 *  missing metadata degrades to empty name / null promptId / collapsed. */
function decodeSectionContent(
  fragment: string,
  pillsMeta: Map<string, PillMetadata>,
): ContentNode[] {
  const pills = scanPills(fragment)
  if (pills.length === 0) return normalizeContent([textNode(fragment)])
  const out: ContentNode[] = []
  let cursor = 0
  for (const p of pills) {
    out.push(textNode(fragment.slice(cursor, p.from)))
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
  out.push(textNode(fragment.slice(cursor)))
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
): Section[] {
  const fragments = splitDocBySeparator(doc)
  return fragments.map((text, i) => {
    const model = models[i] ?? { id: crypto.randomUUID(), role: 'user' as Role }
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

/* ──────────────────────────  Effects  ────────────────────────── */

export const toggleRoleEffect = StateEffect.define<{ index: number }>()
export const splitSectionEffect = StateEffect.define<{
  afterIndex: number
  newId?: string
  newRole?: Role
}>()
export const setSectionsEffect = StateEffect.define<SectionModel[]>()
export const setShowSeparatorsEffect = StateEffect.define<boolean>()

export const setPillsEffect = StateEffect.define<Map<string, PillMetadata>>()
export const updatePillMetaEffect = StateEffect.define<{
  id: string
  patch: Partial<PillMetadata>
}>()
export const togglePillExpandedEffect = StateEffect.define<{ id: string }>()

/* ──────────────────────  sectionsField  ─────────────────────── */

function reconcileToDoc(models: SectionModel[], doc: string): SectionModel[] {
  const expected = countSeparators(doc) + 1
  if (models.length === expected) return normalizeSectionModels(models)
  if (models.length > expected) return normalizeSectionModels(models.slice(0, expected))
  const padded = models.slice()
  while (padded.length < expected) {
    padded.push({ id: crypto.randomUUID(), role: 'user' })
  }
  return normalizeSectionModels(padded)
}

export const sectionsField = StateField.define<SectionModel[]>({
  create: () => [{ id: crypto.randomUUID(), role: 'user' }],
  update(value, tr: Transaction) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setSectionsEffect)) {
        next = e.value.slice()
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
      }
    }
    if (tr.docChanged) {
      next = reconcileToDoc(next, tr.newDoc.toString())
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

/* ──────────────────────────  pillsField  ───────────────────── */

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
    if (tr.docChanged) {
      const liveIds = new Set(scanPills(tr.newDoc.toString()).map((p) => p.id))
      let needsPrune = false
      for (const k of next.keys()) {
        if (!liveIds.has(k)) { needsPrune = true; break }
      }
      if (needsPrune) {
        const pruned = new Map<string, PillMetadata>()
        for (const [k, v] of next) if (liveIds.has(k)) pruned.set(k, v)
        next = pruned
      }
    }
    return next
  },
})

/* ──────────────────────  Role separator widget  ─────────────── */

class RoleSeparatorWidget extends WidgetType {
  constructor(readonly index: number, readonly role: Role, readonly fixed = false) {
    super()
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof RoleSeparatorWidget &&
      other.index === this.index &&
      other.role === this.role &&
      other.fixed === this.fixed
    )
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = this.fixed ? 'dez-role-separator dez-role-separator--fixed' : 'dez-role-separator'
    el.setAttribute('data-section-index', String(this.index))
    el.setAttribute('data-role', this.role)
    if (this.fixed) el.setAttribute('data-fixed', '1')
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
): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [
    {
      from: 0,
      to: 0,
      deco: Decoration.widget({
        widget: new RoleSeparatorWidget(0, 'user', true),
        block: true,
        side: -1,
      }),
    },
  ]
  if (!show) return Decoration.set(ranges.map((b) => b.deco.range(b.from, b.to)), true)
  // The separator char `\u001E` sits alone on its own line. Only block-replace
  // when it actually is line-alone — if the user deletes a surrounding `\n`
  // and the RS joins an adjacent line, skip the block decoration (the next
  // edit or sync reconciles it).
  let sectionIndex = 0
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) !== 0x1e) continue
    sectionIndex += 1
    const atLineStart = i === 0 || doc.charCodeAt(i - 1) === 0x0a
    const atLineEnd = i === doc.length - 1 || doc.charCodeAt(i + 1) === 0x0a
    if (!atLineStart || !atLineEnd) continue
    const nextRole = models[sectionIndex]?.role ?? 'user'
    ranges.push({
      from: i,
      to: i + 1,
      deco: Decoration.replace({
        widget: new RoleSeparatorWidget(sectionIndex, nextRole),
        block: true,
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

/** Click handler: toggle the role of the section that the clicked
 *  separator precedes. */
export const roleSeparatorMouseHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null
    if (!target) return false
    const label = target.closest('.dez-role-separator__label') as HTMLElement | null
    if (!label) return false
    const sep = label.closest('.dez-role-separator') as HTMLElement | null
    if (!sep || sep.getAttribute('data-fixed') === '1') return false
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

export function stripLiveSentinels(text: string): string {
  return text
    .replace(/\u001E/g, '')
    .replace(/\u{E000}/gu, '')
    .replace(/\u{E001}/gu, '')
    .replace(/\u{E002}/gu, '')
    .replace(/\u{E003}/gu, '\n')
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
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      out += `<dez:pill type="${role}"/>\n`
    } else if (c === PILL_NL) {
      out += '\n'
    } else if (c !== PILL_OPEN && c !== PILL_BODY && c !== PILL_CLOSE) {
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
  let out = ''
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

export interface ParsedClipboardText {
  text: string
  pills: Map<string, PillMetadata>
  separatorRoles: Role[]
}

export function parseClipboardText(text: string): ParsedClipboardText {
  const pills = new Map<string, PillMetadata>()
  const separatorRoles: Role[] = []
  const marker = /<dez:pill\s+type="(user|agent)"\s*\/\>|<dez:prompt\s+name="([^"]*)">([\s\S]*?)<\/dez:prompt>/g
  let out = ''
  let cursor = 0
  for (const match of text.matchAll(marker)) {
    out += stripLiveSentinels(text.slice(cursor, match.index))
    if (match[1]) {
      const role = match[1] as Role
      if (out.length > 0 && !out.endsWith('\n')) out += '\n'
      out += `${SECTION_SEP}\n`
      separatorRoles.push(role)
    } else {
      const id = crypto.randomUUID()
      const name = unescapePromptName(match[2] ?? '')
      let body = match[3] ?? ''
      if (body.startsWith('\n')) body = body.slice(1)
      if (body.endsWith('\n')) body = body.slice(0, -1)
      body = unescapePromptClipboardBody(stripLiveSentinels(body))
      out += encodePrompt(id, body, true)
      pills.set(id, { promptId: null, name, expanded: false })
    }
    cursor = (match.index ?? 0) + match[0].length
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
    display: 'flex',
    alignItems: 'center',
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
  '.dez-role-separator--fixed .dez-role-separator__label': {
    cursor: 'default',
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
})

export function dezLanguageSupport(): Extension {
  return [markdown(), syntaxHighlighting(dezHighlightStyle)]
}
