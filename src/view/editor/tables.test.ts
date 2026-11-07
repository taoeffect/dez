import { EditorSelection, EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { PILL_NL, SECTION_SEP, encodePrompt } from '../thread/cmEditor'
import { cellShape, findMarkdownTables, markdownTables } from './tables'

function scan(doc: string) {
  return findMarkdownTables(Text.of(doc.split('\n')))
}

/** Each table as its rows, each row as its cell source texts. */
function cellTexts(doc: string): string[][][] {
  return scan(doc).map((table) => table.rows.map((row) => row.cells.map((cell) => doc.slice(cell.from, cell.to))))
}

/** The source text of each table. */
function tableSources(doc: string): string[] {
  return scan(doc).map((table) => doc.slice(table.from, table.to))
}

function lines(...rows: string[]): string {
  return rows.join('\n')
}

const HEADER = '| a | b |'
const DELIMITER = '|---|---|'

describe('findMarkdownTables', () => {
  it('finds a table and splits each row line into cells that cover it end to end', () => {
    const doc = lines('intro', HEADER, DELIMITER, '| 1 | 2 |', '', 'outro')
    const [table, ...rest] = scan(doc)
    expect(rest).toEqual([])
    expect(doc.slice(table.from, table.to)).toBe(lines(HEADER, DELIMITER, '| 1 | 2 |'))
    expect(table.rows.map((row) => row.kind)).toEqual(['header', 'delimiter', 'body'])
    for (const row of table.rows) {
      expect(row.cells[0].from).toBe(row.from)
      expect(row.cells[row.cells.length - 1].to).toBe(row.to)
      for (let i = 1; i < row.cells.length; i++) expect(row.cells[i].from).toBe(row.cells[i - 1].to)
    }
    expect(cellTexts(doc)).toEqual([[['| a ', '| b |'], ['|---', '|---|'], ['| 1 ', '| 2 |']]])
  })

  it('lists the pipes that split cells inside each cell', () => {
    const doc = lines(HEADER, DELIMITER)
    const [header] = scan(doc)[0].rows
    expect(header.cells.map((cell) => cell.pipes)).toEqual([[0], [4, 8]])
  })

  it('needs a delimiter row with the same cell count as the header', () => {
    expect(scan(lines('| a | b | c |', DELIMITER))).toEqual([])
    expect(scan(lines('| a |', DELIMITER))).toEqual([])
    expect(tableSources(lines('| a | b | c |', '|---|---|---|'))).toHaveLength(1)
  })

  it('does not split cells at escaped pipes', () => {
    expect(cellTexts(lines('a \\| b | c', '--- | ---'))[0][0]).toEqual(['a \\| b ', '| c'])
    // A double backslash escapes itself, so the pipe after it splits.
    expect(cellTexts(lines('a \\\\| b', '--- | ---'))[0][0]).toEqual(['a \\\\', '| b'])
    // A header with only escaped pipes is a paragraph.
    expect(scan(lines('a \\| b', '---|'))).toEqual([])
  })

  it('accepts rows with or without outer pipes', () => {
    expect(cellTexts(lines('a | b', '--- | ---', '1 | 2'))).toEqual([
      [['a ', '| b'], ['--- ', '| ---'], ['1 ', '| 2']],
    ])
    expect(cellTexts(lines('| a | b', '--- | --- |', '1|2|'))).toEqual([
      [['| a ', '| b'], ['--- ', '| --- |'], ['1', '|2|']],
    ])
    // Leading whitespace stays in the first cell, trailing in the last.
    expect(cellTexts(lines('  a | b  ', '-|-'))[0][0]).toEqual(['  a ', '| b  '])
  })

  it('reads column alignments from the delimiter row', () => {
    const [table] = scan(lines('| a | b | c | d |', '| :-- | :-: | --: | --- |'))
    expect(table.alignments).toEqual(['left', 'center', 'right', null])
  })

  it('finds single-column tables', () => {
    expect(cellTexts(lines('| a |', '| - |', '| 1 |'))).toEqual([[['| a |'], ['| - |'], ['| 1 |']]])
    expect(cellTexts(lines('a |', '-|'))).toEqual([[['a |'], ['-|']]])
  })

  it('joins extra body cells into the last column and keeps their pipes as text', () => {
    const doc = lines(HEADER, DELIMITER, '| 1 | 2 | 3 |')
    const body = scan(doc)[0].rows[2]
    expect(body.cells.map((cell) => doc.slice(cell.from, cell.to))).toEqual(['| 1 ', '| 2 | 3 |'])
    expect(body.cells[1].pipes.map((pos) => pos - body.from)).toEqual([4, 12])

    const single = lines('| a |', '| - |', '| 1 | 2 |')
    const singleBody = scan(single)[0].rows[2]
    expect(singleBody.cells.map((cell) => cell.pipes.map((pos) => pos - singleBody.from))).toEqual([[0, 8]])
  })

  it('renders short body rows, pipe-less body rows, and a lone pipe as fewer cells', () => {
    expect(cellTexts(lines(HEADER, DELIMITER, '| 1 |', 'plain text', '  |  '))[0].slice(2)).toEqual([
      ['| 1 |'],
      ['plain text'],
      ['  |  '],
    ])
  })

  it.each([
    ['a blank line', '   '],
    ['an ATX heading', '## Next'],
    ['an empty ATX heading', '#'],
    ['a backtick fence', '```ts'],
    ['a tilde fence', '~~~'],
    ['a bullet list item', '- | x |'],
    ['an ordered list item', '1. | x |'],
    ['a blockquote', '> | x |'],
    ['a thematic break', '***'],
  ])('ends a table at %s', (_name, line) => {
    expect(tableSources(lines(HEADER, DELIMITER, '| 1 | 2 |', line, '| 3 | 4 |'))).toEqual([
      lines(HEADER, DELIMITER, '| 1 | 2 |'),
    ])
  })

  it('keeps lines that only look like block starts as body rows', () => {
    const doc = lines(HEADER, DELIMITER, '#tag | x', '-1 | y', '1.5 | z')
    expect(tableSources(doc)).toEqual([doc])
  })

  it('finds a new table after a blank line, but not inside a table body', () => {
    expect(tableSources(lines(HEADER, DELIMITER, '', HEADER, DELIMITER))).toHaveLength(2)
    const nested = lines(HEADER, DELIMITER, HEADER, DELIMITER)
    expect(tableSources(nested)).toEqual([nested])
  })

  it('lets a header line interrupt a paragraph', () => {
    expect(tableSources(lines('Some text', HEADER, DELIMITER))).toEqual([lines(HEADER, DELIMITER)])
  })

  it('finds no tables inside fenced code', () => {
    expect(scan(lines('```md', HEADER, DELIMITER, '```'))).toEqual([])
    expect(scan(lines('~~~~', HEADER, DELIMITER, '~~~~'))).toEqual([])
  })

  it('closes a fence only with the same char, at least as long, and nothing after', () => {
    const after = lines('', HEADER, DELIMITER)
    expect(tableSources(lines('```', 'x', '  ```  ', after))).toHaveLength(1)
    expect(tableSources(lines('````', 'x', '`````', after))).toHaveLength(1)
    expect(scan(lines('````', 'x', '```', after))).toEqual([])
    expect(scan(lines('```', 'x', '~~~', after))).toEqual([])
    expect(scan(lines('```', 'x', '``` js', after))).toEqual([])
    expect(scan(lines('```', 'x', '    ```', after))).toEqual([])
  })

  it('does not open a fence at a backtick line that has backticks in its info string', () => {
    expect(tableSources(lines('```inline``` code', HEADER, DELIMITER))).toHaveLength(1)
  })

  it('ends an unclosed fence at a section separator', () => {
    const doc = lines('```', HEADER, DELIMITER, SECTION_SEP, HEADER, DELIMITER, '| 1 | 2 |')
    expect(tableSources(doc)).toEqual([lines(HEADER, DELIMITER, '| 1 | 2 |')])
    expect(scan(doc)[0].from).toBe(doc.lastIndexOf(HEADER))
  })

  it('treats sections as separate docs', () => {
    expect(tableSources(lines(HEADER, DELIMITER, SECTION_SEP, '| 1 | 2 |'))).toEqual([lines(HEADER, DELIMITER)])
    expect(tableSources(lines('x', SECTION_SEP, HEADER, DELIMITER))).toEqual([lines(HEADER, DELIMITER)])
    expect(scan(lines(HEADER, SECTION_SEP, DELIMITER))).toEqual([])
  })

  it('never uses a line with a pill marker as a table line', () => {
    const pill = `see ${encodePrompt('p1', 'x | y')}`
    expect(tableSources(lines(HEADER, DELIMITER, pill, '| 1 | 2 |'))).toEqual([lines(HEADER, DELIMITER)])
    expect(scan(lines(`${pill} | b`, DELIMITER))).toEqual([])
    expect(scan(lines(`a ${PILL_NL} | b`, DELIMITER))).toEqual([])
  })

  it('finds a table on the plain lines of an expanded prompt body', () => {
    const body = lines('intro', HEADER, DELIMITER, '| 1 | 2 |', '')
    const doc = encodePrompt('p1', body, false)
    expect(tableSources(doc)).toEqual([lines(HEADER, DELIMITER, '| 1 | 2 |')])
  })

  it('needs at most 3 spaces of indent on the header and delimiter rows', () => {
    expect(tableSources(lines('   | a | b |', '   |---|---|'))).toHaveLength(1)
    expect(scan(lines('    | a | b |', DELIMITER))).toEqual([])
    expect(scan(lines(HEADER, '    |---|---|'))).toEqual([])
    expect(scan(lines(`\t${HEADER}`, DELIMITER))).toEqual([])
  })

  it('finds no table when the header has a list or blockquote prefix', () => {
    expect(scan(lines('- a | b', DELIMITER))).toEqual([])
    expect(scan(lines('1. a | b', DELIMITER))).toEqual([])
    expect(scan(lines('> a | b', DELIMITER))).toEqual([])
    expect(scan(lines('# a | b', DELIMITER))).toEqual([])
  })

  it('finds no table when the delimiter row is a list item', () => {
    expect(scan(lines('a | b', '- | -'))).toEqual([])
  })

  it('allows trailing whitespace after the delimiter row', () => {
    expect(tableSources(lines(HEADER, `${DELIMITER}  `))).toHaveLength(1)
  })

  it('finds a streaming table once the delimiter row has the header cell count', () => {
    expect(scan(lines(HEADER, '|-'))).toEqual([])
    expect(scan(lines(HEADER, '|---'))).toEqual([])
    expect(scan(lines(HEADER, '|---|'))).toEqual([])
    expect(tableSources(lines(HEADER, '|---|-'))).toHaveLength(1)
    expect(cellTexts(lines(HEADER, DELIMITER, '| 1 | 2'))[0][2]).toEqual(['| 1 ', '| 2'])
  })
})

/** The shape of each cell in the last row of the first table, with doc
 *  positions relative to the start of that row. */
function lastRowShapes(doc: string) {
  const row = scan(doc)[0].rows.at(-1)!
  return row.cells.map((cell) => {
    const shape = cellShape(Text.of(doc.split('\n')), cell)
    return {
      opened: shape.opened,
      closingPipe: shape.closingPipe === null ? null : shape.closingPipe - row.from,
      text: doc.slice(shape.text.from, shape.text.to),
      padding: shape.padding.map(({ from, to }) => [from - row.from, to - row.from]),
      visibleText: shape.visibleText,
    }
  })
}

describe('cellShape', () => {
  it('splits padded cells into their pipes, padding, and text', () => {
    expect(lastRowShapes(lines(HEADER, DELIMITER, '| a   |   b |'))).toEqual([
      { opened: true, closingPipe: null, text: 'a', padding: [[1, 2], [3, 6]], visibleText: 'a' },
      { opened: true, closingPipe: 12, text: 'b', padding: [[7, 10], [11, 12]], visibleText: 'b' },
    ])
  })

  it('takes the spaces at the line ends of a row without edge pipes as padding', () => {
    expect(lastRowShapes(lines('x | y', '--- | ---', '  a  |  b  '))).toEqual([
      { opened: false, closingPipe: null, text: 'a', padding: [[0, 2], [3, 5]], visibleText: 'a' },
      { opened: true, closingPipe: null, text: 'b', padding: [[6, 8], [9, 11]], visibleText: 'b' },
    ])
  })

  it('takes the spaces before the leading pipe and after the trailing pipe as padding', () => {
    expect(lastRowShapes(lines('| a |', '|---|', '   | b |   '))).toEqual([
      { opened: true, closingPipe: 7, text: 'b', padding: [[0, 3], [4, 5], [6, 7], [8, 11]], visibleText: 'b' },
    ])
  })

  it('gives an empty cell one padding run and an empty text after its opening pipe', () => {
    expect(lastRowShapes(lines(HEADER, DELIMITER, '|   | b |'))[0]).toEqual(
      { opened: true, closingPipe: null, text: '', padding: [[1, 4]], visibleText: '' },
    )
    const doc = lines(HEADER, DELIMITER, '|   | b |')
    const cell = scan(doc)[0].rows[2].cells[0]
    expect(cellShape(Text.of(doc.split('\n')), cell).text).toEqual({ from: cell.from + 1, to: cell.from + 1 })
  })

  it('keeps the tabs around the text out of the padding and in the visible text', () => {
    expect(lastRowShapes(lines(HEADER, DELIMITER, '\t| x | y |'))[0]).toEqual(
      { opened: true, closingPipe: null, text: 'x', padding: [[2, 3], [4, 5]], visibleText: '\tx' },
    )
    expect(lastRowShapes(lines('| a |', '|---|', '| \tbc |'))[0]).toEqual(
      { opened: true, closingPipe: 6, text: 'bc', padding: [[1, 2], [5, 6]], visibleText: '\tbc' },
    )
  })

  it('keeps an escaped pipe and the spaces inside the text as text', () => {
    expect(lastRowShapes(lines('| a |', '|---|', '| a  \\| |'))[0]).toEqual(
      { opened: true, closingPipe: 8, text: 'a  \\|', padding: [[1, 2], [7, 8]], visibleText: 'a  \\|' },
    )
  })
})

describe('pointer carets in table cells', () => {
  const ROW = '| Ann   |     10 |'
  const DOC = lines('| Name  |  Score |', '|:------|------:|', ROW, '| x |    |')
  const rowFrom = DOC.indexOf(ROW)
  const emptyRowFrom = DOC.indexOf('| x |')
  const state = EditorState.create({ doc: DOC, extensions: markdownTables() })

  function caretAfter(pos: number, assoc: -1 | 1, userEvent = 'select.pointer'): number {
    // A bare range would lose its `assoc`; CM's mouse handler sends a selection.
    const selection = EditorSelection.create([EditorSelection.cursor(pos, assoc)])
    return state.update({ selection, userEvent }).state.selection.main.head
  }

  it('moves a click in the padding to the edge of the text', () => {
    // After the leading pipe, before the space: the text start.
    expect(caretAfter(rowFrom + 1, 1)).toBe(rowFrom + 2)
    // In the spaces after "Ann", and right before the closing pipe.
    expect(caretAfter(rowFrom + 6, 1)).toBe(rowFrom + 5)
    expect(caretAfter(rowFrom + 17, -1)).toBe(rowFrom + 16)
    // In the spaces before "10" (a right-aligned cell).
    expect(caretAfter(rowFrom + 11, 1)).toBe(rowFrom + 14)
  })

  it('puts a caret at a splitting pipe into the cell on its side', () => {
    // Right of "Ann": the end of the first cell's text.
    expect(caretAfter(rowFrom + 8, -1)).toBe(rowFrom + 5)
    // Left of "10": the start of the second cell's text, not before its pipe.
    expect(caretAfter(rowFrom + 8, 1)).toBe(rowFrom + 14)
  })

  it('moves a click in an empty cell to the place after its opening pipe', () => {
    expect(caretAfter(emptyRowFrom + 4, 1)).toBe(emptyRowFrom + 5)
    expect(caretAfter(emptyRowFrom + 7, 1)).toBe(emptyRowFrom + 5)
    expect(caretAfter(emptyRowFrom + 9, -1)).toBe(emptyRowFrom + 5)
  })

  it('leaves the text, the row ends, keyboard carets, and ranges alone', () => {
    expect(caretAfter(rowFrom + 3, 1)).toBe(rowFrom + 3)
    expect(caretAfter(rowFrom, 1)).toBe(rowFrom)
    expect(caretAfter(rowFrom + ROW.length, -1)).toBe(rowFrom + ROW.length)
    expect(caretAfter(rowFrom + 6, 1, 'select')).toBe(rowFrom + 6)
    const range = state.update({ selection: EditorSelection.range(rowFrom + 1, rowFrom + 6), userEvent: 'select.pointer' }).state.selection.main
    expect([range.anchor, range.head]).toEqual([rowFrom + 1, rowFrom + 6])
  })
})
