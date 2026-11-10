import { startApp, type AppOptions, type RunningApp } from './app'
import { waitFor } from './dom'
import { seedRawAppState } from './fixtures'
import { mockChatPath, mockProviderConfig, startHoldingChatMock, type HoldingChatMock, type MockProvider } from './mockServer'
import { createSession, destroySession, type E2EBrowser } from './session'
import { pickModel } from './thread'

export interface MockProviderApp {
  mock: HoldingChatMock
  app: RunningApp
  /** The live session: after `relaunch()`, the new one. */
  readonly browser: E2EBrowser
  /** Ends the session and starts a new one on the same HOME, as a relaunch
   *  of the app does, and returns it. `stop` then ends the new session. */
  relaunch: () => Promise<E2EBrowser>
  /** Ends the session, then stops the app and the mock. */
  stop: () => Promise<void>
}

export interface MockProviderAppOptions extends AppOptions {
  /** More custom providers on the same mock, after the main one. `config`
   *  adds to or replaces fields of the provider's config. */
  moreProviders?: ReadonlyArray<{ provider: MockProvider, config?: Record<string, unknown> }>
  /** More POST paths that the mock holds for the test as it holds chat
   *  requests, such as a media API path. */
  heldPaths?: readonly string[]
}

/**
 * The setup of a spec file whose tests answer each chat request
 * themselves: starts a holding chat mock for `provider` (and
 * `options.moreProviders`), then the app with them as its only custom
 * providers, and picks `provider`'s model. `config` adds to or replaces
 * fields of `provider`'s config, such as `thinking`. The other options go
 * to `startApp`. One app session then serves the whole file. On a failure
 * it stops what it started, then throws.
 */
export async function startMockProviderApp (
  provider: MockProvider,
  config: Record<string, unknown> = {},
  options: MockProviderAppOptions = {},
): Promise<MockProviderApp> {
  const { moreProviders = [], heldPaths = [], ...appOptions } = options
  const providers = [{ provider, config }, ...moreProviders]
  const mock = await startHoldingChatMock([...providers.map((entry) => mockChatPath(entry.provider)), ...heldPaths])
  let app: RunningApp | undefined
  let browser: E2EBrowser | undefined
  const stop = async (): Promise<void> => {
    await destroySession(browser)
    await app?.stop()
    await mock.stop()
  }
  try {
    app = await startApp(appOptions)
    await seedRawAppState(app.home, {
      customProviders: providers.map((entry) => ({ ...mockProviderConfig(entry.provider, mock.url), ...entry.config })),
    })
    browser = await createSession(app.binary, app.port)
    await waitFor(browser, 'header.tab-bar', 60_000)
    await pickModel(browser, provider.name, provider.modelName)
    const { binary, port } = app
    const relaunch = async (): Promise<E2EBrowser> => {
      await destroySession(browser)
      browser = undefined
      const next = await createSession(binary, port)
      browser = next
      await waitFor(next, 'header.tab-bar', 60_000)
      return next
    }
    return {
      mock,
      app,
      get browser () {
        if (!browser) throw new Error('No e2e session: relaunch() failed')
        return browser
      },
      relaunch,
      stop,
    }
  } catch (err) {
    await stop()
    throw err
  }
}
