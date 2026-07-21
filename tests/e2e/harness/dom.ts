import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * operation" (the same limitation as sendKeys), so all clicks in specs must
 * go through the DOM's own click path rather than webdriverio's `.click()`.
 */
export async function click (browser: E2EBrowser, selector: string): Promise<void> {
  await browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`click: element not found: ${sel}`)
    el.click()
  }, selector)
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
