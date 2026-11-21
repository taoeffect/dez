import { describe, expect, it } from 'vitest'
import { linesText, planLineEdits, textLines, type LineEdit } from './lineEdits'

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
      { fromLine: 2, toLine: 3, text: 'TWO' },
      { afterLine: 5, text: 'five and a half\n' },
      { fromLine: 9, text: '' },
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
    const plan = planLineEdits(TEN, [{ fromLine: 9, text: 'NINE' }, { fromLine: 1, text: 'ONE' }])

    expect(plan.lines).toStrictEqual(['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'NINE', 'ten'])
  })

  it('gives each far change its own hunk, with three lines around it', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)

    expect(planLineEdits(lines, [{ fromLine: 2, text: 'L2' }, { fromLine: 15, text: 'L15' }]).hunks).toStrictEqual([
      { header: '@@ -1,5 +1,5 @@', lines: [' l1', '-l2', '+L2', ' l3', ' l4', ' l5'] },
      { header: '@@ -12,7 +12,7 @@', lines: [' l12', ' l13', ' l14', '-l15', '+L15', ' l16', ' l17', ' l18'] },
    ])
  })

  it('counts the lines of a hunk after an earlier hunk that made the file longer', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `l${index + 1}`)

    const { hunks } = planLineEdits(lines, [{ afterLine: 1, text: 'a\nb' }, { fromLine: 15, toLine: 16, text: '' }])

    expect(hunks.map((hunk) => hunk.header)).toStrictEqual(['@@ -1,4 +1,6 @@', '@@ -12,8 +14,6 @@'])
  })

  it('shows as changed only the lines of a replacement that differ', () => {
    const plan = planLineEdits(['a', 'b', 'c', 'd', 'e'], [{ fromLine: 2, toLine: 4, text: 'b\nX\nd' }])

    expect(plan.outcomes).toStrictEqual([{ done: true, text: 'Replaced lines 2-4 with 3 lines.' }])
    expect(plan.hunks).toStrictEqual([{ header: '@@ -1,5 +1,5 @@', lines: [' a', ' b', '-c', '+X', ' d', ' e'] }])
  })

  it('tells that a replacement with the same text changes nothing', () => {
    const plan = planLineEdits(['a', 'b', 'c'], [{ fromLine: 2, text: 'b\n' }])

    expect(plan).toStrictEqual({ outcomes: [{ done: true, text: 'No change: line 2 had this text already.' }], lines: ['a', 'b', 'c'], changed: false, hunks: [] })
  })

  it('puts lines into an empty file, and before the first line', () => {
    const made = planLineEdits([], [{ afterLine: 0, text: 'a\nb\n' }])
    expect(made.lines).toStrictEqual(['a', 'b'])
    expect(made.outcomes).toStrictEqual([{ done: true, text: 'Put 2 lines in at the start of the file.' }])
    expect(made.hunks).toStrictEqual([{ header: '@@ -0,0 +1,2 @@', lines: ['+a', '+b'] }])

    expect(planLineEdits(['a'], [{ afterLine: 0, text: 'first' }]).lines).toStrictEqual(['first', 'a'])
    expect(planLineEdits(['a'], [{ afterLine: 1, text: '\n' }]).lines).toStrictEqual(['a', ''])
  })

  it('puts new lines after the lines that replace their line, and those of two edits in the order of the call', () => {
    const lines = ['a', 'b', 'c']

    expect(planLineEdits(lines, [{ afterLine: 2, text: 'x' }, { fromLine: 2, text: 'B' }, { afterLine: 2, text: 'y' }]).lines).toStrictEqual(['a', 'B', 'x', 'y', 'c'])
    expect(planLineEdits(lines, [{ fromLine: 2, text: 'B' }, { afterLine: 1, text: 'x' }]).lines).toStrictEqual(['a', 'x', 'B', 'c'])
  })

  it('fails an edit that tells no kind, or two', () => {
    const advice = 'Give `from_line` (and `to_line`) to replace lines, or `after_line` to put lines in.'

    expect(outcomes(TEN, [{ text: 'x' }, { fromLine: 1, afterLine: 1, text: 'x' }, { afterLine: 1, toLine: 2, text: 'x' }])).toStrictEqual([
      `failed: It has no \`from_line\` and no \`after_line\`. ${advice}`,
      `failed: It has both \`from_line\` and \`after_line\`. ${advice}`,
      'failed: It has `to_line` with `after_line`. `to_line` goes with `from_line` only: an edit with `after_line` replaces no line.',
    ])
  })

  it('fails an edit of lines that the file does not have', () => {
    expect(outcomes(TEN, [
      { fromLine: 0, text: 'x' },
      { fromLine: 4, toLine: 3, text: 'x' },
      { fromLine: 9, toLine: 12, text: 'x' },
      { afterLine: -1, text: 'x' },
      { afterLine: 11, text: 'x' },
      { afterLine: 10, text: '' },
    ])).toStrictEqual([
      'failed: `from_line` is 0. The first line of a file is line 1.',
      'failed: `to_line` (3) is before `from_line` (4).',
      'failed: It names lines 9-12, and the file has 10 lines.',
      'failed: `after_line` is -1. Give 0 to put the lines in before the first line.',
      'failed: `after_line` is 11, and the file has 10 lines.',
      'failed: Its `text` is empty, so there is no line to put in. Give "\\n" for one empty line.',
    ])
    expect(outcomes([], [{ fromLine: 1, text: 'x' }])).toStrictEqual(['failed: It names line 1, and the file is empty. Put lines in with `after_line` 0.'])
  })

  it('fails an edit of lines that an earlier edit of the call changes, and does the others', () => {
    const plan = planLineEdits(TEN, [
      { fromLine: 2, toLine: 4, text: 'x' },
      { fromLine: 4, toLine: 6, text: 'y' },
      { afterLine: 3, text: 'z' },
      { afterLine: 8, text: 'w' },
      { fromLine: 8, toLine: 9, text: 'v' },
      { afterLine: 4, text: 'u' },
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
