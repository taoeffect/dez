import { remote, type Browser } from 'webdriverio'

export type E2EBrowser = Browser

// tauri-driver's vendor capability is not part of webdriverio's typed
// capability set. Typing it as an interface extension of the global
// WebdriverIO.Capabilities lets us pass it through verbatim to the proxy,
// which translates it into the native driver's webkitgtk:browserOptions.binary.
interface TauriCapabilities extends WebdriverIO.Capabilities {
  'tauri:options': {
    application: string
  }
}

const SETTLED_SIZE_MS = 500

/**
 * Open a WebDriver session against a running tauri-driver instance.
 * `'tauri:options'.application` tells tauri-driver which binary to launch.
 * Do not add `browserName` — WebKitWebDriver rejects capability matching
 * when it is present.
 *
 * The app window starts hidden and shows when startup has restored its size
 * and position (`dez.controller/window/restore`). The page loads before
 * that, and a pointer action on the hidden window fails with "move target
 * out of bounds", so this waits until the window shows.
 *
 * The page size can still change just after the show: under GTK on Wayland
 * the header bar takes its height from the page only then (900x700 becomes
 * 900x673). A pointer action placed with the old size misses an element at
 * the bottom or right edge, so this also waits until the size stays the
 * same for `SETTLED_SIZE_MS`.
 */
export async function createSession (binary: string, port: number): Promise<E2EBrowser> {
  // Bound to a const so the vendor key survives assignability checking
  // against webdriverio's strict RequestedStandaloneCapabilities type.
  const capabilities: TauriCapabilities = {
    'tauri:options': {
      application: binary
    }
  }
  const browser = await remote({
    hostname: '127.0.0.1',
    port,
    path: '/',
    logLevel: 'error',
    capabilities
  })
  try {
    await browser.waitUntil(async () => {
      try {
        return await browser.execute(async () => {
          const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
            invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
          }
          return await internals.invoke('plugin:window|is_visible', { label: 'main' }) === true
        })
      } catch {
        // The page is not loaded yet.
        return false
      }
    }, { timeout: 60_000, interval: 50, timeoutMsg: 'createSession: the app window did not show within 60 s' })
    let size = ''
    let sizeSince = 0
    await browser.waitUntil(async () => {
      const now = await browser.execute(() => `${window.innerWidth}x${window.innerHeight}`)
      if (now !== size) {
        size = now
        sizeSince = Date.now()
      }
      return Date.now() - sizeSince >= SETTLED_SIZE_MS
    }, { timeout: 10_000, interval: 50, timeoutMsg: 'createSession: the page size did not settle within 10 s' })
  } catch (err) {
    await destroySession(browser)
    throw err
  }
  return browser
}

/**
 * End the WebDriver session, which asks WebKitWebDriver to close the app
 * window. Errors are logged, not thrown: teardown must not mask the real
 * test failure that triggered it.
 */
export async function destroySession (browser: E2EBrowser | null | undefined): Promise<void> {
  if (!browser) return
  try {
    await browser.deleteSession()
  } catch (err) {
    console.error('[e2e] failed to delete WebDriver session cleanly', err)
  }
}
