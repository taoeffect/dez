import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import type { Role, Section } from '../types/chat'
import { sectionPlainText, textNode } from '../types/content'

/** ASCII Record Separator; never typeable, never on-disk, used in-buffer to
 *  encode a section boundary. The char sits alone on its own line and the
 *  whole line is replaced with a block widget (the role separator pill). */
export const SECTION_SEP = '\u001E'

/** Lightweight mirror of a Section kept in the CM state. The CM doc is the
 *  source of truth for text; this field just tracks per-section identity
 *  (id) and role. */
export interface SectionModel {
  id: string
  role: Role
}

/** Produce `{ id, role }` for each section to seed `sectionsField`. */
export function initialSectionModels(sections: Section[]): SectionModel[] {
  if (sections.length === 0) return [{ id: crypto.randomUUID(), role: 'user' }]
  return sections.map((s) => ({ id: s.id, role: s.role }))
}

/** Encode `Section[]` as a single string: section plain text joined with
 *  `\n\u001E\n`. No trailing separator (streaming appends to the end). */
export function sectionsToDoc(sections: Section[]): string {
  if (sections.length === 0) return ''
  return sections.map(sectionPlainText).join(`\n${SECTION_SEP}\n`)
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

/** Reconstruct a `Section[]` for the store given the current doc and the
 *  live `SectionModel[]` (for id + role preservation). When the field got
 *  out of sync (e.g. raw deletion of a separator), we truncate / pad with
 *  default user roles to match the fragment count. */
export function docToSections(doc: string, models: SectionModel[]): Section[] {
  const fragments = splitDocBySeparator(doc)
  return fragments.map((text, i) => {
    const model = models[i] ?? { id: crypto.randomUUID(), role: 'user' as Role }
    return {
      id: model.id,
      role: model.role,
      content: [textNode(text)],
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

/* ──────────────────────  sectionsField  ─────────────────────── */

function reconcileToDoc(models: SectionModel[], doc: string): SectionModel[] {
  const expected = countSeparators(doc) + 1
  if (models.length === expected) return models
  if (models.length > expected) return models.slice(0, expected)
  const padded = models.slice()
  while (padded.length < expected) {
    padded.push({ id: crypto.randomUUID(), role: 'user' })
  }
  return padded
}

export const sectionsField = StateField.define<SectionModel[]>({
  create: () => [{ id: crypto.randomUUID(), role: 'user' }],
  update(value, tr: Transaction) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setSectionsEffect)) {
        next = e.value.slice()
      } else if (e.is(toggleRoleEffect)) {
        if (e.value.index >= 0 && e.value.index < next.length) {
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
    return next
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
    const el = document.createElement('div')
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
): DecorationSet {
  if (!show) return Decoration.none
  const ranges: { from: number; to: number; deco: Decoration }[] = []
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
    const sep = target.closest('.dez-role-separator') as HTMLElement | null
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
    cursor: 'pointer',
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
  },
  '.dez-role-separator[data-role="agent"] .dez-role-separator__label': {
    color: 'var(--color-link, #4a9eff)',
    borderColor: 'var(--color-link, #4a9eff)',
  },
})

export function dezLanguageSupport(): Extension {
  return [markdown(), syntaxHighlighting(dezHighlightStyle)]
}
