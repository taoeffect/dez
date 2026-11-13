import { expect } from 'vitest'
import { startApp, type AppOptions, type RunningApp } from './app'
import { click, consoleErrors, waitFor, waitForValue } from './dom'
import { seedRawAppState } from './fixtures'
import { mockChatPath, mockProviderConfig, startHoldingChatMock, type HeldRequest, type HoldingChatMock, type MockProvider } from './mockServer'
import { createSession, destroySession, type E2EBrowser } from './session'
import { openToasts, pickModel, threadSections, type ThreadSection } from './thread'

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
  /** GET paths that the mock answers with JSON at once, such as the model
   *  list of a provider whose config has `fetchModels: true`. */
  jsonAnswers?: Readonly<Record<string, unknown>>
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
  const { moreProviders = [], heldPaths = [], jsonAnswers = {}, ...appOptions } = options
  const providers = [{ provider, config }, ...moreProviders]
  const mock = await startHoldingChatMock([...providers.map((entry) => mockChatPath(entry.provider)), ...heldPaths], jsonAnswers)
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

// The checks of a request that a test took: its body holds no path of the
// test HOME, and it is `json` when that is given.
function checkedRequest (setup: MockProviderApp, request: HeldRequest, json: unknown): HeldRequest {
  expect(request.body).not.toContain(setup.app.home)
  if (json !== undefined) expect(JSON.parse(request.body)).toStrictEqual(json)
  return request
}

/** Takes the next held request, and checks that it goes to `requestPath`
 *  and that its body holds no path of the test HOME. When `json` is given,
 *  the body must be that JSON. */
export async function takeRequest (setup: MockProviderApp, requestPath: string, json?: unknown): Promise<HeldRequest> {
  const request = await setup.mock.waitForRequest(setup.browser)
  expect(request.path).toBe(requestPath)
  return checkedRequest(setup, request, json)
}

/** Takes the oldest held request to `requestPath`, with the checks of
 *  `takeRequest`. For requests that the app sends at the same time, which
 *  come in any order: the request of a job and the next chat request. */
export async function takeRequestTo (setup: MockProviderApp, requestPath: string, json?: unknown): Promise<HeldRequest> {
  return checkedRequest(setup, await setup.mock.waitForRequest(setup.browser, requestPath), json)
}

/** Checks that a submit got the "Cannot send" error toast with `message`
 *  and sent no request: the thread is `thread`, and the one console error
 *  is the refusal. Then closes the toast. */
export async function expectSendRefused (setup: MockProviderApp, message: string, thread: ThreadSection[]): Promise<void> {
  const { browser } = setup
  await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message }])
  expect(await threadSections(browser)).toStrictEqual(thread)
  expect(setup.mock.hasWaitingRequest()).toBe(false)
  expect(await consoleErrors(browser)).toStrictEqual([`Cannot send: ${message}`])
  // The card of an earlier toast can still be closing.
  await click(browser, '.toast-card--error:not(.toast-card--closing) .toast-close')
  await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
}
