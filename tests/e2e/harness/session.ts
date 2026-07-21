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

/**
 * Open a WebDriver session against a running tauri-driver instance.
 * `'tauri:options'.application` tells tauri-driver which binary to launch.
 * Do not add `browserName` — WebKitWebDriver rejects capability matching
 * when it is present.
 */
export async function createSession (binary: string, port: number): Promise<E2EBrowser> {
  // Bound to a const so the vendor key survives assignability checking
  // against webdriverio's strict RequestedStandaloneCapabilities type.
  const capabilities: TauriCapabilities = {
    'tauri:options': {
      application: binary
    }
  }
  return remote({
    hostname: '127.0.0.1',
    port,
    path: '/',
    logLevel: 'error',
    capabilities
  })
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
