import { labelImageReferences } from '../chat/images'
import { modelRefKey } from '../chat/modelRef'
import { parseConversation } from './conversationFormat'
import { conversationSummary } from './summaries'
import type {
  ContentNodeData,
  ConversationFile,
  ConversationSearchResult,
  ConversationSummary,
  SectionData,
  SnippetSegment,
} from './types'

// Total snippet size budget in code points, matching conversationPreview's
// 160-char previews so search results and plain listings look uniform.
const SNIPPET_MAX_CHARS = 160

// Per-conversation parse products retained between searches. Keyed by
// conversation id; an entry is valid while the file's updatedAt (mtime) is
// unchanged, so repeated searches never re-parse unmodified files.
interface SearchCacheEntry {
  updatedAt: number
  summary: ConversationSummary
  plainText: string
  lowerText: string
  lowerTitle: string
  lowerModel: string
}

const cache = new Map<string, SearchCacheEntry>()

// Test hook: reset the module-level cache between test cases.
export function clearConversationSearchCache(): void {
  cache.clear()
}

// Search text for one node: prompt pills contribute their visible name plus
// their body, both of which read as conversation content in the UI. Image
// references are left out (a space keeps the words around one apart): their
// path (`config`, `dez`, `images`, `png`, a uuid) would match every
// conversation with an image. The snippet then shows no `[image]` label
// where the preview does; a label would make `image` match them all too.
function nodeSearchText(node: ContentNodeData): string {
  return node.kind === 'text'
    ? labelImageReferences(node.text, ' ')
    : `${node.name} ${labelImageReferences(node.body, ' ')}`
}

// Flatten a conversation into one searchable line. Whitespace is collapsed
// (mirroring conversationPreview) so snippets render single-line, and the
// result is NFC-normalized so it compares canonically against queries.
export function conversationPlainText(sections: SectionData[]): string {
  const text = sections
    .flatMap((section) => section.nodes)
    .map(nodeSearchText)
    .join(' ')
  return text.split(/\s+/).filter(Boolean).join(' ').normalize('NFC')
}

// Split a raw query into normalized lowercase terms. Terms are matched with
// AND semantics; an empty array means "match everything".
function queryTerms(query: string): string[] {
  return query.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean)
}

// Ids from a (typically metadata-only) listing whose cached parse is missing
// or stale. The persistence layer loads file contents only for these before
// calling searchConversationFiles, keeping panel I/O at O(changed files).
export function staleConversationIds(files: ConversationFile[]): string[] {
  return files
    .filter((file) => {
      const cached = cache.get(file.id)
      return !cached || cached.updatedAt !== file.updatedAt
    })
    .map((file) => file.id)
}

// Return the cached entry for a listing row, re-parsing only when the file's
// mtime changed since it was last cached. A stale row without content cannot
// be parsed (the caller should have loaded it, and searches are serialized
// behind an event queue at the dez.model/conversations/search boundary, so
// concurrent searches can't prune entries out from under each other); this
// null branch is a defensive guard so a caller bug degrades to a skipped row
// instead of failing the whole search.
function entryForFile(file: ConversationFile): SearchCacheEntry | null {
  const cached = cache.get(file.id)
  if (cached && cached.updatedAt === file.updatedAt) return cached
  if (file.content === null) {
    console.error('Missing content for stale conversation file:', file.id)
    return null
  }
  const data = parseConversation(file.id, file.content)
  const plainText = conversationPlainText(data.sections)
  const summary = conversationSummary(data, file.updatedAt)
  const entry: SearchCacheEntry = {
    updatedAt: file.updatedAt,
    summary,
    plainText,
    lowerText: plainText.toLowerCase(),
    lowerTitle: summary.title.normalize('NFC').toLowerCase(),
    // The raw `provider/model` key, not the names that the history row
    // shows: names change with provider configs and the model cache, and
    // this cache entry lives until the file changes.
    lowerModel: (summary.model ? modelRefKey(summary.model) : '').normalize('NFC').toLowerCase(),
  }
  cache.set(file.id, entry)
  return entry
}

// Earliest occurrence of any term in the conversation text, or null when no
// term matches the content (i.e. the query only matched title/model).
function firstContentMatch(
  lowerText: string,
  terms: string[],
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null
  for (const term of terms) {
    const index = lowerText.indexOf(term)
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, length: term.length }
    }
  }
  return best
}

// Mark every occurrence of every term inside the snippet window, merging
// overlapping/adjacent ranges so each highlighted run is one segment.
function highlightTerms(text: string, terms: string[]): SnippetSegment[] {
  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let from = 0
    while (true) {
      const index = lower.indexOf(term, from)
      if (index === -1) break
      ranges.push([index, index + term.length])
      from = index + term.length
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  const segments: SnippetSegment[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

// Build the highlighted ~160-char window around the first content match, or
// null when the content didn't match. Window edges are cut on code points
// (mirroring conversationPreview's [...str] slicing) with '…' marking
// truncation.
//
// NOTE: match indices come from lowerText. toLowerCase() preserves string
// length for all but a few exotic code points (e.g. U+0130 'İ'), so reusing
// the indices on plainText is safe in practice; at worst the window shifts by
// a couple of characters, which is cosmetic.
function extractSnippet(
  plainText: string,
  lowerText: string,
  terms: string[],
): SnippetSegment[] | null {
  const match = firstContentMatch(lowerText, terms)
  if (!match) return null

  const beforeChars = [...plainText.slice(0, match.index)]
  const matchText = plainText.slice(match.index, match.index + match.length)
  const afterChars = [...plainText.slice(match.index + match.length)]

  // Budget context around the match in code points, letting a short side
  // donate its unused budget to the other so the window stays ~full-width.
  const remaining = Math.max(0, SNIPPET_MAX_CHARS - [...matchText].length)
  let beforeBudget = Math.min(beforeChars.length, Math.floor(remaining / 2))
  const afterBudget = Math.min(afterChars.length, remaining - beforeBudget)
  beforeBudget = Math.min(beforeChars.length, remaining - afterBudget)

  const truncatedStart = beforeBudget < beforeChars.length
  const truncatedEnd = afterBudget < afterChars.length
  const windowText =
    beforeChars.slice(beforeChars.length - beforeBudget).join('') +
    matchText +
    afterChars.slice(0, afterBudget).join('')

  const segments = highlightTerms(windowText, terms)
  if (truncatedStart) {
    if (segments.length > 0 && !segments[0].match) segments[0].text = '…' + segments[0].text
    else segments.unshift({ text: '…', match: false })
  }
  if (truncatedEnd) {
    const last = segments[segments.length - 1]
    if (last && !last.match) last.text += '…'
    else segments.push({ text: '…', match: false })
  }
  return segments
}

// Search the full conversation listing. Only files whose updatedAt changed
// since the last call are re-parsed (ids gone from the listing are pruned),
// then every term must match title, model, or content (AND semantics). A
// content match attaches a highlighted snippet; an empty/whitespace query
// returns every conversation, covering the plain listing behavior. Results
// are sorted by updatedAt descending.
export function searchConversationFiles(
  files: ConversationFile[],
  query: string,
): ConversationSearchResult[] {
  const liveIds = new Set(files.map((file) => file.id))
  for (const id of cache.keys()) {
    if (!liveIds.has(id)) cache.delete(id)
  }

  const terms = queryTerms(query)
  const results: ConversationSearchResult[] = []
  for (const file of files) {
    const entry = entryForFile(file)
    if (entry === null) continue
    if (terms.length === 0) {
      results.push({ ...entry.summary, snippet: null })
      continue
    }
    const matches = terms.every((term) =>
      entry.lowerTitle.includes(term) || entry.lowerModel.includes(term) || entry.lowerText.includes(term))
    if (!matches) continue
    results.push({ ...entry.summary, snippet: extractSnippet(entry.plainText, entry.lowerText, terms) })
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}
