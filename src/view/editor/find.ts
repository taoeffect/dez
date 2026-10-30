import { isolateHistory } from '@codemirror/commands'
import { RegExpCursor, SearchCursor, SearchQuery } from '@codemirror/search'
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Range,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { SECTION_SEP, pillsField, scanPills, type PillMetadata } from '../thread/cmEditor'

/** Status counting stops here; the UI shows `1000+`. */
export const FIND_COUNT_LIMIT = 1000

/** Matches are found outside the visible range by this many characters so
 *  regex matches that start just above the viewport still highlight. Same
 *  value as `@codemirror/search`'s own highlighter. */
const HIGHLIGHT_MARGIN = 250

// Live-doc sentinels from cmEditor.ts: SECTION_SEP (U+001E) and the prompt
// pill markers PILL_OPEN..PILL_NL (U+E000-U+E003).
const SENTINEL_CHAR = /[\u001E\uE000-\uE003]/
const SENTINEL_CHARS = /[\u001E\uE000-\uE003]/g

export interface FindQueryInput {
  search: string
  regexp: boolean
}

export interface FindMatch {
  from: number
  to: number
  /** Regex exec result, for `$n` replacement; `null` in plain mode. */
  match: RegExpExecArray | null
}

export interface FindStatus {
  total: number
  /** 1-based index of the match equal to the main selection, if counted. */
  current: number | null
  capped: boolean
}

/** A find transaction spec whose `selection` (when present) is already in
 *  post-change positions, so callers can scroll to it. */
export interface FindTransaction extends TransactionSpec {
  selection?: EditorSelection
}

/** Build the query for the find dropdown. Plain mode is literal text, so a
 *  typed `\n` stays two characters; real newlines from Shift+Enter match line
 *  breaks. Search is always case-insensitive. Sentinels are removed so a
 *  pasted marker can never match or be written back by a replace. */
export function createFindQuery({ search, regexp }: FindQueryInput, replace = ''): SearchQuery {
  return new SearchQuery({
    search: search.replace(SENTINEL_CHARS, ''),
    regexp,
    literal: !regexp,
    replace: replace.replace(SENTINEL_CHARS, ''),
  })
}

export const setFindQueryEffect = StateEffect.define<SearchQuery | null>()

/** The active find query, or `null` while the dropdown is closed. */
export const findQueryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFindQueryEffect)) continue
      const next = effect.value
      // Keep the old object for an equal query so the highlighter, which
      // compares by identity, does not rescan on every keystroke echo.
      value = next && value && next.eq(value) ? value : next
    }
    return value
  },
})

interface DocRange {
  from: number
  to: number
}

interface ProtectedRangesCacheEntry {
  pills: Map<string, PillMetadata> | undefined
  ranges: DocRange[]
}

const protectedRangesCache = new WeakMap<Text, ProtectedRangesCacheEntry>()

/** Sorted, merged doc ranges that a match must not overlap:
 *  - every line holding a section separator, plus the line breaks on both
 *    sides. Replacing a framing `\n` leaves U+001E on a text line, and
 *    `buildSeparatorDecorations` then draws no separator widget;
 *  - pill markers and id slots. Changing them orphans pill metadata;
 *  - collapsed pill bodies. They are hidden, and a real `\n` written into
 *    one breaks the single-line pill decoration.
 *  Pills without metadata (or a state without `pillsField`) count as
 *  collapsed, matching `decodeSectionContent`. Cached per doc + pill map
 *  because the highlighter asks on every viewport change. */
function protectedRanges(state: EditorState): DocRange[] {
  const pills = state.field(pillsField, false)
  const cached = protectedRangesCache.get(state.doc)
  if (cached && cached.pills === pills) return cached.ranges

  const doc = state.doc.toString()
  const raw: DocRange[] = []
  for (let i = doc.indexOf(SECTION_SEP); i >= 0; i = doc.indexOf(SECTION_SEP, i + 1)) {
    const line = state.doc.lineAt(i)
    raw.push({ from: Math.max(0, line.from - 1), to: Math.min(doc.length, line.to + 1) })
  }
  for (const pill of scanPills(doc)) {
    if (pills?.get(pill.id)?.expanded) {
      raw.push({ from: pill.from, to: pill.bodyFrom }, { from: pill.bodyTo, to: pill.to })
    } else {
      raw.push({ from: pill.from, to: pill.to })
    }
  }
  raw.sort((a, b) => a.from - b.from)

  const ranges: DocRange[] = []
  for (const range of raw) {
    const last = ranges[ranges.length - 1]
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to)
    else ranges.push({ ...range })
  }
  protectedRangesCache.set(state.doc, { pills, ranges })
  return ranges
}

function overlapsProtectedRange(ranges: DocRange[], from: number, to: number): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (ranges[mid].to <= from) low = mid + 1
    else high = mid
  }
  return low < ranges.length && ranges[low].from < to
}

/** Iterate the matches the user may see and edit, in doc order, within
 *  `[from, to]`. Rejected matches (empty, containing a sentinel, or
 *  overlapping a protected range) are skipped here instead of through
 *  `SearchQuery.test`: when `test` rejects a match, CM's multi-line regex
 *  cursor (patterns with `\s`, `\W`, `[^`, `\n`, ...) ends the whole search.
 *  A rejected match still consumes its text, so a greedy regex that crosses
 *  a separator yields nothing for that stretch. */
export function* findMatches(
  state: EditorState,
  query: SearchQuery,
  from = 0,
  to = state.doc.length,
): Generator<FindMatch> {
  if (!query.valid) return
  const ranges = protectedRanges(state)
  const cursor = query.regexp
    ? new RegExpCursor(state.doc, query.search, { ignoreCase: !query.caseSensitive }, from, to)
    : new SearchCursor(
      state.doc,
      query.search,
      from,
      to,
      query.caseSensitive ? undefined : (text) => text.toLowerCase(),
    )
  while (!cursor.next().done) {
    const value = cursor.value
    if (value.from === value.to) continue
    const match = 'match' in value ? value.match : null
    const text = match ? match[0] : state.sliceDoc(value.from, value.to)
    if (SENTINEL_CHAR.test(text)) continue
    if (overlapsProtectedRange(ranges, value.from, value.to)) continue
    yield { from: value.from, to: value.to, match }
  }
}

/** First match starting at or after `pos`, wrapping to the first match in
 *  the doc. Scans from 0: a scan that starts mid-doc can split a
 *  multi-line query differently (`[^.]+` from a line start), and would then
 *  disagree with `findMatchStatus` and the highlights. */
export function findNextMatch(state: EditorState, query: SearchQuery, pos: number): FindMatch | null {
  let first: FindMatch | null = null
  for (const match of findMatches(state, query)) {
    if (match.from >= pos) return match
    first ??= match
  }
  return first
}

/** Last match starting before `pos`, wrapping to the last match in the
 *  doc. */
export function findPreviousMatch(state: EditorState, query: SearchQuery, pos: number): FindMatch | null {
  let previous: FindMatch | null = null
  let last: FindMatch | null = null
  for (const match of findMatches(state, query)) {
    if (match.from < pos) previous = match
    else if (previous) return previous
    last = match
  }
  return previous ?? last
}

/** The match that covers exactly `[from, to)`, or `null`. Scans from 0 for
 *  the same reason as `findNextMatch`. */
export function findMatchAt(state: EditorState, query: SearchQuery, from: number, to: number): FindMatch | null {
  if (from === to) return null
  for (const match of findMatches(state, query)) {
    if (match.from > from) break
    if (match.from === from && match.to === to) return match
  }
  return null
}

/** Count matches (up to `FIND_COUNT_LIMIT`) and locate the main selection
 *  among them. Scans the whole doc. */
export function findMatchStatus(state: EditorState, query: SearchQuery): FindStatus {
  const { from, to } = state.selection.main
  let total = 0
  let current: number | null = null
  for (const match of findMatches(state, query)) {
    if (total === FIND_COUNT_LIMIT) return { total, current, capped: true }
    total++
    if (match.from === from && match.to === to) current = total
  }
  return { total, current, capped: false }
}

/** Selections longer than this many lines do not prefill the search. */
const PREFILL_MAX_LINES = 3

// CM compiles find regexes with the `u` flag. There, escaping a character
// that has no regex meaning (e.g. `\-` outside a class) is a syntax error,
// so escape only the syntax characters and `/`.
const REGEXP_SYNTAX_CHARS = /[\^$\\.*+?()[\]{}|/]/g

/** Search text that Cmd/Ctrl+F takes from the main selection, escaped in
 *  regex mode. `null` (keep the current search) when the selection is
 *  empty, longer than 3 lines, holds a sentinel, or already is a match of
 *  the open query: the match text would replace a regex that the user
 *  typed. */
export function findPrefillText(state: EditorState, regexp: boolean): string | null {
  const { from, to } = state.selection.main
  if (from === to) return null
  if (state.doc.lineAt(to).number - state.doc.lineAt(from).number >= PREFILL_MAX_LINES) return null
  const text = state.sliceDoc(from, to)
  if (SENTINEL_CHAR.test(text)) return null
  const query = state.field(findQueryField, false)
  if (query && findMatchAt(state, query, from, to)) return null
  return regexp ? text.replace(REGEXP_SYNTAX_CHARS, '\\$&') : text
}

/** Replacement text for one match. Plain mode inserts `query.replace`
 *  as-is. Regex mode mirrors `RegExpQuery.getReplacement` in
 *  `@codemirror/search` 6.6.0, which is not public API: first `\n`, `\r`,
 *  `\t`, `\\` escapes, then `$&`, `$$`, and `$n` (longest group number that
 *  exists, rest kept literally). Unlike CM, a group that did not take part
 *  expands to '' instead of "undefined". */
function replacementText(query: SearchQuery, match: FindMatch): string {
  const groups = match.match
  if (!query.regexp || !groups) return query.replace
  return query.replace
    .replace(/\\([nrt\\])/g, (_escape, ch: string) =>
      ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\')
    .replace(/\$([$&]|\d+)/g, (token, ref: string) => {
      if (ref === '&') return groups[0]
      if (ref === '$') return '$'
      for (let digits = ref.length; digits > 0; digits--) {
        const group = Number(ref.slice(0, digits))
        // A group inside a lookaround can capture text outside the match,
        // sentinels included, so strip them as the replace text is stripped.
        if (group > 0 && group < groups.length) {
          return (groups[group] ?? '').replace(SENTINEL_CHARS, '') + ref.slice(digits)
        }
      }
      return token
    })
}

/** "Replace": when the main selection is exactly a match, replace it and
 *  select the next match; otherwise only select the match at or after the
 *  selection start. `null` when there is no match. Each replace is its own
 *  undo step. */
export function replaceMatchTransaction(state: EditorState, query: SearchQuery): FindTransaction | null {
  const { from, to } = state.selection.main
  const current = findMatchAt(state, query, from, to)
  if (!current) {
    const next = findNextMatch(state, query, from)
    if (!next) return null
    return { selection: EditorSelection.single(next.from, next.to), userEvent: 'select.search' }
  }
  const changes = state.changes({ from: current.from, to: current.to, insert: replacementText(query, current) })
  const next = findNextMatch(state, query, current.to)
  const nextIsOther = next && (next.from !== current.from || next.to !== current.to)
  const selection = nextIsOther
    ? EditorSelection.single(next.from, next.to).map(changes)
    : EditorSelection.single(changes.mapPos(current.to, 1))
  return { changes, selection, userEvent: 'input.replace', annotations: isolateHistory.of('full') }
}

/** "Replace all": every match in one transaction, so one undo step and one
 *  store sync. `null` when there is no match. */
export function replaceAllMatchesTransaction(state: EditorState, query: SearchQuery): FindTransaction | null {
  const changes: ChangeSpec[] = []
  for (const match of findMatches(state, query)) {
    changes.push({ from: match.from, to: match.to, insert: replacementText(query, match) })
  }
  if (changes.length === 0) return null
  return { changes, userEvent: 'input.replace.all', annotations: isolateHistory.of('full') }
}

const matchMark = Decoration.mark({ class: 'dez-find-match' })
const currentMatchMark = Decoration.mark({ class: 'dez-find-match dez-find-match--current' })

/** Marks for matches in the visible ranges only (plus a margin), like the
 *  `@codemirror/search` highlighter, so large docs stay cheap. The match
 *  equal to the main selection gets the current-match class. */
function buildFindHighlights(view: EditorView): DecorationSet {
  const { state } = view
  const query = state.field(findQueryField)
  if (!query?.valid) return Decoration.none
  const { main } = state.selection
  const margin = Math.max(HIGHLIGHT_MARGIN, query.search.length)
  const visible = view.visibleRanges
  const marks: Range<Decoration>[] = []
  let covered = 0
  for (let i = 0; i < visible.length; i++) {
    let { from, to } = visible[i]
    while (i < visible.length - 1 && to > visible[i + 1].from - 2 * margin) to = visible[++i].to
    const scanFrom = state.doc.lineAt(Math.max(0, from - margin)).from
    const scanTo = Math.min(state.doc.length, to + margin)
    for (const match of findMatches(state, query, scanFrom, scanTo)) {
      // Snapping scanFrom to a line start can overlap the previous window.
      if (match.from < covered) continue
      covered = match.to
      const isCurrent = match.from === main.from && match.to === main.to
      marks.push((isCurrent ? currentMatchMark : matchMark).range(match.from, match.to))
    }
  }
  return Decoration.set(marks, true)
}

const findHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildFindHighlights(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.state.field(findQueryField) !== update.startState.field(findQueryField) ||
        update.state.field(pillsField, false) !== update.startState.field(pillsField, false)
      ) {
        this.decorations = buildFindHighlights(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Find state + highlighting for `buildState()`. `initial` re-seeds the
 *  query because `view.setState()` (tab switch, stream finish) rebuilds every
 *  field. */
export function findExtension(initial: SearchQuery | null): Extension {
  return [
    findQueryField.init(() => initial),
    // Lowest precedence makes the match marks the outer DOM nodes, so syntax
    // highlight spans do not split the match background and outline.
    Prec.lowest(findHighlighter),
  ]
}
