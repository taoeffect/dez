import type { EditorView } from '@codemirror/view'
import { OVERLAY_SCROLLBAR_PX } from '../../src/view/editor/tables'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor } from './harness/thread'

// Markdown tables in the thread editor, driven through the real app.
//
// A valid GFM table shows as a table in place of its source, but the source
// stays in the doc: every char keeps a caret position and every key edits
// one source char. So an edit that breaks the table syntax shows the raw
// source, and an edit that makes it valid again shows the table again.
//
// Clicks, drags, and keys are real WebDriver input. Page code reads the
// CodeMirror view only to find click points (`coordsAtPos`) and to check
// the doc and the caret.
//
// One app session serves the whole file. Each test opens its fixture in a
// new tab, so no test depends on the edits or the scroll of another.

const HEADER = '| Name | Score | Note |'
const DELIMITER = '|:-----|:-----:|-----:|'
const ANN_ROW = '| Ann | 10 | ok |'
const BOB_ROW = '| Bob | 7 | fine |'

// Table syntax inside a fenced code block is code, not a table.
const FENCED_ROWS = ['| A | B |', '|---|---|', '| 1 | 2 |']

const MAIN_TEXT = [
  'Tables fixture.',
  '',
  HEADER,
  DELIMITER,
  ANN_ROW,
  BOB_ROW,
  '',
  '~~~',
  ...FENCED_ROWS,
  '~~~',
].join('\n')

// Long enough to wrap to several visual lines in the second column.
const LONG_CELL = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
const WRAP_ROW = `| w | ${LONG_CELL} |`
const WRAP_TEXT = ['Wrap fixture.', '', '| Key | Text |', '|-----|------|', WRAP_ROW].join('\n')

// A long cell in a left-aligned column and one in a right-aligned last
// column: both wrap.
const HANG_ROW = `| w | ${LONG_CELL} | ${LONG_CELL} |`
const HANG_TEXT = ['Hanging fixture.', '', '| Key | Left | Right |', '|-----|------|------:|', HANG_ROW].join('\n')

// A body row needs no block indent, so a tab may come before its leading
// pipe.
const TAB_ROW = '\t| x | y |'
const TAB_TEXT = ['Tab fixture.', '', '| Key | Text |', '|-----|------|', TAB_ROW].join('\n')

// GFM allows a body row with fewer cells than the table has columns.
const SHORT_ROW = '| Cy |'
const SHORT_TEXT = ['Short row fixture.', '', HEADER, DELIMITER, ANN_ROW, SHORT_ROW].join('\n')

// Short cells with chars that are wider than 1ch (CJK, emoji, a tab), next
// to a long column that wraps and so takes all the width that it can get.
const WIDE_ROW = `| ab | 東京都 | ✅ | 🚀 | \tbc | ${LONG_CELL} |`
const WIDE_TEXT = ['Wide chars fixture.', '', '| Id | C | S | E | T | Text |', '|----|---|---|---|---|------|', WIDE_ROW].join('\n')

// The table starts right below a text line (a header may interrupt a
// paragraph), with more text above, to select into the table from above.
const INTRO_LINE = 'Here is the table:'
const INTRO_TEXT = ['Intro fixture.', '', INTRO_LINE, HEADER, DELIMITER, ANN_ROW, BOB_ROW].join('\n')

// The table of MAIN_TEXT, and the same table with its cells padded more
// than a formatter pads them: an indent before the leading pipe, spaces on
// both sides of the text, and spaces after the closing pipe. The padding
// takes no room, so both tables must look the same.
const PADDED_ANN_ROW = ' |  Ann       |     10      |         ok |'
const PADDED_ROWS = [
  '|   Name     |    Score    |       Note |',
  '|:-----------|:-----------:|-----------:|',
  PADDED_ANN_ROW,
  '| Bob        | 7           |      fine  |  ',
]
const PADDED_TEXT = ['Padded fixture.', '', HEADER, DELIMITER, ANN_ROW, BOB_ROW, '', ...PADDED_ROWS].join('\n')

// The start of the user's table from the TODO-21 report. Its source pads
// each cell to 60 chars and has 60 dashes per delimiter cell. Before the
// padding took no room, its header band was many lines tall (lines of
// padding under each header text) and its delimiter row wrapped.
const USER_PAD_TO = 60
const userRow = (cells: string[]): string => `| ${cells.map((cell) => cell.padEnd(USER_PAD_TO)).join(' | ')} |`
const USER_TABLE_TEXT = ['User table fixture.', '', ...[
  userRow(['What changes results', 'When', 'Cache guard']),
  `| ${Array.from({ length: 3 }, () => '-'.repeat(USER_PAD_TO)).join(' | ')} |`,
  userRow([
    'Re-read cleanup (`compaction.supersedeReads`, on by default)',
    'Each turn. An older `read` of a file becomes `[Superseded by a newer read of this file]` after a newer read of the same file.',
    "Runs only if the messages after that result total about 8k tokens or less, and the result is within Anthropic's 20-block cache lookback. It also runs after 90 minutes idle, which is longer than the 1-hour cache life (`PRUNE_IDLE_FLUSH_MS`).",
  ]),
  userRow([
    'Uneventful results (`compaction.dropUseless`, on by default)',
    'A search with zero matches or a `wait` that ended with no change becomes `[Uneventful result elided]`.',
    'Same guard as above.',
  ]),
]].join('\n')

interface Point {
  x: number
  y: number
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

interface EditorSnapshot {
  doc: string
  anchor: number
  head: number
}

interface RenderedRow {
  kind: string
  text: string
  cells: Array<{ left: number, right: number, align: string }>
}

interface CellText {
  box: Box
  /** The left edge and top of the text's first char. */
  textLeft: number
  textTop: number
  /** The right edge and bottom of the text's last char. */
  textRight: number
  textBottom: number
}

let fixtureCount = 0

describe('markdown tables', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function editorSnapshot (): Promise<EditorSnapshot> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('editorSnapshot: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { anchor, head } = view.state.selection.main
      return { doc: String(view.state.doc), anchor, head }
    })
  }

  async function caret (): Promise<number> {
    return (await editorSnapshot()).head
  }

  // Doc position of `text` plus `offset`; fails if `text` is not in the doc.
  async function docPos (text: string, offset = 0): Promise<number> {
    const index = (await editorSnapshot()).doc.indexOf(text)
    if (index < 0) throw new Error(`docPos: ${JSON.stringify(text)} is not in the doc`)
    return index + offset
  }

  // Viewport point at doc position `pos`: x is the caret position (`side`
  // picks the char before or after it), y the middle of its line.
  async function pointAt (pos: number, side: -1 | 1): Promise<Point> {
    return browser.execute((target: number, bias: -1 | 1) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('pointAt: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const coords = view.coordsAtPos(target, bias)
      if (!coords) throw new Error(`pointAt: no coords for ${target}`)
      return { x: coords.left, y: (coords.top + coords.bottom) / 2 }
    }, pos, side)
  }

  // The rows of each rendered table, in doc order, with their cell boxes.
  async function renderedTables (): Promise<RenderedRow[][]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll('.cm-content .dez-table')).map((table) =>
        Array.from(table.querySelectorAll('.cm-line')).map((line) => ({
          kind: ['header', 'delimiter', 'body'].find((kind) => line.classList.contains(`dez-table-row--${kind}`)) ?? 'none',
          text: line.textContent ?? '',
          cells: Array.from(line.querySelectorAll(':scope > .dez-table-cell')).map((cell) => {
            const box = cell.getBoundingClientRect()
            return { left: box.left, right: box.right, align: getComputedStyle(cell).textAlign }
          }),
        }))
      )
    )
  }

  // 'table' if the editor line with this exact text is in a rendered table,
  // 'raw' if it shows as plain text, 'missing' if no line has this text.
  async function lineState (text: string): Promise<string> {
    return browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line')).find((el) => el.textContent === wanted)
      if (!line) return 'missing'
      return line.closest('.dez-table') ? 'table' : 'raw'
    }, text)
  }

  // For each row of the first rendered table: its kind and the distinct
  // computed colors of the elements that hold its text.
  async function rowTextColors (): Promise<Array<{ kind: string, colors: string[] }>> {
    return browser.execute(() => {
      const table = document.querySelector('.cm-content .dez-table')
      if (!table) throw new Error('rowTextColors: no rendered table')
      return Array.from(table.querySelectorAll('.cm-line')).map((line) => {
        const colors = new Set<string>()
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement && (node.textContent ?? '').trim()) colors.add(getComputedStyle(node.parentElement).color)
        }
        return {
          kind: ['header', 'delimiter', 'body'].find((kind) => line.classList.contains(`dez-table-row--${kind}`)) ?? 'none',
          colors: Array.from(colors),
        }
      })
    })
  }

  // Selection rects that are on screen. CM's own selection layer is in the
  // DOM even when hidden; its rects then have no client rects. A selection
  // layer redraws in CM's measure cycle, on the animation frame after the
  // selection changes, so read after two frames: then the rects match the
  // current selection.
  async function visibleSelectionBoxes (): Promise<Box[]> {
    return browser.execute(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return Array.from(document.querySelectorAll('.cm-selectionBackground'))
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const { left, right, top, bottom } = el.getBoundingClientRect()
          return { left, right, top, bottom }
        })
        .sort((a, b) => a.top - b.top || a.left - b.left)
    })
  }

  // Boxes of the cells of the rendered row whose text starts with `rowStart`.
  async function rowCellBoxes (rowStart: string): Promise<Box[]> {
    return browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .dez-table-row'))
        .find((el) => (el.textContent ?? '').startsWith(wanted))
      if (!line) throw new Error(`rowCellBoxes: no rendered row starts with ${wanted}`)
      return Array.from(line.querySelectorAll(':scope > .dez-table-cell')).map((cell) => {
        const { left, right, top, bottom } = cell.getBoundingClientRect()
        return { left, right, top, bottom }
      })
    }, rowStart)
  }

  // Each rendered table as its header and body rows, each row as its cells:
  // the cell box, and the edges of the cell's text (its source without the
  // pipes and the whitespace around them).
  async function cellTextLayout (): Promise<CellText[][][]> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('cellTextLayout: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const charBox = (pos: number): Box => {
        const rect = view.coordsForChar(pos)
        if (!rect) throw new Error(`cellTextLayout: no char rect at ${pos}`)
        return rect
      }
      return Array.from(document.querySelectorAll('.cm-content .dez-table')).map((table) =>
        Array.from(table.querySelectorAll('.dez-table-row--header, .dez-table-row--body')).map((line) =>
          Array.from(line.querySelectorAll(':scope > .dez-table-cell')).map((cell) => {
            const from = view.posAtDOM(cell, 0)
            const text = /[^\s|](?:.*[^\s|])?/.exec(cell.textContent ?? '')
            if (!text) throw new Error(`cellTextLayout: no text in ${JSON.stringify(cell.textContent)}`)
            const first = charBox(from + text.index)
            const last = charBox(from + text.index + text[0].length - 1)
            const { left, right, top, bottom } = cell.getBoundingClientRect()
            return { box: { left, right, top, bottom }, textLeft: first.left, textTop: first.top, textRight: last.right, textBottom: last.bottom }
          })
        )
      )
    })
  }

  // Each column's cells have the same left and right edge in every row.
  function expectAlignedColumns (rows: RenderedRow[], columns: number): void {
    for (const row of rows) {
      expect(row.cells, `cells of ${row.text}`).toHaveLength(columns)
      row.cells.forEach((cell, column) => {
        expect(cell.left, `left of column ${column} in ${row.text}`).toBeCloseTo(rows[0].cells[column].left, 0)
        expect(cell.right, `right of column ${column} in ${row.text}`).toBeCloseTo(rows[0].cells[column].right, 0)
      })
    }
  }

  function expectBoxInside (box: Box, outer: Box): void {
    expect(box.left).toBeGreaterThanOrEqual(outer.left - 0.5)
    expect(box.right).toBeLessThanOrEqual(outer.right + 0.5)
    expect(box.top).toBeGreaterThanOrEqual(outer.top - 0.5)
    expect(box.bottom).toBeLessThanOrEqual(outer.bottom + 0.5)
  }

  // `count` clicks at one point: 2 is a double-click, 3 a triple-click.
  async function clickAt (point: Point, count = 1): Promise<void> {
    let action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
    for (let i = 0; i < count; i++) action = action.down({ button: 0 }).up({ button: 0 })
    await action.perform()
  }

  // Seed `text` as the user section of a new conversation, open it in a new
  // tab, and put the cursor at the doc start. The agent section ends with
  // the fixture id, so the wait cannot match an older tab's editor.
  async function openFixture (text: string): Promise<void> {
    const id = `tables-e2e-${++fixtureCount}`
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `Reply.\n${id}` }] },
      ],
    }))
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, id)
    await waitForValue(browser, `fixture ${id} open`, async () => (await editorSnapshot()).doc.endsWith(`\n${id}`), true)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    await waitForValue(browser, 'caret at the doc start', caret, 0)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('renders a valid table with aligned columns and leaves a fenced table as code', async () => {
    await openFixture(MAIN_TEXT)

    const tables = await renderedTables()
    expect(tables).toHaveLength(1)
    const [rows] = tables
    // The source text stays in each row.
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['header', HEADER],
      ['delimiter', DELIMITER],
      ['body', ANN_ROW],
      ['body', BOB_ROW],
    ])
    expectAlignedColumns(rows, 3)
    // `:--`, `:-:`, and `--:` in the delimiter row align the columns.
    for (const row of rows) {
      expect(row.cells[0].align, `column 0 of ${row.text}`).toMatch(/^(start|left)$/)
      expect(row.cells[1].align, `column 1 of ${row.text}`).toBe('center')
      expect(row.cells[2].align, `column 2 of ${row.text}`).toBe('right')
    }

    // The delimiter row keeps its source text (checked above) but draws none
    // of it: no dashes under the header. The other rows draw their text
    // (only the splitting pipes in them are transparent).
    const transparent = 'rgba(0, 0, 0, 0)'
    for (const row of await rowTextColors()) {
      if (row.kind === 'delimiter') expect(row.colors, 'delimiter text colors').toEqual([transparent])
      else expect(row.colors.some((color) => color !== transparent), `${row.kind} row text is drawn`).toBe(true)
    }

    for (const line of FENCED_ROWS) expect(await lineState(line), line).toBe('raw')
  })

  it('keeps the table rendered while the user types in a cell', async () => {
    await openFixture(MAIN_TEXT)
    // Click on the right half of the last "n" of "Ann": caret after it.
    const afterAnn = await docPos(ANN_ROW, '| Ann'.length)
    const point = await pointAt(afterAnn, -1)
    await clickAt({ x: point.x - 2, y: point.y })
    await waitForValue(browser, 'caret after the click', caret, afterAnn)

    await typeKeys(browser, 'ie')
    await waitForValue(browser, 'edited row', () => lineState('| Annie | 10 | ok |'), 'table')
    const tables = await renderedTables()
    expect(tables).toHaveLength(1)
    expect(tables[0].map((row) => row.text)).toEqual([HEADER, DELIMITER, '| Annie | 10 | ok |', BOB_ROW])
    expectAlignedColumns(tables[0], 3)
  })

  it('shows the raw source when an edit breaks the syntax and the table again when it is fixed', async () => {
    await openFixture(MAIN_TEXT)
    const pipe = await docPos('| Score')
    // Click on the left half of the "S" of "Score", then step back over the
    // space: the caret is right after the pipe that starts the cell.
    const point = await pointAt(pipe + 2, 1)
    await clickAt({ x: point.x + 2, y: point.y })
    await waitForValue(browser, 'caret before "Score"', caret, pipe + 2)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after the pipe', caret, pipe + 1)

    // Without that pipe the header has 2 cells and the delimiter row 3, so
    // no table: every line shows its source.
    const brokenHeader = '| Name  Score | Note |'
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'broken header', () => lineState(brokenHeader), 'raw')
    expect(await renderedTables()).toEqual([])
    for (const line of [DELIMITER, ANN_ROW, BOB_ROW]) expect(await lineState(line), line).toBe('raw')
    expect(await caret()).toBe(pipe)

    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'header after undo', () => lineState(HEADER), 'table')
    expect((await renderedTables()).map((rows) => rows.map((row) => row.text))).toEqual([[HEADER, DELIMITER, ANN_ROW, BOB_ROW]])
    expect(await caret()).toBe(pipe + 1)

    // Typing the pipe back fixes the syntax too.
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'header broken again', () => lineState(brokenHeader), 'raw')
    await typeKeys(browser, '|')
    await waitForValue(browser, 'header after typing the pipe', () => lineState(HEADER), 'table')
    expect(await editorSnapshot()).toMatchObject({ head: pipe + 1, doc: expect.stringContaining(`${HEADER}\n${DELIMITER}\n${ANN_ROW}`) })
    expectAlignedColumns((await renderedTables())[0], 3)
  })

  it('renders a streamed table once its delimiter row is complete and keeps it when the stream finishes', async () => {
    await openFixture('Stream fixture.')
    const tabId = await browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      return sbp('dez.model/tabs/activeId') as string
    })
    const appendToken = async (token: string): Promise<void> => {
      const applied = await browser.execute((id: string, text: string) => {
        const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
        return sbp('dez.editor/appendTokenIfVisible', id, '', text) as boolean
      }, tabId, token)
      expect(applied, `token ${JSON.stringify(token)} applied`).toBe(true)
    }
    const tableTexts = async (): Promise<string[][]> =>
      (await renderedTables()).map((rows) => rows.map((row) => row.text))

    // No table while the delimiter row has fewer cells than the header:
    // `|---` and then `|---|` have 1 cell, the header 2.
    for (const token of ['\n\n| S ', '| T |\n', '|---', '|']) {
      await appendToken(token)
      expect(await tableTexts(), `after ${JSON.stringify(token)}`).toEqual([])
    }
    await appendToken('---|')
    await waitForValue(browser, 'table after the delimiter row', tableTexts, [['| S | T |', '|---|---|']])
    await appendToken('\n| 1 ')
    await waitForValue(browser, 'table with a partial body row', tableTexts, [['| S | T |', '|---|---|', '| 1 ']])
    await appendToken('| 2 |')
    await waitForValue(browser, 'table with the body row', tableTexts, [['| S | T |', '|---|---|', '| 1 | 2 |']])

    // The stream finish rebuilds the editor from the store and puts the
    // caret at the doc end.
    await browser.execute((id: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      sbp('dez.editor/reconcileAfterStreamFinish', id)
    }, tabId)
    await browser.waitUntil(async () => {
      const { doc, head } = await editorSnapshot()
      return head === doc.length
    }, { timeout: 10_000, timeoutMsg: 'the stream finish did not move the caret to the doc end' })
    expect(await tableTexts()).toEqual([['| S | T |', '|---|---|', '| 1 | 2 |']])
    expectAlignedColumns((await renderedTables())[0], 2)
  })

  it('draws a selection in a wrapped cell over that cell only', async () => {
    await openFixture(WRAP_TEXT)
    const textFrom = await docPos(LONG_CELL)
    // Doc positions where the cell text starts a new visual line.
    const lineStarts = await browser.execute((from: number, length: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineStarts: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const starts: number[] = []
      let lastTop = -Infinity
      for (let pos = from; pos < from + length; pos++) {
        const top = view.coordsAtPos(pos, 1)?.top ?? lastTop
        if (top > lastTop + 1) starts.push(pos)
        lastTop = top
      }
      return starts
    }, textFrom, LONG_CELL.length)
    expect(lineStarts.length, 'visual lines of the long cell').toBeGreaterThanOrEqual(2)

    // Drag from the first visual line of the cell into its second one.
    const start = lineStarts[0] + 3
    const end = lineStarts[1] + 3
    const from = await pointAt(start, 1)
    const to = await pointAt(end, 1)
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(from.x + 2), y: Math.round(from.y), origin: 'viewport' })
      .down({ button: 0 })
      .move({ x: Math.round(to.x + 2), y: Math.round(to.y), origin: 'viewport', duration: 100 })
      .up({ button: 0 })
      .perform()
    await waitForValue(browser, 'dragged selection', async () => {
      const { anchor, head } = await editorSnapshot()
      return { anchor, head }
    }, { anchor: start, head: end })

    const [, longCell] = await rowCellBoxes('| w |')
    const boxes = await visibleSelectionBoxes()
    expect(boxes, 'one selection rect per visual line').toHaveLength(2)
    for (const box of boxes) expectBoxInside(box, longCell)
    expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[1].top + 0.5)

    // A triple-click selects the whole row: each cell is fully selected and
    // is drawn as one rect over the whole cell.
    const rowFrom = await docPos(WRAP_ROW)
    const wCell = await pointAt(rowFrom + 2, 1)
    await clickAt({ x: wCell.x + 2, y: wCell.y }, 3)
    await waitForValue(browser, 'row selection', async () => {
      const { anchor, head } = await editorSnapshot()
      return [Math.min(anchor, head), Math.max(anchor, head)]
    }, [rowFrom, rowFrom + WRAP_ROW.length + 1])
    const cells = await rowCellBoxes('| w |')
    const rowBoxes = await visibleSelectionBoxes()
    expect(rowBoxes).toHaveLength(cells.length)
    rowBoxes.forEach((box, index) => {
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        expect(box[side], `${side} of cell ${index}`).toBeCloseTo(cells[index][side], 0)
      }
    })
  })

  // A cell keeps its source, so its first line starts with the transparent
  // opening pipe. The lines that wrap must start under the text, not under
  // that pipe.
  it('lines up the wrapped lines of a cell and gives a cell the same inset on both sides', async () => {
    await openFixture(HANG_TEXT)
    const rowFrom = await docPos(HANG_ROW)
    const keyFrom = await docPos('| Key', 2)
    const leftFrom = rowFrom + HANG_ROW.indexOf(LONG_CELL)
    const rightFrom = rowFrom + HANG_ROW.lastIndexOf(LONG_CELL)
    const [key, left, right] = await browser.execute((texts: Array<{ from: number, to: number }>) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('cellLayout: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return texts.map(({ from, to }) => {
        // Each visual line of the text: the left edge of its first char and
        // the right edge of its last char that is not a space.
        const lines: Array<{ top: number, left: number, right: number }> = []
        for (let pos = from; pos < to; pos++) {
          const start = view.coordsAtPos(pos, 1)
          const end = view.coordsAtPos(pos + 1, -1)
          if (!start || !end) throw new Error(`cellLayout: no coords at ${pos}`)
          let line = lines.at(-1)
          if (!line || start.top > line.top + 1) {
            line = { top: start.top, left: start.left, right: start.left }
            lines.push(line)
          }
          if (view.state.doc.sliceString(pos, pos + 1) !== ' ') line.right = end.right
        }
        // The cell's box inside its borders.
        const { node, offset } = view.domAtPos(from, 1)
        const target = node.nodeType === Node.ELEMENT_NODE ? node.childNodes[offset] ?? node : node
        const element = target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement
        const cell = element?.closest('.dez-table-cell')
        if (!cell) throw new Error(`cellLayout: no cell at ${from}`)
        const innerLeft = cell.getBoundingClientRect().left + cell.clientLeft
        return { lines, innerLeft, innerRight: innerLeft + cell.clientWidth }
      })
    }, [
      { from: keyFrom, to: keyFrom + 'Key'.length },
      { from: leftFrom, to: leftFrom + LONG_CELL.length },
      { from: rightFrom, to: rightFrom + LONG_CELL.length },
    ])
    expect(left.lines.length, 'visual lines of the left-aligned cell').toBeGreaterThanOrEqual(3)
    expect(right.lines.length, 'visual lines of the right-aligned cell').toBeGreaterThanOrEqual(3)
    // WebKit rounds the rect of a char out to whole px, except at some ends
    // of a text run (where a padding mark starts), so equal edges can
    // measure up to 1px apart. A wrong hang or inset is 1ch (9px) off.
    const expectSameX = (actual: number, expected: number, label: string): void => {
      expect(Math.abs(actual - expected), label).toBeLessThan(1)
    }
    left.lines.forEach((line, index) => {
      expectSameX(line.left, left.lines[0].left, `left edge of line ${index} of the left-aligned cell`)
    })
    // The last line ends before the padding and the row's closing pipe, the
    // others before the space that hangs at the wrap; both end at the same
    // x.
    right.lines.forEach((line, index) => {
      expectSameX(line.right, right.lines[0].right, `right edge of line ${index} of the right-aligned cell`)
    })

    // The gap between the text and the cell's border is the same on both
    // sides of a cell (in the widest cell of a short column, and in the last
    // cell, which has the closing pipe), and in every column.
    const inset = left.lines[0].left - left.innerLeft
    expectSameX(key.lines[0].left - key.innerLeft, inset, 'left inset of Key')
    expectSameX(key.innerRight - key.lines[0].right, inset, 'right inset of Key')
    expectSameX(right.innerRight - right.lines[0].right, inset, 'right inset of the right-aligned cell')
  })

  // A tab before a body row's leading pipe is leading space, so that pipe
  // opens the first cell as the header's pipe does: the row's source starts
  // at the same x as the header's, the pipe keeps its 1ch width, and the
  // space after it takes no room.
  it('opens the first cell at the leading pipe of a body row that starts with a tab', async () => {
    await openFixture(TAB_TEXT)
    const rowFrom = await docPos(TAB_ROW)
    const keyFrom = await docPos('| Key')
    const headerPipe = await pointAt(keyFrom, 1)
    const charWidth = (await pointAt(keyFrom + 3, 1)).x - (await pointAt(keyFrom + 2, 1)).x
    const [tab, pipe, space, text] = [
      await pointAt(rowFrom, 1),
      await pointAt(rowFrom + 1, 1),
      await pointAt(rowFrom + 2, 1),
      await pointAt(rowFrom + 3, 1),
    ]
    expect(tab.x, 'start of the tab').toBeCloseTo(headerPipe.x, 0)
    expect(charWidth, 'width of a header char').toBeGreaterThan(1)
    // WebKit puts the chars after a tab up to about 0.5px off.
    expect(Math.abs(space.x - pipe.x - charWidth), 'width of the leading pipe minus a char width').toBeLessThan(1)
    expect(Math.abs(text.x - space.x), 'width of the space after the pipe').toBeLessThan(0.5)
  })

  // The padding of a cell takes no room: it does not widen a column, add a
  // line, or move the text of a left-, center-, or right-aligned cell.
  it('shows padded cells like the same cells without padding', async () => {
    await openFixture(PADDED_TEXT)
    const [plain, padded] = await cellTextLayout()
    expect(padded).toHaveLength(plain.length)
    plain.forEach((row, rowIndex) => {
      expect(padded[rowIndex]).toHaveLength(row.length)
      row.forEach((cell, column) => {
        const other = padded[rowIndex][column]
        const where = `row ${rowIndex}, column ${column}`
        expect(other.box.right - other.box.left, `width, ${where}`).toBeCloseTo(cell.box.right - cell.box.left, 0)
        expect(other.box.bottom - other.box.top, `height, ${where}`).toBeCloseTo(cell.box.bottom - cell.box.top, 0)
        expect(other.textLeft - other.box.left, `text left, ${where}`).toBeCloseTo(cell.textLeft - cell.box.left, 0)
        expect(other.textTop - other.box.top, `text top, ${where}`).toBeCloseTo(cell.textTop - cell.box.top, 0)
        expect(other.box.right - other.textRight, `text right, ${where}`).toBeCloseTo(cell.box.right - cell.textRight, 0)
      })
    })
  })

  // The padding of the user's table adds no lines under the header texts,
  // and its hidden dashes (60 per delimiter cell) do not wrap.
  it('adds no padding lines to the header and keeps the delimiter row one thin line', async () => {
    await openFixture(USER_TABLE_TEXT)
    const [[header]] = await cellTextLayout()
    const metrics = await browser.execute(() => {
      const headerCell = document.querySelector('.cm-content .dez-table-row--header > .dez-table-cell')
      const delimiter = document.querySelector('.cm-content .dez-table-row--delimiter')
      const delimiterCell = delimiter?.querySelector(':scope > .dez-table-cell')
      if (!headerCell || !delimiter || !delimiterCell) throw new Error('metrics: no rendered table')
      return {
        lineHeight: parseFloat(getComputedStyle(headerCell).lineHeight),
        delimiterHeight: delimiter.getBoundingClientRect().height,
        delimiterFontSize: parseFloat(getComputedStyle(delimiterCell).fontSize),
      }
    })
    expect(metrics.lineHeight, 'header line height').toBeGreaterThan(10)
    const textBottom = Math.max(...header.map((cell) => cell.textBottom))
    const rowBottom = Math.max(...header.map((cell) => cell.box.bottom))
    expect(rowBottom - textBottom, 'space under the lowest header text').toBeLessThan(metrics.lineHeight / 2)
    // One line at line height 1, plus the 1px bottom border.
    expect(metrics.delimiterHeight, 'delimiter row height').toBeLessThanOrEqual(metrics.delimiterFontSize + 1.5)
  })

  // A caret in the padding would show at the text edge, but typing there
  // would show the spaces. Left of the text of a centered or right-aligned
  // cell is the position before the cell's pipe, which would type into the
  // cell before it. So a click in the blank part of a cell puts the caret
  // at the edge of the cell's text.
  it('types at the text edge after a click in the blank part of a padded cell', async () => {
    await openFixture(PADDED_TEXT)
    const rowFrom = await docPos(PADDED_ANN_ROW)
    // Click halfway between the text edge at `edge` and the cell border.
    const clickBeside = async (column: number, side: 'left' | 'right', edge: number, typed: string): Promise<void> => {
      const cell = (await rowCellBoxes(' |  Ann'))[column]
      const point = await pointAt(edge, side === 'left' ? 1 : -1)
      await clickAt({ x: side === 'left' ? (cell.left + point.x) / 2 : (point.x + cell.right) / 2, y: point.y })
      await waitForValue(browser, `caret after a click ${side} of the text in column ${column}`, caret, edge)
      const before = (await editorSnapshot()).doc
      await typeKeys(browser, typed)
      const after = `${before.slice(0, edge)}${typed}${before.slice(edge)}`
      await waitForValue(browser, `doc after typing ${typed}`, async () => (await editorSnapshot()).doc === after, true)
    }
    await clickBeside(0, 'right', rowFrom + PADDED_ANN_ROW.indexOf('Ann') + 'Ann'.length, 'ie')
    await clickBeside(1, 'left', rowFrom + PADDED_ANN_ROW.indexOf('10') + 'ie'.length, '+')
    await clickBeside(2, 'left', rowFrom + PADDED_ANN_ROW.indexOf('ok') + 'ie+'.length, 'x')

    const edited = ' |  Annie       |     +10      |         xok |'
    expect(await lineState(edited)).toBe('table')
    const tables = await renderedTables()
    expect(tables[1].map((row) => row.text)).toEqual([PADDED_ROWS[0], PADDED_ROWS[1], edited, PADDED_ROWS[3]])
    expectAlignedColumns(tables[1], 3)
  })

  // A short last row ends left of the table's right edge: its first cell has
  // the table's bottom-left corner, and no cell has the bottom-right one.
  it('rounds no corner inside the table when the last row is short', async () => {
    await openFixture(SHORT_TEXT)
    const corners = await browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .dez-table-row')).find((el) => el.textContent === wanted)
      if (!line) throw new Error(`corners: no rendered row ${wanted}`)
      return Array.from(line.querySelectorAll(':scope > .dez-table-cell')).map((cell) => {
        const style = getComputedStyle(cell)
        return { bottomLeft: style.borderBottomLeftRadius, bottomRight: style.borderBottomRightRadius }
      })
    }, SHORT_ROW)
    expect(corners).toHaveLength(1)
    expect(corners[0].bottomLeft, 'bottom-left radius').not.toBe('0px')
    expect(corners[0].bottomRight, 'bottom-right radius').toBe('0px')
  })

  it('keeps short cells with wide chars on one line next to a long column', async () => {
    await openFixture(WIDE_TEXT)
    // Text and visual line count of each cell in the body row. Text rects
    // from different fonts on one visual line have different tops, so the
    // rects that overlap vertically are one line.
    const cellLines = await browser.execute(() => {
      const row = document.querySelector('.cm-content .dez-table-row--body')
      if (!row) throw new Error('cellLines: no rendered body row')
      return Array.from(row.querySelectorAll(':scope > .dez-table-cell')).map((cell) => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        const lines: Array<{ top: number, bottom: number }> = []
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) continue
          const line = lines.find((box) => rect.top < box.bottom && rect.bottom > box.top)
          if (line) {
            line.top = Math.min(line.top, rect.top)
            line.bottom = Math.max(line.bottom, rect.bottom)
          } else {
            lines.push({ top: rect.top, bottom: rect.bottom })
          }
        }
        return { text: cell.textContent ?? '', lines: lines.length }
      })
    })
    expect(cellLines.slice(0, -1)).toEqual([
      { text: '| ab ', lines: 1 },
      { text: '| 東京都 ', lines: 1 },
      { text: '| ✅ ', lines: 1 },
      { text: '| 🚀 ', lines: 1 },
      { text: '| \tbc ', lines: 1 },
    ])
    expect(cellLines.at(-1)?.lines, 'visual lines of the long cell').toBeGreaterThanOrEqual(2)
  })

  it('draws no selection from above a table into its header row', async () => {
    await openFixture(INTRO_TEXT)
    const introFrom = await docPos(INTRO_LINE)
    const tableFrom = await docPos(HEADER)
    const cells = await rowCellBoxes(HEADER)
    const headerTop = Math.min(...cells.map((cell) => cell.top))
    const headerBottom = Math.max(...cells.map((cell) => cell.bottom))
    // Selection rects that reach into the header row, at any x.
    const headerBandBoxes = async (): Promise<Box[]> =>
      (await visibleSelectionBoxes()).filter((box) => box.top < headerBottom - 0.5 && box.bottom > headerTop + 0.5)
    const selection = async (): Promise<number[]> => {
      const { anchor, head } = await editorSnapshot()
      return [Math.min(anchor, head), Math.max(anchor, head)]
    }

    // A triple-click on the line right above the header selects that line
    // up to the table start. Nothing in the header row is selected.
    const intro = await pointAt(introFrom + 2, 1)
    await clickAt({ x: intro.x + 2, y: intro.y }, 3)
    await waitForValue(browser, 'intro line selection', selection, [introFrom, tableFrom])
    expect(await headerBandBoxes()).toEqual([])

    // Select All (Alt+A on Linux, where Ctrl+A goes to the line start). In
    // the header row, only the selected header cells are drawn, each as one
    // rect over the whole cell.
    await browser.keys([Key.Alt, 'a'])
    const docLength = (await editorSnapshot()).doc.length
    await waitForValue(browser, 'select all', selection, [0, docLength])
    const boxes = await headerBandBoxes()
    expect(boxes).toHaveLength(cells.length)
    boxes.forEach((box, index) => {
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        expect(box[side], `${side} of header cell ${index}`).toBeCloseTo(cells[index][side], 0)
      }
    })
  })

  it('puts the caret at the row start or end for a click in the margin beside a table row', async () => {
    await openFixture(MAIN_TEXT)
    const rowFrom = await docPos(BOB_ROW)
    const rowTo = rowFrom + BOB_ROW.length
    const rowY = (await pointAt(rowFrom + 2, 1)).y
    // Points in the scroller's side margins (its padding), outside
    // `.cm-content`. The right one stays left of the strip at the right
    // edge where WebKitGTK draws its overlay scrollbar.
    const margins = await browser.execute((y: number, scrollbarWidth: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('margins: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const scroller = view.scrollDOM
      const scrollerBox = scroller.getBoundingClientRect()
      const contentBox = view.contentDOM.getBoundingClientRect()
      const scrollbarLeft = scrollerBox.left + scroller.clientLeft + scroller.clientWidth - scrollbarWidth
      const left = { x: (scrollerBox.left + contentBox.left) / 2, y }
      const right = { x: (contentBox.right + scrollbarLeft) / 2, y }
      return {
        left,
        right,
        leftHitsScroller: document.elementFromPoint(left.x, left.y) === scroller,
        rightHitsScroller: right.x > contentBox.right && document.elementFromPoint(right.x, right.y) === scroller,
      }
    }, rowY, OVERLAY_SCROLLBAR_PX)
    expect(margins).toMatchObject({ leftHitsScroller: true, rightHitsScroller: true })

    await clickAt(margins.left)
    await waitForValue(browser, 'caret after a click left of the row', caret, rowFrom)
    await clickAt(margins.right)
    await waitForValue(browser, 'caret after a click right of the row', caret, rowTo)
    expect(await lineState(BOB_ROW)).toBe('table')
  })
})
