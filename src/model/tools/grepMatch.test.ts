import { describe, expect, it } from 'vitest'
import { GREP_MAX_CHARACTERS, GREP_MAX_MATCHES, GREP_SLOW_LINE_MS, grepFiles, grepRowLines, type GrepOutcome } from './grepMatch'
import { textBytes } from './testing'

// The matching of `apps grep`, as the worker runs it: the rows of each file,
// the limits of one result, and the files that it does not search.

// The outcome of `source` on `files`; `msPerTest` is how long the clock
// says that each test of a line takes (a step of the clock).
function grep(source: string, files: Record<string, string | Uint8Array>, context = 0, msPerTest = 0): GrepOutcome {
  let time = 0
  return grepFiles({
    source,
    flags: 'u',
    context,
    files: Object.entries(files).map(([path, content]) => ({ path, bytes: typeof content === 'string' ? textBytes(content) : content })),
  }, () => (time += msPerTest))
}

// The rows of each file with a match, as a result shows them.
function rows(outcome: GrepOutcome, context = 0): Record<string, string[]> {
  return Object.fromEntries(outcome.files.map((file) => [file.path, grepRowLines(file.rows, context)]))
}

describe('grepFiles', () => {
  it('gives each matching line with its number, the lines around it, and "--" between groups', () => {
    const outcome = grep('foo', { 'a.js': 'a\nfoo 1\nb\nc\nd\ne\nfoo 2\nfoo 3\nf\ng\n', 'b.js': 'none\n', 'c.js': 'foo' }, 1)

    expect(rows(outcome, 1)).toStrictEqual({
      'a.js': ['1- a', '2: foo 1', '3- b', '--', '6- e', '7: foo 2', '8: foo 3', '9- f'],
      'c.js': ['1: foo'],
    })
    expect(outcome.files.map(({ matches, shown }) => [matches, shown])).toStrictEqual([[3, 3], [1, 1]])
    expect(outcome).toMatchObject({ searched: 3, notText: 0, cutLines: false, slowLines: [] })
  })

  it('matches a line with no byte order mark and no "\\r" at its end, and keeps the numbers of read', () => {
    expect(rows(grep('^foo$', { 'a.txt': '\uFEFFfoo\r\nbar\r\nfoo\r\n' }))).toStrictEqual({ 'a.txt': ['1: foo', '3: foo'] })
  })

  it('searches no file that is no text', () => {
    const outcome = grep('foo', { 'a.bin': new Uint8Array([0x66, 0x6f, 0x6f, 0]), 'b.txt': new Uint8Array([0xff, 0x66, 0x6f, 0x6f]), 'c.txt': 'foo' })

    expect(rows(outcome)).toStrictEqual({ 'c.txt': ['1: foo'] })
    expect(outcome).toMatchObject({ searched: 1, notText: 2 })
  })

  it('shows at most the limit of matching lines, and counts them all', () => {
    const outcome = grep('foo', { 'a.js': 'foo\n'.repeat(GREP_MAX_MATCHES + 50), 'b.js': 'foo\nfoo\n' })

    expect(outcome.files.map(({ path, matches, shown, rows: fileRows }) => ({ path, matches, shown, rows: fileRows.length }))).toStrictEqual([
      { path: 'a.js', matches: GREP_MAX_MATCHES + 50, shown: GREP_MAX_MATCHES, rows: GREP_MAX_MATCHES },
      { path: 'b.js', matches: 2, shown: 0, rows: 0 },
    ])
  })

  it('stops the rows at the limit of characters, with the path line of each file', () => {
    const line = `foo${'x'.repeat(280)}`
    const outcome = grep('foo', { 'a.js': `${line}\n`.repeat(100) })
    const [file] = outcome.files
    const shownText = ['', file.path, ...grepRowLines(file.rows, 0)].join('\n')
    const nextRow = `${file.shown + 1}: ${line}\n`

    expect(file.matches).toBe(100)
    expect(file.shown).toBeLessThan(100)
    expect(shownText.length).toBeLessThanOrEqual(GREP_MAX_CHARACTERS)
    expect(shownText.length + nextRow.length).toBeGreaterThan(GREP_MAX_CHARACTERS)
  })

  it('shows a part of a long line: around the first match of a matching line, and the start of a line around one', () => {
    const middle = `${'x'.repeat(1000)}NEEDLE${'y'.repeat(1000)}`
    const outcome = grep('NEEDLE', { 'a.js': `${'z'.repeat(400)}\n${middle}\n`, 'b.js': `${'a'.repeat(1000)}NEEDLE`, 'c.js': `${'😀'.repeat(200)}NEEDLE!` }, 1)

    expect(rows(outcome, 1)).toStrictEqual({
      'a.js': [`1- ${'z'.repeat(300)}…`, `2: …${'x'.repeat(100)}NEEDLE${'y'.repeat(194)}…`],
      'b.js': [`1: …${'a'.repeat(294)}NEEDLE`],
      // The cut drops the half of the character that it splits.
      'c.js': [`1: …${'😀'.repeat(146)}NEEDLE!`],
    })
    expect(outcome.cutLines).toBe(true)
  })

  it('gives each line whose test was slow and gave no match, as the engine can have given up on it', () => {
    const files = { 'a.js': 'a\nfoo\nb\n', 'b.js': 'foo\nc\n' }

    expect(grep('foo', files, 0, GREP_SLOW_LINE_MS + 1).slowLines).toStrictEqual([{ path: 'a.js', line: 1 }, { path: 'a.js', line: 3 }, { path: 'b.js', line: 2 }])
    expect(grep('foo', files, 0, GREP_SLOW_LINE_MS).slowLines).toStrictEqual([])
  })
})
