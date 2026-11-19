import { parser } from '@lezer/markdown'
import type { LinkedPathRule } from './images'

// Markdown code is text. An image reference, a media tag, or an `@id`
// mention in code is no asset: the editor shows its text, and a request
// sends it as text, with no image and no clip. Code is what CommonMark
// parses as code, with the parser that also draws the editor
// (`@lezer/markdown`, CommonMark with no extension):
// - a fenced block (``` or ~~~, or a longer run), up to its closer, or to
//   the end of the text when it has none;
// - an indented block (4 columns of indent);
// - an inline code span (`code`), which can run over the line breaks of
//   one paragraph.
// Each text is a document of its own: a fence ends at the end of the text
// that the caller gives (a section, or a part of the compaction section),
// as a request sends each section as a message of its own.
//
// The lines of Dez: in a text that is not a user's text (a reply, the
// compaction block), a line that starts with `<dez:` or `</dez:` is a line
// that Dez wrote: a media tag, a line of a tool block, a line of the
// compaction block. It is in no code, and it ends the code before it. So a
// reply that stops inside a fence or a code span does not hide the tool
// images and the clips that Dez writes after it. A model cannot write such
// a line (`ModelTextEscaper`, toolBlocks.ts). In a user's text, such a line
// is text: a fence there holds a pasted tag too.

/** A range of code in a text: `from` up to (not with) `to`. */
export interface CodeRange {
  from: number
  to: number
}

const NO_CODE: readonly CodeRange[] = []
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode'])
// A text with none of these has no code: a fence starts with ``` or ~~~, a
// code span with a backtick, and an indented block needs 4 columns of
// indent, which is 4 spaces in a row or a tab (also after the marker of a
// list item or a block quote). Such a text needs no parse.
const CODE_SIGN = /`|~~~|\t| {4}/
// The start of a line of Dez (see the top of this file): at the text start
// or after `\n` only, as the media tags and the tool blocks are read.
const DEZ_LINE = /(?<![^\n])<\/?dez:/g

// The code ranges of the texts that were read last, by text. The same text
// is read many times: by each reader of a request, and by each part of the
// editor on each doc change, where most sections did not change. The oldest
// entry goes first when the cache is full.
const CACHE_ENTRIES = 256
const CACHE_CHARS = 4_000_000
const cache = new Map<string, readonly CodeRange[]>()
let cacheChars = 0

// A copy of `text` with a buffer of its own. A slice of a larger string (a
// section of the editor doc) can keep the whole larger string in memory,
// and the cache must not keep the old docs. The `+` makes a rope of the two
// strings, and the slice of a rope makes a flat copy first, in the JS
// engines of the webviews (JavaScriptCore, V8).
function ownCopy(text: string): string {
  return (' ' + text).slice(1)
}

function parsedCodeRanges(text: string): readonly CodeRange[] {
  const ranges: CodeRange[] = []
  parser.parse(text).iterate({
    enter: (node) => {
      if (!CODE_NODES.has(node.name)) return true
      ranges.push({ from: node.from, to: node.to })
      return false
    },
  })
  return ranges
}

// The code ranges of `text` read as one document.
function documentCodeRanges(text: string): readonly CodeRange[] {
  if (!CODE_SIGN.test(text)) return NO_CODE
  const cached = cache.get(text)
  if (cached) return cached
  const ranges = parsedCodeRanges(text)
  cache.set(ownCopy(text), ranges)
  cacheChars += text.length
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_ENTRIES && cacheChars <= CACHE_CHARS) break
    cache.delete(key)
    cacheChars -= key.length
  }
  return ranges
}

/** The ranges of code in `text`, a text whose linked paths count by `rule`
 *  (images.ts), in order (see the top of this file). Only `'user'` or not
 *  matters here: the lines of Dez end code in any text that is not a
 *  user's text. */
export function codeRanges(text: string, rule: LinkedPathRule): readonly CodeRange[] {
  if (rule === 'user') return documentCodeRanges(text)
  // Each run of lines between two lines of Dez is a document of its own.
  const ranges: CodeRange[] = []
  let runFrom = 0
  const addRun = (runTo: number) => {
    for (const range of documentCodeRanges(text.slice(runFrom, runTo))) {
      ranges.push({ from: runFrom + range.from, to: runFrom + range.to })
    }
  }
  DEZ_LINE.lastIndex = 0
  for (let match = DEZ_LINE.exec(text); match; match = DEZ_LINE.exec(text)) {
    addRun(match.index)
    const lineEnd = text.indexOf('\n', match.index)
    if (lineEnd < 0) return ranges
    runFrom = lineEnd + 1
    DEZ_LINE.lastIndex = runFrom
  }
  addRun(text.length)
  return ranges
}

/** True when `offset` is in one of `ranges` (`codeRanges`). */
export function inCode(ranges: readonly CodeRange[], offset: number): boolean {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (ranges[middle].to <= offset) low = middle + 1
    else high = middle
  }
  return low < ranges.length && ranges[low].from <= offset
}

/** The closer line of the fenced block that `text` leaves open at its end,
 *  or null when it leaves none open. A line at column 0 after `text` ends
 *  an open block in a list item or a block quote, so only a top-level
 *  block needs a closer. The closer is the run of the opener (` ``` `, or
 *  a longer one, or `~~~`). */
export function openFenceCloser(text: string): string | null {
  if (!text.includes('```') && !text.includes('~~~')) return null
  const last = parser.parse(text).topNode.lastChild
  if (last?.name !== 'FencedCode') return null
  const marks = last.getChildren('CodeMark')
  return marks.length === 1 ? text.slice(marks[0].from, marks[0].to) : null
}
