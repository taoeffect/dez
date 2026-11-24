import { describe, expect, it } from 'vitest'
import { cutDiff, hunkRows, linesText, planLineEdits, textLines, type LineEdit } from './lineEdits'

const TEN = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

// The texts of the outcomes of `edits` on the file with `lines`.
function outcomes(lines: readonly string[], edits: readonly LineEdit[]): string[] {
  return planLineEdits(lines, edits).outcomes.map((outcome) => `${outcome.done ? 'done' : 'failed'}: ${outcome.text}`)
}

describe('textLines and linesText', () => {
  it('take a line end at the end of a text as the end of the last line', () => {
    expect(textLines('')).toStrictEqual([])
    expect(textLines('\n')).toStrictEqual([''])
    expect(textLines('a\nb')).toStrictEqual(['a', 'b'])
    expect(textLines('a\nb\n')).toStrictEqual(['a', 'b'])
    expect(textLines('a\n\n')).toStrictEqual(['a', ''])

    expect(linesText(['a', 'b'], false)).toBe('a\nb')
    expect(linesText(['a', 'b'], true)).toBe('a\nb\n')
    expect(linesText([''], true)).toBe('\n')
    expect(linesText([], true)).toBe('')
  })

  it('give the line ends of a Windows file back as they were', () => {
    const text = 'a\r\nb\r\n'

    expect(textLines(text)).toStrictEqual(['a\r', 'b\r'])
    expect(linesText(textLines(text), true)).toBe(text)
  })
})

describe('planLineEdits', () => {
  it('takes every line number as a number of the file before the call', () => {
    const plan = planLineEdits(TEN, [
      { fromLine: 2, toLine: 3, content: 'TWO' },
      { afterLine: 5, content: 'five and a half\n' },
      { fromLine: 9, content: '' },
    ])

    expect(plan.lines).toStrictEqual(['one', 'TWO', 'four', 'five', 'five and a half', 'six', 'seven', 'eight', 'ten'])
    expect(plan.changed).toBe(true)
    expect(plan.outcomes).toStrictEqual([
      { done: true, text: 'Replaced lines 2-3 with 1 line.' },
      { done: true, text: 'Put 1 line in after line 5.' },
      { done: true, text: 'Deleted line 9.' },
    ])
    expect(plan.hunks).toStrictEqual([{
      header: '@@ -1,10 +1,9 @@',
      lines: [' one', '-two', '-three', '+TWO', ' four', ' five', '+five and a half', ' six', ' seven', ' eight', '-nine', ' ten'],
    }])
  })

  it('applies the edits in the order of the file, whatever the order of the call', () => {
    const plan = planLineEdits(TEN, [{ fromLine: 9, content: 'NINE' }, { fromLine: 1, content: 'ONE' }])

    expect(plan.lines).toStrictEqual(['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'NINE', 'ten'])
  })

  it('gives each far change its own hunk, with three lines around it', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)

    expect(planLineEdits(lines, [{ fromLine: 2, content: 'L2' }, { fromLine: 15, content: 'L15' }]).hunks).toStrictEqual([
      { header: '@@ -1,5 +1,5 @@', lines: [' l1', '-l2', '+L2', ' l3', ' l4', ' l5'] },
      { header: '@@ -12,7 +12,7 @@', lines: [' l12', ' l13', ' l14', '-l15', '+L15', ' l16', ' l17', ' l18'] },
    ])
  })

  it('counts the lines of a hunk after an earlier hunk that made the file longer', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)

    const { hunks } = planLineEdits(lines, [{ afterLine: 1, content: 'a\nb' }, { fromLine: 15, toLine: 16, content: '' }])

    expect(hunks.map((hunk) => hunk.header)).toStrictEqual(['@@ -1,4 +1,6 @@', '@@ -12,8 +14,6 @@'])
  })

  it('shows as changed only the lines of a replacement that differ', () => {
    const plan = planLineEdits(['a', 'b', 'c', 'd', 'e'], [{ fromLine: 2, toLine: 4, content: 'b\nX\nd' }])

    expect(plan.outcomes).toStrictEqual([{ done: true, text: 'Replaced lines 2-4 with 3 lines.' }])
    expect(plan.hunks).toStrictEqual([{ header: '@@ -1,5 +1,5 @@', lines: [' a', ' b', '-c', '+X', ' d', ' e'] }])
  })

  it('tells that a replacement with the same text changes nothing', () => {
    const plan = planLineEdits(['a', 'b', 'c'], [{ fromLine: 2, content: 'b\n' }])

    expect(plan).toStrictEqual({ outcomes: [{ done: true, text: 'No change: line 2 had this text already.' }], lines: ['a', 'b', 'c'], changed: false, hunks: [] })
  })

  it('puts lines into an empty file, and before the first line', () => {
    const made = planLineEdits([], [{ afterLine: 0, content: 'a\nb\n' }])
    expect(made.lines).toStrictEqual(['a', 'b'])
    expect(made.outcomes).toStrictEqual([{ done: true, text: 'Put 2 lines in at the start of the file.' }])
    expect(made.hunks).toStrictEqual([{ header: '@@ -0,0 +1,2 @@', lines: ['+a', '+b'] }])

    expect(planLineEdits(['a'], [{ afterLine: 0, content: 'first' }]).lines).toStrictEqual(['first', 'a'])
    expect(planLineEdits(['a'], [{ afterLine: 1, content: '\n' }]).lines).toStrictEqual(['a', ''])
  })

  it('puts new lines after the lines that replace their line, and those of two edits in the order of the call', () => {
    const lines = ['a', 'b', 'c']

    expect(planLineEdits(lines, [{ afterLine: 2, content: 'x' }, { fromLine: 2, content: 'B' }, { afterLine: 2, content: 'y' }]).lines).toStrictEqual(['a', 'B', 'x', 'y', 'c'])
    expect(planLineEdits(lines, [{ fromLine: 2, content: 'B' }, { afterLine: 1, content: 'x' }]).lines).toStrictEqual(['a', 'x', 'B', 'c'])
  })

  it('fails an edit that tells no kind, or two', () => {
    const advice = 'Give `from_line` (and `to_line`) to replace lines, or `after_line` to put lines in.'

    expect(outcomes(TEN, [{ content: 'x' }, { fromLine: 1, afterLine: 1, content: 'x' }, { afterLine: 1, toLine: 2, content: 'x' }])).toStrictEqual([
      `failed: It has no \`from_line\` and no \`after_line\`. ${advice}`,
      `failed: It has both \`from_line\` and \`after_line\`. ${advice}`,
      'failed: It has `to_line` with `after_line`. `to_line` goes with `from_line` only: an edit with `after_line` replaces no line.',
    ])
  })

  it('fails an edit of lines that the file does not have', () => {
    expect(outcomes(TEN, [
      { fromLine: 0, content: 'x' },
      { fromLine: 4, toLine: 3, content: 'x' },
      { fromLine: 9, toLine: 12, content: 'x' },
      { afterLine: -1, content: 'x' },
      { afterLine: 11, content: 'x' },
      { afterLine: 10, content: '' },
    ])).toStrictEqual([
      'failed: `from_line` is 0. The first line of a file is line 1.',
      'failed: `to_line` (3) is before `from_line` (4).',
      'failed: It names lines 9-12, and the file has 10 lines.',
      'failed: `after_line` is -1. Give 0 to put the lines in before the first line.',
      'failed: `after_line` is 11, and the file has 10 lines.',
      'failed: Its `content` is empty, so there is no line to put in. Give "\\n" for one empty line.',
    ])
    expect(outcomes([], [{ fromLine: 1, content: 'x' }])).toStrictEqual(['failed: It names line 1, and the file is empty. Put lines in with `after_line` 0.'])
  })

  it('fails an edit of lines that an earlier edit of the call changes, and does the others', () => {
    const plan = planLineEdits(TEN, [
      { fromLine: 2, toLine: 4, content: 'x' },
      { fromLine: 4, toLine: 6, content: 'y' },
      { afterLine: 3, content: 'z' },
      { afterLine: 8, content: 'w' },
      { fromLine: 8, toLine: 9, content: 'v' },
      { afterLine: 4, content: 'u' },
    ])

    expect(plan.outcomes).toStrictEqual([
      { done: true, text: 'Replaced lines 2-4 with 1 line.' },
      { done: false, text: 'It names lines 4-6, and edit 1 replaces lines 2-4 already. Make one edit of the two.' },
      { done: false, text: 'Line 3 is inside the lines 2-4 that edit 1 replaces. Make one edit of the two.' },
      { done: true, text: 'Put 1 line in after line 8.' },
      { done: false, text: 'It names lines 8-9, and edit 4 puts lines in after line 8, which is inside them. Make one edit of the two.' },
      { done: true, text: 'Put 1 line in after line 4.' },
    ])
    expect(plan.lines).toStrictEqual(['one', 'x', 'u', 'five', 'six', 'seven', 'eight', 'w', 'nine', 'ten'])
  })
})

describe('cutDiff', () => {
  // The rows of the diff of `edits` on the file with `lines`, as a result
  // shows them.
  const diff = (lines: readonly string[], edits: readonly LineEdit[]) => cutDiff(planLineEdits(lines, edits).hunks.flatMap(hunkRows))
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => `l${index + 1}`)

  it('shows a hunk of 20 lines whole', () => {
    expect(diff(numbered(20), [
      { fromLine: 2, toLine: 3, content: 'L2' },
      { afterLine: 8, content: 'new' },
      { fromLine: 14, toLine: 15, content: '' },
    ])).toStrictEqual([
      '@@ -1,18 +1,16 @@', ' l1', '-l2', '-l3', '+L2', ' l4', ' l5', ' l6', ' l7', ' l8', '+new',
      ' l9', ' l10', ' l11', ' l12', ' l13', '-l14', '-l15', ' l16', ' l17', ' l18',
    ])
  })

  it('shows only the first 8 and the last 8 lines of a longer hunk, each hunk by itself', () => {
    const note = (count: number) => `… ${count} lines of this hunk are not shown, to save context. read gives the file as it is now.`

    expect(diff(numbered(80), [
      { fromLine: 5, toLine: 11, content: 'A\nB\nC\nD\nE\nF\nG\nH' },
      { fromLine: 30, content: 'X' },
      { fromLine: 50, toLine: 60, content: Array.from({ length: 11 }, (_, index) => `N${index + 1}`).join('\n') },
    ])).toStrictEqual([
      '@@ -2,13 +2,14 @@', ' l2', ' l3', ' l4', '-l5', '-l6', '-l7', '-l8', '-l9',
      note(5),
      '+D', '+E', '+F', '+G', '+H', ' l12', ' l13', ' l14',
      '@@ -27,7 +28,7 @@', ' l27', ' l28', ' l29', '-l30', '+X', ' l31', ' l32', ' l33',
      '@@ -47,17 +48,17 @@', ' l47', ' l48', ' l49', '-l50', '-l51', '-l52', '-l53', '-l54',
      note(12),
      '+N7', '+N8', '+N9', '+N10', '+N11', ' l61', ' l62', ' l63',
    ])
  })

  it('gives a short diff for an edit of a whole long file', () => {
    const lines = numbered(400)

    expect(diff(lines, [{ fromLine: 1, toLine: 400, content: lines.map((line) => `${line}!`).join('\n') }])).toStrictEqual([
      '@@ -1,400 +1,400 @@', ...lines.slice(0, 8).map((line) => `-${line}`),
      '… 784 lines of this hunk are not shown, to save context. read gives the file as it is now.',
      ...lines.slice(-8).map((line) => `+${line}!`),
    ])
  })

  it('cuts a long diff of many hunks', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} ${'-'.repeat(90)}`)
    const shown = diff(lines, Array.from({ length: 40 }, (_, index) => ({ fromLine: index * 10 + 1, content: `${lines[index * 10]}!` })))

    expect(shown.at(-1)).toMatch(/^… [\d,]+ more lines of the diff are not shown\. read gives the file as it is now\.$/)
    expect(shown.join('\n').length).toBeLessThan(20_200)
  })

  it('counts the lines of the diff that a cut leaves out, with those that the note of a long hunk stands for', () => {
    const cutNote = (count: number) => `… ${count} more lines of the diff are not shown. read gives the file as it is now.`
    const long = numbered(20).map((line) => line.padEnd(5_000, '.'))

    expect(diff(long, [{ fromLine: 1, toLine: 20, content: long.map((line) => line.replaceAll('.', '!')).join('\n') }]))
      .toStrictEqual(['@@ -1,20 +1,20 @@', ...long.slice(0, 3).map((line) => `-${line}`), cutNote(37)])

    const longNew = numbered(20).map((line) => line.padEnd(7_000, '!'))

    expect(diff(numbered(20), [{ fromLine: 1, toLine: 20, content: longNew.join('\n') }])).toStrictEqual([
      '@@ -1,20 +1,20 @@', ...numbered(8).map((line) => `-${line}`),
      '… 24 lines of this hunk are not shown, to save context. read gives the file as it is now.',
      `+${longNew[12]}`, `+${longNew[13]}`, cutNote(6),
    ])
  })
})
