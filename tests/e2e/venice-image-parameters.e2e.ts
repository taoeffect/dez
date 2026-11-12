import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { pasteImageReference, pngDataUrl, solidPng } from './harness/images'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, type MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView, type PopupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { focusEditor, newTab, pickModel, submit, threadSections } from './harness/thread'

// The options of Venice image models, driven through the real app against
// a mock of Venice's media API (`mediaApi: { format: 'venice' }`). The mock
// also serves the model list, in the form of Venice's list: the aspect
// ratios, resolutions, and qualities of a model are in its entry, and a
// config model has no entry.
// - the provider settings popup shows the options of a model that makes
//   images, with the defaults of its entry; the options that the user
//   picks and the defaults of the others go into the `/image/generate`
//   request, after its fixed fields;
// - a list with no default shows "Default", and its field does not go into
//   the `/image/multi-edit` request of an edit model.
// (`image-generation.e2e.ts` has the requests of models with no entry.)
//
// One app session serves the whole file; each test starts in a new tab.

const CANVAS: MockProvider = { id: 'canvas', name: 'Canvas Mock', modelId: 'canvas-model', modelName: 'Canvas Model' }
const EDIT_MODEL = { id: 'canvas-edit', name: 'Canvas Edit' }
const GENERATE_PATH = `/${CANVAS.id}/v1/image/generate`
const EDIT_PATH = `/${CANVAS.id}/v1/image/multi-edit`

// Two entries in the form of Venice's lists (2026-11-11), with fewer
// options: a model like `krea-3`, and an edit model like
// `qwen-image-2-1-turbo-edit`, whose list of aspect ratios names no default
// (an edit with none takes the one of its first image).
const MODEL_LIST = {
  object: 'list',
  data: [
    {
      id: CANVAS.modelId,
      name: CANVAS.modelName,
      type: 'image',
      model_spec: {
        constraints: {
          aspectRatios: ['1:1', '16:9', '9:16'],
          resolutions: ['1K', '2K', '4K'],
          qualities: ['medium', 'high'],
          defaultAspectRatio: '1:1',
          defaultResolution: '1K',
          defaultQuality: 'high',
        },
      },
    },
    {
      id: EDIT_MODEL.id,
      name: EDIT_MODEL.name,
      type: 'inpaint',
      model_spec: {
        constraints: {
          aspectRatios: ['auto', '1:1', '16:9'],
          resolutions: ['1K', '2K'],
          defaultResolution: '1K',
          maxInputImages: 6,
        },
      },
    },
  ],
}

// The shorter side has the 256 pixels that Venice's edit API asks for, so
// the image goes as its own bytes.
const INPUT_PNG = solidPng(320, 256, [40, 160, 60])
const OUTPUT_PNG = solidPng(24, 24, [200, 120, 20])

describe('venice image parameters', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  beforeAll(async () => {
    setup = await startMockProviderApp(CANVAS, {
      mediaApi: { format: 'venice' },
      // Every model comes from the list of the mock.
      fetchModels: true,
      models: [],
      modelOutputs: {
        path: 'type',
        values: {
          image: { outputs: ['image'], request: 'image' },
          inpaint: { outputs: ['image'], request: 'imageEdit' },
        },
      },
    }, {
      heldPaths: [GENERATE_PATH, EDIT_PATH],
      jsonAnswers: { [`/${CANVAS.id}/v1/models`]: MODEL_LIST },
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
  })

  it('shows the options of an image model with the defaults of its entry, and sends the picked ones and the defaults', async () => {
    const defaults: PopupView = {
      headers: ['Model Parameters'],
      rows: [
        { name: 'aspect_ratio', label: 'Aspect ratio', options: ['1:1', '16:9', '9:16'], picked: '1:1' },
        { name: 'resolution', label: 'Resolution', options: ['1K', '2K', '4K'], picked: '1K' },
        { name: 'quality', label: 'Quality', options: ['medium', 'high'], picked: 'high' },
      ],
      hint: null,
      reset: true,
    }
    await pickModel(browser, CANVAS.name, CANVAS.modelName)
    await openPopup(browser)
    await waitForValue(browser, 'popup of the image model', () => popupView(browser), defaults)

    await changeParameterField(browser, 'aspect_ratio', '16:9', 'option')
    await changeParameterField(browser, 'quality', 'medium', 'option')
    await waitForValue(browser, 'popup with the options of the user', () => popupView(browser), {
      ...defaults,
      rows: [
        { name: 'aspect_ratio', label: 'Aspect ratio', options: ['1:1', '16:9', '9:16'], picked: '16:9' },
        defaults.rows[1],
        { name: 'quality', label: 'Quality', options: ['medium', 'high'], picked: 'medium' },
      ],
    })
    await closePopup(browser)

    await submit(browser, 'Draw a fox')
    const generate = await setup.mock.waitForRequest(browser)
    expect(generate.path).toBe(GENERATE_PATH)
    expect(JSON.parse(generate.body)).toStrictEqual({
      model: CANVAS.modelId,
      prompt: 'Draw a fox',
      format: 'webp',
      hide_watermark: true,
      safe_mode: false,
      aspect_ratio: '16:9',
      resolution: '1K',
      quality: 'medium',
    })
    answerHeld(generate.reply, 'application/json', JSON.stringify({ images: [OUTPUT_PNG.toString('base64')] }))

    await waitForValue(browser, 'sections of the reply', async () => (await threadSections(browser)).map((section) => section.role), ['user', 'agent', 'user'])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows "Default" for a list with no default, and sends no field for it in an edit', async () => {
    await pickModel(browser, CANVAS.name, EDIT_MODEL.name)
    await openPopup(browser)
    await waitForValue(browser, 'popup of the edit model', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'aspect_ratio', label: 'Aspect ratio', options: ['Default', 'auto', '1:1', '16:9'], picked: 'Default' },
        { name: 'resolution', label: 'Resolution', options: ['1K', '2K'], picked: '1K' },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)

    await focusEditor(browser)
    await pasteImageReference(browser, INPUT_PNG, 'a')
    await submit(browser, '')

    const edit = await setup.mock.waitForRequest(browser)
    expect(edit.path).toBe(EDIT_PATH)
    expect(JSON.parse(edit.body)).toStrictEqual({
      modelId: EDIT_MODEL.id,
      prompt: '![image](id=a)',
      images: [pngDataUrl(INPUT_PNG)],
      safe_mode: false,
      resolution: '1K',
    })
    answerHeld(edit.reply, 'image/png', OUTPUT_PNG)

    await waitForValue(browser, 'sections of the reply', async () => (await threadSections(browser)).map((section) => section.role), ['user', 'agent', 'user'])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
