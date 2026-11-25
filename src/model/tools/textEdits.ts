import { countText } from '../../utils/countText'
import { seriesText } from '../../utils/seriesText'

// Edits of a text by find and replace (the `edit` subcommand of the `apps`
// tool, appsTool.ts): what each edit of a call does, and the new text.
//
// The edits apply in the order of the call, each to the text that the
// edits before it left, and each one passes or fails by itself. The code
// works on the whole text, not on lines, and changes only the text that
// an edit matched: a byte order mark and the line ends stay as they were.

/** One edit of a call: it replaces `oldString`, which must be in the text
 *  at one place only, with `newString`; with `replaceAll`, it replaces
 *  every place. */
export interface TextEdit {
  oldString: string
  newString: string
  replaceAll: boolean
}

/** What became of one edit: `text` tells what it did, or why it failed. */
export interface TextEditOutcome {
  done: boolean
  text: string
}

export interface TextEditPlan {
  /** One for each edit, in the order of the call. */
  outcomes: TextEditOutcome[]
  /** The text after the edits that passed. */
  text: string
  /** Whether the text after the edits differs from the text before. */
  changed: boolean
}

// The most places of one edit whose lines its outcome tells.
const SHOWN_PLACES = 5

// What became of one edit that found its text, before the line numbers of
// its places are known. `marks` are the offsets of its first places (at
// most `SHOWN_PLACES`) in the text as it is now: each later replacement
// moves them. `text` makes the outcome text from the line numbers of the
// marks.
interface PlacedStep {
  done: boolean
  marks: number[]
  text: (lines: readonly number[]) => string
}

// The start of each place of `search` in `text`, left to right. With
// `overlap`, every start, for the check that `search` is at one place
// only: `}\n}` is at two places of `}\n}\n}`. With no `overlap`, the places
// that `String.replaceAll` replaces.
function placesOf(text: string, search: string, overlap: boolean): number[] {
  const step = overlap ? 1 : search.length
  const starts: number[] = []
  for (let start = text.indexOf(search); start !== -1; start = text.indexOf(search, start + step)) {
    starts.push(start)
  }
  return starts
}

// `text` with the `oldLength` characters at each of `starts` replaced by
// `replacement`. No `String.replace`: it reads `$&` and the like in the
// replacement as patterns.
function replacedAt(text: string, starts: readonly number[], oldLength: number, replacement: string): string {
  const parts: string[] = []
  let end = 0
  for (const start of starts) {
    parts.push(text.slice(end, start), replacement)
    end = start + oldLength
  }
  parts.push(text.slice(end))
  return parts.join('')
}

// The offsets of `marks` (ascending) after the replacement of the
// `oldLength` characters at each of `starts` (ascending) with
// `newLength` characters. A mark after a replaced place moves by the
// change of its length; a mark inside a replaced place moves to its
// start. One walk over both lists.
function shiftedMarks(marks: readonly number[], starts: readonly number[], oldLength: number, newLength: number): number[] {
  const change = newLength - oldLength
  let before = 0
  return marks.map((mark) => {
    while (before < starts.length && starts[before] + oldLength <= mark) before += 1
    const inside = before < starts.length && starts[before] < mark
    return (inside ? starts[before] : mark) + before * change
  })
}

// Each `\n` of `text` that has no `\r` before it, as `\r\n`.
function withCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

// Whether `text` has `\r\n` line ends and no lone `\n`.
function hasOnlyCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(?:^|[^\r])\n/.test(text)
}

// `newString` with each lone `\n` as `\r\n`, for a text whose line ends
// are all `\r\n`. A place of an `oldString` that starts with `\n` comes
// after the `\r` of its line end, which stays: there, a `\n` at the start
// of `newString` ends that line as it is, with no second `\r`.
function crlfNewString(oldString: string, newString: string): string {
  if (oldString.startsWith('\n') && newString.startsWith('\n')) return `\n${withCrlf(newString.slice(1))}`
  return withCrlf(newString)
}

// The line number of each of `offsets` in `text`; line 1 is the first.
function lineNumbers(text: string, offsets: readonly number[]): number[] {
  const lineStarts = [0]
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', end + 1)) lineStarts.push(end + 1)
  return offsets.map((offset) => {
    // The number of line starts at or before `offset`.
    let low = 0
    let high = lineStarts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (lineStarts[middle] <= offset) low = middle + 1
      else high = middle
    }
    return low
  })
}

// The words that tell where the places of an edit are: `on line 4`,
// `on lines 4 and 9`, or, for more places than `SHOWN_PLACES`, `the first
// 5 on lines 1, 2, and 7`. Two places on one line name it once.
function placesText(lines: readonly number[], count: number): string {
  const distinct = [...new Set(lines)].map(String)
  const named = distinct.length === 1 ? `line ${distinct[0]}` : `lines ${seriesText(distinct, 'and')}`
  return count > lines.length ? `the first ${lines.length} on ${named}` : `on ${named}`
}

const MATCH_ADVICE = 'Read the file again, and give the text as it is in the file, with its white space and its line ends, '
  + 'but without the `12: ` before each line of a read result: that number is no part of the file.'

/** The plan of the `edits` of `text`. An edit fails when its
 *  `oldString` is empty, when it is not in the text, and when it is at
 *  more than one place with no `replaceAll` (places that overlap count);
 *  the other edits still pass. When an `oldString` with `\n` is not in a
 *  text with `\r\n` line ends, the edit takes each lone `\n` of
 *  `oldString` and `newString` as `\r\n`; in a text whose line ends are
 *  all `\r\n`, it writes each lone `\n` of `newString` as `\r\n` too.
 *  Each line number of an outcome is a number of the text after all the
 *  edits. */
export function planTextEdits(text: string, edits: readonly TextEdit[]): TextEditPlan {
  let current = text
  let replacedBefore = false
  const placed: PlacedStep[] = []
  const steps = edits.map((edit): TextEditOutcome | PlacedStep => {
    if (edit.oldString === '') {
      return { done: false, text: '`old_string` is empty. Give the text to replace; to make a new file, or to give a file all new text, use write.' }
    }
    let { oldString, newString } = edit
    let starts = placesOf(current, oldString, !edit.replaceAll)
    if (starts.length === 0 && current.includes('\r\n') && oldString.includes('\n')) {
      oldString = withCrlf(oldString)
      newString = withCrlf(newString)
      starts = placesOf(current, oldString, !edit.replaceAll)
    } else if (newString.includes('\n') && hasOnlyCrlf(current)) {
      newString = crlfNewString(oldString, newString)
    }
    if (starts.length === 0) {
      const earlier = replacedBefore ? ' The edits before this one changed the file first, and this edit looked for its text in what they left.' : ''
      return { done: false, text: `\`old_string\` is not in the file.${earlier} ${MATCH_ADVICE}` }
    }
    if (oldString === newString) return { done: true, text: 'No change: `new_string` is the same as `old_string`.' }

    const count = starts.length
    const marks = starts.slice(0, SHOWN_PLACES)
    if (count > 1 && !edit.replaceAll) {
      const step: PlacedStep = {
        done: false,
        marks,
        text: (lines) => `\`old_string\` is in the file at ${countText(count)} places, ${placesText(lines, count)}. `
          + 'Give more of the text around the place to change, so that `old_string` is in the file once, or set `replace_all` to true to change every place.',
      }
      placed.push(step)
      return step
    }

    const verb = newString === '' ? 'Deleted' : 'Replaced'
    const step: PlacedStep = {
      done: true,
      marks,
      text: (lines) => (count === 1 ? `${verb} the text at line ${lines[0]}.` : `${verb} the text at ${countText(count)} places, ${placesText(lines, count)}.`),
    }
    placed.push(step)
    // The marks of this edit move too: each one goes to the start of its
    // new text.
    for (const each of placed) each.marks = shiftedMarks(each.marks, starts, oldString.length, newString.length)
    current = replacedAt(current, starts, oldString.length, newString)
    replacedBefore = true
    return step
  })

  const lines = lineNumbers(current, placed.flatMap((step) => step.marks))
  let next = 0
  const outcomes = steps.map((step): TextEditOutcome => {
    if (!('marks' in step)) return step
    const stepLines = lines.slice(next, next + step.marks.length)
    next += step.marks.length
    return { done: step.done, text: step.text(stepLines) }
  })
  return { outcomes, text: current, changed: current !== text }
}
