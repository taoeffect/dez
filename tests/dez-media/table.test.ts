import { describe, expect, it } from 'vitest'
import { csvTable, jsonTable, numericColumns, parseCsv } from '../../src-tauri/libs/dez-media/table.js'

describe('dez-media parseCsv', () => {
  it('splits records at LF, CRLF, and CR, and fields at the delimiter', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4\r5,6')).toStrictEqual([['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']])
    expect(parseCsv('a\tb\n1\t2', { delimiter: '\t' })).toStrictEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a;b\n1,5;2', { delimiter: ';' })).toStrictEqual([['a', 'b'], ['1,5', '2']])
  })

  it('keeps the delimiter, line ends, and doubled quotes inside a quoted field', () => {
    expect(parseCsv('name,note\n"Smith, J.","said ""hi""\nthen left"\n')).toStrictEqual([['name', 'note'], ['Smith, J.', 'said "hi"\nthen left']])
    expect(parseCsv('"",x\n"a"')).toStrictEqual([['', 'x'], ['a']])
  })

  it('makes no record of a byte order mark, an empty line, or a line end at the end', () => {
    expect(parseCsv('\uFEFFa,b\n\n1,2\n\n')).toStrictEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('')).toStrictEqual([])
    // A line with only delimiters is a record of empty fields.
    expect(parseCsv('a,b\n,\n')).toStrictEqual([['a', 'b'], ['', '']])
  })

  it('refuses a quote that does not close, text after a closing quote, and a bad delimiter', () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3')).toThrow('The quote that opens a field on line 2 does not close.')
    expect(() => parseCsv('a,b\n"x"y,2')).toThrow(/^Line 2 has text right after the closing quote of a field/)
    expect(() => parseCsv('a', { delimiter: '"' })).toThrow(RangeError)
    expect(() => parseCsv('a', { delimiter: ', ' })).toThrow(RangeError)
  })
})

describe('dez-media csvTable', () => {
  it('names the columns from the header, and reads numbers, texts, and empty fields', () => {
    expect(csvTable('month,sales,note\nJan,3,ok\nFeb,-2.5e1,\nMar, 7 ,"1,234"\n')).toStrictEqual({
      columns: ['month', 'sales', 'note'],
      rows: [['Jan', 3, 'ok'], ['Feb', -25, null], ['Mar', 7, '1,234']],
    })
  })

  it('gives a short row null for the rest, and a column with no name a name', () => {
    expect(csvTable('x,,z\n1,2\n')).toStrictEqual({ columns: ['x', 'column 2', 'z'], rows: [[1, 2, null]] })
  })

  it('refuses a text with no line, and a row with more fields than the header', () => {
    expect(() => csvTable('\n')).toThrow('The CSV text has no line: its first line names the columns.')
    expect(() => csvTable('a,b\n1,2\n3,4,5\n')).toThrow(/^Row 3 has 3 fields, and the header has 2 columns\./)
  })

  it('refuses two columns with one name, after the trim and the names of columns with none', () => {
    const again = 'Give each column its own name in the first line.'
    expect(() => csvTable('x,y,y\n1,2,3\n')).toThrow(`Columns 2 and 3 of the CSV text have the same name, "y". ${again}`)
    expect(() => csvTable('y\t x\t y \n', { delimiter: '\t' })).toThrow(`Columns 1 and 3 of the CSV text have the same name, "y". ${again}`)
    expect(() => csvTable('a,,column 2\n')).toThrow(
      `Columns 2 and 3 of the CSV text have the same name, "column 2". Column 2 has no name, so it gets the name "column 2". ${again}`)
  })
})

describe('dez-media jsonTable', () => {
  it('takes the columns in the order in which the rows first have them', () => {
    const rows = [{ month: 'Jan', sales: 3 }, { month: 'Feb', cost: 1, sales: null }, { month: 'Mar', ok: true, tags: ['a'] }]
    expect(jsonTable(rows)).toStrictEqual({
      columns: ['month', 'sales', 'cost', 'ok', 'tags'],
      rows: [['Jan', 3, null, null, null], ['Feb', null, 1, null, null], ['Mar', null, null, 'true', '["a"]']],
    })
  })

  it('gives null for a field that a row lacks, also when Object.prototype has that name', () => {
    const rows = JSON.parse('[{"__proto__": 1, "constructor": 2, "toString": "a"}, {"x": 3}]')
    expect(jsonTable(rows)).toStrictEqual({
      columns: ['__proto__', 'constructor', 'toString', 'x'],
      rows: [[1, 2, 'a', null], [null, null, null, 3]],
    })
  })

  it('refuses a value that is no list of objects', () => {
    for (const value of [{ a: 1 }, [1, 2], [[1]], [null], 'a']) expect(() => jsonTable(value), JSON.stringify(value)).toThrow(RangeError)
  })
})

describe('dez-media numericColumns', () => {
  it('lists the columns whose values are all numbers or null, with at least one number', () => {
    const table = csvTable('label,a,b,c,d\nx,1,,2,n/a\ny,2,,,3\n')
    expect(numericColumns(table)).toStrictEqual(['a', 'c'])
  })
})
