import { Key } from 'webdriverio'
import { typeInto, waitFor } from './dom'
import type { E2EBrowser } from './session'

// The Find dropdown of the thread editor (src/view/thread/FindDropdown.vue),
// driven and read from the page.

export const FIND_FIELD = '.find-field[aria-label="Find"]'
export const REGEX_TOGGLE = '.find-btn--regex'
export const CASE_TOGGLE = '.find-btn--case'

/** The text of the Find status (`2 of 5`); `''` with no status. */
export async function findStatus (browser: E2EBrowser): Promise<string> {
  return browser.execute(() => document.querySelector('.find-status')?.textContent?.trim() ?? '')
}

/** Whether the Find dropdown is open. */
export async function findDropdownOpen (browser: E2EBrowser): Promise<boolean> {
  return browser.execute(() => document.querySelector('.find-dropdown') !== null)
}

/** Turns the Find toggle `selector` (`REGEX_TOGGLE`, `CASE_TOGGLE`) on or
 *  off, with a click only when it is not in that state. */
export async function setToggle (browser: E2EBrowser, selector: string, on: boolean): Promise<void> {
  await browser.execute((sel: string, wanted: boolean) => {
    const toggle = document.querySelector(sel) as HTMLButtonElement | null
    if (!toggle) throw new Error(`setToggle: ${sel} not found`)
    if ((toggle.getAttribute('aria-pressed') === 'true') !== wanted) toggle.click()
  }, selector, on)
}

/** Ctrl+F, then a fresh query: plain, case-insensitive, empty field, typed
 *  text. */
export async function openFindWithQuery (browser: E2EBrowser, search: string): Promise<void> {
  await browser.keys([Key.Control, 'f'])
  await waitFor(browser, FIND_FIELD, 10_000)
  await setToggle(browser, REGEX_TOGGLE, false)
  await setToggle(browser, CASE_TOGGLE, false)
  await typeInto(browser, FIND_FIELD, search, { clear: true })
}
