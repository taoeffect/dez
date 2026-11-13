import { Key } from 'webdriverio'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, isOnTop, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, typeInto, waitFor, waitForValue, type Point } from './harness/dom'
import { seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { drawnPickerRows, openPicker, pickerGroups, pickerOpen, sbpCall } from './harness/thread'

// The virtual list of the model pickers, driven through the real app. A
// custom provider with `fetchModels: false` gives 1000 config models, and a
// second one gives the last group of the list. No request goes to their
// servers.
//
// The picker draws only the rows near the visible part of its list. The
// tests check that, and that the list still works as one long list: the
// scroll reaches every row, and the search, the Favorites group, and a
// click on a far row work at any scroll position. One app session serves
// the file; the tests run in order, and each one starts where the one
// before it ends.

const BIG = 'Big Mock'
const SMALL = 'Small Mock'
const SMALL_MODEL = 'Small Model'
const BIG_MODELS = Array.from({ length: 1000 }, (_, index) => `Model ${String(index + 1).padStart(4, '0')}`)
const ALL_GROUPS = [
  { provider: BIG, models: BIG_MODELS },
  { provider: SMALL, models: [SMALL_MODEL] },
]
// The text of each row of the full list with no favorite, top to bottom.
const ROW_TEXTS = [BIG, ...BIG_MODELS, SMALL, SMALL_MODEL]
// More rows than the DOM holds at a time: about 10 rows are in view, and
// the virtual list keeps some more drawn above and below them.
const MAX_DRAWN_ROWS = 50
const NONE_LABEL = 'None (use last used)'

const BOTTOM = '.model-dropdown'
const SETTINGS = '.settings-model-dropdown'

describe('model picker virtual list', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // The text of each row that the DOM holds, top to bottom.
  async function drawnTexts (root = BOTTOM): Promise<string[]> {
    return (await drawnPickerRows(browser, root)).map((row) => row.text)
  }

  // Scrolls the list to `fraction` of its scroll range: 0 is the top, 1 the
  // end.
  async function scrollList (fraction: number, root = BOTTOM): Promise<void> {
    await browser.execute((rootSelector: string, part: number) => {
      const list = document.querySelector(`${rootSelector} .model-picker-list`)
      if (!list) throw new Error(`scrollList: no list in ${rootSelector}`)
      list.scrollTop = part * (list.scrollHeight - list.clientHeight)
    }, root, fraction)
  }

  // The id of the model `name` of the two providers.
  function modelId (name: string): string {
    return name.toLowerCase().replace(' ', '-')
  }

  // The first drawn row of the model `name`, found by the tooltip of its
  // name: the model id, then the name. It is in view when `isOnTop` holds
  // for it: a click at its center goes to it.
  function modelRow (name: string, root = BOTTOM): string {
    return `${root} .model-item:has(.model-item-name[title="${modelId(name)} (${name})"])`
  }

  // The model row at the middle of the list's visible part: its name and
  // its center.
  async function middleRow (root = BOTTOM): Promise<{ name: string, center: Point }> {
    // Wait until the list has drawn the rows of its scroll position.
    await drawnPickerRows(browser, root)
    return browser.execute((rootSelector: string) => {
      const list = document.querySelector(`${rootSelector} .model-picker-list`)
      if (!list) throw new Error(`middleRow: no list in ${rootSelector}`)
      const listRect = list.getBoundingClientRect()
      const middle = listRect.top + listRect.height / 2
      for (const row of list.querySelectorAll('.model-item')) {
        const rect = row.getBoundingClientRect()
        if (rect.top <= middle && middle < rect.bottom) {
          return {
            name: row.querySelector('.model-item-name')?.textContent?.trim() ?? '',
            center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          }
        }
      }
      throw new Error(`middleRow: no model row at the middle of ${rootSelector}`)
    }, root)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedRawAppState(app.home, {
        customProviders: [
          {
            id: 'big',
            name: BIG,
            baseUrl: 'http://127.0.0.1:9/v1',
            fetchModels: false,
            models: BIG_MODELS.map((name) => ({ id: modelId(name), name })),
          },
          {
            id: 'small',
            name: SMALL,
            baseUrl: 'http://127.0.0.1:9/v1',
            fetchModels: false,
            models: [{ id: modelId(SMALL_MODEL), name: SMALL_MODEL }],
          },
        ],
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

  it('draws only the first rows of a long list, in a list as long as all its rows', async () => {
    await openPicker(browser)
    await waitForValue(browser, 'first rows', async () => (await drawnTexts()).slice(0, 2), [BIG, BIG_MODELS[0]])
    const drawn = await drawnTexts()
    expect(drawn.length).toBeLessThan(MAX_DRAWN_ROWS)
    expect(drawn).toEqual(ROW_TEXTS.slice(0, drawn.length))

    // The scroll range stands for all rows, so the scroll bar shows the
    // length of the list. The heights of rows not yet drawn are estimates,
    // so the check is loose.
    const sizes = await browser.execute((root: string) => {
      const list = document.querySelector(`${root} .model-picker-list`)!
      const dropdown = document.querySelector(root)!.getBoundingClientRect()
      return {
        scrollHeight: list.scrollHeight,
        rowHeight: list.querySelector('.model-item')!.getBoundingClientRect().height,
        dropdownTop: dropdown.top,
        dropdownHeight: dropdown.height,
      }
    }, BOTTOM)
    expect(sizes.scrollHeight).toBeGreaterThan(900 * sizes.rowHeight)
    // The dropdown is as tall as its limit lets it be, and stays in the
    // window.
    expect(sizes.dropdownHeight).toBeCloseTo(360, 0)
    expect(sizes.dropdownTop).toBeGreaterThanOrEqual(0)
  })

  it('reaches every row, in order, with the scroll', async () => {
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)
    // `pickerGroups` puts the list back at the top.
    const drawn = await drawnTexts()
    expect(drawn).toEqual(ROW_TEXTS.slice(0, drawn.length))
  })

  it('shows the last rows after a scroll to the end', async () => {
    await scrollList(1)
    await waitForValue(browser, 'last row in view', () => isOnTop(browser, modelRow(SMALL_MODEL)), true)
    const drawn = await drawnTexts()
    expect(drawn.length).toBeLessThan(MAX_DRAWN_ROWS)
    expect(drawn).toEqual(ROW_TEXTS.slice(-drawn.length))
  })

  it('shows the matches of a search from a far scroll position, then the full list again', async () => {
    // The list is at its end. A search with many matches gives a long list
    // again.
    await typeInto(browser, `${BOTTOM} .model-picker-input`, '09')
    const matches = BIG_MODELS.filter((name) => name.includes('09'))
    expect(matches.length).toBeGreaterThan(MAX_DRAWN_ROWS)
    await waitForValue(browser, 'matches of 09', () => pickerGroups(browser), [{ provider: BIG, models: matches }])

    await scrollList(1)
    await typeInto(browser, `${BOTTOM} .model-picker-input`, '0777', { clear: true })
    await waitForValue(browser, 'matches of 0777', () => pickerGroups(browser), [{ provider: BIG, models: ['Model 0777'] }])
    expect(await isOnTop(browser, modelRow('Model 0777'))).toBe(true)

    await typeInto(browser, `${BOTTOM} .model-picker-input`, '', { clear: true })
    await waitForValue(browser, 'first rows', async () => (await drawnTexts()).slice(0, 2), [BIG, BIG_MODELS[0]])
    const drawn = await drawnTexts()
    expect(drawn.length).toBeLessThan(MAX_DRAWN_ROWS)
    expect(drawn).toEqual(ROW_TEXTS.slice(0, drawn.length))
  })

  it('picks a far row with a click right after a scroll, and shows it as selected', async () => {
    await scrollList(0.5)
    const far = await middleRow()
    expect(BIG_MODELS.slice(400, 600)).toContain(far.name)
    await pointerClickAt(browser, far.center)
    await waitForValue(browser, 'selected model', () => browser.execute(
      () => document.querySelector('.model-selector-label')?.textContent?.trim() ?? null
    ), far.name)
    expect(await pickerOpen(browser)).toBe(false)

    // A new picker starts at the top, where the selected row is not drawn.
    await openPicker(browser)
    await waitForValue(browser, 'first rows', async () => (await drawnTexts()).slice(0, 2), [BIG, BIG_MODELS[0]])
    expect((await drawnPickerRows(browser)).filter((row) => row.active)).toEqual([])
    await scrollList(0.5)
    await waitForValue(browser, 'selected rows', async () =>
      (await drawnPickerRows(browser)).filter((row) => row.active).map((row) => row.text), [far.name])
  })

  it('puts a far model in the Favorites group with its star, and takes it out again', async () => {
    // The list is at its middle, with the selected model in view.
    const far = (await middleRow()).name
    await pointerClick(browser, `${modelRow(far)} .model-item-star`)
    await scrollList(0)
    await waitForValue(browser, 'first rows', async () => (await drawnTexts()).slice(0, 4), ['Favorites', far, BIG, BIG_MODELS[0]])
    // The two new rows at the top move every other row down; no row is lost
    // and none shows twice.
    expect(await pickerGroups(browser)).toEqual([{ provider: 'Favorites', models: [far] }, ...ALL_GROUPS])

    // The first row of that model is now the one in Favorites.
    await pointerClick(browser, `${modelRow(far)} .model-item-star`)
    await waitForValue(browser, 'first rows', async () => (await drawnTexts()).slice(0, 2), [BIG, BIG_MODELS[0]])
    const drawn = await drawnTexts()
    expect(drawn).toEqual(ROW_TEXTS.slice(0, drawn.length))

    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => pickerOpen(browser), false)
  })

  it('draws the Settings picker the same way, with the None row first', async () => {
    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-model-trigger')
    await pointerClick(browser, '.settings-model-trigger')
    await waitFor(browser, SETTINGS)
    await waitForValue(browser, 'first rows', async () => (await drawnTexts(SETTINGS)).slice(0, 3), [NONE_LABEL, BIG, BIG_MODELS[0]])
    const first = await drawnPickerRows(browser, SETTINGS)
    expect(first.length).toBeLessThan(MAX_DRAWN_ROWS)
    expect(first[0]).toEqual({ kind: 'none', text: NONE_LABEL, title: '', active: true })
    expect(first.slice(1).map((row) => row.text)).toEqual(ROW_TEXTS.slice(0, first.length - 1))

    await scrollList(1, SETTINGS)
    await waitForValue(browser, 'last row in view', () => isOnTop(browser, modelRow(SMALL_MODEL, SETTINGS)), true)
    const last = await drawnTexts(SETTINGS)
    expect(last.length).toBeLessThan(MAX_DRAWN_ROWS)
    expect(last).toEqual(ROW_TEXTS.slice(-last.length))

    // A pick of the last row closes the picker; a new one shows it as
    // selected, and the None row as not selected.
    await pointerClick(browser, `${modelRow(SMALL_MODEL, SETTINGS)} .model-item-name`)
    await waitForValue(browser, 'default model', () => browser.execute(
      () => document.querySelector('.settings-model-trigger-label')?.textContent?.trim() ?? null
    ), `${SMALL} — ${SMALL_MODEL}`)
    expect(await pickerOpen(browser, SETTINGS)).toBe(false)
    await pointerClick(browser, '.settings-model-trigger')
    await waitFor(browser, SETTINGS)
    await waitForValue(browser, 'None row', async () => (await drawnPickerRows(browser, SETTINGS))[0],
      { kind: 'none', text: NONE_LABEL, title: '', active: false })
    await scrollList(1, SETTINGS)
    await waitForValue(browser, 'selected rows', async () =>
      (await drawnPickerRows(browser, SETTINGS)).filter((row) => row.active).map((row) => row.text), [SMALL_MODEL])

    await sbpCall(browser, 'dez.model/settings/close')
  })
})
