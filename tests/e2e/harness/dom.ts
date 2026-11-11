import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Key } from 'webdriverio'
import type { E2EBrowser } from './session'

const artifactsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts')

/**
 * Type text into an input element using the per-character InputEvent
 * workaround. wry's automation session rejects WebDriver sendKeys
 * ("unsupported operation"), so we focus the element, then append each
 * character to `.value` and dispatch a synthetic InputEvent — this still
 * exercises the history panel's 150 ms debounce because each dispatch
 * triggers the same `input` listener the real keyboard would.
 * Pass `{ clear: true }` to empty the input first (with its own input
 * event) so a caller can replace a previous value outright.
 */
export async function typeInto (
  browser: E2EBrowser,
  selector: string,
  text: string,
  options: { clear?: boolean } = {}
): Promise<void> {
  await browser.execute((sel: string, chars: string, clear: boolean) => {
    const el = document.querySelector(sel) as HTMLInputElement | null
    if (!el) throw new Error(`typeInto: element not found: ${sel}`)
    el.focus()
    if (clear) {
      el.value = ''
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    }
    for (const ch of chars) {
      el.value += ch
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }))
    }
  }, selector, text, options.clear === true)
}

/**
 * Poll until at least one element matching `selector` exists in the DOM.
 */
export async function waitFor (browser: E2EBrowser, selector: string, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const el = await browser.$(selector)
        return el.isExisting()
      } catch {
        return false
      }
    },
    { timeout: timeoutMs, timeoutMsg: `waitFor: "${selector}" did not appear within ${timeoutMs}ms` }
  )
}

/**
 * Poll until `read()` returns `expected` (deep equality). The failure
 * message shows the last value read, which `waitUntil` alone would not.
 * Its cause is the `waitUntil` error: a timeout, or the error that the
 * last `read()` threw.
 */
export async function waitForValue<T> (browser: E2EBrowser, label: string, read: () => Promise<T>, expected: T): Promise<void> {
  let actual: T | undefined
  try {
    await browser.waitUntil(async () => {
      actual = await read()
      return isDeepStrictEqual(actual, expected)
    }, { timeout: 10_000, interval: 50 })
  } catch (err) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, { cause: err })
  }
}

/**
 * Send real key actions, one action per character: a key repeated inside
 * one `browser.keys` chord is dropped.
 */
export async function typeKeys (browser: E2EBrowser, text: string): Promise<void> {
  for (const ch of text) await browser.keys(ch)
}

/**
 * Start a fresh record of the page's `console.error` calls. Errors thrown
 * inside CodeMirror plugins and Vue handlers are only logged, not thrown
 * to WebDriver, so a spec calls this in `beforeEach` and checks
 * `consoleErrors()` in `afterEach`. `console.error` is wrapped once per
 * page; later calls only empty the record.
 */
export async function resetConsoleErrors (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    Reflect.set(window, '__e2eErrors', [])
    if (Reflect.get(window, '__e2eConsoleWrapped')) return
    Reflect.set(window, '__e2eConsoleWrapped', true)
    const original = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      const record = Reflect.get(window, '__e2eErrors') as string[]
      record.push(args.map((arg) => arg instanceof Error ? arg.stack ?? arg.message : String(arg)).join(' '))
      original(...args)
    }
  })
}

/**
 * The `console.error` calls recorded since the last `resetConsoleErrors()`.
 */
export async function consoleErrors (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => Reflect.get(window, '__e2eErrors') as string[])
}

/**
 * Poll until exactly `count` `.history-row` elements are rendered.
 * Useful after search queries where the panel re-renders asynchronously
 * (debounced input -> re-index -> DOM update).
 */
export async function waitForRowCount (browser: E2EBrowser, expected: number, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const count = await browser.execute(() => document.querySelectorAll('.history-row').length)
        return count === expected
      } catch {
        return false
      }
    },
    { timeout: timeoutMs, timeoutMsg: `waitForRowCount: expected ${expected} .history-row elements within ${timeoutMs}ms` }
  )
}

/**
 * Click an element via executed JS (`el.click()`). wry's automation session
 * rejects WebDriver's native `element/click` endpoint with "unsupported
 * operation" (the same limitation as sendKeys), so specs never use
 * webdriverio's `.click()`. This click sends no mousedown, so the focus
 * stays as it is; `pointerClick` sends real mouse events.
 */
export async function click (browser: E2EBrowser, selector: string): Promise<void> {
  await browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`click: element not found: ${sel}`)
    el.click()
  }, selector)
}

/** A point in viewport px, for WebDriver pointer actions. */
export interface Point {
  x: number
  y: number
}

/** The center of an element in viewport px, rounded. */
export async function elementCenter (browser: E2EBrowser, selector: string): Promise<Point> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`elementCenter: element not found: ${sel}`)
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }, selector)
}

/** Whether the first element that matches `selector` is the top one at its
 *  own center: no other layer (an overlay, a fullscreen element) covers it
 *  there. False when no element matches. */
export async function isOnTop (browser: E2EBrowser, selector: string): Promise<boolean> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit !== null && el.contains(hit)
  }, selector)
}

/** Move the mouse pointer to `point`, with no button down. */
export async function movePointer (browser: E2EBrowser, point: Point): Promise<void> {
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
    .perform()
}

/**
 * Click at `point` with WebDriver pointer actions: a real mousedown,
 * mouseup, and click, with the browser's default actions (the focus moves
 * unless the page prevents the mousedown). WebKitWebDriver accepts pointer
 * actions, unlike the `element/click` endpoint (see `click`). `count`
 * clicks with no pause between them: 2 is a double-click, 3 a triple-click.
 * Each call starts a new click series (`event.detail` is 1), also right
 * after another call at the same place; for a double-click with a set gap,
 * use `pointerDoubleClick`.
 */
export async function pointerClickAt (browser: E2EBrowser, point: Point, count = 1): Promise<void> {
  let action = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
  for (let i = 0; i < count; i++) action = action.down({ button: 0 }).up({ button: 0 })
  await action.perform()
}

/** Click the center of an element with `pointerClickAt`. */
export async function pointerClick (browser: E2EBrowser, selector: string): Promise<void> {
  await pointerClickAt(browser, await elementCenter(browser, selector))
}

/**
 * Double-click the center of an element with WebDriver pointer actions: two
 * real clicks in one action sequence, so the second click has
 * `event.detail` 2. `gapMs` is the time between the clicks; WebKitGTK still
 * counts a double-click at 150 ms, but not at 600 ms.
 */
export async function pointerDoubleClick (browser: E2EBrowser, selector: string, gapMs: number): Promise<void> {
  const center = await elementCenter(browser, selector)
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: center.x, y: center.y, origin: 'viewport' })
    .down({ button: 0 })
    .up({ button: 0 })
    .pause(gapMs)
    .down({ button: 0 })
    .up({ button: 0 })
    .perform()
}

// The input source of `pointerDrag`, `pointerPress`, and `pointerRelease`. A
// button held by one action call is released only by an `up` from the same
// source: WebKitWebDriver's `releaseActions` sends no pointerup, and a source
// that pressed nothing has no button to release.
const DRAG_POINTER = { id: 'dragMouse', parameters: { pointerType: 'mouse' } } as const

/**
 * Drag an element with WebDriver pointer actions: press at its center and
 * move in a straight line to `toX` (viewport px) on the same row, or on row
 * `toY` when given, in steps of at most 10 px, one pointermove each, as a
 * real mouse sends them. Then release, unless `release` is false: the
 * button stays down until `pointerRelease`.
 */
export async function pointerDrag (
  browser: E2EBrowser,
  fromSelector: string,
  toX: number,
  options: { release?: boolean, toY?: number } = {}
): Promise<void> {
  const from = await elementCenter(browser, fromSelector)
  const toY = options.toY ?? from.y
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - from.x, toY - from.y) / 10))
  let action = browser.action('pointer', DRAG_POINTER)
    .move({ x: from.x, y: from.y, origin: 'viewport' })
    .down({ button: 0 })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(from.x + (toX - from.x) * step / steps)
    const y = Math.round(from.y + (toY - from.y) * step / steps)
    action = action.move({ x, y, origin: 'viewport', duration: 10 })
  }
  if (options.release === false) {
    await action.perform(true)
  } else {
    await action.up({ button: 0 }).perform()
  }
}

/**
 * Press the button at a viewport point and hold it, with no move: a click
 * that `pointerRelease` ends. For checks between the press and the release.
 */
export async function pointerPress (browser: E2EBrowser, x: number, y: number): Promise<void> {
  await browser.action('pointer', DRAG_POINTER)
    .move({ x, y, origin: 'viewport' })
    .down({ button: 0 })
    .perform(true)
}

/** Release the button that `pointerPress` or `pointerDrag(…, { release: false })` holds. */
export async function pointerRelease (browser: E2EBrowser): Promise<void> {
  await browser.action('pointer', DRAG_POINTER).up({ button: 0 }).perform()
}

/**
 * Open the history panel by clicking the toolbar toggle button and
 * waiting for the overlay to render.
 */
export async function openHistoryPanel (browser: E2EBrowser): Promise<void> {
  await click(browser, 'button[title^="History"]')
  await waitFor(browser, '.history-overlay')
}

/**
 * Close Settings with Esc and wait until its Providers page is gone. Call it
 * while the Providers page is open.
 */
export async function closeSettings (browser: E2EBrowser): Promise<void> {
  await browser.keys([Key.Escape])
  await waitForValue(browser, 'Settings open', () => browser.execute(() => document.querySelector('.provider-manager') !== null), false)
}

/** Click the nav button of the open Settings whose label is `label`. */
export async function clickSettingsNav (browser: E2EBrowser, label: string): Promise<void> {
  await browser.execute((wanted: string) => {
    const button = [...document.querySelectorAll<HTMLElement>('.settings-nav-btn')].find((el) => el.textContent?.trim() === wanted)
    if (!button) throw new Error(`clickSettingsNav: no ${wanted} nav button`)
    button.click()
  }, label)
}

/**
 * Save a WebDriver screenshot to `tests/e2e/artifacts/` on test failure.
 * Call from an `afterEach` hook with the Vitest task context so the
 * filename reflects the failed test. No-op when the test passed.
 *
 * Usage in a spec:
 * ```ts
 * afterEach(async (ctx) => { await screenshotOnFailure(browser, ctx) })
 * ```
 */
export async function screenshotOnFailure (
  browser: E2EBrowser | null | undefined,
  ctx: { task: { name?: string; result?: { state?: string } } }
): Promise<void> {
  // Vitest's TestContext has no top-level `state`; the fail state lives at
  // task.result.state, which the runner sets to 'fail' before afterEach
  // hooks run (a passing test is still 'run' at that point).
  if (ctx.task.result?.state !== 'fail' || !browser) return
  await fs.promises.mkdir(artifactsDir, { recursive: true })
  const safeName = (ctx.task.name ?? 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_')
  const filePath = path.join(artifactsDir, `${safeName}-${Date.now()}.png`)
  try {
    const png = await browser.takeScreenshot()
    await fs.promises.writeFile(filePath, png, 'base64')
    console.error(`[e2e] failure screenshot saved: ${filePath}`)
  } catch (err) {
    console.error('[e2e] failed to capture screenshot', err)
  }
}
