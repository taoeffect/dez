import { EditorSelection, EditorState, RangeSetBuilder, StateField, type Extension, type RangeSet, type Text } from '@codemirror/state'
import {
  BlockWrapper,
  Decoration,
  EditorView,
  RectangleMarker,
  ViewPlugin,
  layer,
  type DecorationSet,
} from '@codemirror/view'
import { SENTINEL_CHAR } from '../../model/chat/content'
import { closesFence, fenceOpener, type Fence } from '../../utils/markdownFence'
import { SECTION_SEP } from '../thread/cmEditor'

export type TableAlignment = 'left' | 'center' | 'right' | null

export type TableRowKind = 'header' | 'delimiter' | 'body'

export interface TableCell {
  /** Doc range. The cells of a row cover its line from end to end, so no
   *  row character is outside a cell. */
  from: number
  to: number
  /** Doc positions of the pipes in this cell that split cells: the leading
   *  pipe, the pipe that starts the cell, and the trailing pipe. */
  pipes: number[]
}

export interface TableRow {
  kind: TableRowKind
  /** Line range, without the line break. */
  from: number
  to: number
  cells: TableCell[]
}

export interface MarkdownTable {
  /** From the start of the header line to the end of the last row line. */
  from: number
  to: number
  /** One entry per column, from the delimiter row. */
  alignments: TableAlignment[]
  rows: TableRow[]
}

const PIPE = 124
const BACKSLASH = 92
const SPACE = 32
const TAB = 9

/** `@lezer/markdown`'s GFM `delimiterLine`. */
const DELIMITER_ROW = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/
const BLANK = /^[ \t]*$/
/** A pipe after an even number of backslashes (`\|` is an escaped pipe). */
const UNESCAPED_PIPE = /(?:^|[^\\])(?:\\\\)*\|/
/** At most 3 spaces of indent; more makes an indented code line. */
const BLOCK_INDENT = /^ {0,3}[^ \t]/
/** ATX heading, blockquote, or list item. */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|\d{1,9}[.)])[ \t])/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

interface ParsedRow {
  cells: TableCell[]
  /** The cell count of `@lezer/markdown`'s `parseRow`. */
  count: number
}

/** True for a line that starts a block which interrupts a paragraph, and so
 *  ends a table and cannot be a header or delimiter row. */
function startsOtherBlock(text: string): boolean {
  return BLOCK_START.test(text) || THEMATIC_BREAK.test(text) || fenceOpener(text) !== null
}

function isSpaceOrTab(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const ch = text.charCodeAt(i)
    if (ch !== SPACE && ch !== TAB) return false
  }
  return true
}

/** Split a row line into cells that cover the whole line. Like lezer's
 *  `parseRow`, a backslash escapes the next char, a leading pipe (only
 *  whitespace before it) opens the first cell, a trailing pipe (only
 *  whitespace after it) closes the last cell, and every other pipe starts a
 *  new cell. Leading / trailing whitespace stays in the first / last cell.
 *  After `maxCells` cells, pipes are content of the last cell: GFM drops
 *  extra body cells, but the source text must stay visible. */
function parseRow(text: string, from: number, maxCells = Infinity): ParsedRow {
  const pipes: number[] = []
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === PIPE && !escaped) pipes.push(i)
    escaped = !escaped && ch === BACKSLASH
  }

  const lineTo = from + text.length
  if (pipes.length === 0) {
    return { cells: [{ from, to: lineTo, pipes: [] }], count: BLANK.test(text) ? 0 : 1 }
  }

  const first = pipes[0]
  const last = pipes[pipes.length - 1]
  const leading = isSpaceOrTab(text, 0, first)
  const trailing = isSpaceOrTab(text, last + 1, text.length)
  const cells: TableCell[] = []
  let cell: TableCell = { from, to: lineTo, pipes: [] }
  for (const pipe of pipes) {
    const splits = !(pipe === first && leading) && !(pipe === last && trailing)
    if (splits) {
      if (cells.length + 1 >= maxCells) continue
      cell.to = from + pipe
      cells.push(cell)
      cell = { from: from + pipe, to: lineTo, pipes: [] }
    }
    cell.pipes.push(from + pipe)
  }
  cells.push(cell)

  // lezer counts a lone pipe with only whitespace around it as zero cells.
  // The row still renders as one cell so its text stays in a cell.
  const count = pipes.length + 1 - (leading ? 1 : 0) - (trailing ? 1 : 0)
  return { cells, count }
}

function cellAlignment(cellText: string): TableAlignment {
  const spec = cellText.replace(/[|\s]/g, '')
  const left = spec.startsWith(':')
  const right = spec.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return null
}

/** Find the GFM tables in a live editor doc, in doc order. The editor's
 *  markdown language (`dezLanguageSupport` in `cmEditor.ts`) has no GFM, so
 *  its syntax tree has no tables; this scan finds them. The rules follow
 *  `@lezer/markdown`'s GFM `Table` extension, with these differences, because
 *  the app's syntax tree is one CommonMark doc over all sections:
 *  - each section is a separate doc: a `SECTION_SEP` line ends a table and
 *    any open code fence;
 *  - a line with a pill marker or other sentinel is never a table line and
 *    ends a table (tables inside an expanded prompt body still count);
 *  - container blocks are not tracked. A table in a blockquote is not
 *    found. A table in a list item is not found when its header is on the
 *    list-marker line, or when its header or delimiter row has 4 or more
 *    spaces of indent; otherwise it is found as a top-level table.
 *  Two lezer quirks are not copied; we do what cmark-gfm (GitHub) does. The
 *  header is the line right before the delimiter row, even when an earlier
 *  line of the same paragraph has a pipe (lezer then finds no table). And
 *  the delimiter row can have up to 3 spaces of indent and trailing
 *  whitespace.
 *  The scan reads only the doc text, so a table is found whenever its syntax
 *  is valid, wherever the cursor is. */
export function findMarkdownTables(doc: Text): MarkdownTable[] {
  const tables: MarkdownTable[] = []
  let table: MarkdownTable | null = null
  let fence: Fence | null = null
  // The previous line, if it can be the header of a table.
  let header: { from: number, text: string } | null = null
  let lineFrom = 0

  for (const text of doc.iterLines()) {
    const from = lineFrom
    lineFrom += text.length + 1

    if (SENTINEL_CHAR.test(text)) {
      table = null
      header = null
      if (text === SECTION_SEP) fence = null
      continue
    }
    if (fence) {
      if (closesFence(text, fence)) fence = null
      continue
    }
    if (table) {
      // GFM: a body row needs no pipe; only a blank line or the start of
      // another block ends the table.
      if (!BLANK.test(text) && !startsOtherBlock(text)) {
        const columns = table.alignments.length
        table.rows.push({ kind: 'body', from, to: from + text.length, cells: parseRow(text, from, columns).cells })
        table.to = from + text.length
        continue
      }
      table = null
    }

    const opener = fenceOpener(text)
    if (opener) {
      fence = opener
      header = null
      continue
    }
    if (header && BLOCK_INDENT.test(text) && DELIMITER_ROW.test(text.trim()) && !startsOtherBlock(text)) {
      const headerRow = parseRow(header.text, header.from)
      const delimiterRow = parseRow(text, from)
      if (headerRow.count === delimiterRow.count) {
        const to = from + text.length
        table = {
          from: header.from,
          to,
          alignments: delimiterRow.cells.map((cell) => cellAlignment(text.slice(cell.from - from, cell.to - from))),
          rows: [
            { kind: 'header', from: header.from, to: header.from + header.text.length, cells: headerRow.cells },
            { kind: 'delimiter', from, to, cells: delimiterRow.cells },
          ],
        }
        tables.push(table)
        header = null
        continue
      }
    }
    const canBeHeader = BLOCK_INDENT.test(text) && UNESCAPED_PIPE.test(text) && !startsOtherBlock(text)
    header = canBeHeader ? { from, text } : null
  }
  return tables
}

interface TableDecorations {
  /** Outer marks: one `dez-table-cell` per cell. */
  cells: DecorationSet
  /** Row line classes, the marks that hide the splitting pipes, and the
   *  padding marks. */
  rows: DecorationSet
  /** One `div.dez-table` around the lines of each table. */
  wrappers: RangeSet<BlockWrapper>
  /** One per cell, in doc order, for `snapPointerCarets`. */
  caretZones: CaretZone[]
}

/** Where a pointer caret in a cell goes (see `snapPointerCarets`): a caret
 *  in `[leadingFrom, text.from]` goes to the text start, one in
 *  `(text.to, trailingTo]` to the text end. */
interface CaretZone {
  from: number
  to: number
  leadingFrom: number
  text: DocRange
  trailingTo: number
}

/** Row line decorations of each row kind: [any row but the last, the last
 *  row]. The last row's class rounds the table's bottom corners. */
const ROW_LINES: Record<TableRowKind, [Decoration, Decoration]> = {
  header: rowLines('header'),
  delimiter: rowLines('delimiter'),
  body: rowLines('body'),
}
const PIPE_MARK = Decoration.mark({ class: 'dez-table-pipe' })
const PAD_MARK = Decoration.mark({ class: 'dez-table-pad' })
const TABLE_WRAPPER = BlockWrapper.create({ tagName: 'div', attributes: { class: 'dez-table' } })
const cellMarks = new Map<string, Decoration>()

function rowLines(kind: TableRowKind): [Decoration, Decoration] {
  const cls = `dez-table-row dez-table-row--${kind}`
  return [Decoration.line({ class: cls }), Decoration.line({ class: `${cls} dez-table-row--last` })]
}

// The horizontal geometry of a cell. A cell keeps its source, but only its
// text takes room. Its pipes are transparent and 1ch wide. The spaces
// between a pipe (or a line end) and the text are the cell's padding: they
// take no room (`.dez-table-pad` in `cmEditor.ts`), so a source that pads
// its cells to line up its pipes does not widen a column, add wrapped
// lines, or move aligned text. Each side of a cell box has `CELL_INSET_CH`
// between the border and the text, the gap that `| text |` shows:
// - left: the opening pipe hangs into it (negative `text-indent`), so the
//   text of the first line starts where the lines that wrap start.
// - right: the pipe that closes a row hangs into it (negative
//   `margin-right`), so the last cell has the same inset as the others.
// So `| a | b |`, `|a|b|`, and `|   a |  b      |` look the same. A tab in
// the padding keeps its width: it goes to the next tab stop, so its width
// depends on where it starts and cannot be cancelled.
// The styles are inline because they depend on each cell's source.

/** The gap in ch between a cell's border and its text, on each side. */
const CELL_INSET_CH = 2.5
/** A pipe is 1ch wide in the editor's monospace font. */
const PIPE_SLOT_CH = 1

const CLOSING_PIPE_MARK = Decoration.mark({ class: 'dez-table-pipe', attributes: { style: `margin-right: -${PIPE_SLOT_CH}ch` } })

interface DocRange {
  from: number
  to: number
}

/** Where a cell's source sits in its box (see the notes above). */
export interface CellShape {
  /** Whether a pipe opens the cell. */
  opened: boolean
  /** Doc position of the pipe that closes the row, if this cell has it. */
  closingPipe: number | null
  /** The text without the padding around it. In a cell with no text, the
   *  empty range after the opening pipe (or at the cell start). */
  text: DocRange
  /** The padding, in doc order: each run of spaces between the cell's
   *  text and a pipe or a line end. In a cell with no text, all its spaces. */
  padding: DocRange[]
  /** The source that takes room: the text, and the tabs of the padding. */
  visibleText: string
}

/** Split a cell's source into its pipes, its padding, and its text. Only the
 *  pipes in `cell.pipes` are structure; an escaped pipe is text. */
export function cellShape(doc: Text, cell: TableCell): CellShape {
  const text = doc.sliceString(cell.from, cell.to)
  const isBlank = (index: number): boolean => text.charCodeAt(index) === SPACE || text.charCodeAt(index) === TAB
  let textFrom = 0
  while (isBlank(textFrom)) textFrom++
  const opened = cell.pipes[0] === cell.from + textFrom
  // `cell.pipes` holds at most the opening pipe and a trailing pipe.
  const last = cell.pipes.at(-1)
  const closingPipe = last === undefined || (opened && cell.pipes.length === 1) ? null : last
  const innerFrom = opened ? textFrom + 1 : 0
  const innerTo = closingPipe === null ? text.length : closingPipe - cell.from
  textFrom = innerFrom
  while (textFrom < innerTo && isBlank(textFrom)) textFrom++
  let textTo = innerTo
  while (textTo > textFrom && isBlank(textTo - 1)) textTo--
  if (textFrom === innerTo) textFrom = textTo = innerFrom

  // The whitespace around the text, without the pipes.
  const blanks: [number, number][] = [[innerFrom, textFrom], [textTo, innerTo]]
  if (opened) blanks.unshift([0, innerFrom - 1])
  if (closingPipe !== null) blanks.push([innerTo + 1, text.length])
  const padding: DocRange[] = []
  let tabs = ''
  for (const [from, to] of blanks) {
    let run = from
    for (let index = from; index <= to; index++) {
      if (index < to && text.charCodeAt(index) === SPACE) continue
      if (index > run) padding.push({ from: cell.from + run, to: cell.from + index })
      if (index < to) tabs += '\t'
      run = index + 1
    }
  }
  return {
    opened,
    closingPipe,
    text: { from: cell.from + textFrom, to: cell.from + textTo },
    padding,
    visibleText: tabs + text.slice(textFrom, textTo),
  }
}

/** The inline style of a cell: its insets, its hanging indent, and the
 *  widths of its column (see `columnWidths`), if any. */
function cellStyle(shape: CellShape, widths: ColumnWidths | null): string {
  let style = `padding-left: ${CELL_INSET_CH}ch; padding-right: ${CELL_INSET_CH}ch`
  if (shape.opened) style += `; text-indent: -${PIPE_SLOT_CH}ch`
  if (widths?.width) style += `; width: ${widths.width}`
  if (widths) style += `; min-width: ${widths.minWidth}`
  return style
}

/** The first cell of a row draws the table's left border. The first and
 *  last cells round the table's corners in the header and the last row.
 *  Left alignment is the default, so only center / right need a class. */
function cellMark(first: boolean, last: boolean, alignment: TableAlignment, style: string): Decoration {
  const key = `${first}:${last}:${alignment}:${style}`
  let mark = cellMarks.get(key)
  if (!mark) {
    let cls = 'dez-table-cell'
    if (first) cls += ' dez-table-cell--first'
    if (last) cls += ' dez-table-cell--last'
    if (alignment === 'center' || alignment === 'right') cls += ` dez-table-cell--${alignment}`
    mark = Decoration.mark({ class: cls, attributes: { style } })
    cellMarks.set(key, mark)
  }
  return mark
}

/** A column whose widest header / body cell is at most this many ch wide is
 *  a short column (see `columnWidths`). */
const SHORT_COLUMN_CH = 20

/** Chars that the editor's monospace fonts draw 1ch wide: printable ASCII,
 *  Latin-1, Latin Extended-A / B, Greek, Cyrillic, and the dashes, quotes,
 *  bullets, and ellipsis of General Punctuation. */
const ONE_CH_TEXT = /^[\x20-\x7E\u00A0-\u024F\u0370-\u04FF\u2010-\u2027]*$/

/** Width that `textWidthCh` gives a char that is not in `ONE_CH_TEXT` and
 *  not a tab. Such a char can come from a fallback font, so this is an
 *  upper bound: CJK chars are about 1.7ch wide and emoji about 2.1ch
 *  (measured with Liberation Mono). */
const OTHER_CHAR_CH = 2.5

export interface ColumnTextWidths {
  /** The widest text of the column's cells, on one line. */
  line: number
  /** The widest word of the column: the text between two spaces. */
  word: number
}

/** Upper bounds in ch (`textWidthCh`) for the text of each column of a
 *  table, from its header and body cells; the delimiter row draws no text.
 *  The padding takes no room, so it does not count (`visibleText`). */
export function columnTextWidths(tabSize: number, table: MarkdownTable, shapes: CellShape[][]): ColumnTextWidths[] {
  const widths = table.alignments.map(() => ({ line: 0, word: 0 }))
  shapes.forEach((rowShapes, rowIndex) => {
    if (table.rows[rowIndex].kind === 'delimiter') return
    rowShapes.forEach(({ visibleText }, index) => {
      const column = widths[index]
      column.line = Math.max(column.line, textWidthCh(visibleText, tabSize))
      for (const word of visibleText.split(' ')) column.word = Math.max(column.word, textWidthCh(word, tabSize))
    })
  })
  return widths
}

/** CSS widths for the cells of one column. */
interface ColumnWidths {
  /** The `width` of a short column; `null` for a long column. */
  width: string | null
  /** The `min-width`: room for the column's longest word, or less when the
   *  longest words of all columns do not fit the editor side by side. */
  minWidth: string
}

/** The widths of each column of a table. Every row has them because CM
 *  renders only the lines near the viewport, and the header may not be one
 *  of them. The browser's automatic table layout makes each column at least
 *  as wide as its cells' `min-width`, and shares the rest of the width in
 *  proportion to each column's longest line.
 *  - `min-width`, so that cell text wraps only between words, as in Typora:
 *    the column's longest word. Cell text inherits CM's
 *    `overflow-wrap: anywhere`, so without it a column has no floor, and one
 *    long text column squeezes the others until their words break. When the
 *    longest words of all columns do not fit the editor side by side, the
 *    floors are cut to a common level, so that the table is never wider
 *    than the editor, and the words that do not fit break: the columns with
 *    the shorter words keep them whole, and the others share the rest of the
 *    width equally. The level is `max(...)` below: for k = 0 … n-1, the
 *    width left after the k smallest floors, shared by the other n-k
 *    columns; the largest of those is the level at which the floors fill
 *    the width exactly. It is a CSS expression of `TABLE_WIDTH_VAR`, the
 *    width that the tables fill (`tableWidthTracker`), so it follows the
 *    editor width with no new decorations. Before the first measure the
 *    variable is not set, and the cells have no floors. A floor of the
 *    word's exact width holds the word: WebKit's line builder adds
 *    `LayoutUnit::epsilon()` to a line's width, as layout floors the widths
 *    that it gets.
 *  - `width`, for a short column: the width of its text, so that it does not
 *    wrap. A CSS width makes it a fixed column, which the layout fills first
 *    and shrinks last; the long columns take the rest. A fixed column that
 *    is narrower than its text wraps that text, so the width is an upper
 *    bound (`textWidthCh`).
 *  Do not give the wrapper a width that depends on the text: a wrapper whose
 *  attributes change is a new DOM element, which moves the line that the
 *  user is typing in (and can break an IME composition there).
 *  https://github.com/WebKit/WebKit/blob/main/Source/WebCore/layout/formattingContexts/inline/InlineLineBuilder.cpp */
function columnWidths(tabSize: number, table: MarkdownTable, shapes: CellShape[][]): ColumnWidths[] {
  const texts = columnTextWidths(tabSize, table, shapes)
  const floorsCh = texts.map(({ word }) => word + 2 * CELL_INSET_CH)
  const levels: string[] = []
  let takenCh = 0
  // The borders of a row: each cell's right border and the first cell's
  // left border.
  const bordersPx = texts.length + 1
  for (const [index, floorCh] of [...floorsCh].sort((a, b) => a - b).entries()) {
    levels.push(`(var(${TABLE_WIDTH_VAR}) - ${bordersPx}px - ${takenCh}ch) / ${texts.length - index}`)
    takenCh += floorCh
  }
  const level = `max(${levels.join(', ')})`
  return texts.map(({ line }, index) => {
    // `box-sizing` is `border-box` app-wide: the widths include the insets
    // (the pipes hang into them) and the cell's borders.
    const borderPx = index === 0 ? 2 : 1
    return {
      width: line <= SHORT_COLUMN_CH ? `calc(${line + 2 * CELL_INSET_CH}ch + ${borderPx}px)` : null,
      minWidth: `calc(min(${floorsCh[index]}ch, ${level}) + ${borderPx}px)`,
    }
  })
}

/** The CSS variable on `.cm-scroller` that holds the width of the content
 *  box of `.cm-content`, which the tables fill (see `columnWidths`). */
const TABLE_WIDTH_VAR = '--dez-table-width'

/** Keeps `TABLE_WIDTH_VAR` at the width that the tables fill. The column
 *  floors (`columnWidths`) need that width in CSS. `100%` does not work:
 *  a percentage `min-width` on a table cell has no effect in the automatic
 *  table layout. A query container on `.cm-scroller` gives the width as
 *  `100cqw` with no script, but in WebKitGTK the container moves the view
 *  up when a reply ends and the editor rebuilds its state
 *  (`tests/e2e/stream-follow.e2e.ts`).
 *  The width is read and written in CM's measure cycle, after each change
 *  of the editor geometry. A new width asks for one more measure: CM then
 *  reads the line heights again in the same frame, after the tables took
 *  the new width, before it keeps the top line in place. The variable stays
 *  on the scroller when the editor gets a new state, so the tables of the
 *  new state lay out at once with the right width. */
const tableWidthTracker = ViewPlugin.define((view) => {
  const measure = {
    read: (): string => {
      const content = view.contentDOM
      const style = getComputedStyle(content)
      const width = content.getBoundingClientRect().width / view.scaleX - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return `${width}px`
    },
    write: (width: string): void => {
      if (view.scrollDOM.style.getPropertyValue(TABLE_WIDTH_VAR) === width) return
      view.scrollDOM.style.setProperty(TABLE_WIDTH_VAR, width)
      view.requestMeasure(measure)
    },
  }
  view.requestMeasure(measure)
  return {
    update: (update) => {
      if (update.geometryChanged) view.requestMeasure(measure)
    },
  }
})

/** An upper bound for the width of `text` in ch, in the editor font. The
 *  font is monospace, but some chars are wider than 1ch, and a tab goes to
 *  the next tab stop (at most `tabSize` ch). Each code point counts, so a
 *  sequence that draws as one glyph (an emoji with a skin tone, a letter
 *  with a combining accent) gets more width than it takes. */
function textWidthCh(text: string, tabSize: number): number {
  if (ONE_CH_TEXT.test(text)) return text.length
  let width = 0
  for (const char of text) {
    width += ONE_CH_TEXT.test(char) ? 1 : char === '\t' ? tabSize : OTHER_CHAR_CH
  }
  return width
}

function buildTableDecorations(state: EditorState): TableDecorations {
  const { doc } = state
  const cells = new RangeSetBuilder<Decoration>()
  const rows = new RangeSetBuilder<Decoration>()
  const wrappers = new RangeSetBuilder<BlockWrapper>()
  const caretZones: CaretZone[] = []
  for (const table of findMarkdownTables(doc)) {
    wrappers.add(table.from, table.to, TABLE_WRAPPER)
    const shapes = table.rows.map((row) => row.cells.map((cell) => cellShape(doc, cell)))
    const widths = columnWidths(state.tabSize, table, shapes)
    table.rows.forEach((row, rowIndex) => {
      // RangeSetBuilder needs sorted input. A line decoration sorts before
      // a mark that starts at the same position.
      rows.add(row.from, row.from, ROW_LINES[row.kind][rowIndex === table.rows.length - 1 ? 1 : 0])
      row.cells.forEach((cell, index) => {
        const shape = shapes[rowIndex][index]
        // The delimiter row's smaller font would shrink a `ch` width.
        const columnWidth = row.kind === 'delimiter' ? null : widths[index]
        // A short body row (fewer cells than columns) ends inside the table,
        // so only a cell in the last column takes the table's right corners.
        const last = index === table.alignments.length - 1
        cells.add(cell.from, cell.to, cellMark(index === 0, last, table.alignments[index], cellStyle(shape, columnWidth)))
        const marks: [number, number, Decoration][] = cell.pipes.map((pipe) => [pipe, pipe + 1, pipe === shape.closingPipe ? CLOSING_PIPE_MARK : PIPE_MARK])
        // The delimiter row's CSS gives all its text but the pipes no room.
        if (row.kind !== 'delimiter') for (const { from, to } of shape.padding) marks.push([from, to, PAD_MARK])
        marks.sort((a, b) => a[0] - b[0])
        for (const [from, to, mark] of marks) rows.add(from, to, mark)
        // A click left of a row's leading pipe puts the caret at the row
        // start (see `tableMarginClicks`), so that position does not snap.
        const leadingFrom = index === 0 && shape.opened ? cell.pipes[0] + 1 : cell.from
        caretZones.push({ from: cell.from, to: cell.to, leadingFrom, text: shape.text, trailingTo: shape.closingPipe ?? cell.to })
      })
    })
  }
  return { cells: cells.finish(), rows: rows.finish(), wrappers: wrappers.finish(), caretZones }
}

/** Lay out each table that `findMarkdownTables` finds as a table, in place,
 *  with the source text still in the doc and editable. No text is replaced,
 *  so every character keeps its caret position; the CSS only makes the
 *  delimiter row and the splitting pipes transparent and gives the padding
 *  and the delimiter row's text no width. The wrapper is
 *  `display: table`, each row line is a table row, and cell marks that
 *  cover each row from end to end are the table cells. Inside a
 *  table row, any inline node that is not a cell becomes an extra anonymous
 *  cell, so row lines must never get widgets or replace decorations (CM adds
 *  buffer `<img>` / `<br>` / empty `<span>` nodes for those). The cells are
 *  outer decorations so syntax and find marks nest inside them and never
 *  split a cell.
 *  The decorations come only from the doc text, never from the cursor: an
 *  edit that breaks the syntax shows the raw source, and the table returns
 *  as soon as the source is valid again. The table CSS is in `dezTheme`
 *  (`cmEditor.ts`), except the horizontal cell geometry, which is inline
 *  (`cellStyle`, `CLOSING_PIPE_MARK`), and the width that the column floors
 *  use (`tableWidthTracker`). */
const tableDecorationsField = StateField.define<TableDecorations>({
  create: (state) => buildTableDecorations(state),
  update: (value, tr) => tr.docChanged ? buildTableDecorations(tr.state) : value,
  provide: (field) => [
    EditorView.outerDecorations.from(field, (value) => value.cells),
    EditorView.decorations.from(field, (value) => value.rows),
    EditorView.blockWrappers.from(field, (value) => value.wrappers),
  ],
})

/** The zone of the cell that holds `pos`. Two cells meet at a splitting
 *  pipe: with `side` < 0 that position is in the cell before it, otherwise
 *  in the cell that the pipe opens. */
function caretZoneAt(zones: CaretZone[], pos: number, side: number): CaretZone | null {
  let lo = 0
  let hi = zones.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (side < 0 ? zones[mid].from < pos : zones[mid].from <= pos) lo = mid + 1
    else hi = mid
  }
  const zone = zones[lo - 1]
  return zone !== undefined && pos <= zone.to ? zone : null
}

/** A click in a cell's padding puts the caret at the edge of the cell's
 *  text. The padding takes no room, so a caret in it looks like a caret at
 *  the text, but typing there would show the spaces between the text and
 *  the typed chars. A click left of the text of a cell that a splitting
 *  pipe opens gives the position before that pipe, which is the end of the
 *  cell before it, so typing there would go into the wrong cell. The
 *  caret's side tells which cell a click was in: CM gives -1 for a click
 *  right of a cell's text and 1 for a click left of the next cell's text.
 *  Only pointer carets snap: the arrow keys still step over each space,
 *  and a selected range keeps its ends (a triple-click selects the whole
 *  row line). */
const snapPointerCarets = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent('select.pointer')) return tr
  const zones = tr.startState.field(tableDecorationsField).caretZones
  if (zones.length === 0) return tr
  let snapped = false
  const ranges = tr.selection.ranges.map((range) => {
    if (!range.empty) return range
    const { head } = range
    const side = range.assoc < 0 ? -1 : 1
    const zone = caretZoneAt(zones, head, side) ?? caretZoneAt(zones, head, -side)
    if (zone === null) return range
    if (head >= zone.leadingFrom && head < zone.text.from) {
      snapped = true
      return EditorSelection.cursor(zone.text.from, 1)
    }
    if (head > zone.text.to && head <= zone.trailingTo) {
      snapped = true
      return EditorSelection.cursor(zone.text.to, -1)
    }
    return range
  })
  return snapped ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }] : tr
})

interface ClientBox {
  left: number
  right: number
  top: number
  bottom: number
}

const SELECTION_CLASS = 'cm-selectionBackground'

/** The `.dez-table-cell` element that holds the char at `pos`. */
function cellElementAt(view: EditorView, pos: number): Element | null {
  const { node, offset } = view.domAtPos(pos, 1)
  const target = node.nodeType === Node.ELEMENT_NODE ? node.childNodes[offset] ?? node : node
  const element = target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement
  return element?.closest('.dez-table-cell') ?? null
}

/** The client rects of the text from `from` to `to`, one per visual line.
 *  `getClientRects` gives a rect per text node and per inline element (pipe,
 *  syntax and find marks), so the rects of a line are joined: overlapping
 *  rects would draw a semi-transparent selection color twice. */
function textLineBoxes(view: EditorView, from: number, to: number): ClientBox[] {
  const start = view.domAtPos(from, 1)
  const end = view.domAtPos(to, -1)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  const lines: ClientBox[] = []
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const line = lines.find((box) => rect.top < box.bottom && rect.bottom > box.top)
    if (line) {
      line.left = Math.min(line.left, rect.left)
      line.right = Math.max(line.right, rect.right)
      line.top = Math.min(line.top, rect.top)
      line.bottom = Math.max(line.bottom, rect.bottom)
    } else {
      lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
    }
  }
  return lines
}

/** Draws the selection, in place of the selection layer of `drawSelection()`
 *  (CSS below hides that one). CM draws a selection in text-flow order and
 *  finds the visual lines of a wrapped line with `posAtCoords` at the
 *  editor's left and right edges. In a table row those points are in other
 *  cells, so a selection inside a wrapped cell got a rect over the cells to
 *  its left. This layer draws the text outside tables with CM's own
 *  `RectangleMarker.forRange`, and the selected part of each table cell
 *  itself: the whole cell box when the cell is fully selected, else the
 *  selected text, line by line.
 *  The layer also has CM's `cm-selectionLayer` class, so the theme's
 *  selection colors (focused and not focused) apply to it unchanged. */
const tableAwareSelectionLayer = layer({
  above: false,
  class: 'dez-selection-layer',
  mount: (dom) => dom.classList.add('cm-selectionLayer'),
  update: (update) => update.docChanged || update.selectionSet || update.viewportChanged,
  markers(view) {
    const { cells, wrappers } = view.state.field(tableDecorationsField)
    // Marker coordinates are relative to the scroller's content origin, as
    // in CM's (internal) `getBase`. The editor text is always left to right.
    const scroller = view.scrollDOM.getBoundingClientRect()
    const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX
    const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY
    const markers: RectangleMarker[] = []
    const addBox = (box: ClientBox): void => {
      markers.push(new RectangleMarker(SELECTION_CLASS, box.left - baseLeft, box.top - baseTop, box.right - box.left, box.bottom - box.top))
    }
    const drawText = (from: number, to: number, tableFrom: number | null): void => {
      if (from >= to) return
      const rects = RectangleMarker.forRange(view, SELECTION_CLASS, EditorSelection.range(from, to))
      // CM draws a range that ends at the start of a table into the header
      // row: a thin rect on the header line, from the content's left edge
      // to the header's first char, and a full-width rect over the lines in
      // between that goes down to the header's text top, below the top
      // edge of the header cells. When the range starts on the line just
      // above the table, CM moves the top of the thin rect up to the middle
      // of the gap. Drop the thin rect (its bottom is below the header's
      // text top), and stop the others at the top edge of the header cells.
      const headerTextTop = tableFrom === null ? undefined : view.coordsAtPos(tableFrom, 1)?.top
      const headerCellTop = tableFrom === null ? undefined : cellElementAt(view, tableFrom)?.getBoundingClientRect().top
      for (const rect of rects) {
        if (headerTextTop === undefined || headerCellTop === undefined) {
          markers.push(rect)
          continue
        }
        const top = rect.top + baseTop
        const bottom = top + rect.height
        if (bottom > headerTextTop + 0.5) continue
        const clippedBottom = Math.min(bottom, headerCellTop)
        if (clippedBottom > top) markers.push(new RectangleMarker(SELECTION_CLASS, rect.left, rect.top, rect.width, clippedBottom - top))
      }
    }
    const drawCells = (from: number, to: number): void => {
      from = Math.max(from, view.viewport.from)
      to = Math.min(to, view.viewport.to)
      if (from >= to) return
      cells.between(from, to, (cellFrom, cellTo) => {
        const start = Math.max(from, cellFrom)
        const end = Math.min(to, cellTo)
        if (start >= end) return
        if (start === cellFrom && end === cellTo) {
          const cell = cellElementAt(view, cellFrom)
          if (cell) addBox(cell.getBoundingClientRect())
          return
        }
        for (const box of textLineBoxes(view, start, end)) addBox(box)
      })
    }

    for (const range of view.state.selection.ranges) {
      if (range.empty) continue
      // Draw the range in parts: text between tables, then the table cells.
      // The line break after a table belongs to the table part.
      let pos = range.from
      wrappers.between(range.from, range.to, (tableFrom, tableTo) => {
        drawText(pos, tableFrom, tableFrom)
        drawCells(Math.max(pos, tableFrom), Math.min(range.to, tableTo))
        pos = tableTo + 1
      })
      drawText(pos, range.to, null)
    }
    return markers
  },
})

const hideDefaultSelectionLayer = EditorView.theme({
  '.cm-selectionLayer:not(.dez-selection-layer)': { display: 'none' },
})

/** The width of WebKitGTK's overlay scrollbar, which also takes presses:
 *  `scrollbarSize` in WebKit's `AdwaitaScrollbarPainter.h`. It is drawn
 *  over the right edge of a scroller's padding box. macOS overlay
 *  scrollbars are narrower.
 *  https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/adwaita/AdwaitaScrollbarPainter.h */
export const OVERLAY_SCROLLBAR_PX = 21

/** A mousedown in the scroller's side margins (outside `.cm-content`) does
 *  not reach CM's handlers, which are on the content element, so WebKit
 *  places the caret with its own hit test. Next to a normal line that is
 *  the line's start or end, but next to a table row WebKit picks the
 *  table's first position or the line after the table. This sends such a
 *  mousedown on to the content element, with x moved inside the content,
 *  so that CM handles it (caret, drag, double-click, Shift) as a click on
 *  the row. */
const tableMarginClicks = ViewPlugin.define((view) => {
  const onMouseDown = (event: MouseEvent): void => {
    const scroller = view.scrollDOM
    if (event.target !== scroller) return
    // Leave presses on a scrollbar alone. An overlay scrollbar takes no
    // layout width, so `clientWidth` does not show it, but a press on it
    // still fires mousedown here. The side margins are the scroller's
    // padding (`TEXT_GUTTER` in cmEditor.ts), which can be much wider than
    // the scrollbar, so only the scrollbar's strip at the right edge is
    // skipped. A classic scrollbar is outside the padding box.
    const paddingBoxRight = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth
    if (event.clientX >= paddingBoxRight - OVERLAY_SCROLLBAR_PX) return
    const content = view.contentDOM.getBoundingClientRect()
    if (event.clientY < content.top || event.clientY >= content.bottom) return
    const line = view.lineBlockAtHeight(event.clientY - view.documentTop)
    let inTable = false
    view.state.field(tableDecorationsField).wrappers.between(line.from, line.from, () => {
      inTable = true
      return false
    })
    if (!inTable) return
    event.preventDefault()
    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: event.view,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: Math.min(Math.max(event.clientX, content.left), content.right - 1),
      clientY: event.clientY,
      button: event.button,
      buttons: event.buttons,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }))
  }
  view.scrollDOM.addEventListener('mousedown', onMouseDown)
  return {
    destroy: () => view.scrollDOM.removeEventListener('mousedown', onMouseDown),
  }
})

/** Tables for the thread editor (`buildState()` in `ThreadEditor.vue`). It
 *  also tracks the width that the tables fill, replaces the selection layer
 *  of `drawSelection()`, forwards clicks in the margin beside table rows,
 *  and moves a click in a cell's padding to the cell's text. */
export function markdownTables(): Extension {
  return [tableDecorationsField, tableWidthTracker, snapPointerCarets, tableAwareSelectionLayer, hideDefaultSelectionLayer, tableMarginClicks]
}
