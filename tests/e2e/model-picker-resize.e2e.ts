import { Key } from 'webdriverio'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MODEL_PICKER_SIZE_DEFAULT } from '../../src/model/modelPickerSize'
import { PICKER_ROOM_MARGIN_PX } from '../../src/view/model-selector/pickerResize'
import { startApp, type RunningApp } from './harness/app'
import { boxRect, cursorAt, dragHandle, elementAtIs, handlePoint, resizeClasses, viewport } from './harness/boxResize'
import {
  consoleErrors,
  pointerClick,
  pointerClickAt,
  pointerRelease,
  resetConsoleErrors,
  screenshotOnFailure,
  typeKeys,
  waitFor,
  waitForValue,
} from './harness/dom'
import { readAppState, seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { drawnPickerRows, openPicker, pickerOpen, sbpCall, selectedModelName } from './harness/thread'

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

const BOTTOM = '.model-dropdown'

describe('model picker resize', () => {
  let app: RunningApp
  let browser: E2EBrowser
  // The size of the picker at the end of the last drag that the store kept.
  let keptSize = { width: 0, height: 0 }

  const pickerBox = () => boxRect(browser, BOTTOM)

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

    expect(await cursorAt(browser, handlePoint(box, 'top'))).toBe('ns-resize')
    expect(await cursorAt(browser, handlePoint(box, 'right'))).toBe('ew-resize')
    expect(await cursorAt(browser, handlePoint(box, 'corner'))).toBe('nesw-resize')
    // The ends of the strips near the corner belong to the corner.
    expect(await cursorAt(browser, { x: box.right - 5, y: box.top - 3 })).toBe('nesw-resize')
    expect(await cursorAt(browser, { x: box.right + 3, y: box.top + 5 })).toBe('nesw-resize')

    // The handles take nothing of the controls near the edges: the right
    // side of the output filter (the control nearest to the right and
    // corner handles; a point in its rounded corner would hit its parent),
    // and the list with its scrollbar.
    const filterSide = await browser.execute((root: string) => {
      const rect = document.querySelector(`${root} .output-filter-btn`)!.getBoundingClientRect()
      return { x: rect.right - 1, y: rect.top + rect.height / 2 }
    }, BOTTOM)
    expect(await elementAtIs(browser, filterSide, '.output-filter-btn')).toBe(true)
    const inList = await browser.execute((root: string) => {
      const list = document.querySelector(`${root} .model-picker-list`)!.getBoundingClientRect()
      const middle = list.top + list.height / 2
      return [{ x: list.left + list.width / 2, y: middle }, { x: list.right - 1, y: middle }]
    }, BOTTOM)
    for (const point of inList) {
      expect(await elementAtIs(browser, point, `${BOTTOM} .model-picker-list`)).toBe(true)
      expect(await cursorAt(browser, point)).not.toMatch(/resize/)
    }
  })

  it('stays in the window, and is never smaller than the default size', async () => {
    const view = await viewport(browser)
    await dragHandle(browser, BOTTOM, 'top', { to: { x: handlePoint(await pickerBox(), 'top').x, y: 0 } })
    let box = await pickerBox()
    expect(box.top).toBeGreaterThanOrEqual(PICKER_ROOM_MARGIN_PX)
    expect(box.top).toBeLessThan(PICKER_ROOM_MARGIN_PX + 1)

    await dragHandle(browser, BOTTOM, 'right', { to: { x: view.width - 1, y: handlePoint(box, 'right').y } })
    box = await pickerBox()
    expect(box.right).toBeLessThanOrEqual(view.width - PICKER_ROOM_MARGIN_PX)
    expect(box.right).toBeGreaterThan(view.width - PICKER_ROOM_MARGIN_PX - 1)

    await dragHandle(browser, BOTTOM, 'top', { to: { x: handlePoint(box, 'top').x, y: view.height - 1 } })
    await dragHandle(browser, BOTTOM, 'right', { to: { x: 0, y: handlePoint(await pickerBox(), 'right').y } })
    box = await pickerBox()
    expect(box.width).toBeCloseTo(MODEL_PICKER_SIZE_DEFAULT.width, 0)
    expect(box.height).toBeCloseTo(MODEL_PICKER_SIZE_DEFAULT.maxHeight, 0)
  })

  it('grows up by the top edge, to the right by the right edge, and both ways by the corner', async () => {
    const start = await pickerBox()
    await dragHandle(browser, BOTTOM, 'top', { dx: 0, dy: -120 })
    const taller = await pickerBox()
    expect(taller.height).toBeCloseTo(start.height + 120, 0)
    expect(taller.top).toBeCloseTo(start.top - 120, 0)
    expect([taller.left, taller.bottom, taller.width]).toEqual([start.left, start.bottom, start.width])
    await waitForValue(browser, 'rows fill the list', rowsFillList, true)

    await dragHandle(browser, BOTTOM, 'right', { dx: 150, dy: 0 })
    const wider = await pickerBox()
    expect(wider.width).toBeCloseTo(taller.width + 150, 0)
    expect([wider.left, wider.top, wider.bottom]).toEqual([taller.left, taller.top, taller.bottom])

    await dragHandle(browser, BOTTOM, 'corner', { dx: 100, dy: -80 })
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
    await dragHandle(browser, BOTTOM, 'top', { to: off }, false)
    expect(await cursorAt(browser, off)).toBe('ns-resize')
    expect(await resizeClasses(browser)).toEqual(['picker-resizing--top'])
    await pointerRelease(browser)
    expect(await cursorAt(browser, off)).not.toBe('ns-resize')
    expect(await resizeClasses(browser)).toEqual([])
    // A release out of the picker does not close it.
    expect(await pickerOpen(browser)).toBe(true)
    const released = await pickerBox()
    keptSize = { width: released.width, height: released.height }

    // Escape closes the picker during a held drag, and the drag saves
    // nothing.
    const right = handlePoint(released, 'right')
    await dragHandle(browser, BOTTOM, 'right', { dx: 60, dy: 0 }, false)
    expect((await pickerBox()).width).toBeCloseTo(released.width + 60, 0)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => pickerOpen(browser), false)
    expect(await resizeClasses(browser)).toEqual([])
    expect(await cursorAt(browser, { x: right.x + 60, y: right.y })).not.toMatch(/resize/)
    await pointerRelease(browser)

    await openPicker(browser)
    const reopened = await pickerBox()
    expect([reopened.width, reopened.height]).toEqual([released.width, released.height])
  })

  it('keeps the focus in the search field after a drag, and a click still picks a model', async () => {
    await dragHandle(browser, BOTTOM, 'right', { dx: 40, dy: 0 })
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
    await waitForValue(browser, 'selected model', () => selectedModelName(browser), 'Model 0150')
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
    expect(await browser.execute(() => document.querySelectorAll('.picker-handle').length)).toBe(0)
    await sbpCall(browser, 'dez.model/settings/close')
  })
})
