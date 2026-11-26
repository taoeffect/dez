import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MODEL_SETTINGS_SIZE_DEFAULT } from '../../src/model/modelSettingsSize'
import { PICKER_ROOM_MARGIN_PX } from '../../src/view/model-selector/pickerResize'
import { APIMART_CONFIG, MART, MODELS_PATH, MODEL_LIST, SUNO } from './harness/apimartMock'
import { boxRect, cursorAt, dragHandle, elementAtIs, handlePoint, viewport, type Box } from './harness/boxResize'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue, withSmallerWindow } from './harness/dom'
import { readAppState, readModelCache } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { closePopup, openPopup, popupOpen, popupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { pickModel } from './harness/thread'

// The settings panel of the gear in the bottom bar
// (`ProviderSettingsPopup.vue`): the width of its longest label, a scroll
// body under the room of the window or the user's height limit, and the
// resize of the model picker (`pickerResize.ts`). Suno of a mock APIMart
// provider gives many rows with long labels and a long hint; MiniMax-H3,
// the model at the start, has short labels. No test reads a label text.
// One app session serves the file; the tests run in order, and each one
// starts where the one before it ends.

const PANEL = '.provider-settings-popup'
// A page height under the height of the Suno panel.
const SHORT_PAGE_HEIGHT = 420

describe('model settings panel resize', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The Suno panel with no height limit of the user, in the normal window.
  let fullHeight = 0
  // The size of the panel at the end of the last drag.
  let keptSize = { width: 0, height: 0 }

  const panelBox = (): Promise<Box> => boxRect(browser, PANEL)

  // The labels of the open panel: how many are cut, and the width that
  // shows the longest one in full (the panel's width less the room that the
  // tightest label has to spare). A label's `scrollWidth` is never under
  // its `clientWidth`, so the text's own width comes from a range.
  async function labelFit (): Promise<{ cut: number, fittedWidth: number }> {
    return browser.execute((sel: string) => {
      const panel = document.querySelector(sel)!
      const labels = Array.from(panel.querySelectorAll('.provider-settings-label'))
      const spare = labels.map((label) => {
        const range = document.createRange()
        range.selectNodeContents(label.firstChild!)
        return label.getBoundingClientRect().width - range.getBoundingClientRect().width
      })
      return {
        cut: labels.filter((label) => label.scrollWidth > label.clientWidth).length,
        fittedWidth: panel.getBoundingClientRect().width - Math.min(...spare),
      }
    }, PANEL)
  }

  async function bodyScrolls (): Promise<boolean> {
    return browser.execute(() => {
      const body = document.querySelector('.provider-settings-body')!
      return body.scrollHeight > body.clientHeight
    })
  }

  // Opens the panel and waits for the rows of the model.
  async function openRows (): Promise<void> {
    await openPopup(browser)
    await waitForValue(browser, 'rows of the model', async () => (await popupView(browser)).rows.length > 0, true)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(MART, APIMART_CONFIG, { jsonAnswers: { [MODELS_PATH]: MODEL_LIST } })
    browser = setup.browser
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (await popupOpen(browser)) await closePopup(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('is as wide as its longest label, and keeps the default width for short labels', async () => {
    await openRows()
    expect((await panelBox()).width).toBeCloseTo(MODEL_SETTINGS_SIZE_DEFAULT.width, 0)
    expect((await labelFit()).cut).toBe(0)
    await closePopup(browser)

    await pickModel(browser, MART.name, SUNO.name)
    await openRows()
    const box = await panelBox()
    const fit = await labelFit()
    expect(fit.cut).toBe(0)
    expect(Math.abs(box.width - Math.max(MODEL_SETTINGS_SIZE_DEFAULT.width, fit.fittedWidth))).toBeLessThanOrEqual(1)
    // The hint wraps: it gives the panel no width.
    const hintLine = await browser.execute(() => {
      const copy = document.querySelector('.provider-settings-hint')!.cloneNode(true) as HTMLElement
      copy.style.cssText = 'position: absolute; visibility: hidden; width: max-content; min-width: 0; white-space: nowrap'
      document.body.append(copy)
      const width = copy.getBoundingClientRect().width
      copy.remove()
      return width
    })
    expect(box.width).toBeLessThan(hintLine / 2)
    fullHeight = box.height
  })

  it('fits a short window, scrolls its rows, and keeps the Reset button in view', async () => {
    const page = await viewport(browser)
    await withSmallerWindow(browser, (size) => ({ width: size.width, height: size.height - (page.height - SHORT_PAGE_HEIGHT) }), async () => {
      await openRows()
      const box = await panelBox()
      expect(box.top).toBeGreaterThanOrEqual(PICKER_ROOM_MARGIN_PX)
      expect(box.top).toBeLessThan(PICKER_ROOM_MARGIN_PX + 1)
      expect(await bodyScrolls()).toBe(true)

      const reset = await browser.execute(() => {
        const rect = document.querySelector('.provider-settings-reset')!.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })
      expect(await elementAtIs(browser, reset, '.provider-settings-reset')).toBe(true)

      const lastRow = await browser.execute(() => {
        const body = document.querySelector('.provider-settings-body')!
        body.scrollTop = body.scrollHeight
        const rows = body.querySelectorAll<HTMLElement>('[data-parameter]')
        const row = rows[rows.length - 1]
        const rect = row.getBoundingClientRect()
        return { name: row.dataset.parameter ?? '', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })
      expect(await elementAtIs(browser, lastRow, `[data-parameter="${lastRow.name}"]`)).toBe(true)
      await closePopup(browser)
    })
    await openRows()
    expect((await panelBox()).height).toBeCloseTo(fullHeight, 0)
  })

  it('resizes by its top edge, its right edge, and its top right corner, and stays in the window', async () => {
    await openRows()
    const start = await panelBox()
    expect(await cursorAt(browser, handlePoint(start, 'top'))).toBe('ns-resize')
    expect(await cursorAt(browser, handlePoint(start, 'right'))).toBe('ew-resize')
    expect(await cursorAt(browser, handlePoint(start, 'corner'))).toBe('nesw-resize')
    // The handles take nothing of the scroll body. The probe is the last
    // whole pixel of the body: the panel is as wide as its longest label,
    // so its edge can fall between two pixels, and WebKit gives a pixel
    // that a handle covers in part to the handle.
    const bodySide = await browser.execute(() => {
      const rect = document.querySelector('.provider-settings-body')!.getBoundingClientRect()
      return { x: Math.floor(rect.right) - 1, y: rect.top + rect.height / 2 }
    })
    expect(await elementAtIs(browser, bodySide, '.provider-settings-body')).toBe(true)
    expect(await cursorAt(browser, bodySide)).not.toMatch(/resize/)

    await dragHandle(browser, PANEL, 'top', { dx: 0, dy: 150 })
    const shorter = await panelBox()
    expect(shorter.height).toBeCloseTo(start.height - 150, 0)
    expect([shorter.left, shorter.bottom, shorter.width]).toEqual([start.left, start.bottom, start.width])
    expect(await bodyScrolls()).toBe(true)

    // The release is out of the panel, which stays open.
    await dragHandle(browser, PANEL, 'right', { dx: 60, dy: 0 })
    expect(await popupOpen(browser)).toBe(true)
    const wider = await panelBox()
    expect(wider.width).toBeCloseTo(shorter.width + 60, 0)
    expect([wider.left, wider.top, wider.bottom]).toEqual([shorter.left, shorter.top, shorter.bottom])

    await dragHandle(browser, PANEL, 'corner', { dx: 40, dy: -50 })
    const larger = await panelBox()
    expect(larger.width).toBeCloseTo(wider.width + 40, 0)
    expect(larger.height).toBeCloseTo(wider.height + 50, 0)
    expect([larger.left, larger.bottom]).toEqual([wider.left, wider.bottom])

    const view = await viewport(browser)
    await dragHandle(browser, PANEL, 'right', { to: { x: view.width - 1, y: handlePoint(larger, 'right').y } })
    const widest = await panelBox()
    expect(widest.right).toBeLessThanOrEqual(view.width - PICKER_ROOM_MARGIN_PX)
    expect(widest.right).toBeGreaterThan(view.width - PICKER_ROOM_MARGIN_PX - 1)
    keptSize = { width: widest.width, height: widest.height }
  })

  it('keeps the size in app_state.json, in the next panel, and after a restart', async () => {
    await waitForValue(browser, 'saved size', async () => (await readAppState(setup.app.home))?.modelSettingsSize,
      { width: keptSize.width, maxHeight: keptSize.height })
    await openRows()
    expect(await panelBox()).toMatchObject(keptSize)
    await closePopup(browser)

    await waitForValue(browser, 'Suno in model_cache.json', async () =>
      (await readModelCache(setup.app.home))?.providers[MART.id]?.models.some((model) => model.id === SUNO.id) ?? false, true)
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)
    await pickModel(browser, MART.name, SUNO.name)
    await openRows()
    expect(await panelBox()).toMatchObject(keptSize)
  })

  it('gets the default size back by a drag to the left end and to the top of the window', async () => {
    await openRows()
    await dragHandle(browser, PANEL, 'right', { to: { x: 0, y: handlePoint(await panelBox(), 'right').y } })
    await dragHandle(browser, PANEL, 'top', { to: { x: handlePoint(await panelBox(), 'top').x, y: 0 } })
    await waitForValue(browser, 'saved size', async () => (await readAppState(setup.app.home))?.modelSettingsSize,
      { width: MODEL_SETTINGS_SIZE_DEFAULT.width, maxHeight: null })
    const box = await panelBox()
    const fit = await labelFit()
    expect(fit.cut).toBe(0)
    expect(Math.abs(box.width - Math.max(MODEL_SETTINGS_SIZE_DEFAULT.width, fit.fittedWidth))).toBeLessThanOrEqual(1)
    expect(box.height).toBeCloseTo(fullHeight, 0)
  })
})
