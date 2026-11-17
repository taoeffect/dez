// A table of the notes of a compaction (compactionNotes.ts) as a text for
// a model. Every later request of the conversation sends the notes, so the
// text tells a value one time where it can, not once in each row:
//
//   <intro> Each line: <the names of the columns of the rows>. <legends>
//   <a line for each column that has one value in every row>
//
//   Jobs 1 to 28, tool model_invoke:
//   j-ab12 | A red fox in the snow
//   …
//
//   Job 29, tool video:
//   j-cd34 | join_clips @c @d
//
// - A column with one value in every row leaves the rows, and a line of
//   the head tells the value (`NotesColumn.shared`). Each value has a line
//   of its own: a value can hold `. ` and `, `, but never a line break.
// - A column whose value changes only a few times down the rows splits
//   them into groups, the runs of rows with one value. The lead line of a
//   group tells the value, and its rows do not hold the column
//   (`NotesColumn.groups`).
// - Numbers that count the rows up by 1 with no gap leave the rows, and the
//   lead line of each group tells its range (`NotesColumn.counts`).
// - Each of the three is used only when it makes the text shorter. The
//   rows keep their order.
// - The head names only the columns that the rows hold, and a legend tells
//   only the values that the rows and the lead lines hold.
// - The reader gives back every row with every column. It finds the
//   columns of a row by the names of the "Each line:" text, so a text with
//   any set of columns in its rows reads, also one of an older Dez with all
//   of them in each row. A column that an older Dez did not write reads as
//   its fallback value (`NotesColumn.fallback`). The writer uses a shorter
//   form only when the reader reads it back to the same cells.

const COLUMN = ' | '

/** How a column tells one value for many rows, in place of a cell in each
 *  of them. */
export interface NotesStatement {
  /** The text that tells `value`; null for a value that it cannot tell. */
  text(value: string): string | null
  /** The value that `line` tells, when `line` is a text of `text()`; null
   *  for any other line. */
  read(line: string): string | null
}

/** A statement with its own text for each value of a closed set. */
export function textsStatement(texts: Readonly<Record<string, string>>): NotesStatement {
  const values = new Map(Object.entries(texts).map(([value, text]) => [text, value]))
  return {
    text: (value) => (Object.hasOwn(texts, value) ? texts[value] : null),
    read: (line) => values.get(line) ?? null,
  }
}

/** A statement that tells any value that is not blank as `start`, the
 *  value, and `end`. */
export function templateStatement(start: string, end: string): NotesStatement {
  return {
    text: (value) => (value === '' ? null : `${start}${value}${end}`),
    read: (line) => (line.length > start.length + end.length && line.startsWith(start) && line.endsWith(end) ? line.slice(start.length, line.length - end.length) : null),
  }
}

/** One column of a table of the notes. */
export interface NotesColumn {
  /** Its name in the "Each line:" text. The reader finds the column by it,
   *  and saved notes hold it: never change it. */
  name: string
  /** A regex source that each value of the column matches in full. The
   *  reader skips a row with a value that does not match. */
  pattern: string
  /** The line of the head that tells a value of every row; absent for a
   *  column that always stays in the rows. */
  shared?: NotesStatement
  /** The column can split the rows into groups: the lead line of a group
   *  tells its value as `<name> <value>`. */
  groups?: boolean
  /** The column holds the numbers of the rows, which the lead lines can
   *  tell as ranges. */
  counts?: boolean
  /** What `values` mean: the values of the column that the rows or the
   *  lead lines hold. Absent for a column whose values need no legend. */
  legend?: (values: ReadonlySet<string>) => string
  /** The value of a row whose text does not hold the column: a line of an
   *  older Dez, which had no such column. Absent for a column that every
   *  form holds; the reader skips a row with no value of it. */
  fallback?: string
}

/** The form of one table of the notes. */
export interface NotesTable {
  /** The noun of a row, which starts a lead line, as in `Job 29` and
   *  `Jobs 1 to 28`. */
  noun: { one: string, many: string }
  /** What the rows are: the start of the first line. */
  intro: string
  /** The columns, in the order of a row. The first one names the row, and
   *  the last one is free text, which can hold the column mark: neither
   *  of the two leaves the rows. */
  columns: readonly NotesColumn[]
  /** The text between two rows of a group. */
  rowGap: string
}

/** One row of a table of the notes. */
export interface NotesRow {
  /** Its cells, in the order of the columns: each on one line, and with no
   *  column mark but in the last one. A blank last cell is left out with
   *  its mark. */
  cells: readonly string[]
  /** Lines that go right before the row, as the reference of an image;
   *  null for none. The reader skips them. */
  before: string | null
}

// Where a table tells each value: in the rows, in a line of the head, or
// in the lead lines of the groups.
interface Layout {
  /** The one value of each column that a line of the head tells, by the
   *  index of the column. */
  shared: ReadonlyMap<number, string>
  /** The index of the column whose runs of one value are the groups; null
   *  for one group of all the rows. */
  group: number | null
  /** The lead line of each group tells the range of its numbers. */
  ranges: boolean
}

function inRows(table: NotesTable, layout: Layout, index: number): boolean {
  return !layout.shared.has(index) && index !== layout.group && !(layout.ranges && table.columns[index].counts === true)
}

// The groups of `rows`: the runs of rows, in their order, with one value of
// the column `group`; all of the rows for no column.
function groupsOf(rows: readonly NotesRow[], group: number | null): NotesRow[][] {
  if (group === null) return rows.length > 0 ? [[...rows]] : []
  const groups: NotesRow[][] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last && last[0].cells[group] === row.cells[group]) last.push(row)
    else groups.push([row])
  }
  return groups
}

// The lead line of the group `rows`, as in `Jobs 1 to 28, tool
// model_invoke:`; null for a layout whose lead lines tell nothing.
function leadText(table: NotesTable, layout: Layout, rows: readonly NotesRow[]): string | null {
  const { noun, columns } = table
  const words = layout.group === null ? '' : `, ${columns[layout.group].name} ${rows[0].cells[layout.group]}`
  if (!layout.ranges) return layout.group === null ? null : `${noun.many}${words}:`
  const counter = columns.findIndex((column) => column.counts)
  const first = rows[0].cells[counter]
  const subject = rows.length === 1 ? `${noun.one} ${first}` : `${noun.many} ${first} to ${rows.at(-1)?.cells[counter]}`
  return `${subject}${words}:`
}

function rowText(table: NotesTable, layout: Layout, row: NotesRow): string {
  const cells = row.cells.filter((_cell, index) => inRows(table, layout, index))
  if (cells.at(-1) === '') cells.pop()
  const line = cells.join(COLUMN)
  return row.before === null ? line : `${row.before}\n${line}`
}

function tableText(table: NotesTable, rows: readonly NotesRow[], layout: Layout): string {
  const { columns } = table
  const names = columns.filter((_column, index) => inRows(table, layout, index)).map((column) => column.name)
  const legends = columns.flatMap((column, index) => (column.legend && !layout.shared.has(index) && rows.length > 0
    ? [column.legend(new Set(rows.map((row) => row.cells[index])))]
    : []))
  const sharedLines = [...layout.shared].map(([index, value]) => columns[index].shared?.text(value) ?? '')
  const head = [[table.intro, `Each line: ${names.join(COLUMN)}.`, ...legends].join(' '), ...sharedLines].join('\n')
  const blocks = groupsOf(rows, layout.group).map((group) => {
    const lead = leadText(table, layout, group)
    const body = group.map((row) => rowText(table, layout, row)).join(table.rowGap)
    return lead === null ? body : `${lead}\n${body}`
  })
  return [head, ...blocks].join('\n\n')
}

// Whether the reader reads `text` back to the cells of `rows`.
function readsBack(table: NotesTable, rows: readonly NotesRow[], text: string): boolean {
  const read = notesTableRows(table, text.split('\n'))
  return read.length === rows.length && read.every((cells, index) => cells.every((cell, column) => cell === rows[index].cells[column]))
}

// Whether the numbers of the column `counter` count the rows up by 1, with
// no gap, in the form that the lead lines write.
function countsUpByOne(rows: readonly NotesRow[], counter: number): boolean {
  if (counter < 0 || rows.length === 0) return false
  const first = Number(rows[0].cells[counter])
  return Number.isSafeInteger(first) && first >= 0 && rows.every((row, index) => row.cells[counter] === String(first + index))
}

/** The text of the table `table` with the rows `rows`, in the shortest of
 *  its forms (see the head of this module). */
export function notesTableText(table: NotesTable, rows: readonly NotesRow[]): string {
  let layout: Layout = { shared: new Map(), group: null, ranges: false }
  let text = tableText(table, rows, layout)
  const tryLayout = (next: Layout) => {
    const nextText = tableText(table, rows, next)
    if (nextText.length < text.length && readsBack(table, rows, nextText)) {
      layout = next
      text = nextText
    }
  }
  table.columns.forEach((column, index) => {
    const value = rows[0]?.cells[index]
    if (column.shared && value !== undefined && rows.every((row) => row.cells[index] === value)) {
      tryLayout({ ...layout, shared: new Map([...layout.shared, [index, value]]) })
    }
  })
  const shared = layout.shared
  // A column with one value in every row makes one group: that is a value
  // of the head, or no change.
  const groupColumns = table.columns.flatMap((column, index) => (column.groups && !shared.has(index) && rows.some((row) => row.cells[index] !== rows[0].cells[index]) ? [index] : []))
  const ranges = countsUpByOne(rows, table.columns.findIndex((column) => column.counts))
  for (const group of [null, ...groupColumns]) {
    for (const withRanges of ranges ? [false, true] : [false]) {
      if (group !== null || withRanges) tryLayout({ shared, group, ranges: withRanges })
    }
  }
  return text
}

const NAMES = /Each line: (.+?)\.(?: |$)/

// The value of the line `line` of the head: the first column whose
// statement reads it.
function sharedValue(table: NotesTable, patterns: readonly RegExp[], line: string): { index: number, value: string } | null {
  for (const [index, column] of table.columns.entries()) {
    const value = column.shared?.read(line) ?? null
    if (value !== null && patterns[index].test(value)) return { index, value }
  }
  return null
}

// The value of the words of a lead line, as in `tool model_invoke`: the
// first column that can group the rows whose name starts them.
function leadValue(table: NotesTable, patterns: readonly RegExp[], words: string): { index: number, value: string } | null {
  for (const [index, column] of table.columns.entries()) {
    const value = words.slice(column.name.length + 1)
    if (column.groups && words.startsWith(`${column.name} `) && patterns[index].test(value)) return { index, value }
  }
  return null
}

/** The rows of the table `table` in `lines` (the lines of its part of the
 *  notes, which `notesTableText` wrote), each with a cell for every column,
 *  in the order of the columns. A row whose text gives no value of a
 *  column, or a value that does not match the column, is left out. */
export function notesTableRows(table: NotesTable, lines: readonly string[]): string[][] {
  const start = lines.findIndex((line) => line !== '')
  const names = start < 0 ? undefined : NAMES.exec(lines[start])?.[1].split(COLUMN)
  if (names === undefined) return []
  const { columns, noun } = table
  const patterns = columns.map((column) => new RegExp(`^(?:${column.pattern})$`))
  const places = names.map((name) => columns.findIndex((column) => column.name === name))
  const counter = columns.findIndex((column) => column.counts)
  const lead = new RegExp(`^(?:${noun.many}|${noun.one})(?: (\\d+)(?: to \\d+)?)?(?:, (.+))?:$`)

  let index = start + 1
  const shared = new Map<number, string>()
  for (; index < lines.length && lines[index] !== ''; index += 1) {
    const found = sharedValue(table, patterns, lines[index])
    if (found) shared.set(found.index, found.value)
  }

  const rows: string[][] = []
  let group = new Map<number, string>()
  let next: number | null = null
  for (const line of lines.slice(index)) {
    if (line === '') continue
    const leadMatch = lead.exec(line)
    if (leadMatch) {
      const found = leadMatch[2] === undefined ? null : leadValue(table, patterns, leadMatch[2])
      group = new Map(found ? [[found.index, found.value]] : [])
      next = leadMatch[1] === undefined ? null : Number(leadMatch[1])
      continue
    }
    const cells = line.split(COLUMN)
    if (cells.length < names.length - 1) continue
    const values = new Map([...shared, ...group])
    places.forEach((place, at) => {
      const cell = at < names.length - 1 ? cells[at] : cells.slice(at).join(COLUMN)
      if (place >= 0) values.set(place, cell)
    })
    if (next !== null && counter >= 0 && !values.has(counter)) values.set(counter, String(next))
    const row = columns.map((column, at) => values.get(at) ?? column.fallback)
    if (!row.every((cell, at): cell is string => cell !== undefined && patterns[at].test(cell))) continue
    if (next !== null) next += 1
    rows.push(row)
  }
  return rows
}
