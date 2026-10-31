import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { PILL_NL, SECTION_SEP, encodePrompt } from '../thread/cmEditor'
import { findMarkdownTables } from './tables'

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
