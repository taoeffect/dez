import { countOf } from '../../utils/countText'

// The text and the lines of a text file, for the `apps` tool
// (appsTool.ts).
//
// The rest of the file, from `linesText` on, is kept code with no caller:
// edits of a file by line number, and a diff of their change.

/** The text of a file from its bytes, or null for a file that is no text:
 *  one with a zero byte, or with bytes that are no UTF-8. A byte order mark
 *  stays in the text, so that an edit writes it back. The one rule of a
 *  text file of the `apps` tool, so that `grep` searches the files that
 *  `read` and `edit` take. */
export function textOfBytes(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The lines of a text: the pieces between its `\n`. A `\n` at the end of
 *  the text ends the last line and starts no new one: `a\nb\n` and `a\nb`
 *  both have two lines, `\n` has one empty line, and an empty text has
 *  none. Only `\n` ends a line: a `\r` before it stays in its line, so the
 *  line ends of a Windows file come back as they were. */
export function textLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** `line 4`, `lines 4-6`. */
export function linesName(from: number, to: number): string {
  return from === to ? `line ${from}` : `lines ${from}-${to}`
}

// Kept code with no caller, from here to the end of the file. `edit` took
// line numbers before it took find and replace (textEdits.ts), and the
// user wants this code kept, in case it takes them again. Every line
// number of a call is a number of the file before the call, so a model
// never has to work out how an earlier edit of the same call moved the
// lines. The edits apply all at once, and each one passes or fails by
// itself.

/** The text of `lines` (`textLines` gives them back), with a `\n` after
 *  the last line when `finalLineEnd` is set. */
export function linesText(lines: readonly string[], finalLineEnd: boolean): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}${finalLineEnd ? '\n' : ''}`
}

/** One edit of a call, as the model gave it: it replaces the lines
 *  `fromLine` to `toLine` (only `fromLine` with no `toLine`) with the lines
 *  of `content`, or it puts them in after the line `afterLine` (0: before
 *  the first line). An empty `content` has no line, so it deletes. */
export interface LineEdit {
  fromLine?: number
  toLine?: number
  afterLine?: number
  content: string
}

/** What became of one edit: `text` tells what it did, or why it failed. */
export interface LineEditOutcome {
  done: boolean
  text: string
}

/** One line of the file before or after the edits: one that stays, one
 *  that the edits take out, or one that they put in. */
interface LineOp {
  kind: 'keep' | 'remove' | 'add'
  text: string
}

/** One hunk of a unified diff: its `@@ -old +new @@` line, and its lines
 *  after that one, each with its mark (` `, `-`, `+`). */
export interface DiffHunk {
  header: string
  lines: string[]
}

export interface LineEditPlan {
  /** One for each edit, in the order of the call. */
  outcomes: LineEditOutcome[]
  /** The lines of the file after the edits that passed. */
  lines: string[]
  /** Whether a line of the file changes. */
  changed: boolean
  /** The change as the hunks of a unified diff; none when nothing
   *  changes. */
  hunks: DiffHunk[]
}

// An edit that passed its checks: it replaces the lines `from` to `to`, or
// puts lines in after the line `after`. `number` is its place in the call,
// from 1.
interface Replacement { number: number; from: number; to: number; lines: string[] }
interface Insertion { number: number; after: number; lines: string[] }

const failed = (text: string): LineEditOutcome => ({ done: false, text })
const done = (text: string): LineEditOutcome => ({ done: true, text })

const KINDS_ADVICE = 'Give `from_line` (and `to_line`) to replace lines, or `after_line` to put lines in.'
const ONE_EDIT_ADVICE = 'Make one edit of the two.'

/** The plan of the `edits` of the file with `lines`. An edit fails for
 *  line numbers that the file does not have, for lines that an earlier edit
 *  of the call replaces, and for a place inside such lines; the other
 *  edits still pass. */
export function planLineEdits(lines: readonly string[], edits: readonly LineEdit[]): LineEditPlan {
  const total = lines.length
  const fileLength = total === 0 ? 'the file is empty' : `the file has ${countOf(total, 'line')}`
  const replacements: Replacement[] = []
  const insertions: Insertion[] = []

  const outcomes = edits.map((edit, index): LineEditOutcome => {
    const number = index + 1
    const { fromLine, toLine, afterLine } = edit
    const newLines = textLines(edit.content)
    if (fromLine !== undefined && afterLine !== undefined) return failed(`It has both \`from_line\` and \`after_line\`. ${KINDS_ADVICE}`)

    if (afterLine !== undefined) {
      if (toLine !== undefined) return failed('It has `to_line` with `after_line`. `to_line` goes with `from_line` only: an edit with `after_line` replaces no line.')
      if (afterLine < 0) return failed(`\`after_line\` is ${afterLine}. Give 0 to put the lines in before the first line.`)
      if (afterLine > total) return failed(`\`after_line\` is ${afterLine}, and ${fileLength}.`)
      if (newLines.length === 0) return failed('Its `content` is empty, so there is no line to put in. Give "\\n" for one empty line.')
      const around = replacements.find(({ from, to }) => from <= afterLine && afterLine < to)
      if (around) return failed(`Line ${afterLine} is inside the ${linesName(around.from, around.to)} that edit ${around.number} replaces. ${ONE_EDIT_ADVICE}`)
      insertions.push({ number, after: afterLine, lines: newLines })
      return done(`Put ${countOf(newLines.length, 'line')} in ${afterLine === 0 ? 'at the start of the file' : `after line ${afterLine}`}.`)
    }

    if (fromLine === undefined) return failed(`It has no \`from_line\` and no \`after_line\`. ${KINDS_ADVICE}`)
    const to = toLine ?? fromLine
    if (fromLine < 1) return failed(`\`from_line\` is ${fromLine}. The first line of a file is line 1.`)
    if (to < fromLine) return failed(`\`to_line\` (${to}) is before \`from_line\` (${fromLine}).`)
    const name = linesName(fromLine, to)
    if (to > total) return failed(`It names ${name}, and ${fileLength}.${total === 0 ? ' Put lines in with `after_line` 0.' : ''}`)
    const overlapped = replacements.find((other) => other.from <= to && fromLine <= other.to)
    if (overlapped) return failed(`It names ${name}, and edit ${overlapped.number} replaces ${linesName(overlapped.from, overlapped.to)} already. ${ONE_EDIT_ADVICE}`)
    const inside = insertions.find(({ after }) => fromLine <= after && after < to)
    if (inside) return failed(`It names ${name}, and edit ${inside.number} puts lines in after line ${inside.after}, which is inside them. ${ONE_EDIT_ADVICE}`)
    replacements.push({ number, from: fromLine, to, lines: newLines })
    if (newLines.length === 0) return done(`Deleted ${name}.`)
    const same = newLines.length === to - fromLine + 1 && newLines.every((line, offset) => line === lines[fromLine - 1 + offset])
    return done(same ? `No change: ${name} had this text already.` : `Replaced ${name} with ${countOf(newLines.length, 'line')}.`)
  })

  const ops = lineOps(lines, replacements, insertions)
  return {
    outcomes,
    lines: ops.filter((op) => op.kind !== 'remove').map((op) => op.text),
    changed: ops.some((op) => op.kind !== 'keep'),
    hunks: diffHunks(ops),
  }
}

// Every line of the file before and after the edits, in the order of the
// new file. The lines that are put in after a line come after the lines
// that replace it, and those of two edits at one place in the order of the
// call. The lines at the start and the end of a replacement that are the
// same as the old ones stay: a model often gives a line before and after
// its change again, and the diff must show only the change.
function lineOps(lines: readonly string[], replacements: readonly Replacement[], insertions: readonly Insertion[]): LineOp[] {
  const ops: LineOp[] = []
  const push = (kind: LineOp['kind'], texts: readonly string[]) => {
    for (const text of texts) ops.push({ kind, text })
  }
  const starts = new Map(replacements.map((replacement) => [replacement.from, replacement]))
  // `line` is how many lines of the old file are done.
  let line = 0
  for (;;) {
    for (const insertion of insertions) {
      if (insertion.after === line) push('add', insertion.lines)
    }
    if (line === lines.length) return ops
    const replacement = starts.get(line + 1)
    if (!replacement) {
      push('keep', [lines[line]])
      line += 1
      continue
    }
    const old = lines.slice(line, replacement.to)
    const fresh = replacement.lines
    const shorter = Math.min(old.length, fresh.length)
    let head = 0
    while (head < shorter && old[head] === fresh[head]) head += 1
    let tail = 0
    while (tail < shorter - head && old[old.length - 1 - tail] === fresh[fresh.length - 1 - tail]) tail += 1
    push('keep', old.slice(0, head))
    push('remove', old.slice(head, old.length - tail))
    push('add', fresh.slice(head, fresh.length - tail))
    push('keep', old.slice(old.length - tail))
    line = replacement.to
  }
}

/** The lines around a change that a hunk of the diff shows. */
const DIFF_CONTEXT_LINES = 3

const DIFF_MARKS: Record<LineOp['kind'], string> = { keep: ' ', remove: '-', add: '+' }

// The place of a hunk in one file, as a unified diff writes it: its first
// line and its number of lines. A hunk with no line of the file names the
// line before it.
function hunkRange(linesBefore: number, count: number): string {
  return count === 0 ? `${linesBefore},0` : `${linesBefore + 1},${count}`
}

// The hunks of a unified diff of `ops`: each change with the lines around
// it, under a `@@ -old +new @@` line. Two changes whose lines around them
// touch are one hunk.
function diffHunks(ops: readonly LineOp[]): DiffHunk[] {
  // The first and the last op of each hunk.
  const ranges: { start: number; end: number }[] = []
  ops.forEach((op, index) => {
    if (op.kind === 'keep') return
    const start = Math.max(0, index - DIFF_CONTEXT_LINES)
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES)
    const last = ranges.at(-1)
    if (last && start <= last.end + 1) last.end = end
    else ranges.push({ start, end })
  })

  const hunks: DiffHunk[] = []
  // How many lines of the old and the new file are before the op.
  let oldLines = 0
  let newLines = 0
  let next = 0
  for (const { start, end } of ranges) {
    for (; next < start; next += 1) {
      if (ops[next].kind !== 'add') oldLines += 1
      if (ops[next].kind !== 'remove') newLines += 1
    }
    const part = ops.slice(start, end + 1)
    const oldCount = part.filter((op) => op.kind !== 'add').length
    const newCount = part.filter((op) => op.kind !== 'remove').length
    hunks.push({
      header: `@@ -${hunkRange(oldLines, oldCount)} +${hunkRange(newLines, newCount)} @@`,
      lines: part.map((op) => `${DIFF_MARKS[op.kind]}${op.text}`),
    })
    oldLines += oldCount
    newLines += newCount
    next = end + 1
  }
  return hunks
}

// The most characters of a diff that `cutDiff` keeps.
const DIFF_MAX_CHARACTERS = 20_000
// The most lines that one hunk shows (the lines after its `@@` line). A
// longer hunk shows only its first and its last `HUNK_END_LINES` lines:
// the model gave the new lines and read the old ones, so all of them
// again would only fill its context. A hunk is cut only when the cut
// leaves out more than 4 lines: a note line in place of fewer saves
// little.
const HUNK_END_LINES = 8
const HUNK_MAX_LINES = 2 * HUNK_END_LINES + 4

/** One row of a diff for a model, and the number of lines of the diff
 *  that it stands for: 1, or for the note of a long hunk the lines that
 *  the note leaves out. */
export interface DiffRow {
  text: string
  lines: number
}

/** The rows of one hunk: a long hunk shows its ends, and between them a
 *  row with no diff mark that tells how many lines it leaves out. The `@@`
 *  line keeps the counts of the whole hunk. */
export function hunkRows({ header, lines }: DiffHunk): DiffRow[] {
  const row = (text: string): DiffRow => ({ text, lines: 1 })
  if (lines.length <= HUNK_MAX_LINES) return [header, ...lines].map(row)
  const hidden = lines.length - 2 * HUNK_END_LINES
  return [
    row(header),
    ...lines.slice(0, HUNK_END_LINES).map(row),
    { text: `… ${countOf(hidden, 'line')} of this hunk are not shown, to save context. read gives the file as it is now.`, lines: hidden },
    ...lines.slice(-HUNK_END_LINES).map(row),
  ]
}

/** The first rows of a diff that fit a result, and a row that tells how
 *  many lines of the diff the rows after them stand for. The lines that a
 *  shown note of a long hunk leaves out are told already, so they do not
 *  count. */
export function cutDiff(rows: readonly DiffRow[]): string[] {
  const shown: string[] = []
  let characters = 0
  let rest = rows.reduce((sum, row) => sum + row.lines, 0)
  for (const { text, lines } of rows) {
    if (characters + text.length + 1 > DIFF_MAX_CHARACTERS) break
    shown.push(text)
    characters += text.length + 1
    rest -= lines
  }
  return rest === 0 ? shown : [...shown, `… ${countOf(rest, 'more line')} of the diff ${rest === 1 ? 'is' : 'are'} not shown. read gives the file as it is now.`]
}
