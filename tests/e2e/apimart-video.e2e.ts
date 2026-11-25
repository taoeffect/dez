import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { MP4_VIDEO, shownPlayers, startClipServer, type ClipServer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockModelKey, type MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { activeTabId, closeToasts, newTab, openToasts, pickModel, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// Video models of APIMart, driven through the real app against a mock of
// its API (`mediaApi: { format: 'apimart' }`). The mock serves the model
// list in the form of APIMart's list, with the schema of each model's
// request (`?expand=parameters`), the account price of a request, and the
// state of each task.
// - the popup shows the rows that the docs tell for a model that Dez knows
//   (MiniMax-H3), and the rows of the schema for any other model;
// - a request is one POST to `/videos/generations` with the values of the
//   rows (a whole-number text as a number); the app asks for the state of
//   its task, copies the file of the done task, and shows a player; the
//   cost of the tab is the cost of the task, not the quote;
// - a task that failed shows an error toast with the task id, and costs
//   what the task tells (APIMart gives the money back).
//
// One app session serves the whole file; each test starts in a new tab.

// The id `apimart` is the id of the built-in provider.
const MART: MockProvider = { id: 'mart', name: 'Mart Mock', modelId: 'MiniMax-H3', modelName: 'MiniMax-H3' }
const GENERAL_MODEL = 'kling-v3'
const SUBMIT_PATH = `/${MART.id}/v1/videos/generations`
const taskPath = (taskId: string) => `/${MART.id}/v1/tasks/${taskId}?language=en`
const quotePath = (query: string) => `/${MART.id}/v1/pricing/model?${query}`

// The general schema of almost all video models (kling-v3 in the live
// list, 2026-11-24, with the descriptions and some image fields cut).
const GENERAL_SCHEMA = {
  model: { type: 'string' },
  prompt: { type: 'string' },
  aspect_ratio: { type: 'string' },
  duration: { minimum: 1, type: 'integer' },
  first_frame_image: { type: 'string' },
  generate_audio: { type: 'boolean' },
  image_urls: { items: { type: 'string' }, minItems: 1, type: 'array' },
  quality: { type: 'string' },
  resolution: { type: 'string' },
  seed: { type: 'integer' },
  timestamps: { type: 'string' },
  webhook: { type: 'string' },
}

const videoEntry = (id: string) => ({
  id,
  object: 'model',
  created: 1626777600,
  owned_by: 'custom',
  supported_endpoint_types: ['openai'],
  category: 'video',
  capability_tags: ['Image to Video', 'Text to Video'],
  parameters: { endpoint: '/v1/videos/generations', method: 'POST', input_schema: { type: 'object', properties: GENERAL_SCHEMA } },
})

const MODEL_LIST = { object: 'list', success: true, data: [videoEntry(MART.modelId), videoEntry(GENERAL_MODEL)] }

// An answer of the account price request (live, 2026-11-24).
const quote = (model: string, totalUsd: number) =>
  ({ billing_type: 'per_second', canonical_model: model, currency: 'USD', estimated: false, model, total_usd: totalUsd, unit: 'per_second' })

const submitted = (taskId: string) => JSON.stringify({ code: 200, data: [{ status: 'submitted', task_id: taskId }] })

describe('APIMart video models', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let clips: ClipServer

  beforeAll(async () => {
    clips = await startClipServer({ 'fox.mp4': { type: 'video/mp4', bytes: MP4_VIDEO } })
    setup = await startMockProviderApp(MART, {
      mediaApi: { format: 'apimart' },
      // Every model comes from the list of the mock.
      fetchModels: true,
      models: [],
      modelListQuery: { expand: 'parameters' },
      modelOutputs: { path: 'category', values: { video: { outputs: ['video'], request: 'video' } } },
    }, {
      heldPaths: [SUBMIT_PATH],
      jsonAnswers: {
        [`/${MART.id}/v1/models?expand=parameters`]: MODEL_LIST,
        // The free price request that goes before each request.
        [quotePath('model=MiniMax-H3&duration=4&resolution=768P')]: quote(MART.modelId, 0.22848),
        [quotePath('model=kling-v3&duration=5')]: quote(GENERAL_MODEL, 0.336),
        // The state of each task, which the app asks for 5 seconds after
        // the request.
        [taskPath('task-done')]: {
          code: 200,
          data: { id: 'task-done', status: 'completed', progress: 100, cost: 0.3, result: { videos: [{ url: [clips.clipUrl('fox.mp4')], expires_at: 1763174708 }] } },
        },
        [taskPath('task-failed')]: {
          code: 200,
          data: { id: 'task-failed', status: 'failed', progress: 0, cost: 0, error: { code: 400, message: 'The prompt breaks the content rules' } },
        },
      },
    })
    browser = setup.browser
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    // A test that fails can leave the popup open.
    if (await popupOpen(browser)) await closePopup(browser)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
    await clips?.stop()
  })

  it('shows the rows that the docs tell for a model that Dez knows, and the rows of the schema for another model', async () => {
    await pickModel(browser, MART.name, MART.modelName)
    await openPopup(browser)
    // The lowest length and resolution are the defaults.
    await waitForValue(browser, 'popup of MiniMax-H3', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'duration', label: 'Length (seconds)', number: '4', min: '4', max: '15', step: '1' },
        { name: 'resolution', label: 'Resolution', options: ['768P', '2K'], picked: '768P' },
        { name: 'aspect_ratio', label: 'Aspect ratio', options: ['Default', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], picked: 'Default' },
        { name: 'watermark', label: 'Watermark', on: false },
        { name: 'nsfw_check', label: 'Moderation check', on: false },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)

    // No row for the fields that Dez fills or never sends (the prompt, the
    // images, the webhook).
    await pickModel(browser, MART.name, GENERAL_MODEL)
    await openPopup(browser)
    await waitForValue(browser, 'popup of a model with the general schema', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'aspect_ratio', label: 'Aspect ratio', text: '' },
        { name: 'duration', label: 'Length (seconds)', text: '' },
        { name: 'generate_audio', label: 'Audio', on: false },
        { name: 'quality', label: 'Quality', text: '' },
        { name: 'resolution', label: 'Resolution', text: '' },
        { name: 'seed', label: 'Seed', text: '' },
        { name: 'timestamps', label: 'Timestamps', text: '' },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the values of the rows, asks for the state of the task, and shows the video of its file at the cost of the task', async () => {
    const prompt = 'A fox runs through deep snow'
    await pickModel(browser, MART.name, GENERAL_MODEL)
    await openPopup(browser)
    await changeParameterField(browser, 'duration', '5', 'text')
    await changeParameterField(browser, 'seed', '42', 'text')
    await click(browser, '.provider-settings-popup [data-parameter="generate_audio"]')
    await waitForValue(browser, 'rows with the values of the user', async () => (await popupView(browser)).rows.slice(1, 3), [
      { name: 'duration', label: 'Length (seconds)', text: '5' },
      { name: 'generate_audio', label: 'Audio', on: true },
    ])
    await closePopup(browser)
    await submit(browser, prompt)

    // The texts of the whole-number fields go as numbers.
    const request = await takeRequest(setup, SUBMIT_PATH, { duration: 5, seed: 42, generate_audio: true, model: GENERAL_MODEL, prompt })
    answerHeld(request.reply, 'application/json', submitted('task-done'))
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const reply = (await threadSections(browser))[1].text
    // The tag keeps the task id, the only way back to a paid clip.
    expect(reply).toMatch(new RegExp(String.raw`^<dez:video id="a" type="video/mp4" src="[^"]+\.mp4" expires="[^"]+" model="${mockModelKey(MART, GENERAL_MODEL)}" job="task-done"/>$`))
    await waitForThread(browser, [
      { role: 'user', text: prompt },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'player of the video', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: 'Not saved', save: 'save' },
    ])
    // The cost of the task, not the quote ($0.336).
    expect(await sbpCall(browser, 'dez.model/tabs/costNumbers', await activeTabId(browser))).toEqual({ cost: { usd: 0.3, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tells the user about a task that failed, with its id, and counts the cost that the task tells', async () => {
    const prompt = 'A fox in the rain'
    await pickModel(browser, MART.name, MART.modelName)
    await submit(browser, prompt)

    // The lowest length and resolution of the model go with no choice.
    const request = await takeRequest(setup, SUBMIT_PATH, { duration: 4, resolution: '768P', model: MART.modelId, prompt })
    answerHeld(request.reply, 'application/json', submitted('task-failed'))
    await waitForValue(browser, 'error toast of the task', async () => {
      const [toast] = await openToasts(browser, 'error')
      return toast !== undefined && toast.message.includes('Mart Mock did not make the clip.') && toast.message.includes('task-failed') && toast.message.includes('State: failed: The prompt breaks the content rules')
    }, true)
    // APIMart gave the money back: the quote ($0.22848) does not count.
    expect(await sbpCall(browser, 'dez.model/tabs/costNumbers', await activeTabId(browser))).toEqual({ cost: { usd: 0, requests: 1, unpriced: 0 } })
    await closeToasts(browser)
  })
})
