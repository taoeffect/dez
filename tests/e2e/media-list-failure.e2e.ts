import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ModelCache } from '../../src/model/persistence/types'
import { click, closeSettings, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { readModelCache } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { MockProvider } from './harness/mockServer'
import { closePopup, openPopup, popupOpen, popupView, type ParameterRow } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { pickModel, sbpCall } from './harness/thread'

// The parameters of a model whose provider has model lists of its media
// API, driven through the real app against a mock of OpenRouter's
// (`mediaApi: { format: 'openrouter' }`): the lengths of a video model come
// only from the list of the video API (`/videos/models`).
// - when that list fails at a later model check, the provider settings
//   popup still shows the lengths that an earlier check read, also after an
//   app restart;
// - the next list that loads replaces them.

const FILMS: MockProvider = { id: 'router-films', name: 'Router Films Mock', modelId: 'film-model', modelName: 'Film Model' }
const MODEL_LIST_PATH = `/${FILMS.id}/v1/models`
const VIDEO_LIST_PATH = `/${FILMS.id}/v1/videos/models`
const IMAGE_LIST_PATH = `/${FILMS.id}/v1/images/models`
const PROVIDER_ROW = `.provider-row[data-provider-id="${FILMS.id}"]`

describe('model parameters after a media model list that fails', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // What the mock answers to a GET of each path. The mock reads this object
  // at each request, and a path that is not in it gets a 404.
  const answers: Record<string, unknown> = {
    [MODEL_LIST_PATH]: { data: [{ id: FILMS.modelId, name: FILMS.modelName, type: 'video' }] },
    [VIDEO_LIST_PATH]: { data: [{ id: FILMS.modelId, supported_durations: [8, 4] }] },
    [IMAGE_LIST_PATH]: { data: [] },
  }

  async function lastCheckedAt (): Promise<number> {
    const cache = await sbpCall(browser, 'dez.model/modelCache/snapshot') as ModelCache
    return cache.providers[FILMS.id]?.lastCheckedAt ?? 0
  }

  // "Check again" in Settings › Providers, for the mock provider. Returns
  // when the model cache has the result of the check.
  async function checkAgain (): Promise<void> {
    const before = await lastCheckedAt()
    await sbpCall(browser, 'dez.model/settings/open', 'providers')
    await waitFor(browser, PROVIDER_ROW, 10_000)
    await click(browser, PROVIDER_ROW)
    await waitFor(browser, '.provider-check-btn', 10_000)
    await click(browser, '.provider-check-btn')
    await waitForValue(browser, 'a newer model check', async () => await lastCheckedAt() > before, true)
    await closeSettings(browser)
  }

  // Opens the provider settings popup and waits for these parameter rows.
  async function waitForRows (label: string, rows: ParameterRow[]): Promise<void> {
    await openPopup(browser)
    await waitForValue(browser, label, async () => (await popupView(browser)).rows, rows)
    await closePopup(browser)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(FILMS, {
      mediaApi: { format: 'openrouter' },
      // Every model comes from the list of the mock.
      fetchModels: true,
      models: [],
      modelOutputs: { path: 'type', values: { video: { outputs: ['video'], request: 'video' } } },
    }, { jsonAnswers: answers })
    browser = setup.browser
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    // A test that fails can leave the popup open.
    if (await popupOpen(browser)) await closePopup(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('keeps the lengths of a video model while the list of the video API fails, also after a restart, until a list loads again', async () => {
    // The model's entry lists no frames, so it takes its images only as
    // references.
    const imagesAs: ParameterRow = { name: 'images_as', label: 'Images as', options: ['references'], picked: 'references' }
    const lengths: ParameterRow[] = [{ name: 'duration', label: 'Length (seconds)', options: ['4', '8'], picked: '4' }, imagesAs]
    await resetConsoleErrors(browser)
    await waitForRows('lengths of the first check', lengths)

    delete answers[VIDEO_LIST_PATH]
    await checkAgain()
    await waitForRows('lengths after the list failed', lengths)
    const errors = await consoleErrors(browser)
    expect(errors).toHaveLength(1)
    expect(errors[0].startsWith(`Failed to list the media models of provider ${FILMS.id}:`)).toBe(true)

    // The lengths are in model_cache.json, which the app saves a moment
    // after a check: a new app session reads them from the file, and its
    // own check gets no list either.
    await waitForValue(browser, 'the failed check in model_cache.json', async () => (await readModelCache(setup.app.home))?.providers[FILMS.id]?.lastCheckedAt, await lastCheckedAt())
    browser = await setup.relaunch()
    await pickModel(browser, FILMS.name, FILMS.modelName)
    await waitForRows('lengths after the restart', lengths)
    await checkAgain()
    await waitForRows('lengths after the list failed in the new session', lengths)

    answers[VIDEO_LIST_PATH] = { data: [{ id: FILMS.modelId, supported_durations: [6] }] }
    await checkAgain()
    await waitForRows('lengths of the list that loaded', [{ name: 'duration', label: 'Length (seconds)', options: ['6'], picked: '6' }, imagesAs])
  })
})
