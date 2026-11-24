// @ts-check
// Tables of data from the text of a CSV, TSV, or JSON file, such as a file
// of the work folder that a model wrote or the user gave. The built-in app
// dez-chart (src-tauri/builtin-apps/) draws a chart from one. Plain text
// work, so the page of a UI app can use it too.

/**
 * One value of a table: a number, a text, or null for an empty field.
 * @typedef {string | number | null} TableValue
 */

/**
 * A table: the names of its columns, and its rows, each with one value for
 * each column.
 * @typedef {{ columns: string[], rows: TableValue[][] }} Table
 */

// A number as a data file writes it: digits with an optional sign, point,
// and exponent. "1,234", "12%", and "$5" are texts.
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * The records of a CSV text (RFC 4180), each a list of its fields as
 * texts. A field in double quotes can hold the delimiter, a line end, and
 * a double quote as two (`""`). A record ends at a line end (LF, CRLF, or
 * CR); a line end at the end of the text and an empty line make no record.
 * A byte order mark at the start is no part of the text.
 *
 * Throws a RangeError for a quote that does not close, and for text right
 * after a closing quote.
 * @param {string} text
 * @param {{ delimiter?: string }} [options] `delimiter`: one character,
 *   "," by default ("\t" for a TSV file, ";" for some locales).
 * @returns {string[][]}
 */
export function parseCsv(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new TypeError('parseCsv takes the text of the file.')
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || '"\r\n'.includes(delimiter)) {
    throw new RangeError(`The delimiter of a CSV text is one character that is no quote and no line end, such as "," or "\\t", not ${JSON.stringify(delimiter)}.`)
  }
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  /** @type {string[][]} */
  const records = []
  /** @type {string[]} */
  let fields = []
  let field = ''
  // Whether the record has any text yet: an empty line makes no record.
  let started = false
  let line = 1
  let at = 0
  const endRecord = () => {
    if (started) records.push([...fields, field])
    fields = []
    field = ''
    started = false
  }
  while (at < source.length) {
    const char = source[at]
    if (char === '"' && field === '') {
      const opened = line
      at += 1
      for (;;) {
        if (at >= source.length) throw new RangeError(`The quote that opens a field on line ${opened} does not close.`)
        const inner = source[at]
        if (inner === '"' && source[at + 1] === '"') {
          field += '"'
          at += 2
        } else if (inner === '"') {
          at += 1
          break
        } else {
          if (inner === '\n' || (inner === '\r' && source[at + 1] !== '\n')) line += 1
          field += inner
          at += 1
        }
      }
      started = true
      const next = source[at]
      if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') {
        throw new RangeError(`Line ${line} has text right after the closing quote of a field: a field in quotes ends at its quote. Write a quote in a field as two quotes ("").`)
      }
      continue
    }
    if (char === delimiter) {
      fields.push(field)
      field = ''
      started = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1
      endRecord()
      line += 1
    } else {
      field += char
      started = true
    }
    at += 1
  }
  endRecord()
  return records
}

/**
 * The value of a field of a CSV text: a number when the field is one
 * (`NUMBER`), null when it is empty, else its text.
 * @param {string} field
 * @returns {TableValue}
 */
function fieldValue(field) {
  const trimmed = field.trim()
  if (trimmed === '') return null
  return NUMBER.test(trimmed) ? Number(trimmed) : field
}

/**
 * The table of a CSV text (`parseCsv`) whose first record names the
 * columns. A field that is a number becomes a number, and an empty field
 * null; a row with fewer fields than the header gets null for the rest.
 * A column with no name gets the name "column N".
 *
 * Throws a RangeError for a text with no record, for two columns with one
 * name, and for a row with more fields than the header.
 * @param {string} text
 * @param {{ delimiter?: string }} [options] as for `parseCsv`
 * @returns {Table}
 */
export function csvTable(text, options) {
  const [header, ...records] = parseCsv(text, options)
  if (header === undefined) throw new RangeError('The CSV text has no line: its first line names the columns.')
  const columns = header.map((name, index) => (name.trim() === '' ? `column ${index + 1}` : name.trim()))
  checkColumnNames(header, columns)
  const rows = records.map((record, index) => {
    if (record.length > columns.length) {
      throw new RangeError(`Row ${index + 2} has ${record.length} fields, and the header has ${columns.length} columns. `
        + 'Put a field that holds the delimiter in double quotes.')
    }
    return columns.map((_, column) => fieldValue(record[column] ?? ''))
  })
  return { columns, rows }
}

/**
 * Throws a RangeError when two of `columns` have one name: a reader that
 * finds a column by its name (dez-chart) would else read the first one
 * twice. Only one of the two can have no name in `header`, as the names
 * that `csvTable` gives such columns have their numbers.
 * @param {string[]} header the names of the first record, as in the text
 * @param {string[]} columns the names that `csvTable` gives the columns
 */
function checkColumnNames(header, columns) {
  /** @type {Map<string, number>} */
  const firstColumns = new Map()
  columns.forEach((name, column) => {
    const first = firstColumns.get(name)
    if (first === undefined) {
      firstColumns.set(name, column)
      return
    }
    const nameless = [first, column].find((index) => header[index].trim() === '')
    const why = nameless === undefined ? '' : ` Column ${nameless + 1} has no name, so it gets the name "column ${nameless + 1}".`
    throw new RangeError(`Columns ${first + 1} and ${column + 1} of the CSV text have the same name, ${JSON.stringify(name)}.${why} `
      + 'Give each column its own name in the first line.')
  })
}

/**
 * The table of a JSON value that is a list of objects, one for each row:
 * the columns are the names of their fields, in the order in which the
 * rows first have them. A number or a text stays as it is; a missing
 * field and null are null; true and false are texts; a list or an object
 * is its JSON text.
 *
 * Throws a RangeError for a value that is no list of objects.
 * @param {unknown} value the parsed JSON
 * @returns {Table}
 */
export function jsonTable(value) {
  const isRow = (/** @type {unknown} */ item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (!Array.isArray(value) || !value.every(isRow)) {
    throw new RangeError('The JSON of a table is a list of objects, one for each row, as in [{"month": "Jan", "sales": 3}, {"month": "Feb", "sales": 5}].')
  }
  const items = /** @type {Record<string, unknown>[]} */ (value)
  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))]
  // A row that lacks a field reads it as missing, not as a field of Object.prototype (`constructor`, `__proto__`).
  const rows = items.map((item) => columns.map((column) => jsonValue(Object.hasOwn(item, column) ? item[column] : undefined)))
  return { columns, rows }
}

/**
 * A value of a field of a JSON row (`jsonTable`).
 * @param {unknown} value
 * @returns {TableValue}
 */
function jsonValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * The names of the columns of `table` that hold numbers: each value of the
 * column is a number or null, and at least one is a number.
 * @param {Table} table
 * @returns {string[]}
 */
export function numericColumns({ columns, rows }) {
  return columns.filter((_, column) => {
    const values = rows.map((row) => row[column]).filter((value) => value !== null)
    return values.length > 0 && values.every((value) => typeof value === 'number')
  })
}
