import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, openSeededConversation, setCaret } from './harness/thread'

// Up and Down in the real editor, on long lines that wrap next to a role
// pill. A key first moves one visual row in the caret's line; with no row
// left, it goes across a pill to the nearest row of the next line, at the
// caret's x. The rules are in `moveCaretByRow`
// (src/view/thread/ThreadEditor.vue). They need layout, which jsdom does
// not have, so only this spec tests them.
//
// One app session and one conversation serve the whole file. The doc lines
// of the conversation: 1 `one …`, 2 the agent pill, 3 `two …`, 4 `short`,
// 5 `three …`, 6 the user pill, 7 `four …`.

/** A line long enough to wrap to three rows or more in the e2e window. */
function wrapped (word: string): string {
  return Array.from({ length: 12 }, () => `${word} lorem ipsum dolor sit amet`).join(' ')
}

const SECTIONS: Array<{ role: 'user' | 'agent', text: string }> = [
  { role: 'user', text: wrapped('one') },
  { role: 'agent', text: `${wrapped('two')}\nshort\n${wrapped('three')}` },
  { role: 'user', text: wrapped('four') },
]
const ONE = 1
const TWO = 3
const SHORT = 4
const THREE = 5
const FOUR = 7
// Where in its row the caret starts: far enough from the row start that a
// move at the caret's x is not a move to a line start. A row that is
// shorter puts the caret before its last char.
const ROW_OFFSET = 30

/** Where the caret is: its doc line, its visual row in that line (0 is the
 *  first row), its offset in the line, the line's length, and its x. */
interface CaretPlace {
  line: number
  row: number
  column: number
  length: number
  x: number
  charWidth: number
}

describe('caret moves', () => {
  let app: RunningApp
  let browser: E2EBrowser

  /** The visual rows of doc line `line`: where each starts and ends, and
   *  the x of its end. */
  async function lineRows (line: number): Promise<Array<{ from: number, to: number, endX: number }>> {
    return browser.execute((lineNumber: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineRows: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { from, to } = view.state.doc.line(lineNumber)
      const starts: number[] = []
      let rowTop = -Infinity
      for (let pos = from; pos < to; pos++) {
        const coords = view.coordsAtPos(pos, 1)
        if (!coords) throw new Error(`lineRows: no coords for ${pos}`)
        if (coords.top > rowTop + 1) {
          starts.push(pos)
          rowTop = coords.top
        }
      }
      return starts.map((start, index) => {
        const end = starts[index + 1] ?? to
        const endCoords = view.coordsAtPos(end, -1)
        if (!endCoords) throw new Error(`lineRows: no coords for the end of the row at ${start}`)
        return { from: start, to: end, endX: endCoords.left }
      })
    }, line)
  }

  async function caretPlace (): Promise<CaretPlace> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('caretPlace: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { head, assoc } = view.state.selection.main
      const line = view.state.doc.lineAt(head)
      // The side that CodeMirror draws the caret on.
      const caret = view.coordsAtPos(head, assoc || 1)
      if (!caret) throw new Error(`caretPlace: no coords for ${head}`)
      let row = 0
      let rowTop = -Infinity
      for (let pos = line.from; pos < line.to; pos++) {
        const coords = view.coordsAtPos(pos, 1)
        if (!coords) throw new Error(`caretPlace: no coords for ${pos}`)
        if (coords.top > rowTop + 1) {
          if (rowTop > -Infinity && coords.top <= caret.top + 1) row++
          rowTop = coords.top
        }
      }
      return {
        line: line.number,
        row,
        column: head - line.from,
        length: line.length,
        x: caret.left,
        charWidth: view.defaultCharacterWidth,
      }
    })
  }

  /** Puts the caret `ROW_OFFSET` chars into visual row `row` of doc line
   *  `line` (a negative row counts from the last), and gives its place. */
  async function caretOnRow (line: number, row: number): Promise<CaretPlace> {
    const start = (await lineRows(line)).at(row)
    if (!start) throw new Error(`caretOnRow: line ${line} has no row ${row}`)
    await setCaret(browser, Math.min(start.from + ROW_OFFSET, start.to - 1))
    return caretPlace()
  }

  /** Presses `key` and expects the caret on `row` of `line` (a negative
   *  row counts from the last), at the x of `start`, or at the end of a
   *  row that ends before that x. */
  async function pressTo (key: string, line: number, row: number, start: CaretPlace): Promise<void> {
    await browser.keys([key])
    const rows = await lineRows(line)
    const place = await caretPlace()
    const rowIndex = row < 0 ? rows.length + row : row
    expect({ line: place.line, row: place.row }).toEqual({ line, row: rowIndex })
    // The caret goes to the char edge nearest to the x.
    expect(Math.abs(place.x - Math.min(start.x, rows[rowIndex].endX))).toBeLessThan(place.charWidth)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await openSeededConversation(browser, app.home, 'caret-moves', SECTIONS)
    for (const line of [ONE, TWO, THREE, FOUR]) {
      expect((await lineRows(line)).length, `rows of line ${line}`).toBeGreaterThanOrEqual(3)
    }
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await focusEditor(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    if (browser) await destroySession(browser)
    await app?.stop()
  })

  // The case of the bug report: Up jumped across the pill.
  it('moves Up one row inside the first line of a section', async () => {
    const start = await caretOnRow(FOUR, 1)
    await pressTo(Key.ArrowUp, FOUR, 0, start)
  })

  it('moves Down one row inside the last line of a section', async () => {
    const start = await caretOnRow(THREE, 0)
    await pressTo(Key.ArrowDown, THREE, 1, start)
  })

  it('moves Up across a pill to the last row of the line above, at the same x', async () => {
    const start = await caretOnRow(FOUR, 0)
    await pressTo(Key.ArrowUp, THREE, -1, start)
  })

  it('moves Down across a pill to the first row of the line below, at the same x', async () => {
    const start = await caretOnRow(THREE, -1)
    await pressTo(Key.ArrowDown, FOUR, 0, start)
  })

  it('keeps the x of a run of presses across a short line and a pill', async () => {
    const start = await caretOnRow(THREE, 0)
    await browser.keys([Key.ArrowUp])
    expect(await caretPlace()).toMatchObject({ line: SHORT, column: 'short'.length })
    await pressTo(Key.ArrowUp, TWO, -1, start)
    const rows = (await lineRows(TWO)).length
    for (let row = rows - 2; row >= 0; row--) await pressTo(Key.ArrowUp, TWO, row, start)
    await pressTo(Key.ArrowUp, ONE, -1, start)
    await pressTo(Key.ArrowDown, TWO, 0, start)
  })

  it('moves one row at the doc edges, then to the start or the end of the line', async () => {
    const top = await caretOnRow(ONE, 1)
    await pressTo(Key.ArrowUp, ONE, 0, top)
    await browser.keys([Key.ArrowUp])
    expect(await caretPlace()).toMatchObject({ line: ONE, column: 0 })

    const bottom = await caretOnRow(FOUR, 0)
    await pressTo(Key.ArrowDown, FOUR, 1, bottom)
    await caretOnRow(FOUR, -1)
    await browser.keys([Key.ArrowDown])
    const end = await caretPlace()
    expect(end).toMatchObject({ line: FOUR, column: end.length })
  })
})
