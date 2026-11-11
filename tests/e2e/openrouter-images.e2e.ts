import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { unstoredOutputMessage } from '../../src/model/providers/unusableModel'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { pasteImage, pngDataUrl, shownImages, solidPng } from './harness/images'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { focusEditor, newTab, openToasts, pickModel, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// The image-only models of OpenRouter, driven through the real app against
// a mock of OpenRouter's image API (`mediaApi: { format: 'openrouter' }`):
// - a reply is one request to `/images` with the last user message as its
//   prompt and no field that the user did not choose; the image of the
//   JSON answer (`data[].b64_json`) is saved in the generated image folder,
//   and the reply holds a reference to it with a new image id;
// - the provider settings popup shows the fields of the model's entry in
//   the image list (`/images/models`), with the model's own default; a
//   value that the user picks goes into the request;
// - the images of the message go as reference images (`input_references`,
//   data URLs with no path); a model that takes fewer gets the first ones,
//   and a warning toast tells of the rest;
// - a model that needs a reference image, with none in the conversation,
//   and a model that makes only SVG images get an error toast that tells
//   what to do, and no request goes.
//
// One app session serves the whole file; each test starts in a new tab.

const ROUTER: MockProvider = { id: 'router-paint', name: 'Router Paint Mock', modelId: 'flux-model', modelName: 'Flux Model' }
// Takes up to 4 reference images, and none is needed.
const FLUX = { id: ROUTER.modelId, name: ROUTER.modelName }
// Makes its image from exactly one reference image.
const STYLE_MODEL = { id: 'style-model', name: 'Style Model' }
// Makes only SVG files, which Dez does not store.
const VECTOR_MODEL = { id: 'vector-model', name: 'Vector Model' }
const IMAGES_PATH = `/${ROUTER.id}/v1/images`
// The entries of the image list, in the shape of OpenRouter's (2026-11-11).
const IMAGE_LIST = {
  data: [
    {
      id: FLUX.id,
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K'] },
        aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
        output_format: { type: 'enum', values: ['jpeg', 'png'] },
        input_references: { type: 'range', min: 0, max: 4 },
        seed: { type: 'boolean' },
      },
    },
    { id: STYLE_MODEL.id, supported_parameters: { input_references: { type: 'range', min: 1, max: 1 } } },
    { id: VECTOR_MODEL.id, supported_parameters: { output_format: { type: 'enum', values: ['svg'] } } },
  ],
}
const MADE_PNG = solidPng(24, 16, [40, 160, 60])
const PASTED_PNG = solidPng(20, 20, [200, 60, 60])
const SECOND_PNG = solidPng(20, 20, [60, 60, 200])
const STORED_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

describe('images of the OpenRouter image API', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  function generatedDir (): string {
    return path.join(setup.app.home, '.config', 'dez', 'assets', 'generated', 'images')
  }

  async function generatedImages (): Promise<string[]> {
    try {
      return (await fs.promises.readdir(generatedDir())).sort()
    } catch {
      return []
    }
  }

  // The one new file name in the generated image folder, once it is there.
  async function newGeneratedImage (before: string[]): Promise<string> {
    const added = async () => (await generatedImages()).filter((name) => !before.includes(name))
    await waitForValue(browser, 'generated image files', async () => (await added()).length, 1)
    return (await added())[0]
  }

  // OpenRouter's answer: JSON with the image as base64, and its price.
  function answerImage (reply: http.ServerResponse, png: Buffer): void {
    reply.writeHead(200, { 'Content-Type': 'application/json' })
    reply.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.01 } }))
  }

  // Pastes `pngs` into the editor and returns the section text with their
  // references (ids a, b, …).
  async function pasteImages (pngs: Buffer[]): Promise<string> {
    await focusEditor(browser)
    for (const [index, png] of pngs.entries()) {
      await pasteImage(browser, png)
      const id = String.fromCharCode(97 + index)
      await waitForValue(browser, `pasted reference ${id}`, async () => (await threadSections(browser))[0]?.text.endsWith(`](id=${id})`) ?? false, true)
    }
    return (await threadSections(browser))[0].text
  }

  async function refusal (model: { name: string }, text: string, message: string): Promise<void> {
    await pickModel(browser, ROUTER.name, model.name)
    await submit(browser, text)

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message }])
    expect(await threadSections(browser)).toEqual([{ role: 'user', text }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toEqual([`Cannot send: ${message}`])
    await click(browser, '.toast-card--error:not(.toast-card--closing) .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(ROUTER, {
      mediaApi: { format: 'openrouter' },
      models: [FLUX, STYLE_MODEL, VECTOR_MODEL].map(({ id, name }) => ({ id, name, outputs: ['image'], request: 'image' })),
    }, {
      heldPaths: [IMAGES_PATH],
      jsonAnswers: { [`/${ROUTER.id}/v1/images/models`]: IMAGE_LIST, [`/${ROUTER.id}/v1/videos/models`]: { data: [] } },
    })
    browser = setup.browser
    // The rules of the reference images come with the model check of the
    // app start.
    await waitForValue(browser, 'image rules of the model check', async () =>
      (await sbpCall(browser, 'dez.model/modelCache/model', ROUTER.id, STYLE_MODEL.id) as { images?: unknown } | null)?.images, { maxImages: 1, minImages: 1 })
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

  it('makes an image from the prompt alone, with no field that the user did not choose', async () => {
    const before = await generatedImages()
    await pickModel(browser, ROUTER.name, FLUX.name)
    await submit(browser, 'Draw a fox')

    const request = await setup.mock.waitForRequest(browser)
    expect(request.path).toBe(IMAGES_PATH)
    expect(JSON.parse(request.body)).toEqual({ model: FLUX.id, prompt: 'Draw a fox' })
    answerImage(request.reply, MADE_PNG)

    const name = await newGeneratedImage(before)
    expect(name).toMatch(STORED_IMAGE_NAME)
    const file = path.join(generatedDir(), name)
    expect(await fs.promises.readFile(file)).toEqual(MADE_PNG)
    await waitForThread(browser, [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: `![${file}](id=a)` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: name, width: 24, height: 16 }])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('sends the images of the message as references, with the resolution that the user picked', async () => {
    await pickModel(browser, ROUTER.name, FLUX.name)
    await openPopup(browser)
    const row = (name: string, label: string, options: string[], picked = 'Default') => ({ name, label, options: ['Default', ...options], picked })
    const rows = [
      row('resolution', 'Resolution', ['1K', '2K']),
      row('aspect_ratio', 'Aspect ratio', ['1:1', '16:9']),
      row('output_format', 'Format', ['jpeg', 'png']),
    ]
    await waitForValue(browser, 'popup of the image model', async () => (await popupView(browser)).rows, rows)
    await changeParameterField(browser, 'resolution', '2K', 'option')
    await waitForValue(browser, 'popup with the resolution of the user', async () => (await popupView(browser)).rows, [row('resolution', 'Resolution', ['1K', '2K'], '2K'), ...rows.slice(1)])
    await closePopup(browser)

    const before = await generatedImages()
    const references = await pasteImages([PASTED_PNG, SECOND_PNG])
    await submit(browser, 'Mix them')

    const request = await setup.mock.waitForRequest(browser)
    expect(request.path).toBe(IMAGES_PATH)
    expect(JSON.parse(request.body)).toEqual({
      resolution: '2K',
      model: FLUX.id,
      prompt: '![image](id=a)![image](id=b)Mix them',
      input_references: [PASTED_PNG, SECOND_PNG].map((png) => ({ type: 'image_url', image_url: { url: pngDataUrl(png) } })),
    })
    expect(request.body).not.toContain(setup.app.home)
    answerImage(request.reply, MADE_PNG)

    const name = await newGeneratedImage(before)
    await waitForThread(browser, [
      { role: 'user', text: `${references}Mix them` },
      { role: 'agent', text: `![${path.join(generatedDir(), name)}](id=c)` },
      { role: 'user', text: '' },
    ])
    expect(await openToasts(browser, 'warning')).toEqual([])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('sends a model that takes one reference image the first image of the message, and tells of the other one', async () => {
    await pickModel(browser, ROUTER.name, STYLE_MODEL.name)
    const before = await generatedImages()
    const references = await pasteImages([PASTED_PNG, SECOND_PNG])
    await submit(browser, 'In this style')

    const request = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(request.body)).toEqual({
      model: STYLE_MODEL.id,
      prompt: '![image](id=a)![image](id=b)In this style',
      input_references: [{ type: 'image_url', image_url: { url: pngDataUrl(PASTED_PNG) } }],
    })
    await waitForValue(browser, 'warning toast', () => openToasts(browser, 'warning'), [{
      title: 'Image not sent',
      message: `${STYLE_MODEL.name} takes only 1 image, so 1 image was left out of the request.`,
    }])
    answerImage(request.reply, MADE_PNG)

    const name = await newGeneratedImage(before)
    await waitForThread(browser, [
      { role: 'user', text: `${references}In this style` },
      { role: 'agent', text: `![${path.join(generatedDir(), name)}](id=c)` },
      { role: 'user', text: '' },
    ])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('refuses a model that needs a reference image when the conversation has none, and sends nothing', async () => {
    await refusal(STYLE_MODEL, 'In this style', `${STYLE_MODEL.name} needs an input image. Paste an image, or name one with @id.`)
  })

  // The provider would bill an image that Dez cannot store.
  it('refuses a model that makes only SVG images, and sends nothing', async () => {
    await refusal(VECTOR_MODEL, 'Draw a logo', unstoredOutputMessage(VECTOR_MODEL.name, 'SVG'))
  })
})
