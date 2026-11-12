import fs from 'node:fs'
import path from 'node:path'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { unusableModelMessage } from '../../src/model/providers/unusableModel'
import { openAiChatBody } from './harness/chatBody'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { conversationFilePath, filesIn, newFileIn, storedFileName } from './harness/fixtures'
import { generatedImagesDir, pasteImageReference, pngDataUrl, shownImages, solidPng } from './harness/images'
import { expectSendRefused, startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockChatPath, startEventStream, writeChatFrame, type MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, focusEditor, newTab, openToasts, pickModel, submit, threadSections, waitForThread } from './harness/thread'

// Image replies, driven through the real app against a mock of Venice's
// media API (`mediaApi: { format: 'venice' }`) and of a chat API that
// makes images (`imageOutputBody`):
// - a reply of an image model is one request to `/image/generate` with the
//   last user message as its prompt, and with Venice's watermark and safe
//   mode off; each image of the answer is saved in the generated image
//   folder, the reply holds a reference to it with a new image id, and the
//   editor shows it;
// - an edit model's request to `/image/multi-edit` takes the newest image of
//   the conversation when the last user message has none, as a data URL
//   with no path; an image that passes the size rule of that API goes as
//   its own bytes;
// - an edit whose message names an image with `@a` takes that image, not
//   the newest one;
// - an edit of a message with more images than the model takes (3, when
//   the model list tells no count: Venice's rule) sends the first ones, and
//   a warning toast tells of the rest;
// - a chat model that also makes images gets the config's image output
//   fields in its chat request; each image of its streamed reply is saved
//   in the generated image folder and shown as a paragraph between the
//   reply's text, with a new image id; a later request sends it as text
//   with its id and no path, and as an image part when the user names it
//   with `@a`;
// - when the view followed a reply to its end, it stays at its bottom when
//   the reply's image loads after the end;
// - an upscale model's request to `/image/upscale` takes the image of the
//   message as bare base64, with the scale that the user picked in the
//   provider settings popup, the default creativity, and no text (the
//   popup tells so); the reply holds the larger image with a new id. With
//   no image in the conversation, an error toast tells what to do, and no
//   request goes;
// - Stop during the request leaves no file and no agent section;
// - a model that Dez has no request for gets an error toast, and no request
//   goes.
//
// One app session serves the whole file; each test starts in a new tab.

const PAINTER: MockProvider = { id: 'painter', name: 'Painter Mock', modelId: 'paint-model', modelName: 'Paint Model' }
const EDIT_MODEL = { id: 'edit-model', name: 'Edit Model' }
const UPSCALE_MODEL = { id: 'upscale-model', name: 'Upscale Model' }
// An image model of an API that Dez does not speak.
const SKETCH_MODEL = { id: 'sketch-model', name: 'Sketch Model' }
// A chat model that writes text and makes images in one reply.
const CHAT_MODEL = { id: 'chat-paint-model', name: 'Chat Paint Model' }
const GENERATE_PATH = `/${PAINTER.id}/v1/image/generate`
const EDIT_PATH = `/${PAINTER.id}/v1/image/multi-edit`
const UPSCALE_PATH = `/${PAINTER.id}/v1/image/upscale`
// The image that the edit requests take. Its shorter side has the 256
// pixels that Venice's edit API asks for, so it goes as it is; Dez sends a
// smaller image as a larger copy (tests/e2e/image-to-video.e2e.ts has the
// test of such a copy).
const GENERATED_PNG = solidPng(320, 256, [40, 160, 60])
const EDITED_PNG = solidPng(20, 36, [200, 120, 20])
const NEWEST_PNG = solidPng(28, 28, [150, 60, 180])
const TALL_PNG = solidPng(40, 300, [60, 90, 200])
// Both sides have the 256 pixels that Venice's upscale API asks for, so the
// image goes as it is.
const UPSCALE_INPUT_PNG = solidPng(256, 256, [220, 60, 60])
const UPSCALED_PNG = solidPng(512, 512, [220, 60, 60])
const STORED_IMAGE_NAME = storedFileName('png')

/** What a view at its bottom may still have below it: scroll positions
 *  can be fractions of a pixel. */
const AT_BOTTOM_PX = 1

describe('image generation', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  function generatedDir (): string {
    return generatedImagesDir(setup.app.home)
  }

  // Keeps the generated images that the editor shows from loading until
  // `releaseImageLoads`: their `src` waits in the page. So a test decides
  // when an image gets its size, which is otherwise a race with the
  // editor's own work.
  async function holdImageLoads (): Promise<void> {
    await browser.execute(() => {
      const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      const setSrc = src?.set
      if (!src || !setSrc) throw new Error('holdImageLoads: no src setter')
      const held: Array<[HTMLImageElement, string]> = []
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...src,
        set (this: HTMLImageElement, url: string) {
          if (url.includes('generated')) held.push([this, url])
          else setSrc.call(this, url)
        },
      })
      Reflect.set(window, '__e2eReleaseImageLoads', () => {
        Object.defineProperty(HTMLImageElement.prototype, 'src', src)
        for (const [img, url] of held) img.src = url
      })
    })
  }

  async function releaseImageLoads (): Promise<void> {
    await browser.execute(() => {
      const release = Reflect.get(window, '__e2eReleaseImageLoads') as (() => void) | undefined
      Reflect.deleteProperty(window, '__e2eReleaseImageLoads')
      release?.()
    })
  }

  // The distance from the bottom of the editor's view to the bottom of its
  // scrollable area, read two frames after the last change.
  async function viewFromBottom (): Promise<number> {
    return browser.execute(() => new Promise<number>((resolve, reject) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const scroll = document.querySelector<HTMLElement>('.cm-scroller')
        if (!scroll) reject(new Error('viewFromBottom: .cm-scroller not found'))
        else resolve(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight)
      }))
    }))
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PAINTER, {
      mediaApi: { format: 'venice' },
      imageOutputBody: { modalities: ['image', 'text'] },
      models: [
        { id: PAINTER.modelId, name: PAINTER.modelName, outputs: ['image'], request: 'image' },
        { id: EDIT_MODEL.id, name: EDIT_MODEL.name, outputs: ['image'], request: 'imageEdit' },
        { id: UPSCALE_MODEL.id, name: UPSCALE_MODEL.name, outputs: ['image'], request: 'upscale' },
        { id: SKETCH_MODEL.id, name: SKETCH_MODEL.name, outputs: ['image'], request: 'none' },
        { id: CHAT_MODEL.id, name: CHAT_MODEL.name, outputs: ['text', 'image'], request: 'chat' },
      ],
    }, { heldPaths: [GENERATE_PATH, EDIT_PATH, UPSCALE_PATH] })
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
    await releaseImageLoads()
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('makes an image, then edits the newest image of the conversation', async () => {
    const before = await filesIn(generatedDir())
    await pickModel(browser, PAINTER.name, PAINTER.modelName)
    await submit(browser, 'Draw a fox')

    const generate = await setup.mock.waitForRequest(browser)
    expect(generate.path).toBe(GENERATE_PATH)
    expect(JSON.parse(generate.body)).toEqual({ model: PAINTER.modelId, prompt: 'Draw a fox', format: 'webp', hide_watermark: true, safe_mode: false })
    answerHeld(generate.reply, 'application/json', JSON.stringify({ images: [GENERATED_PNG.toString('base64')] }))

    const generatedName = await newFileIn(browser, generatedDir(), before)
    expect(generatedName).toMatch(STORED_IMAGE_NAME)
    const generatedPath = path.join(generatedDir(), generatedName)
    expect(await fs.promises.readFile(generatedPath)).toEqual(GENERATED_PNG)
    const generatedReference = `![${generatedPath}](id=a)`
    await waitForThread(browser, [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: generatedReference },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: generatedName, width: 320, height: 256 }])
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
      images: [pngDataUrl(GENERATED_PNG)],
      safe_mode: false,
    })
    expect(edit.body).not.toContain(setup.app.home)
    // The edit endpoint answers the bytes of one image.
    answerHeld(edit.reply, 'image/png', EDITED_PNG)

    const editedName = await newFileIn(browser, generatedDir(), [...before, generatedName])
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
      { alt: generatedName, width: 320, height: 256 },
      { alt: editedName, width: 20, height: 36 },
    ])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('edits the image that the message names with `@a`, not the newest one', async () => {
    const before = await filesIn(generatedDir())
    await pickModel(browser, PAINTER.name, PAINTER.modelName)
    await submit(browser, 'Draw a fox')
    const fox = await setup.mock.waitForRequest(browser)
    answerHeld(fox.reply, 'application/json', JSON.stringify({ images: [GENERATED_PNG.toString('base64')] }))
    const foxName = await newFileIn(browser, generatedDir(), before)
    const foxReply = [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: `![${path.join(generatedDir(), foxName)}](id=a)` },
    ]
    await waitForThread(browser, [...foxReply, { role: 'user', text: '' }])

    await submit(browser, 'Draw a cat')
    const cat = await setup.mock.waitForRequest(browser)
    answerHeld(cat.reply, 'application/json', JSON.stringify({ images: [NEWEST_PNG.toString('base64')] }))
    const catName = await newFileIn(browser, generatedDir(), [...before, foxName])
    const catReply = [
      { role: 'user', text: 'Draw a cat' },
      { role: 'agent', text: `![${path.join(generatedDir(), catName)}](id=b)` },
    ]
    await waitForThread(browser, [...foxReply, ...catReply, { role: 'user', text: '' }])

    await pickModel(browser, PAINTER.name, EDIT_MODEL.name)
    await submit(browser, 'Edit @a to add an apple')

    const edit = await setup.mock.waitForRequest(browser)
    expect(edit.path).toBe(EDIT_PATH)
    // The mention stays in the prompt, and only the fox goes.
    expect(JSON.parse(edit.body)).toEqual({
      modelId: EDIT_MODEL.id,
      prompt: 'Edit @a to add an apple',
      images: [pngDataUrl(GENERATED_PNG)],
      safe_mode: false,
    })
    answerHeld(edit.reply, 'image/png', EDITED_PNG)

    const editedName = await newFileIn(browser, generatedDir(), [...before, foxName, catName])
    await waitForThread(browser, [
      ...foxReply,
      ...catReply,
      { role: 'user', text: 'Edit @a to add an apple' },
      { role: 'agent', text: `![${path.join(generatedDir(), editedName)}](id=c)` },
      { role: 'user', text: '' },
    ])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('sends an edit model the first 3 images of a message with 4, and tells of the one left out', async () => {
    // The shorter side has 256 pixels, so each image goes as its own bytes.
    const pngs = ([[200, 40, 40], [40, 160, 60], [40, 90, 220], [220, 200, 40]] as const)
      .map((rgb) => solidPng(320, 256, [...rgb]))
    await pickModel(browser, PAINTER.name, EDIT_MODEL.name)
    await focusEditor(browser)
    for (const [index, png] of pngs.entries()) await pasteImageReference(browser, png, String.fromCharCode(97 + index))
    const message = (await threadSections(browser))[0].text
    await submit(browser, '')

    const edit = await setup.mock.waitForRequest(browser)
    expect(edit.path).toBe(EDIT_PATH)
    expect(JSON.parse(edit.body)).toEqual({
      modelId: EDIT_MODEL.id,
      prompt: '![image](id=a)![image](id=b)![image](id=c)![image](id=d)',
      images: pngs.slice(0, 3).map(pngDataUrl),
      safe_mode: false,
    })
    await waitForValue(browser, 'warning toast', () => openToasts(browser, 'warning'), [{
      title: 'Image not sent',
      message: `${EDIT_MODEL.name} takes only 3 images, so 1 image was left out of the request.`,
    }])
    answerHeld(edit.reply, 'image/png', EDITED_PNG)

    await waitForValue(browser, 'sections after the edit', async () => (await threadSections(browser)).length, 3)
    expect((await threadSections(browser))[0].text).toBe(message)
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('shows the image of a chat reply between its text, and sends it back by its id', async () => {
    const chatModel = { ...PAINTER, modelId: CHAT_MODEL.id }
    // An image of a chat reply, as OpenRouter streams it: whole, in one
    // chunk.
    const imageFrame = (png: Buffer) => ({
      content: '',
      images: [{ type: 'image_url', image_url: { url: pngDataUrl(png) } }],
    })
    const before = await filesIn(generatedDir())
    await pickModel(browser, PAINTER.name, CHAT_MODEL.name)
    await submit(browser, 'Draw a fox')

    const first = await setup.mock.waitForRequest(browser)
    expect(first.path).toBe(mockChatPath(PAINTER))
    expect(JSON.parse(first.body)).toEqual({
      ...openAiChatBody(chatModel, [{ role: 'user', content: 'Draw a fox' }]),
      modalities: ['image', 'text'],
    })
    startEventStream(first.reply)
    writeChatFrame(first.reply, { content: 'Here is a fox.' })
    writeChatFrame(first.reply, imageFrame(GENERATED_PNG))
    writeChatFrame(first.reply, { content: 'It is green.' })
    writeChatFrame(first.reply, {}, 'stop')
    first.reply.end('data: [DONE]\n\n')

    const foxName = await newFileIn(browser, generatedDir(), before)
    expect(foxName).toMatch(STORED_IMAGE_NAME)
    const foxPath = path.join(generatedDir(), foxName)
    expect(await fs.promises.readFile(foxPath)).toEqual(GENERATED_PNG)
    const foxReply = [
      { role: 'user', text: 'Draw a fox' },
      { role: 'agent', text: `Here is a fox.\n\n![${foxPath}](id=a)\n\nIt is green.` },
    ]
    await waitForThread(browser, [...foxReply, { role: 'user', text: '' }])
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: foxName, width: 320, height: 256 }])

    await submit(browser, 'Make @a orange')

    // The reply's image goes back as text only; the mention adds the image
    // part to the user message.
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual({
      ...openAiChatBody(chatModel, [
        { role: 'user', content: 'Draw a fox' },
        { role: 'assistant', content: 'Here is a fox.\n\n![image](id=a)\n\nIt is green.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Make @a' },
            { type: 'image_url', image_url: { url: pngDataUrl(GENERATED_PNG) } },
            { type: 'text', text: ' orange' },
          ],
        },
      ]),
      modalities: ['image', 'text'],
    })
    expect(second.body).not.toContain(setup.app.home)
    // A reply with an image and no text.
    startEventStream(second.reply)
    writeChatFrame(second.reply, imageFrame(EDITED_PNG))
    writeChatFrame(second.reply, {}, 'stop')
    second.reply.end('data: [DONE]\n\n')

    const editedName = await newFileIn(browser, generatedDir(), [...before, foxName])
    const editedPath = path.join(generatedDir(), editedName)
    expect(await fs.promises.readFile(editedPath)).toEqual(EDITED_PNG)
    await waitForThread(browser, [
      ...foxReply,
      { role: 'user', text: 'Make @a orange' },
      { role: 'agent', text: `![${editedPath}](id=b)` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [
      { alt: foxName, width: 320, height: 256 },
      { alt: editedName, width: 20, height: 36 },
    ])
    const file = conversationFilePath(setup.app.home, await activeConversationId(browser))
    await waitForValue(browser, 'saved references', async () => {
      const content = await fs.promises.readFile(file, 'utf8').catch(() => '')
      return content.includes(`![${foxPath}](id=a)`) && content.includes(`![${editedPath}](id=b)`)
    }, true)
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('keeps the view at its bottom when the image of a followed reply loads after the reply ended', async () => {
    // A question taller than the editor, so the view can scroll.
    const question = Array.from({ length: 40 }, (_, i) => `Question line ${i + 1}`).join('\n')
    await browser.execute((text: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('.cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ changes: { from: 0, insert: text } })
    }, `${question}\n`)
    const before = await filesIn(generatedDir())
    await pickModel(browser, PAINTER.name, PAINTER.modelName)
    await holdImageLoads()
    await submit(browser, 'Draw a tall fox')

    const request = await setup.mock.waitForRequest(browser)
    answerHeld(request.reply, 'application/json', JSON.stringify({ images: [TALL_PNG.toString('base64')] }))
    const name = await newFileIn(browser, generatedDir(), before)
    await waitForThread(browser, [
      { role: 'user', text: `${question}\nDraw a tall fox` },
      { role: 'agent', text: `![${path.join(generatedDir(), name)}](id=a)` },
      { role: 'user', text: '' },
    ])
    // The rebuild at the end of the reply scrolls in a later frame.
    await browser.pause(300)
    expect(await shownImages(browser), 'image before its load').toEqual([{ alt: name, width: 0, height: 0 }])
    expect(await viewFromBottom(), 'distance from the bottom before the load').toBeLessThanOrEqual(AT_BOTTOM_PX)

    await releaseImageLoads()
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: name, width: 40, height: 300 }])
    // The load event and the editor's measure come in later frames.
    await browser.pause(300)
    expect(await viewFromBottom(), 'distance from the bottom after the load').toBeLessThanOrEqual(AT_BOTTOM_PX)
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('upscales the image of the message with the scale of the popup, and sends no text', async () => {
    const before = await filesIn(generatedDir())
    await pickModel(browser, PAINTER.name, UPSCALE_MODEL.name)
    await openPopup(browser)
    const scale = (picked: string) => ({ name: 'scale', label: 'Scale', options: ['2', '4'], picked })
    const popup = {
      headers: ['Model Parameters', 'Input'],
      rows: [scale('2'), { name: 'creativity', label: 'Creativity', number: '0.01', min: '0', max: '0.02', step: '0.001' }],
      hint: 'This model makes an image larger. It takes one image (pasted, or named with @id); the text of the message is not sent.',
      reset: true,
    }
    await waitForValue(browser, 'popup of the upscale model', () => popupView(browser), popup)
    await changeParameterField(browser, 'scale', '4', 'option')
    await waitForValue(browser, 'popup with the scale of the user', () => popupView(browser), { ...popup, rows: [scale('4'), popup.rows[1]] })
    await closePopup(browser)

    await focusEditor(browser)
    await pasteImageReference(browser, UPSCALE_INPUT_PNG, 'a')
    const reference = (await threadSections(browser))[0].text
    await submit(browser, 'Make it larger')

    const upscale = await setup.mock.waitForRequest(browser)
    expect(upscale.path).toBe(UPSCALE_PATH)
    expect(JSON.parse(upscale.body)).toEqual({ scale: 4, creativity: 0.01, image: UPSCALE_INPUT_PNG.toString('base64') })
    answerHeld(upscale.reply, 'image/png', UPSCALED_PNG)

    const upscaledName = await newFileIn(browser, generatedDir(), before)
    const upscaledPath = path.join(generatedDir(), upscaledName)
    expect(await fs.promises.readFile(upscaledPath)).toEqual(UPSCALED_PNG)
    await waitForThread(browser, [
      { role: 'user', text: `${reference}Make it larger` },
      { role: 'agent', text: `![${upscaledPath}](id=b)` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown image sizes', async () => (await shownImages(browser)).map(({ width, height }) => [width, height]), [[256, 256], [512, 512]])
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('refuses an upscale with no image in the conversation with an error toast that tells what to do, and sends nothing', async () => {
    const message = `${UPSCALE_MODEL.name} makes an image larger. Paste an image, or name one with @id.`
    await pickModel(browser, PAINTER.name, UPSCALE_MODEL.name)
    await submit(browser, 'Make it larger')

    await expectSendRefused(setup, message, [{ role: 'user', text: 'Make it larger' }])
  })

  it('leaves no file and no agent section when the user stops a request that has begun its answer', async () => {
    const before = await filesIn(generatedDir())
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
    expect(await filesIn(generatedDir())).toEqual(before)
    expect(await consoleErrors(browser)).toEqual([])
  })

  it('refuses a model that has an API that Dez does not support with an error toast that tells so, and sends nothing', async () => {
    // What the config tells of the model (`beforeAll`) picks the text.
    const message = unusableModelMessage(SKETCH_MODEL.name, { outputs: ['image'] })
    await pickModel(browser, PAINTER.name, SKETCH_MODEL.name)
    await submit(browser, 'Work on it')

    await expectSendRefused(setup, message, [{ role: 'user', text: 'Work on it' }])
  })
})
