import { EditorSelection, RangeSetBuilder, StateField, type EditorState, type Extension, type RangeSet, type Text } from '@codemirror/state'
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
  /** Row line classes and the marks that hide the splitting pipes. */
  rows: DecorationSet
  /** One `div.dez-table` around the lines of each table. */
  wrappers: RangeSet<BlockWrapper>
}

/** Row line decorations of each row kind: [any row but the last, the last
 *  row]. The last row's class rounds the table's bottom corners. */
const ROW_LINES: Record<TableRowKind, [Decoration, Decoration]> = {
  header: rowLines('header'),
  delimiter: rowLines('delimiter'),
  body: rowLines('body'),
}
const PIPE_MARK = Decoration.mark({ class: 'dez-table-pipe' })
const TABLE_WRAPPER = BlockWrapper.create({ tagName: 'div', attributes: { class: 'dez-table' } })
const cellMarks = new Map<string, Decoration>()

function rowLines(kind: TableRowKind): [Decoration, Decoration] {
  const cls = `dez-table-row dez-table-row--${kind}`
  return [Decoration.line({ class: cls }), Decoration.line({ class: `${cls} dez-table-row--last` })]
}

// The horizontal geometry of a cell. A cell keeps its source, so its text
// sits between pipes that are transparent but keep their width: `| text |`.
// Each side of a cell box has a pipe slot, 1ch wide, plus the padding:
// - left: the opening pipe and the spaces after it are a hanging indent
//   (`padding-left` + negative `text-indent`), so the first line starts
//   where it always did and the lines that wrap start under its text, not
//   2ch to the left of it. A cell with no opening pipe (a row without a
//   leading pipe) gets an empty slot instead.
// - right: an empty slot, as the next cell's opening pipe is in that cell.
//   The pipe that closes a row hangs into it (negative `margin-right`), so
//   the last cell has the same inset as the others and the last line of a
//   wrapped right-aligned cell ends where the lines above it end (they end
//   with the 1ch space at the wrap).
// So `| a | b |` shows the same gap on both sides of `a` and of `b`.
// The styles are inline because they depend on each cell's source.

/** Cell padding in ch on each side, besides the pipe slot. */
const CELL_PADDING_CH = 0.5
/** A pipe is 1ch wide in the editor's monospace font. */
const PIPE_SLOT_CH = 1
/** At most this many ch of a cell's prefix hang. A source that pads a
 *  right-aligned column with leading spaces would otherwise give each such
 *  cell a wide `padding-left`, which the column cannot shrink below. The
 *  rest of the prefix stays plain leading space on the first line. */
const MAX_HANG_CH = 4

const CLOSING_PIPE_MARK = Decoration.mark({ class: 'dez-table-pipe', attributes: { style: `margin-right: -${PIPE_SLOT_CH}ch` } })

/** Where a cell's source sits in its box (see the notes above). */
interface CellShape {
  /** Width in ch of the leading spaces, the opening pipe, and the spaces
   *  after it: the part of the first line before the text. Capped at
   *  `MAX_HANG_CH`; 0 when the leading space has a tab. */
  hang: number
  /** Whether a pipe opens the cell. */
  opened: boolean
  /** Doc position of the pipe that closes the row, if this cell has it. */
  closingPipe: number | null
}

function cellShape(doc: Text, cell: TableCell): CellShape {
  const text = doc.sliceString(cell.from, cell.to)
  let prefix = 0
  while (text.charCodeAt(prefix) === SPACE || text.charCodeAt(prefix) === TAB) prefix++
  const opened = cell.pipes[0] === cell.from + prefix
  // Only a body row can start with a tab. A tab goes to the next tab stop,
  // so its width is not known here, and a prefix with a tab does not hang:
  // the lines that wrap start under the tab.
  const hangs = !text.slice(0, prefix).includes('\t')
  if (opened) {
    prefix++
    while (text.charCodeAt(prefix) === SPACE) prefix++
  }
  // `cell.pipes` holds at most the opening pipe and a trailing pipe.
  const last = cell.pipes.at(-1)
  const closingPipe = last === undefined || (opened && cell.pipes.length === 1) ? null : last
  return { hang: hangs ? Math.min(prefix, MAX_HANG_CH) : 0, opened, closingPipe }
}

/** The inline style of a cell: its side paddings, its hanging indent, and
 *  its `width` (see `shortColumnWidths`), if any. */
function cellStyle(shape: CellShape, width: string | null): string {
  const left = CELL_PADDING_CH + (shape.opened ? 0 : PIPE_SLOT_CH) + shape.hang
  let style = `padding-left: ${left}ch; padding-right: ${CELL_PADDING_CH + PIPE_SLOT_CH}ch`
  if (shape.hang > 0) style += `; text-indent: -${shape.hang}ch`
  if (width !== null) style += `; width: ${width}`
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
 *  a short column (see `shortColumnWidths`). */
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

/** CSS widths for the cells of the short columns, one per column; `null`
 *  for a long column. The browser's automatic table layout shares the width
 *  in proportion to each column's longest line, and cell text may break
 *  anywhere (so that a table is never wider than the editor), so one long
 *  text column would squeeze the short columns until their words wrap. A
 *  CSS width on the cells of a short column makes it a fixed column, which
 *  the layout fills first and shrinks last; the long columns take the rest.
 *  Every row has the widths because CM renders only the lines near the
 *  viewport, and the header may not be one of them. Long columns still size
 *  from the rendered rows. A fixed column that is narrower than its text
 *  wraps that text, so a cell's width is an upper bound (`textWidthCh`).
 *  Do not give the wrapper a width that depends on the text: a wrapper whose
 *  attributes change is a new DOM element, which moves the line that the
 *  user is typing in (and can break an IME composition there). */
function shortColumnWidths(doc: Text, tabSize: number, table: MarkdownTable, shapes: CellShape[][]): (string | null)[] {
  const textWidths = table.alignments.map(() => 0)
  const boxWidths = table.alignments.map(() => 0)
  table.rows.forEach((row, rowIndex) => {
    if (row.kind === 'delimiter') return
    row.cells.forEach((cell, index) => {
      // `textWidthCh` gives each UTF-16 code unit at least 1ch, so a cell
      // with more code units than a short column holds is long as it is.
      const length = cell.to - cell.from
      const width = length > SHORT_COLUMN_CH ? length : textWidthCh(doc.sliceString(cell.from, cell.to), tabSize)
      textWidths[index] = Math.max(textWidths[index], width)
      // Beyond its source text, the box needs its empty pipe slots. The hang
      // needs nothing: its padding and its negative indent cancel out on the
      // first line.
      const { opened, closingPipe } = shapes[rowIndex][index]
      const emptySlots = (opened ? 0 : PIPE_SLOT_CH) + (closingPipe === null ? PIPE_SLOT_CH : 0)
      boxWidths[index] = Math.max(boxWidths[index], width + emptySlots)
    })
  })
  // `box-sizing` is `border-box` app-wide: add the side paddings and the 1px
  // right border of `.dez-table-cell`, and the first column's 1px left
  // border.
  return textWidths.map((width, index) => width <= SHORT_COLUMN_CH
    ? `calc(${boxWidths[index] + 2 * CELL_PADDING_CH}ch + ${index === 0 ? 2 : 1}px)`
    : null)
}

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
  for (const table of findMarkdownTables(doc)) {
    wrappers.add(table.from, table.to, TABLE_WRAPPER)
    const shapes = table.rows.map((row) => row.cells.map((cell) => cellShape(doc, cell)))
    const widths = shortColumnWidths(doc, state.tabSize, table, shapes)
    table.rows.forEach((row, rowIndex) => {
      // RangeSetBuilder needs sorted input. A line decoration sorts before
      // a pipe mark that starts at the same position.
      rows.add(row.from, row.from, ROW_LINES[row.kind][rowIndex === table.rows.length - 1 ? 1 : 0])
      row.cells.forEach((cell, index) => {
        const shape = shapes[rowIndex][index]
        // The delimiter row's smaller font would shrink a `ch` width.
        const width = row.kind === 'delimiter' ? null : widths[index]
        const last = index === row.cells.length - 1
        cells.add(cell.from, cell.to, cellMark(index === 0, last, table.alignments[index], cellStyle(shape, width)))
        for (const pipe of cell.pipes) rows.add(pipe, pipe + 1, pipe === shape.closingPipe ? CLOSING_PIPE_MARK : PIPE_MARK)
      })
    })
  }
  return { cells: cells.finish(), rows: rows.finish(), wrappers: wrappers.finish() }
}

/** Lay out each table that `findMarkdownTables` finds as a table, in place,
 *  with the source text still in the doc and editable. No text is replaced,
 *  so every character keeps its caret position; the CSS only makes the
 *  delimiter row and the splitting pipes transparent. The wrapper is
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
 *  (`cellStyle`, `CLOSING_PIPE_MARK`). */
const tableDecorationsField = StateField.define<TableDecorations>({
  create: (state) => buildTableDecorations(state),
  update: (value, tr) => tr.docChanged ? buildTableDecorations(tr.state) : value,
  provide: (field) => [
    EditorView.outerDecorations.from(field, (value) => value.cells),
    EditorView.decorations.from(field, (value) => value.rows),
    EditorView.blockWrappers.from(field, (value) => value.wrappers),
  ],
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
 *  also replaces the selection layer of `drawSelection()` and forwards
 *  clicks in the margin beside table rows. */
export function markdownTables(): Extension {
  return [tableDecorationsField, tableAwareSelectionLayer, hideDefaultSelectionLayer, tableMarginClicks]
}
