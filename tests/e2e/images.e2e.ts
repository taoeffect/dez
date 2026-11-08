import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { conversationFilePath } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabId, focusEditor, pickModel, sbpCall, threadSections, waitForThread } from './harness/thread'

// Images in a conversation, driven through the real app: a paste or a drop
// stores the file and puts its reference in the doc, the editor shows the
// image (through the asset protocol) and keeps its delete rules, both API
// formats get the image in the request body, a model that does not read
// images gets `[image]` and the user a warning, and a relaunch shows the
// saved image again.
//
// WebDriver can send neither clipboard data nor an OS drag, so the paste
// and drop events are synthetic DOM events built in the page. The PNG bytes
// are built here and cross `browser.execute` as base64.
//
// One app session serves the whole file. Each test opens a new tab. The
// relaunch test reopens the conversation of the OpenAI test, so it runs
// last.

const VISION: MockProvider = { id: 'vision', name: 'Vision Mock', modelId: 'vision-model', modelName: 'Vision Model' }
// A second model of Vision Mock, which does not read images.
const TEXT_MODEL = { id: 'text-model', name: 'Text Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }

// Longer than CodeMirror's history group delay (500 ms): two edits with
// this pause between them are two undo steps.
const UNDO_STEP_MS = 600

const QUESTION = ' What color?'
const NOT_AN_IMAGE_MESSAGE = 'Only image files can be dropped into a conversation.'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A PNG of one color: 8-bit RGB, no interlace, each row with filter 0. */
function solidPng (width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(typeAndData))
    return Buffer.concat([length, typeAndData, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per sample
  header[9] = 2 // color type: RGB
  const row = Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

const PASTED_PNG = solidPng(48, 32, [220, 40, 40])
const DROPPED_PNG = solidPng(40, 24, [40, 90, 220])

/** A Dez image reference in the doc, `![<absolute path>]()`. */
const REFERENCE = /!\[[^\]\n]+\]\(\)/

interface EditorState {
  doc: string
  caret: number
}

/** An image that the editor shows, with its natural size: 0 x 0 until the
 *  asset protocol has served the file. */
interface ShownImage {
  alt: string
  width: number
  height: number
}

/** A file for `dropFiles`. */
interface DroppedFile {
  name: string
  type: string
  base64: string
}

interface Point {
  x: number
  y: number
}

interface InsertedImage {
  path: string
  /** `![<path>]()`. */
  reference: string
  /** The doc range of the reference. */
  from: number
  to: number
}

function pastedImageView (image: InsertedImage): ShownImage {
  return { alt: path.basename(image.path), width: 48, height: 32 }
}

describe('images', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The image and conversation of the OpenAI test, for the relaunch test.
  let sentImage: { image: InsertedImage, conversationId: string } | null = null

  function imagesDir (): string {
    return path.join(setup.app.home, '.config', 'dez', 'assets', 'images')
  }

  // The file names in the image folder, sorted.
  async function storedImages (): Promise<string[]> {
    try {
      return (await fs.promises.readdir(imagesDir())).sort()
    } catch {
      return []
    }
  }

  async function editorState (): Promise<EditorState> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('editorState: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return { doc: view.state.doc.toString(), caret: view.state.selection.main.head }
    })
  }

  async function setCaret (pos: number): Promise<void> {
    await browser.execute((anchor: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('setCaret: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ selection: { anchor } })
    }, pos)
  }

  async function shownImages (): Promise<ShownImage[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll<HTMLImageElement>('.cm-content .dez-image__img'),
      (img) => ({ alt: img.alt, width: img.naturalWidth, height: img.naturalHeight }),
    ))
  }

  async function activeTabTitle (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.tab--active .tab-title')?.textContent ?? null)
  }

  async function activeConversationId (): Promise<string> {
    // `dez.model/tab` returns the tab record of the store.
    const tab = await sbpCall(browser, 'dez.model/tab', await activeTabId(browser)) as { conversationId: string }
    return tab.conversationId
  }

  // Messages of the toasts that are shown and not closing.
  async function openToastMessages (): Promise<string[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.toast-card:not(.toast-card--closing) .toast-message'),
      (el) => el.textContent ?? '',
    ))
  }

  async function openWarningToasts (): Promise<Array<{ title: string, message: string }>> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.toast-card--warning:not(.toast-card--closing)'),
      (card) => ({
        title: card.querySelector('.toast-title')?.textContent ?? '',
        message: card.querySelector('.toast-message')?.textContent ?? '',
      }),
    ))
  }

  // Closes every toast, so that a test sees only the toasts it causes (the
  // non-image toast of one drop test stays open into the next).
  async function closeToasts (): Promise<void> {
    await browser.execute(() => {
      document.querySelectorAll<HTMLElement>('.toast-card:not(.toast-card--closing) .toast-close').forEach((button) => button.click())
    })
    await waitForValue(browser, 'toasts closed', () => browser.execute(() => document.querySelectorAll('.toast-card').length), 0)
  }

  // A viewport point just inside the char after doc position `pos`, on the
  // middle of its line: CodeMirror maps it back to `pos`.
  async function docPoint (pos: number): Promise<Point> {
    return browser.execute((target: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('docPoint: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const coords = view.coordsAtPos(target, 1)
      if (!coords) throw new Error(`docPoint: no coords for ${target}`)
      return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2 }
    }, pos)
  }

  async function elementCenter (selector: string): Promise<Point> {
    return browser.execute((wanted: string) => {
      const element = document.querySelector(wanted)
      if (!element) throw new Error(`elementCenter: ${wanted} not found`)
      const box = element.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, selector)
  }

  // Pastes a PNG file with no text, as an image copied in an image viewer
  // gives it.
  async function pasteImage (png: Buffer): Promise<void> {
    await browser.execute((base64: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('pasteImage: .cm-content not found')
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, png.toString('base64'))
  }

  // Drags `files` over `point` and drops them there, on the element at that
  // point. Returns whether a handler canceled each event: a canceled
  // dragover accepts the drag, and a canceled drop keeps the webview from
  // opening the file.
  async function dropFiles (point: Point, files: DroppedFile[]): Promise<{ dragover: boolean, drop: boolean }> {
    return browser.execute((at: Point, dropped: DroppedFile[]) => {
      const target = document.elementFromPoint(at.x, at.y)
      if (!target) throw new Error(`dropFiles: nothing at ${at.x}, ${at.y}`)
      const data = new DataTransfer()
      for (const file of dropped) {
        data.items.add(new File([Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))], file.name, { type: file.type }))
      }
      const send = (type: 'dragover' | 'drop'): boolean => {
        const event = new DragEvent(type, { dataTransfer: data, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true })
        target.dispatchEvent(event)
        return event.defaultPrevented
      }
      return { dragover: send('dragover'), drop: send('drop') }
    }, point, files)
  }

  // Sends the drop event of Tauri's native file drop to the page, as wry
  // sends it when a file manager drops `paths` at `point` (CSS px). The
  // native drop is on only on Linux (src-tauri/tauri.linux.conf.json), and
  // WebDriver cannot drive an OS drag, so the page emits the event itself.
  // Unlike a real drop, this event adds no path to the asset-protocol
  // scope: a dropped image must be in the image folder, which is always in
  // the scope.
  async function nativeDrop (point: Point, paths: string[]): Promise<void> {
    await browser.execute(async (at: Point, dropped: string[]) => {
      const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: unknown) => Promise<unknown> }
      await internals.invoke('plugin:event|emit_to', {
        target: { kind: 'Webview', label: 'main' },
        event: 'tauri://drag-drop',
        payload: { paths: dropped, position: at },
      })
    }, point, paths)
  }

  // Waits for the drop of DROPPED_PNG into the doc `Before after`, after
  // `Before `. Checks that the reference is there with the caret after it,
  // that the image is a new file in the image folder with the dropped bytes,
  // and that the editor shows it. `before` is the image folder before the
  // drop.
  async function expectDroppedImage (before: string[]): Promise<void> {
    await waitForValue(browser, 'dropped reference', async () => REFERENCE.test((await editorState()).doc), true)
    const { doc, caret } = await editorState()
    const reference = doc.slice('Before '.length, doc.length - 'after'.length)
    expect(doc).toBe(`Before ${reference}after`)
    expect(reference).toMatch(new RegExp(`^${REFERENCE.source}$`))
    expect(caret).toBe('Before '.length + reference.length)
    const fileName = path.basename(reference.slice(2, -3))
    expect(reference.slice(2, -3)).toBe(path.join(imagesDir(), fileName))
    expect(await storedImages()).toEqual([...before, fileName].sort())
    expect(await fs.promises.readFile(path.join(imagesDir(), fileName))).toEqual(DROPPED_PNG)
    await waitForValue(browser, 'shown image', shownImages, [{ alt: fileName, width: 40, height: 24 }])
  }

  async function newTab (): Promise<void> {
    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'new tab', () => threadSections(browser), [{ role: 'user', text: '' }])
  }

  // Types `before` in the empty active tab, pastes PASTED_PNG, waits for
  // its reference, then types `after`, which lands after the image only
  // when the paste left the caret there.
  async function insertPastedImage (before: string, after: string): Promise<InsertedImage> {
    await focusEditor(browser)
    await typeKeys(browser, before)
    await pasteImage(PASTED_PNG)
    await waitForValue(browser, 'pasted reference', async () => REFERENCE.test((await editorState()).doc), true)
    const pasted = await editorState()
    const reference = pasted.doc.slice(before.length)
    expect(pasted.doc.slice(0, before.length)).toBe(before)
    expect(reference).toMatch(new RegExp(`^${REFERENCE.source}$`))
    expect(pasted.caret).toBe(pasted.doc.length)
    await typeKeys(browser, after)
    await waitForValue(browser, 'text after the image', async () => (await editorState()).doc, before + reference + after)
    return { path: reference.slice(2, -3), reference, from: before.length, to: before.length + reference.length }
  }

  // Sends the active tab with Ctrl+Enter and takes its request, with the
  // body parsed.
  async function sendRequest (): Promise<{ path: string, body: unknown, reply: HeldRequest['reply'] }> {
    await browser.keys([Key.Control, Key.Enter])
    const request = await setup.mock.waitForRequest(browser)
    return { path: request.path, body: JSON.parse(request.body), reply: request.reply }
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(VISION, {
      models: [
        { id: VISION.modelId, name: VISION.modelName },
        { id: TEXT_MODEL.id, name: TEXT_MODEL.name, imageInput: false },
      ],
    }, { moreProviders: [{ provider: CLAUDE }] })
    browser = setup.browser
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await closeToasts()
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('stores a pasted image, puts its reference at the caret, and shows the image', async () => {
    const before = await storedImages()
    await newTab()
    const image = await insertPastedImage('See ', ' here')

    const fileName = path.basename(image.path)
    expect(fileName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/)
    expect(image.path).toBe(path.join(imagesDir(), fileName))
    expect(await storedImages()).toEqual([...before, fileName].sort())
    expect(await fs.promises.readFile(image.path)).toEqual(PASTED_PNG)
    await waitForValue(browser, 'shown image', shownImages, [pastedImageView(image)])
  })

  it('shows the source on Backspace after an image, and the image again on `)`, undo, and redo', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    const shown = [pastedImageView(image)]
    const withImage = { doc: `See ${image.reference} here`, caret: image.to }
    const source = { doc: `See ${image.reference.slice(0, -1)} here`, caret: image.to - 1 }
    await waitForValue(browser, 'shown image', shownImages, shown)
    await setCaret(image.to)

    await browser.pause(UNDO_STEP_MS)
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'doc after Backspace', editorState, source)
    await waitForValue(browser, 'images after Backspace', shownImages, [])

    await browser.pause(UNDO_STEP_MS)
    await typeKeys(browser, ')')
    await waitForValue(browser, 'doc after `)`', editorState, withImage)
    await waitForValue(browser, 'images after `)`', shownImages, shown)

    // Undo the `)`, then the Backspace; redo both.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after one undo', editorState, source)
    await waitForValue(browser, 'images after one undo', shownImages, [])
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after two undos', editorState, withImage)
    await waitForValue(browser, 'images after two undos', shownImages, shown)
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after one redo', editorState, source)
    await waitForValue(browser, 'images after one redo', shownImages, [])
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after two redos', editorState, withImage)
    await waitForValue(browser, 'images after two redos', shownImages, shown)
  })

  it('moves the caret over an image with one arrow key press', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    await waitForValue(browser, 'shown image', shownImages, [pastedImageView(image)])
    await setCaret(image.from)
    const caret = async (): Promise<number> => (await editorState()).caret

    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'caret after one ArrowRight', caret, image.to)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'caret after two ArrowRights', caret, image.to + 1)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after one ArrowLeft', caret, image.to)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after two ArrowLefts', caret, image.from)
  })

  it('shows the source on Delete before an image, and the image again when `!` is typed', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    const shown = [pastedImageView(image)]
    await waitForValue(browser, 'shown image', shownImages, shown)
    await setCaret(image.from)

    await browser.keys(Key.Delete)
    await waitForValue(browser, 'doc after Delete', editorState, { doc: `See ${image.reference.slice(1)} here`, caret: image.from })
    await waitForValue(browser, 'images after Delete', shownImages, [])

    await typeKeys(browser, '!')
    await waitForValue(browser, 'doc after `!`', async () => (await editorState()).doc, `See ${image.reference} here`)
    await waitForValue(browser, 'images after `!`', shownImages, shown)
  })

  it('puts a dropped image at the drop point', async () => {
    const before = await storedImages()
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', async () => (await editorState()).doc, 'Before after')

    const accepted = await dropFiles(await docPoint('Before '.length), [
      { name: 'blue.png', type: 'image/png', base64: DROPPED_PNG.toString('base64') },
    ])
    expect(accepted).toEqual({ dragover: true, drop: true })
    await expectDroppedImage(before)
  })

  it('stores and inserts no dropped file that is not an image, and says so', async () => {
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Some text')
    await waitForValue(browser, 'typed text', async () => (await editorState()).doc, 'Some text')
    const before = await storedImages()

    const accepted = await dropFiles(await docPoint('Some '.length), [
      { name: 'notes.txt', type: 'text/plain', base64: Buffer.from('notes').toString('base64') },
    ])
    expect(accepted).toEqual({ dragover: true, drop: true })
    await waitForValue(browser, 'toast', async () => (await openToastMessages()).includes(NOT_AN_IMAGE_MESSAGE), true)
    expect((await editorState()).doc).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // Outside the editor, the window refuses every file drop, so the
    // webview does not open the file in place of the app.
    const refused = await dropFiles(await elementCenter('header.tab-bar'), [
      { name: 'red.png', type: 'image/png', base64: PASTED_PNG.toString('base64') },
    ])
    expect(refused).toEqual({ dragover: true, drop: true })
    expect((await editorState()).doc).toBe('Some text')
    expect(await storedImages()).toEqual(before)
  })

  it('puts an image of a native file drop at the drop point', async () => {
    // A file outside the image folder in a real drop; see `nativeDrop`.
    await fs.promises.mkdir(imagesDir(), { recursive: true })
    const source = path.join(imagesDir(), 'native-drop-source.png')
    await fs.promises.writeFile(source, DROPPED_PNG)
    const before = await storedImages()
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', async () => (await editorState()).doc, 'Before after')

    await nativeDrop(await docPoint('Before '.length), [source])
    await expectDroppedImage(before)
  })

  it('leaves out a native-dropped file that is not an image, and puts a dropped link in as text', async () => {
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Some text')
    await waitForValue(browser, 'typed text', async () => (await editorState()).doc, 'Some text')
    const before = await storedImages()

    await nativeDrop(await docPoint('Some '.length), [path.join(setup.app.home, 'notes.txt')])
    await waitForValue(browser, 'toast', async () => (await openToastMessages()).includes(NOT_AN_IMAGE_MESSAGE), true)
    expect((await editorState()).doc).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // wry passes on a URI that is not a `file://` URI as it is.
    const link = 'https://example.com/page'
    await nativeDrop(await docPoint('Some '.length), [link])
    await waitForValue(browser, 'dropped link', editorState, { doc: `Some ${link}text`, caret: 'Some '.length + link.length })
    expect(await storedImages()).toEqual(before)
  })

  it('sends a pasted image to an OpenAI-format model as a data URL, and titles the tab with [image]', async () => {
    await newTab()
    await pickModel(browser, VISION.name, VISION.modelName)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(VISION))
    expect(request.body).toHaveProperty('messages', [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PASTED_PNG.toString('base64')}` } },
        { type: 'text', text: QUESTION },
      ],
    }])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: image.reference + QUESTION },
      { role: 'agent', text: replyText(VISION.modelName) },
      { role: 'user', text: '' },
    ])
    expect(await activeTabTitle()).toBe(`[image]${QUESTION}`)

    const conversationId = await activeConversationId()
    await waitForValue(browser, 'saved reference', async () => {
      const content = await fs.promises.readFile(conversationFilePath(setup.app.home, conversationId), 'utf8').catch(() => '')
      return content.split('\n').includes(image.reference + QUESTION)
    }, true)
    sentImage = { image, conversationId }
  })

  it('sends a pasted image to an Anthropic-format model as an image block', async () => {
    await newTab()
    await pickModel(browser, CLAUDE.name, CLAUDE.modelName)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(CLAUDE))
    // The last block of the last user message carries a cache breakpoint
    // (`withCacheBreakpoints` in src/model/providers/apiFormats.ts).
    expect(request.body).toHaveProperty('messages', [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PASTED_PNG.toString('base64') } },
        { type: 'text', text: QUESTION, cache_control: { type: 'ephemeral' } },
      ],
    }])
    sendAnthropicReply(request.reply, CLAUDE.modelName)
    await waitForThread(browser, [
      { role: 'user', text: image.reference + QUESTION },
      { role: 'agent', text: replyText(CLAUDE.modelName) },
      { role: 'user', text: '' },
    ])
  })

  it('sends [image] in place of the image to a model that does not read images, and warns', async () => {
    await newTab()
    await pickModel(browser, VISION.name, TEXT_MODEL.name)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(VISION))
    expect(request.body).toHaveProperty('messages', [{ role: 'user', content: `[image]${QUESTION}` }])
    expect(await openWarningToasts()).toEqual([{
      title: 'Image not sent',
      message: `${TEXT_MODEL.name} does not read images, so 1 image was left out of the request.`,
    }])
    await sendChatReply(request.reply, TEXT_MODEL.name)
    await waitForThread(browser, [
      { role: 'user', text: image.reference + QUESTION },
      { role: 'agent', text: replyText(TEXT_MODEL.name) },
      { role: 'user', text: '' },
    ])
  })

  it('shows the saved image and the [image] tab title after a relaunch', async () => {
    if (!sentImage) throw new Error('The OpenAI test saved no conversation with an image')
    const { image, conversationId } = sentImage
    const lastActive = await activeConversationId()
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    // The restore sets the active tab after the tab bar shows; switch only
    // after it, or the restore switches back.
    await waitForValue(browser, 'restored active tab', activeConversationId, lastActive)
    await sbpCall(browser, 'dez.model/tabs/openConversation', conversationId)
    await waitForValue(browser, 'reopened conversation', async () => (await threadSections(browser))[0]?.text ?? null, image.reference + QUESTION)
    await waitForValue(browser, 'shown image', shownImages, [pastedImageView(image)])
    expect(await activeTabTitle()).toBe(`[image]${QUESTION}`)
  })
})
