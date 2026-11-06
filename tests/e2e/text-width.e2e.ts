import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { startMockProviderApp } from './harness/mockProviderApp'
import type { HoldingChatMock, MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { submit } from './harness/thread'

// The thread's text column has no max width: the window decides how wide
// it is. Side gutters (the scroller's padding) grow with the window, and the
// busy indicator's dots line up with the text's left edge at every width.
//
// The widths fit the 1280x800 logical screen of the kwin recipe in
// vitest.e2e.config.ts: the 600 px minimum, the 900 px default, and wider
// than the old 768 px column with its margins.

const PROVIDER: MockProvider = { id: 'width', name: 'Width Mock', modelId: 'width-model', modelName: 'Width Model' }
const WIDTHS = [600, 900, 1240]
const HEIGHT = 700

interface ColumnLayout {
  /** Width of the page, which the editor fills. */
  windowWidth: number
  /** Width of `.cm-content`, where the text is. */
  columnWidth: number
  /** Whether the column fills the scroller's content box (no cap). */
  fillsScroller: boolean
  /** From the scroller's left edge to the column, and from the column to
   *  the right edge of the scroller's padding box. */
  leftGutter: number
  rightGutter: number
  /** The first busy dot's left edge minus the column's left edge, or null
   *  while no busy indicator shows. */
  busyDotOffset: number | null
}

describe('text column width', () => {
  let browser: E2EBrowser
  let mock: HoldingChatMock
  let stopApp: (() => Promise<void>) | undefined

  async function columnLayout (): Promise<ColumnLayout> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('columnLayout: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const scroller = view.scrollDOM
      const style = getComputedStyle(scroller)
      const paddingBoxLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
      const contentBoxWidth = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const column = view.contentDOM.getBoundingClientRect()
      const dot = document.querySelector('.busy-indicator .busy-dot')
      return {
        windowWidth: window.innerWidth,
        columnWidth: column.width,
        fillsScroller: Math.abs(column.width - contentBoxWidth) < 1,
        leftGutter: column.left - paddingBoxLeft,
        rightGutter: paddingBoxLeft + scroller.clientWidth - column.right,
        busyDotOffset: dot ? dot.getBoundingClientRect().left - column.left : null,
      }
    })
  }

  // The window API that the app uses, called in the page.
  async function resizeWindow (width: number): Promise<void> {
    await browser.execute(async (size: { width: number, height: number }) => {
      const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      }
      await internals.invoke('plugin:window|set_size', { label: 'main', value: { Logical: size } })
    }, { width, height: HEIGHT })
    await waitForValue(browser, `page width after a resize to ${width}`, async () => (await columnLayout()).windowWidth, width)
  }

  beforeAll(async () => {
    ({ browser, mock, stop: stopApp } = await startMockProviderApp(PROVIDER))
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await stopApp?.()
  })

  it('fills the window between gutters that grow with it, with the busy dots at the text edge', async () => {
    // A held reply keeps the busy indicator up while the window changes.
    await submit(browser, 'Width question')
    await mock.waitForRequest(browser)
    await waitFor(browser, '.busy-indicator .busy-dot')

    const layouts: ColumnLayout[] = []
    for (const width of WIDTHS) {
      await resizeWindow(width)
      const layout = await columnLayout()
      layouts.push(layout)
      expect(layout.fillsScroller, `column fills the scroller at ${width}`).toBe(true)
      expect(layout.rightGutter, `right gutter at ${width}`).toBeCloseTo(layout.leftGutter, 0)
      expect(layout.busyDotOffset, `busy dot offset at ${width}`).not.toBeNull()
      expect(Math.abs(layout.busyDotOffset as number), `busy dot offset at ${width}`).toBeLessThan(1)
    }
    for (let i = 1; i < layouts.length; i++) {
      expect(layouts[i].columnWidth).toBeGreaterThan(layouts[i - 1].columnWidth)
      expect(layouts[i].leftGutter).toBeGreaterThan(layouts[i - 1].leftGutter)
    }
    // The old column stopped at 768 px.
    expect(layouts[layouts.length - 1].columnWidth).toBeGreaterThan(1000)
  })
})
