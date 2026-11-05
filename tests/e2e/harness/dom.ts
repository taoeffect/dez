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

/** The center of an element in viewport px, for WebDriver pointer actions. */
async function elementCenter (browser: E2EBrowser, selector: string): Promise<{ x: number, y: number }> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`elementCenter: element not found: ${sel}`)
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }, selector)
}

/**
 * Click the center of an element with WebDriver pointer actions: a real
 * mousedown, mouseup, and click, with the browser's default actions (the
 * focus moves unless the page prevents the mousedown). WebKitWebDriver
 * accepts pointer actions, unlike the `element/click` endpoint (see
 * `click`). Each call starts a new click series (`event.detail` is 1), also
 * right after another call at the same place; for a double-click, use
 * `pointerDoubleClick`.
 */
export async function pointerClick (browser: E2EBrowser, selector: string): Promise<void> {
  const center = await elementCenter(browser, selector)
  await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: center.x, y: center.y, origin: 'viewport' })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform()
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
