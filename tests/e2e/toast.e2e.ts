import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

const DURATION_MS = 2000
const MESSAGE = 'Toast hover e2e'

// Messages of the toasts that are shown and not closing.
async function openToastMessages (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => Array.from(
    document.querySelectorAll('.toast-card:not(.toast-card--closing) .toast-message'),
    (el) => el.textContent ?? ''
  ))
}

async function movePointerOffToasts (browser: E2EBrowser): Promise<void> {
  await browser.action('pointer').move({ x: 20, y: 300, origin: 'viewport' }).perform()
}

describe('toast hover', () => {
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('pauses a self-closing toast while the pointer is on it', async () => {
    await movePointerOffToasts(browser)
    await browser.execute((message: string, duration: number) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      sbp('dez.ui/toast', 'app-global', { message, duration })
    }, MESSAGE, DURATION_MS)
    await waitForValue(browser, 'toast shown', () => openToastMessages(browser), [MESSAGE])

    await (await browser.$('.toast-card')).moveTo()
    await browser.pause(DURATION_MS + 1000)
    expect(await openToastMessages(browser), 'toast open while hovered').toEqual([MESSAGE])

    // The timer continues from where it paused, so some time remains.
    await movePointerOffToasts(browser)
    expect(await openToastMessages(browser), 'toast open right after the pointer leaves').toEqual([MESSAGE])
    await waitForValue(browser, 'toast closed after the remaining time', () => openToastMessages(browser), [])
  })
})
