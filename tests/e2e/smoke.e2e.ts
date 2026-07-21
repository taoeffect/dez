import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { screenshotOnFailure } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// Smoke test for the lifecycle harness: proves tauri-driver can launch the
// real (self-contained debug) app under an isolated HOME and that webdriverio
// can drive its webview. The tab bar is the app's outermost always-rendered
// chrome, so its presence means startup completed and the DOM is live.
describe('app lifecycle smoke test', () => {
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      // Don't leak the driver process group + temp HOME if the session
      // never comes up (afterAll may not run after a beforeAll failure).
      await app.stop()
      throw err
    }
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('launches the real app and renders the tab bar', async () => {
    await browser.waitUntil(
      async () => {
        try {
          const tabBar = await browser.$('header.tab-bar')
          return tabBar.isExisting()
        } catch {
          // Page not live yet (session still loading the webview).
          return false
        }
      },
      { timeout: 60_000, timeoutMsg: 'tab bar did not render within 60s of session start' }
    )

    const historyButton = await browser.$('button[title^="History"]')
    await expect(historyButton.isExisting()).resolves.toBe(true)
  })
})
