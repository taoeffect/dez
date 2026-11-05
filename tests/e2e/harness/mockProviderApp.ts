import { startApp, type RunningApp } from './app'
import { waitFor } from './dom'
import { seedRawAppState } from './fixtures'
import { mockChatPath, mockProviderConfig, startHoldingChatMock, type HoldingChatMock, type MockProvider } from './mockServer'
import { createSession, destroySession, type E2EBrowser } from './session'
import { pickModel } from './thread'

export interface MockProviderApp {
  mock: HoldingChatMock
  app: RunningApp
  browser: E2EBrowser
  /** Ends the session, then stops the app and the mock. */
  stop: () => Promise<void>
}

/**
 * The setup of a spec file whose tests answer each chat request
 * themselves: starts a holding chat mock for `provider`, then the app with
 * `provider` as its only custom provider, and picks the provider's model.
 * `config` adds to or replaces fields of the provider's config, such as
 * `thinking`. One app session then serves the whole file. On a failure it
 * stops what it started, then throws.
 */
export async function startMockProviderApp (provider: MockProvider, config: Record<string, unknown> = {}): Promise<MockProviderApp> {
  const mock = await startHoldingChatMock(mockChatPath(provider))
  let app: RunningApp | undefined
  let browser: E2EBrowser | undefined
  const stop = async (): Promise<void> => {
    await destroySession(browser)
    await app?.stop()
    await mock.stop()
  }
  try {
    app = await startApp()
    await seedRawAppState(app.home, { customProviders: [{ ...mockProviderConfig(provider, mock.url), ...config }] })
    browser = await createSession(app.binary, app.port)
    await waitFor(browser, 'header.tab-bar', 60_000)
    await pickModel(browser, provider.name, provider.modelName)
    return { mock, app, browser, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
