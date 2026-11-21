import { Key } from 'webdriverio'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import {
  consoleErrors,
  pointerClick,
  pointerClickAt,
  pointerDrag,
  pointerRelease,
  resetConsoleErrors,
  screenshotOnFailure,
  typeKeys,
  waitFor,
  waitForValue,
  type Point,
} from './harness/dom'
import { readAppState, seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { drawnPickerRows, openPicker, pickerOpen, sbpCall } from './harness/thread'

// The resize of the model picker of the bottom bar (`pickerResize.ts`): a
// drag of its top edge, its right edge, or its top right corner, with a
// resize cursor on each. A custom provider with `fetchModels: false` gives
// a list that is taller than the window, so the picker is always as tall as
// its height limit; no request goes to its server. One app session serves
// the file; the tests run in order, and each one starts where the one
// before it ends.

const PROVIDER = 'Mock'
const MODELS = Array.from({ length: 200 }, (_, index) => `Model ${String(index + 1).padStart(4, '0')}`)
const SEEDED_SIZE = { width: 480, maxHeight: 420 }
const DEFAULT_SIZE = { width: 320, maxHeight: 360 }
// `PICKER_ROOM_MARGIN_PX`: the picker stays this far from the window's top
// and right edges.
const ROOM_MARGIN = 8

const BOTTOM = '.model-dropdown'

type Edge = 'top' | 'right' | 'corner'

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

describe('model picker resize', () => {
  let app: RunningApp
  let browser: E2EBrowser
  // The size of the picker at the end of the last drag that the store kept.
  let keptSize = { width: 0, height: 0 }

  async function pickerBox (selector = BOTTOM): Promise<Box> {
    return browser.execute((sel: string) => {
      const element = document.querySelector(sel)
      if (!element) throw new Error(`pickerBox: no ${sel}`)
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
      return { left, top, right, bottom, width, height }
    }, selector)
  }

  // A point on each handle: the middle of the strip on the top edge and of
  // the one on the right edge, each 3 px out of the border, and the corner
  // of the border.
  function handlePoint (box: Box, edge: Edge): Point {
    if (edge === 'top') return { x: box.left + box.width / 2, y: box.top - 3 }
    if (edge === 'right') return { x: box.right + 3, y: box.top + box.height / 2 }
    return { x: box.right, y: box.top }
  }

  async function cursorAt (point: Point): Promise<string> {
    return browser.execute((x: number, y: number) => {
      const element = document.elementFromPoint(x, y)
      return element ? getComputedStyle(element).cursor : 'no element'
    }, Math.round(point.x), Math.round(point.y))
  }

  // Whether the element at `point` is in an element that matches `selector`.
  async function elementAtIs (point: Point, selector: string): Promise<boolean> {
    return browser.execute((x: number, y: number, sel: string) =>
      document.elementFromPoint(x, y)?.closest(sel) != null, Math.round(point.x), Math.round(point.y), selector)
  }

  async function viewport (): Promise<{ width: number, height: number }> {
    return browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }))
  }

  // Drags the handle of `edge` by (dx, dy), or to the viewport point `to`.
  async function dragHandle (edge: Edge, move: { dx: number, dy: number } | { to: Point }, release = true): Promise<void> {
    const from = handlePoint(await pickerBox(), edge)
    const to = 'to' in move ? move.to : { x: from.x + move.dx, y: from.y + move.dy }
    await pointerDrag(browser, from, Math.round(to.x), { toY: Math.round(to.y), release })
  }

  // The classes of `<html>` that a running resize sets.
  async function resizeClasses (): Promise<string[]> {
    return browser.execute(() => [...document.documentElement.classList].filter((name) => name.startsWith('picker-resizing')))
  }

  // Whether the drawn rows reach the bottom of the list's visible part: a
  // larger picker shows more rows, with no empty space under them.
  async function rowsFillList (): Promise<boolean> {
    return browser.execute((root: string) => {
      const list = document.querySelector(`${root} .model-picker-list`)
      const rows = list?.querySelectorAll('.model-item')
      if (!list || !rows?.length) return false
      return rows[rows.length - 1].getBoundingClientRect().bottom >= list.getBoundingClientRect().bottom
    }, BOTTOM)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedRawAppState(app.home, {
        customProviders: [
          {
            id: 'mock',
            name: PROVIDER,
            baseUrl: 'http://127.0.0.1:9/v1',
            fetchModels: false,
            models: MODELS.map((name) => ({ id: name.toLowerCase().replace(' ', '-'), name })),
          },
        ],
        modelPickerSize: SEEDED_SIZE,
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

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

  it('opens at the kept size, with a resize cursor on each handle and none on the controls', async () => {
    await openPicker(browser)
    const box = await pickerBox()
    expect(box.width).toBeCloseTo(SEEDED_SIZE.width, 0)
    expect(box.height).toBeCloseTo(SEEDED_SIZE.maxHeight, 0)

    expect(await cursorAt(handlePoint(box, 'top'))).toBe('ns-resize')
    expect(await cursorAt(handlePoint(box, 'right'))).toBe('ew-resize')
    expect(await cursorAt(handlePoint(box, 'corner'))).toBe('nesw-resize')
    // The ends of the strips near the corner belong to the corner.
    expect(await cursorAt({ x: box.right - 5, y: box.top - 3 })).toBe('nesw-resize')
    expect(await cursorAt({ x: box.right + 3, y: box.top + 5 })).toBe('nesw-resize')

    // The handles take nothing of the controls near the edges: the right
    // side of the output filter (the control nearest to the right and
    // corner handles; a point in its rounded corner would hit its parent),
    // and the list with its scrollbar.
    const filterSide = await browser.execute((root: string) => {
      const rect = document.querySelector(`${root} .output-filter-btn`)!.getBoundingClientRect()
      return { x: rect.right - 1, y: rect.top + rect.height / 2 }
    }, BOTTOM)
    expect(await elementAtIs(filterSide, '.output-filter-btn')).toBe(true)
    const inList = await browser.execute((root: string) => {
      const list = document.querySelector(`${root} .model-picker-list`)!.getBoundingClientRect()
      const middle = list.top + list.height / 2
      return [{ x: list.left + list.width / 2, y: middle }, { x: list.right - 1, y: middle }]
    }, BOTTOM)
    for (const point of inList) {
      expect(await elementAtIs(point, `${BOTTOM} .model-picker-list`)).toBe(true)
      expect(await cursorAt(point)).not.toMatch(/resize/)
    }
  })

  it('stays in the window, and is never smaller than the default size', async () => {
    const view = await viewport()
    await dragHandle('top', { to: { x: handlePoint(await pickerBox(), 'top').x, y: 0 } })
    let box = await pickerBox()
    expect(box.top).toBeGreaterThanOrEqual(ROOM_MARGIN)
    expect(box.top).toBeLessThan(ROOM_MARGIN + 1)

    await dragHandle('right', { to: { x: view.width - 1, y: handlePoint(box, 'right').y } })
    box = await pickerBox()
    expect(box.right).toBeLessThanOrEqual(view.width - ROOM_MARGIN)
    expect(box.right).toBeGreaterThan(view.width - ROOM_MARGIN - 1)

    await dragHandle('top', { to: { x: handlePoint(box, 'top').x, y: view.height - 1 } })
    await dragHandle('right', { to: { x: 0, y: handlePoint(await pickerBox(), 'right').y } })
    box = await pickerBox()
    expect(box.width).toBeCloseTo(DEFAULT_SIZE.width, 0)
    expect(box.height).toBeCloseTo(DEFAULT_SIZE.maxHeight, 0)
  })

  it('grows up by the top edge, to the right by the right edge, and both ways by the corner', async () => {
    const start = await pickerBox()
    await dragHandle('top', { dx: 0, dy: -120 })
    const taller = await pickerBox()
    expect(taller.height).toBeCloseTo(start.height + 120, 0)
    expect(taller.top).toBeCloseTo(start.top - 120, 0)
    expect([taller.left, taller.bottom, taller.width]).toEqual([start.left, start.bottom, start.width])
    await waitForValue(browser, 'rows fill the list', rowsFillList, true)

    await dragHandle('right', { dx: 150, dy: 0 })
    const wider = await pickerBox()
    expect(wider.width).toBeCloseTo(taller.width + 150, 0)
    expect([wider.left, wider.top, wider.bottom]).toEqual([taller.left, taller.top, taller.bottom])

    await dragHandle('corner', { dx: 100, dy: -80 })
    const larger = await pickerBox()
    expect(larger.width).toBeCloseTo(wider.width + 100, 0)
    expect(larger.height).toBeCloseTo(wider.height + 80, 0)
    expect([larger.left, larger.bottom]).toEqual([wider.left, wider.bottom])
    await waitForValue(browser, 'rows fill the list', rowsFillList, true)

    // A drag over the text of the page selects none of it.
    expect(await browser.execute(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)
  })

  it('keeps the resize cursor for the whole drag, and Escape ends a held drag with no cursor left', async () => {
    // Past the room, off the strip: the cursor stays.
    const top = handlePoint(await pickerBox(), 'top')
    const off = { x: top.x, y: 0 }
    await dragHandle('top', { to: off }, false)
    expect(await cursorAt(off)).toBe('ns-resize')
    expect(await resizeClasses()).toEqual(['picker-resizing--top'])
    await pointerRelease(browser)
    expect(await cursorAt(off)).not.toBe('ns-resize')
    expect(await resizeClasses()).toEqual([])
    // A release out of the picker does not close it.
    expect(await pickerOpen(browser)).toBe(true)
    const released = await pickerBox()
    keptSize = { width: released.width, height: released.height }

    // Escape closes the picker during a held drag, and the drag saves
    // nothing.
    const right = handlePoint(released, 'right')
    await dragHandle('right', { dx: 60, dy: 0 }, false)
    expect((await pickerBox()).width).toBeCloseTo(released.width + 60, 0)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => pickerOpen(browser), false)
    expect(await resizeClasses()).toEqual([])
    expect(await cursorAt({ x: right.x + 60, y: right.y })).not.toMatch(/resize/)
    await pointerRelease(browser)

    await openPicker(browser)
    const reopened = await pickerBox()
    expect([reopened.width, reopened.height]).toEqual([released.width, released.height])
  })

  it('keeps the focus in the search field after a drag, and a click still picks a model', async () => {
    await dragHandle('right', { dx: 40, dy: 0 })
    const box = await pickerBox()
    keptSize = { width: box.width, height: box.height }
    expect(await pickerOpen(browser)).toBe(true)
    expect(await browser.execute(() => document.activeElement?.classList.contains('model-picker-input') ?? false)).toBe(true)

    await typeKeys(browser, '0150')
    await waitForValue(browser, 'matches of 0150', async () => (await drawnPickerRows(browser)).map((row) => row.text), [PROVIDER, 'Model 0150'])
    const row = await browser.execute((root: string) => {
      const rect = document.querySelector(`${root} .model-item`)!.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, BOTTOM)
    await pointerClickAt(browser, row)
    await waitForValue(browser, 'selected model', () => browser.execute(
      () => document.querySelector('.model-selector-label')?.textContent?.trim() ?? null
    ), 'Model 0150')
    expect(await pickerOpen(browser)).toBe(false)
  })

  it('keeps the size in app_state.json and in the next picker', async () => {
    await waitForValue(browser, 'saved size', async () => (await readAppState(app.home))?.modelPickerSize,
      { width: keptSize.width, maxHeight: keptSize.height })
    await openPicker(browser)
    const box = await pickerBox()
    expect([box.width, box.height]).toEqual([keptSize.width, keptSize.height])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => pickerOpen(browser), false)
  })

  it('gives the picker of Settings no handles', async () => {
    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-model-trigger')
    await pointerClick(browser, '.settings-model-trigger')
    await waitFor(browser, '.settings-model-dropdown')
    expect(await browser.execute(() => document.querySelectorAll('.model-dropdown-handle').length)).toBe(0)
    await sbpCall(browser, 'dez.model/settings/close')
  })
})
