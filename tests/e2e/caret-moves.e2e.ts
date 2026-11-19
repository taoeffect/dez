import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, editorCaret, editorDoc, focusEditor, openSeededConversation, setCaret } from './harness/thread'
import { modelListBlock, toolChips } from './harness/toolChips'

// Up and Down in the real editor: on long lines that wrap next to a role
// pill, and through tool chips. A key first moves one visual row in the
// caret's line; with no row left, it goes to the next line that the user
// sees, or across a pill to the nearest row of the next line, at the
// caret's x. A tool chip is one such line, however many doc lines its
// block has. The rules are in `moveCaretByRow`
// (src/view/thread/ThreadEditor.vue). They need layout, which jsdom does
// not have, so only this spec tests them.
//
// One app session serves the whole file, with two conversations. The doc
// lines of the first: 1 `one …`, 2 the agent pill, 3 `two …`, 4 `short`,
// 5 `three …`, 6 the user pill, 7 `four …`. The second (`CHIP_SECTIONS`),
// in a tab of its own after the tests of the first: a user line; a reply
// of the chips a, b, c, d, and e, with a blank line after b, c, d, and e,
// and a line of text; a user line; a reply of the chip f only; and an
// empty user line.

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

/** A visual row of a doc line: where it starts and ends, its top, and the
 *  x of its end. */
interface LineRow {
  from: number
  to: number
  top: number
  endX: number
}

/** Where the caret is: its doc line, the top of its row, its offset in the
 *  line, the line's length, and its x. */
interface CaretPlace {
  line: number
  top: number
  column: number
  length: number
  x: number
  charWidth: number
}

/** A tool chip of the second conversation: its name (the filter of its
 *  call) and the text of its block. */
interface ChipBlock {
  name: string
  block: string
}

function chipBlock (name: string, result: string): ChipBlock {
  return { name, block: modelListBlock(`call_rows_${name}`, name, result) }
}

function resultLines (name: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${name} result ${index + 1}`).join('\n')
}

const LONG_RESULT = JSON.stringify({ id: 'studio/paint', parameters: ['size', 'quality', 'style'], usage: ['text', 'image', 'cost'] }, null, 2)
const CHIPS: ChipBlock[] = [
  chipBlock('a', resultLines('a', 3)),
  chipBlock('b', resultLines('b', 4)),
  chipBlock('c', LONG_RESULT),
  chipBlock('d', resultLines('d', 2)),
  chipBlock('e', resultLines('e', 2)),
  chipBlock('f', resultLines('f', 3)),
]
const [A, B, C, D, E, F] = CHIPS
const ABOVE = 'text above the chips'
const BELOW = 'text below the chips'
const REPLY_END = 'the end of the reply'
const CHIP_SECTIONS: Array<{ role: 'user' | 'agent', text: string }> = [
  { role: 'user', text: ABOVE },
  // The shape of the reply of the bug report: two chips on adjacent lines,
  // a chip with a long result between blank lines, and two chips with a
  // blank line between them. A saved section drops its last blank lines,
  // so a line of text keeps the blank line after the last chip.
  { role: 'agent', text: [A.block, B.block, '', C.block, '', D.block, '', E.block, '', REPLY_END].join('\n') },
  { role: 'user', text: BELOW },
  // A section that ends with a chip.
  { role: 'agent', text: F.block },
  { role: 'user', text: '' },
]
// Far more presses than a walk through every hidden line of the chips takes.
const MAX_PRESSES = 80

/** Where `head` is in `doc`, the doc of the second conversation:
 *  `chip <name>` at an edge of a chip, `in chip <name>` strictly inside one
 *  (in its hidden text), `blank after <name>` on the blank line after a
 *  chip, `blank` on another blank line, else the text of its line. */
function stopName (doc: string, head: number): string {
  for (const { name, block } of CHIPS) {
    const from = doc.indexOf(block)
    const to = from + block.length
    if (head === from || head === to) return `chip ${name}`
    if (from < head && head < to) return `in chip ${name}`
  }
  const lineStart = doc.lastIndexOf('\n', head - 1) + 1
  const lineEnd = doc.indexOf('\n', head)
  const text = doc.slice(lineStart, lineEnd === -1 ? doc.length : lineEnd)
  if (text !== '') return text
  const above = CHIPS.find(({ block }) => doc.indexOf(block) + block.length === lineStart - 1)
  return above ? `blank after ${above.name}` : 'blank'
}

describe('caret moves', () => {
  let app: RunningApp
  let browser: E2EBrowser

  /** The visual rows of doc line `line`, in order. */
  async function lineRows (line: number): Promise<LineRow[]> {
    return browser.execute((lineNumber: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineRows: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { from, to } = view.state.doc.line(lineNumber)
      const starts: Array<{ from: number, top: number }> = []
      let rowTop = -Infinity
      for (let pos = from; pos < to; pos++) {
        const coords = view.coordsAtPos(pos, 1)
        if (!coords) throw new Error(`lineRows: no coords for ${pos}`)
        if (coords.top > rowTop + 1) {
          starts.push({ from: pos, top: coords.top })
          rowTop = coords.top
        }
      }
      return starts.map((start, index) => {
        const end = starts[index + 1]?.from ?? to
        const endCoords = view.coordsAtPos(end, -1)
        if (!endCoords) throw new Error(`lineRows: no coords for the end of the row at ${start.from}`)
        return { ...start, to: end, endX: endCoords.left }
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
      return {
        line: line.number,
        top: caret.top,
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
    // The caret's row: the last one that starts at or above the caret.
    const placeRow = rows.findLastIndex((rowOfLine) => rowOfLine.top <= place.top + 1)
    expect({ line: place.line, row: placeRow }).toEqual({ line, row: rowIndex })
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

  // The second conversation. Each chip is one stop, however many lines its
  // block has, and so is each blank line around the chips: the caret never
  // goes into the hidden text of a block.
  describe('through tool chips', () => {
    /** Presses `key` until the caret is on the line `target`, and gives
     *  the stop of each press (`stopName`). The walk ends early when a
     *  press does not move the caret on in the key's way, or after
     *  `MAX_PRESSES`. */
    async function walk (key: string, target: string): Promise<string[]> {
      const forward = key === Key.ArrowDown
      const doc = await editorDoc(browser)
      const stops: string[] = []
      let last = await editorCaret(browser)
      for (let press = 0; press < MAX_PRESSES && stops.at(-1) !== target; press++) {
        await browser.keys([key])
        const head = await editorCaret(browser)
        if (forward ? head <= last : head >= last) {
          stops.push(`no move on from ${stopName(doc, last)}`)
          break
        }
        stops.push(stopName(doc, head))
        last = head
      }
      return stops
    }

    beforeAll(async () => {
      await openSeededConversation(browser, app.home, 'caret-chips', CHIP_SECTIONS)
      await waitForValue(browser, 'chips', async () => (await toolChips(browser)).length, CHIPS.length)
    })

    // The case of the bug report: Up walked every hidden line of the chips.
    it('moves Up one stop per chip and per blank line', async () => {
      await setCaret(browser, await docPos(browser, BELOW, BELOW.length))
      expect(await walk(Key.ArrowUp, ABOVE)).toEqual([
        REPLY_END, 'blank after e', 'chip e', 'blank after d', 'chip d', 'blank after c', 'chip c', 'blank after b', 'chip b', 'chip a', ABOVE,
      ])
    })

    it('moves Down one stop per chip and per blank line, from across a pill onto the first chip', async () => {
      await setCaret(browser, await docPos(browser, ABOVE, ABOVE.length))
      expect(await walk(Key.ArrowDown, BELOW)).toEqual([
        'chip a', 'chip b', 'blank after b', 'chip c', 'blank after c', 'chip d', 'blank after d', 'chip e', 'blank after e', REPLY_END, BELOW,
      ])
    })

    it('moves Up across a pill onto a chip that ends its section, then on across the next pill', async () => {
      await setCaret(browser, (await editorDoc(browser)).length)
      expect(await walk(Key.ArrowUp, BELOW)).toEqual(['chip f', BELOW])
    })
  })
})
