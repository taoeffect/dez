import { Key } from 'webdriverio'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
import { readAppState, seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { openPicker, pickerGroups, sbpCall } from './harness/thread'

// The output filter of the model pickers (the funnel at the right of the
// search field), driven through the real app. Two custom providers with
// `fetchModels: false` give the model lists: "Media Mock" sets config
// `outputs` on each model, and "Plain Mock" has one model with unknown
// outputs, which counts as a text model. No request goes to their servers.
//
// The clicks in the filter are real pointer clicks, so they check that the
// dropdown's prevented mousedown (it keeps the focus in the search field)
// still toggles its inputs. One app session serves the file; the tests run
// in order and each one ends with the filter on All, unless it says so.

interface FilterView {
  open: boolean
  active: boolean
  title: string
  ariaExpanded: string | null
  // Each option's label and checked state, All first.
  options: Array<{ label: string, checked: boolean }>
}

const MEDIA = 'Media Mock'
const PLAIN = 'Plain Mock'
const ALL_MEDIA = ['Alpha Text', 'Bravo Image', 'Charlie Video', 'Delta Text Image']
const FAVORITES = ['Alpha Text', 'Bravo Image']
const ALL_GROUPS = [
  { provider: 'Favorites', models: FAVORITES },
  { provider: MEDIA, models: ALL_MEDIA },
  { provider: PLAIN, models: ['plain-model'] },
]

const OPTION_LABELS = ['All', 'Text', 'Image', 'Audio', 'Video']
const BOTTOM = '.model-dropdown'
const SETTINGS = '.settings-model-dropdown'

describe('model output filter', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function filterView (root = BOTTOM): Promise<FilterView | null> {
    return browser.execute((rootSelector: string) => {
      const button = document.querySelector<HTMLButtonElement>(`${rootSelector} .output-filter-btn`)
      if (!button) return null
      return {
        open: document.querySelector(`${rootSelector} .output-filter-dropdown`) !== null,
        active: button.classList.contains('output-filter-btn--active'),
        title: button.title,
        ariaExpanded: button.getAttribute('aria-expanded'),
        options: Array.from(document.querySelectorAll(`${rootSelector} .output-filter-option`)).map((option) => ({
          label: option.textContent?.trim() ?? '',
          checked: option.querySelector('input')?.checked ?? false,
        })),
      }
    }, root)
  }

  // The view of an open dropdown whose checked types are `checked` (none:
  // All). The title lists them in table order.
  function openFilter (checked: string[]): FilterView {
    return {
      open: true,
      active: checked.length > 0,
      title: checked.length > 0 ? `Filter by output: ${checked.join(', ')}` : 'Filter by output',
      ariaExpanded: 'true',
      options: OPTION_LABELS.map((label) => ({
        label,
        checked: label === 'All' ? checked.length === 0 : checked.includes(label),
      })),
    }
  }

  function closedFilter (checked: string[]): FilterView {
    return { ...openFilter(checked), open: false, ariaExpanded: 'false', options: [] }
  }

  // A real pointer click on the label text of `label` in the open filter
  // dropdown of `root`. The options are the dropdown's labels, All first.
  async function clickOption (label: string, root = BOTTOM): Promise<void> {
    await pointerClick(browser, `${root} .output-filter-option:nth-of-type(${OPTION_LABELS.indexOf(label) + 1}) span`)
  }

  // What has the focus: `input:radio` for All, `input:<type id>` for a type
  // checkbox, else the class of the focused element.
  async function focusedClass (): Promise<string> {
    return browser.execute(() => {
      const el = document.activeElement
      if (!el) return ''
      if (el instanceof HTMLInputElement && el.type !== 'text') return `input:${el.type === 'checkbox' ? el.value : el.type}`
      return el.className
    })
  }

  async function savedFilter (): Promise<unknown> {
    return (await readAppState(app.home))?.modelOutputFilter
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedRawAppState(app.home, {
        customProviders: [
          {
            id: 'media',
            name: MEDIA,
            baseUrl: 'http://127.0.0.1:9/v1',
            fetchModels: false,
            models: [
              { id: 'alpha-text', name: 'Alpha Text', outputs: ['text'] },
              { id: 'bravo-image', name: 'Bravo Image', outputs: ['image'] },
              { id: 'charlie-video', name: 'Charlie Video', outputs: ['video'] },
              { id: 'delta-text-image', name: 'Delta Text Image', outputs: ['text', 'image'] },
            ],
          },
          {
            id: 'plain',
            name: PLAIN,
            baseUrl: 'http://127.0.0.1:9/v1',
            fetchModels: false,
            models: [{ id: 'plain-model' }],
          },
        ],
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await sbpCall(browser, 'dez.model/settings/toggleFavorite', 'media', 'alpha-text')
    await sbpCall(browser, 'dez.model/settings/toggleFavorite', 'media', 'bravo-image')
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

  it('shows every model with All checked, and keeps the focus in the search field', async () => {
    await openPicker(browser)
    await waitForValue(browser, 'picker groups', () => pickerGroups(browser), ALL_GROUPS)
    expect(await filterView()).toEqual(closedFilter([]))

    await pointerClick(browser, `${BOTTOM} .output-filter-btn`)
    expect(await filterView()).toEqual(openFilter([]))
    expect(await focusedClass()).toBe('model-picker-input')
  })

  it('shows only the models that make a checked type, Favorites too', async () => {
    await clickOption('Image')
    expect(await filterView()).toEqual(openFilter(['Image']))
    expect(await pickerGroups(browser)).toEqual([
      { provider: 'Favorites', models: ['Bravo Image'] },
      { provider: MEDIA, models: ['Bravo Image', 'Delta Text Image'] },
    ])
    expect(await focusedClass()).toBe('model-picker-input')

    // Two types show the models that make either of them.
    await clickOption('Video')
    expect(await filterView()).toEqual(openFilter(['Image', 'Video']))
    expect(await pickerGroups(browser)).toEqual([
      { provider: 'Favorites', models: ['Bravo Image'] },
      { provider: MEDIA, models: ['Bravo Image', 'Charlie Video', 'Delta Text Image'] },
    ])
    await waitForValue(browser, 'saved filter', savedFilter, ['image', 'video'])
  })

  it('selects All again when the last type is unchecked, and All clears the types', async () => {
    await clickOption('Image')
    expect(await filterView()).toEqual(openFilter(['Video']))
    await clickOption('Video')
    expect(await filterView()).toEqual(openFilter([]))
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)
    await waitForValue(browser, 'saved filter', savedFilter, [])

    // The model with unknown outputs counts as a text model.
    await clickOption('Text')
    expect(await filterView()).toEqual(openFilter(['Text']))
    expect(await pickerGroups(browser)).toEqual([
      { provider: 'Favorites', models: ['Alpha Text'] },
      { provider: MEDIA, models: ['Alpha Text', 'Delta Text Image'] },
      { provider: PLAIN, models: ['plain-model'] },
    ])

    // A click on the box itself, not on its text, works the same way.
    await pointerClick(browser, `${BOTTOM} .output-filter-option input[value="audio"]`)
    expect(await filterView()).toEqual(openFilter(['Text', 'Audio']))
    expect(await focusedClass()).toBe('model-picker-input')
    await clickOption('All')
    expect(await filterView()).toEqual(openFilter([]))
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)
  })

  it('works together with the search terms, and shows the empty state', async () => {
    await clickOption('Video')
    await typeKeys(browser, 'delta')
    await waitForValue(browser, 'search', () => browser.execute(
      (sel: string) => document.querySelector<HTMLInputElement>(sel)?.value ?? null, `${BOTTOM} .model-picker-input`
    ), 'delta')
    expect(await pickerGroups(browser)).toEqual([])
    expect(await browser.execute(
      (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null, `${BOTTOM} .model-picker-empty`
    )).toBe('No models found')

    // With no model rows, the picker is still tall enough for the whole
    // dropdown, and the dropdown stays in the window.
    const boxes = await browser.execute((root: string) => {
      const picker = document.querySelector(`${root} .model-picker`)!.getBoundingClientRect()
      const dropdown = document.querySelector(`${root} .output-filter-dropdown`)!.getBoundingClientRect()
      return { pickerTop: picker.top, pickerBottom: picker.bottom, dropdownBottom: dropdown.bottom, windowHeight: window.innerHeight }
    }, BOTTOM)
    expect(boxes.dropdownBottom).toBeLessThanOrEqual(boxes.pickerBottom)
    expect(boxes.pickerTop).toBeGreaterThanOrEqual(0)
    expect(boxes.dropdownBottom).toBeLessThanOrEqual(boxes.windowHeight)

    await clickOption('Text')
    expect(await pickerGroups(browser)).toEqual([{ provider: MEDIA, models: ['Delta Text Image'] }])

    await typeInto(browser, `${BOTTOM} .model-picker-input`, '', { clear: true })
    await clickOption('All')
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)
  })

  it('closes only the filter dropdown on Escape; a second Escape closes the picker', async () => {
    await browser.keys([Key.Escape])
    expect(await filterView()).toEqual(closedFilter([]))
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)

    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => browser.execute(
      (sel: string) => document.querySelector(sel) !== null, BOTTOM
    ), false)
  })

  it('closes on a click outside it and on Tab out of it; the keyboard opens it with the focus inside', async () => {
    await openPicker(browser)
    await pointerClick(browser, `${BOTTOM} .output-filter-btn`)
    expect((await filterView())?.open).toBe(true)
    await pointerClick(browser, `${BOTTOM} .model-picker-input`)
    expect((await filterView())?.open).toBe(false)
    expect(await pickerGroups(browser)).toEqual(ALL_GROUPS)

    // Enter on the focused button opens it and moves the focus to All.
    await browser.execute((sel: string) => document.querySelector<HTMLElement>(sel)?.focus(), `${BOTTOM} .output-filter-btn`)
    await browser.keys([Key.Enter])
    expect((await filterView())?.open).toBe(true)
    expect(await focusedClass()).toBe('input:radio')

    // Escape gives the focus back to the button.
    await browser.keys([Key.Escape])
    expect((await filterView())?.open).toBe(false)
    expect(await focusedClass()).toContain('output-filter-btn')

    // Tab from the last type leaves the dropdown, which closes.
    await browser.keys([Key.Enter])
    await browser.execute((sel: string) => document.querySelector<HTMLElement>(sel)?.focus(), `${BOTTOM} .output-filter-option input[value="video"]`)
    await browser.keys([Key.Tab])
    expect((await filterView())?.open).toBe(false)
    expect(await browser.execute((sel: string) => document.querySelector(sel) !== null, BOTTOM)).toBe(true)

    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => browser.execute(
      (sel: string) => document.querySelector(sel) !== null, BOTTOM
    ), false)
  })

  it('is shared with the Settings picker, where Escape closes only the filter dropdown', async () => {
    await openPicker(browser)
    await pointerClick(browser, `${BOTTOM} .output-filter-btn`)
    await clickOption('Image')
    await browser.keys([Key.Escape])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'picker open', () => browser.execute(
      (sel: string) => document.querySelector(sel) !== null, BOTTOM
    ), false)

    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-model-trigger')
    await pointerClick(browser, '.settings-model-trigger')
    await waitFor(browser, SETTINGS)
    // The Settings picker shows no Favorites group.
    expect(await pickerGroups(browser, SETTINGS)).toEqual([
      { provider: MEDIA, models: ['Bravo Image', 'Delta Text Image'] },
    ])
    expect((await filterView(SETTINGS))?.active).toBe(true)

    await pointerClick(browser, `${SETTINGS} .output-filter-btn`)
    expect(await filterView(SETTINGS)).toEqual(openFilter(['Image']))
    await browser.keys([Key.Escape])
    expect((await filterView(SETTINGS))?.open).toBe(false)
    expect(await browser.execute((sel: string) => document.querySelector(sel) !== null, SETTINGS)).toBe(true)
    expect(await browser.execute(() => document.querySelector('.settings-overlay') !== null)).toBe(true)

    // A change here shows in the bottom bar picker.
    await pointerClick(browser, `${SETTINGS} .output-filter-btn`)
    await clickOption('Video', SETTINGS)
    expect(await pickerGroups(browser, SETTINGS)).toEqual([
      { provider: MEDIA, models: ['Bravo Image', 'Charlie Video', 'Delta Text Image'] },
    ])
    await waitForValue(browser, 'saved filter', savedFilter, ['image', 'video'])
    await sbpCall(browser, 'dez.model/settings/close')
    await openPicker(browser)
    expect(await pickerGroups(browser)).toEqual([
      { provider: 'Favorites', models: ['Bravo Image'] },
      { provider: MEDIA, models: ['Bravo Image', 'Charlie Video', 'Delta Text Image'] },
    ])
    await browser.keys([Key.Escape])
  })

  it('keeps the filter after an app restart', async () => {
    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    await waitFor(browser, 'header.tab-bar', 60_000)
    await resetConsoleErrors(browser)

    await openPicker(browser)
    await waitForValue(browser, 'picker groups', () => pickerGroups(browser), [
      { provider: 'Favorites', models: ['Bravo Image'] },
      { provider: MEDIA, models: ['Bravo Image', 'Charlie Video', 'Delta Text Image'] },
    ])
    expect(await filterView()).toEqual(closedFilter(['Image', 'Video']))
  })
})
