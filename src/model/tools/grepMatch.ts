import { endOf, startOf } from '../../utils/textCut'
import { textLines, textOfBytes } from './lineEdits'

// The matching of `apps grep` (appsGrep.ts): the lines of each file that a
// regular expression matches, with the lines around them, as `rg -n`
// shows them. It runs in a Web Worker (controller/grepWorker.ts): a
// regular expression can backtrack for minutes on one line (".*x" on a
// long line), and the webview runs the whole window of Dez on one thread,
// so Dez must be able to end the work at a time limit. That is why this
// module imports nothing of the apps tool, only the rules of a text file:
// the worker loads only what it runs.

/** The most lines that a call shows before and after each matching line
 *  (`context`). */
export const GREP_MAX_CONTEXT = 10

/** The most matching lines that one result shows, and the most characters
 *  of its rows, with the paths of their files and the `--` lines between
 *  groups: about what a model reads well in one result. */
export const GREP_MAX_MATCHES = 200
export const GREP_MAX_CHARACTERS = 20_000

/** The most characters of one line of a result. A longer matching line
 *  shows a part from a little before its first match, and a longer line
 *  around a match shows its start. */
export const GREP_LINE_MAX_CHARACTERS = 300
// How many characters before its first match the part of a long matching
// line starts.
const LINE_LEAD = 100

/** How long the matching of one call can run, in seconds, before Dez ends
 *  it. */
export const GREP_TIME_LIMIT_SECONDS = 10

/** How long the test of one line can take, in milliseconds, before the
 *  result tells that the line can match. JavaScriptCore, the engine of
 *  WebKit, ends a match that backtracks too much (a repeat in a repeat, as
 *  "(a+)+") and gives no match, with no error. That took 0.4 to 0.6 s on
 *  the computer where it was measured, and the slowest test of a normal
 *  pattern on a line of 2 MiB took 42 ms, so this limit is between the
 *  two, with room for a faster and a slower computer. A slow test that
 *  ended with no match on its own gets the note too: the result cannot
 *  tell the two apart. */
export const GREP_SLOW_LINE_MS = 100

/** The most bytes of the files that one call reads: they are all in the
 *  webview at once, and twice that as the text of the worker. */
export const GREP_MAX_BYTES = 32 * 1024 * 1024

/** The line between two groups of rows of a file that do not follow each
 *  other, as grep writes it. */
const GROUP_BREAK = '--'

/** One file to search: the path that the result shows, and its bytes. */
export interface GrepFile {
  path: string
  bytes: Uint8Array
}

/** What the worker gets: the regular expression of the call, as the
 *  source and the flags of a `RegExp`, how many lines to show around a
 *  match, and the files in the order of the result. */
export interface GrepRequest {
  source: string
  flags: string
  context: number
  files: GrepFile[]
}

/** One row of a result: a matching line, or a line around one. `text` is
 *  the line as the result shows it, a part of a long line. */
export interface GrepRow {
  line: number
  text: string
  match: boolean
}

/** The matches of one file: how many of its lines match, how many of them
 *  the rows show, and the rows, in the order of the lines. */
export interface GrepFileMatches {
  path: string
  matches: number
  shown: number
  rows: GrepRow[]
}

/** A line of a file of a request, by its number. */
export interface GrepLineRef {
  path: string
  line: number
}

export interface GrepOutcome {
  /** The files with at least one matching line, in the order of the
   *  request. */
  files: GrepFileMatches[]
  /** How many files of the request are text: it searched each of them. */
  searched: number
  /** How many files of the request are no text: it did not search them. */
  notText: number
  /** Whether a row shows only a part of its line. */
  cutLines: boolean
  /** The lines whose test gave no match after more than
   *  `GREP_SLOW_LINE_MS`: each of them can match. */
  slowLines: GrepLineRef[]
}

// A row as the result shows it: `12: text` for a matching line, and
// `11- text` for a line around one.
function grepRowText({ line, text, match }: GrepRow): string {
  return `${line}${match ? ':' : '-'} ${text}`
}

/** The lines of the rows of one file. With lines around the matches
 *  (`context`), a `--` line goes between two rows whose lines do not
 *  follow each other, as in grep; with none, each row is a match. */
export function grepRowLines(rows: readonly GrepRow[], context: number): string[] {
  return rows.flatMap((row, index) => (context > 0 && index > 0 && row.line !== rows[index - 1].line + 1 ? [GROUP_BREAK, grepRowText(row)] : [grepRowText(row)]))
}

// What is left of one result as the files fill it, and whether a row of it
// shows only a part of its line. Once a group of rows does not fit, the
// result is full: the later matches only count.
interface Room {
  matches: number
  characters: number
  full: boolean
  cutLines: boolean
}

// A line as a row shows it: the whole line, or a part of a long one. A
// matching line (`regExp`) shows from a little before its first match, so
// that the row shows the match also in a minified file; another line shows
// its start.
function shownText(text: string, regExp: RegExp | null): string {
  if (text.length <= GREP_LINE_MAX_CHARACTERS) return text
  const first = regExp?.exec(text)?.index ?? 0
  const start = Math.max(0, Math.min(first - LINE_LEAD, text.length - GREP_LINE_MAX_CHARACTERS))
  const end = start + GREP_LINE_MAX_CHARACTERS
  const part = startOf(endOf(text.slice(0, end), GREP_LINE_MAX_CHARACTERS), GREP_LINE_MAX_CHARACTERS)
  return `${start > 0 ? '…' : ''}${part}${end < text.length ? '…' : ''}`
}

// The line `line` of `lines` as grep reads it: with no `\r` at its end, so
// that `$` matches at the end of a line of a Windows file. The number of a
// line stays that of `read` (textLines).
function lineAt(lines: readonly string[], line: number): string {
  const text = lines[line - 1]
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

// The matches of the file at `path` with `lines`, where `matches` tests
// one line. A shown match brings the `context` lines before it that no row
// shows yet, and the ones after it come as the loop reaches them. The rows
// take from `room`.
function fileMatches(path: string, lines: readonly string[], regExp: RegExp, matches: (text: string, line: number) => boolean, context: number, room: Room): GrepFileMatches | null {
  const file: GrepFileMatches = { path, matches: 0, shown: 0, rows: [] }
  const lastRow = () => file.rows.at(-1)?.line ?? 0
  // Adds a group of rows when it fits in the room, with the path line of
  // the file (and the empty line before it) or a `--` line before it
  // (`grepRowLines`).
  const added = (rows: GrepRow[]): boolean => {
    let size = rows.reduce((sum, row) => sum + grepRowText(row).length + 1, 0)
    if (file.rows.length === 0) size += path.length + 2
    else if (context > 0 && rows[0].line !== lastRow() + 1) size += GROUP_BREAK.length + 1
    if (size > room.characters) {
      room.full = true
      return false
    }
    room.characters -= size
    file.rows.push(...rows)
    if (rows.some((row) => lineAt(lines, row.line).length > GREP_LINE_MAX_CHARACTERS)) room.cutLines = true
    return true
  }

  // The last line that the context of the last shown match reaches.
  let contextEnd = 0
  for (let line = 1; line <= lines.length; line += 1) {
    const text = lineAt(lines, line)
    const match = matches(text, line)
    if (match) file.matches += 1
    if (room.full) continue
    if (match) {
      if (room.matches === 0) {
        room.full = true
        continue
      }
      const rows: GrepRow[] = []
      for (let before = Math.max(line - context, lastRow() + 1); before < line; before += 1) {
        rows.push({ line: before, text: shownText(lineAt(lines, before), null), match: false })
      }
      rows.push({ line, text: shownText(text, regExp), match: true })
      if (!added(rows)) continue
      room.matches -= 1
      file.shown += 1
      contextEnd = line + context
    } else if (line <= contextEnd) {
      added([{ line, text: shownText(text, null), match: false }])
    }
  }
  return file.matches === 0 ? null : file
}

/** The lines of the files of `request` that its regular expression
 *  matches, each line by itself. A file that is no text (`textOfBytes`) is
 *  not searched. A byte order mark is no part of the first line. The rows
 *  stop at `GREP_MAX_MATCHES` matching lines and `GREP_MAX_CHARACTERS`
 *  characters; the count of the matches goes on to the end. `now` gives
 *  the time in milliseconds, for the lines whose test is slow. */
export function grepFiles({ source, flags, context, files }: GrepRequest, now: () => number = () => performance.now()): GrepOutcome {
  const regExp = new RegExp(source, flags)
  const room: Room = { matches: GREP_MAX_MATCHES, characters: GREP_MAX_CHARACTERS, full: false, cutLines: false }
  const outcome: GrepOutcome = { files: [], searched: 0, notText: 0, cutLines: false, slowLines: [] }
  for (const file of files) {
    const text = textOfBytes(file.bytes)
    if (text === null) {
      outcome.notText += 1
      continue
    }
    outcome.searched += 1
    const matchesLine = (lineText: string, line: number): boolean => {
      const start = now()
      const match = regExp.test(lineText)
      if (!match && now() - start > GREP_SLOW_LINE_MS) outcome.slowLines.push({ path: file.path, line })
      return match
    }
    const matches = fileMatches(file.path, textLines(text.replace(/^\uFEFF/, '')), regExp, matchesLine, context, room)
    if (matches) outcome.files.push(matches)
  }
  outcome.cutLines = room.cutLines
  return outcome
}
