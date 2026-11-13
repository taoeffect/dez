import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { DEZ_DISCUSSIONS_URL } from '../../src/utils/dezLinks'
import { startApp, type RunningApp } from './harness/app'
import { clearOpenedUrls, consoleErrors, openedUrls, pointerClick, pointerClickAt, pointerDrag, resetConsoleErrors, screenshotOnFailure, stopOpenUrl, waitFor, waitForValue } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, focusedArea, sbpCall } from './harness/thread'

// The Help panel: the `?` button at the right end of the bottom bar and
// Help › Dez Help open it. No spec can click a native menu item, so the
// menu item is tested through the selector that it calls.
//
// The spec stops every `dez.controller/openUrl` call (`stopOpenUrl`), so no
// real browser opens.

// The nav buttons, in their order.
const NAV = {
  General: '.help-nav-btn:nth-child(1)',
  Tips: '.help-nav-btn:nth-child(2)',
  Support: '.help-nav-btn:nth-child(3)',
}

describe('Help panel', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function helpOpen (): Promise<boolean> {
    return browser.execute(() => document.querySelector('.help-overlay') !== null)
  }

  // The label of the active nav button and the class of the shown page.
  async function shownPage (): Promise<{ nav: string, page: string } | null> {
    return browser.execute(() => {
      const nav = document.querySelector('.help-nav-btn--active')?.textContent?.trim()
      const page = document.querySelector('.help-page')
      if (nav === undefined || !page) return null
      return { nav, page: [...page.classList].find((name) => name.startsWith('help-page--')) ?? '' }
    })
  }

  // The keys that the General page names, in text order.
  async function generalKeys (): Promise<string[]> {
    return browser.execute(() => [...document.querySelectorAll('.help-page--general kbd')].map((kbd) => kbd.textContent ?? ''))
  }

  async function openWithButton (): Promise<void> {
    await pointerClick(browser, '.help-button')
    await waitFor(browser, '.help-overlay')
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
    await stopOpenUrl(browser)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await clearOpenedUrls(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (await helpOpen()) await sbpCall(browser, 'dez.model/settings/helpClose')
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('opens from the ? button on General, keeps the editor focus, switches pages, and closes on Esc', async () => {
    await focusEditor(browser)
    await openWithButton()
    expect(await focusedArea(browser)).toBe('editor')
    expect(await shownPage()).toEqual({ nav: 'General', page: 'help-page--general' })
    // Submit, Stop, New Message, Settings, History: the keys that they have.
    expect(await generalKeys()).toEqual(['Ctrl+Enter', 'Esc', 'Shift+Enter', 'Ctrl+,', 'Ctrl+Shift+H'])

    await pointerClick(browser, NAV.Tips)
    await waitForValue(browser, 'Tips page', shownPage, { nav: 'Tips', page: 'help-page--tips' })
    await pointerClick(browser, NAV.Support)
    await waitForValue(browser, 'Support page', shownPage, { nav: 'Support', page: 'help-page--support' })

    // Esc with the focus in the editor closes the panel; it does not stop
    // or change anything in the editor.
    await focusEditor(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Help open after Esc', helpOpen, false)

    // The panel opens on General each time.
    await openWithButton()
    expect(await shownPage()).toEqual({ nav: 'General', page: 'help-page--general' })
  })

  it('names the keys that the shortcuts have now', async () => {
    expect(await sbpCall(browser, 'dez.model/settings/setShortcut', 'submit', 'Ctrl-j')).toBeNull()
    try {
      await openWithButton()
      expect((await generalKeys())[0]).toBe('Ctrl+J')
    } finally {
      await sbpCall(browser, 'dez.model/settings/setShortcut', 'submit', null)
    }
    await waitForValue(browser, 'Submit key in Help', async () => (await generalKeys())[0], 'Ctrl+Enter')
  })

  it('closes on a click outside the panel', async () => {
    await openWithButton()
    await pointerClickAt(browser, { x: 5, y: 5 })
    await waitForValue(browser, 'Help open after a click outside', helpOpen, false)
  })

  // The browser sends the click of a drag to the nearest parent of the press
  // and the release: the overlay, for a drag out of the panel.
  it('stays open when a text selection ends outside the panel', async () => {
    await openWithButton()
    const { from, belowModal } = await browser.execute(() => {
      const paragraph = document.querySelector('.help-page--general p')?.getBoundingClientRect()
      const modal = document.querySelector('.help-modal')?.getBoundingClientRect()
      if (!paragraph || !modal) throw new Error('no General paragraph or no modal')
      return { from: { x: paragraph.left + 2, y: paragraph.top + 8 }, belowModal: modal.bottom + 20 }
    })
    await pointerDrag(browser, from, from.x + 40, { toY: belowModal })
    expect(await helpOpen()).toBe(true)
    expect(await browser.execute(() => document.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0)
  })

  it('opens the Discussions page with the system browser from Support', async () => {
    await openWithButton()
    await pointerClick(browser, NAV.Support)
    await waitFor(browser, '.help-link')
    await pointerClick(browser, '.help-link')
    await waitForValue(browser, 'opened URLs', () => openedUrls(browser), [DEZ_DISCUSSIONS_URL])
    expect(await helpOpen()).toBe(true)
  })

  // Help › Dez Help calls this selector.
  it('opens from the menu action in place of Settings', async () => {
    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-overlay')
    await sbpCall(browser, 'dez.model/settings/helpOpen')
    await waitFor(browser, '.help-overlay')
    expect(await browser.execute(() => document.querySelector('.settings-overlay') !== null)).toBe(false)
    expect(await shownPage()).toEqual({ nav: 'General', page: 'help-page--general' })
  })

  // A modal covers find: Esc closes the modal first, and find on the next
  // Esc (useKeyboardShortcuts.ts, FindDropdown.vue).
  it('closes before find on Esc in the find field', async () => {
    const findOpen = async (): Promise<boolean> => browser.execute(() => document.querySelector('.find-dropdown') !== null)
    await focusEditor(browser)
    await browser.keys([Key.Control, 'f'])
    await waitForValue(browser, 'find focused', () => focusedArea(browser), 'find')
    await openWithButton()
    expect(await focusedArea(browser)).toBe('find')

    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Help open after Esc', helpOpen, false)
    expect(await findOpen()).toBe(true)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'find open after the second Esc', findOpen, false)
  })
})
