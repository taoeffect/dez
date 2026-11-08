import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { movePointer, screenshotOnFailure, waitFor, waitForValue, type Point } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { openToasts } from './harness/thread'

const DURATION_MS = 2000
const MESSAGE = 'Toast hover e2e'
// The toast as `openToasts` reads it: it has no title.
const SHOWN = [{ title: '', message: MESSAGE }]
// Far from the toasts, which show at the lower right.
const OFF_TOASTS: Point = { x: 20, y: 300 }

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
    await movePointer(browser, OFF_TOASTS)
    await browser.execute((message: string, duration: number) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      sbp('dez.ui/toast', 'app-global', { message, duration })
    }, MESSAGE, DURATION_MS)
    await waitForValue(browser, 'toast shown', () => openToasts(browser), SHOWN)

    await (await browser.$('.toast-card')).moveTo()
    await browser.pause(DURATION_MS + 1000)
    expect(await openToasts(browser), 'toast open while hovered').toEqual(SHOWN)

    // The timer continues from where it paused, so some time remains.
    await movePointer(browser, OFF_TOASTS)
    expect(await openToasts(browser), 'toast open right after the pointer leaves').toEqual(SHOWN)
    await waitForValue(browser, 'toast closed after the remaining time', () => openToasts(browser), [])
  })
})
