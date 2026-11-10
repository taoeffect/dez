import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { conversationFilePath } from './harness/fixtures'
import { shownImages, solidPng } from './harness/images'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, newTab, openToasts, pickModel, submit, threadSections, waitForThread } from './harness/thread'

// Image replies, driven through the real app against a mock of Venice's
// media API (`mediaApi: { format: 'venice' }`):
// - a reply of an image model is one request to `/image/generate` with the
//   last user message as its prompt; each image of the answer is saved in
//   the generated image folder, the reply holds a reference to it with a
//   new image id, and the editor shows it;
// - an edit model's request to `/image/multi-edit` takes the newest image of
//   the conversation when the last user message has none, as a data URL
//   with no path;
// - Stop during the request leaves no file and no agent section;
// - a model that Dez has no request for gets an error toast, and no request
//   goes.
//
// One app session serves the whole file; each test starts in a new tab.

const PAINTER: MockProvider = { id: 'painter', name: 'Painter Mock', modelId: 'paint-model', modelName: 'Paint Model' }
const EDIT_MODEL = { id: 'edit-model', name: 'Edit Model' }
const UPSCALE_MODEL = { id: 'upscale-model', name: 'Upscale Model' }
const GENERATE_PATH = `/${PAINTER.id}/v1/image/generate`
const EDIT_PATH = `/${PAINTER.id}/v1/image/multi-edit`

const GENERATED_PNG = solidPng(36, 20, [40, 160, 60])
const EDITED_PNG = solidPng(20, 36, [200, 120, 20])
const STORED_IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

describe('image generation', () => {
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

  // The file names in the generated image folder that are not in `before`,
  // once there are `count` of them.
  async function newGeneratedImages (before: string[], count: number): Promise<string[]> {
    const added = async () => (await generatedImages()).filter((name) => !before.includes(name))
    await waitForValue(browser, 'generated image files', async () => (await added()).length, count)
    return await added()
  }

  function answer (reply: http.ServerResponse, contentType: string, body: string | Buffer): void {
    reply.writeHead(200, { 'Content-Type': contentType })
    reply.end(body)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PAINTER, {
      mediaApi: { format: 'venice' },
      models: [
        { id: PAINTER.modelId, name: PAINTER.modelName, outputs: ['image'], request: 'image' },
        { id: EDIT_MODEL.id, name: EDIT_MODEL.name, outputs: ['image'], request: 'imageEdit' },
        { id: UPSCALE_MODEL.id, name: UPSCALE_MODEL.name, outputs: ['image'], request: 'none' },
      ],
    }, { heldPaths: [GENERATE_PATH, EDIT_PATH] })
    browser = setup.browser
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('makes an image, then edits the newest image of the conversation', async () => {
    const before = await generatedImages()
    await pickModel(browser, PAINTER.name, PAINTER.modelName)
    await submit(browser, 'Draw a fox')

    const generate = await setup.mock.waitForRequest(browser)
    expect(generate.path).toBe(GENERATE_PATH)
    expect(JSON.parse(generate.body)).toEqual({ model: PAINTER.modelId, prompt: 'Draw a fox', format: 'webp' })
    answer(generate.reply, 'application/json', JSON.stringify({ images: [GENERATED_PNG.toString('base64')] }))

    const [generatedName] = await newGeneratedImages(before, 1)
    expect(generatedName).toMatch(STORED_IMAGE_NAME)
    const generatedPath = path.join(generatedDir(), generatedName)
    expect(await fs.promises.readFile(generatedPath)).toEqual(GENERATED_PNG)
    const generatedReference = `![${generatedPath}](id=a)`
    await waitForThread(browser, [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: generatedReference },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: generatedName, width: 36, height: 20 }])
    const file = conversationFilePath(setup.app.home, await activeConversationId(browser))
    await waitForValue(browser, 'saved reference', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(generatedReference), true)

    // The last user message has no image, so the edit takes the generated one.
    await pickModel(browser, PAINTER.name, EDIT_MODEL.name)
    await submit(browser, 'Make it orange')

    const edit = await setup.mock.waitForRequest(browser)
    expect(edit.path).toBe(EDIT_PATH)
    expect(JSON.parse(edit.body)).toEqual({
      modelId: EDIT_MODEL.id,
      prompt: 'Make it orange',
      images: [`data:image/png;base64,${GENERATED_PNG.toString('base64')}`],
    })
    expect(edit.body).not.toContain(setup.app.home)
    // The edit endpoint answers the bytes of one image.
    answer(edit.reply, 'image/png', EDITED_PNG)

    const [editedName] = await newGeneratedImages([...before, generatedName], 1)
    const editedPath = path.join(generatedDir(), editedName)
    expect(await fs.promises.readFile(editedPath)).toEqual(EDITED_PNG)
    await waitForThread(browser, [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: generatedReference },
      { role: 'user', text: 'Make it orange' },
      { role: 'agent', text: `![${editedPath}](id=b)` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [
      { alt: generatedName, width: 36, height: 20 },
      { alt: editedName, width: 20, height: 36 },
    ])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('leaves no file and no agent section when the user stops a request that has begun its answer', async () => {
    const before = await generatedImages()
    await pickModel(browser, PAINTER.name, PAINTER.modelName)
    await submit(browser, 'Draw a cat')

    const request = await setup.mock.waitForRequest(browser)
    request.reply.writeHead(200, { 'Content-Type': 'application/json' })
    request.reply.write(`{"images":["${GENERATED_PNG.toString('base64').slice(0, 24)}`)
    await waitForValue(browser, 'agent section', async () => (await threadSections(browser)).length, 2)
    // While a reply runs, the Submit button stops it.
    await pointerClick(browser, '.submit-button')

    await waitForValue(browser, 'request closed', async () => request.closed, true)
    await waitForThread(browser, [{ role: 'user', text: 'Draw a cat' }])
    expect(await generatedImages()).toEqual(before)
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('refuses a model that Dez has no request for with an error toast, and sends nothing', async () => {
    const message = 'Dez cannot use Upscale Model yet. It makes image output through an API that Dez does not support.'
    await pickModel(browser, PAINTER.name, UPSCALE_MODEL.name)
    await submit(browser, 'Upscale it')

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message }])
    expect(await threadSections(browser)).toEqual([{ role: 'user', text: 'Upscale it' }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toEqual([`Cannot send: ${message}`])

    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })
})
