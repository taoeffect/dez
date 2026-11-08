import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { consoleErrors, elementCenter, movePointer, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue, type Point } from './harness/dom'
import { conversationFilePath } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabId, editorDoc, focusEditor, openToasts, pickModel, sbpCall, setCaret, threadSections, waitForThread } from './harness/thread'

// Images in a conversation, driven through the real app: a paste or a drop
// stores the file and puts its reference, with a new image id, in the doc,
// the editor shows the image (through the asset protocol) with its id and a
// trash button in a hover toolbar at its top-right corner, each with a
// tooltip that says what it is for, and keeps its delete rules, the trash
// asks first and then deletes the file and the reference, both API formats
// get the image in the request body, a model that does not read images
// gets `[image]` and the user a warning, and a relaunch shows the saved
// image again.
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
// Wider than an image's overlay toolbar, which is wider than PASTED_PNG.
const WIDE_PNG = solidPng(200, 60, [30, 30, 30])

/** A Dez image reference in the doc, `![<absolute path>](id=<letters>)`. */
const REFERENCE = /!\[[^\]\n]+\]\(id=[a-z]+\)/

/** The path in a reference, `![<path>](…)`. */
function referencePath (reference: string): string {
  return reference.slice(2, reference.indexOf(']('))
}

interface DocAndCaret {
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

/** The hover overlay of an image that the editor shows, or of its "Image
 *  not found" box. */
interface ImageOverlay {
  /** The id in its badge; null for an image with no id. */
  id: string | null
  /** Whether it has a trash button. */
  trash: boolean
  /** Whether the overlay can be seen. */
  shown: boolean
}

/** Where an image's overlay sits on the image, in px from each image edge
 *  (negative: out past that edge), and the heights of the image and its
 *  line. */
interface OverlayLayout {
  top: number
  left: number
  right: number
  imageHeight: number
  lineHeight: number
}

/** The tooltip of an overlay item: the id badge or a trash. */
interface OverlayTooltip {
  title: string
  text: string
}

/** The confirm prompt (`dez.ui/confirm`) and the focus. */
interface PromptState {
  /** The prompt's text; null when no prompt is open. */
  message: string | null
  /** The labels of its buttons, in page order. */
  buttons: string[]
  focus: 'yes' | 'no' | 'editor' | 'other'
}

/** A file for `dropFiles`. */
interface DroppedFile {
  name: string
  type: string
  base64: string
}

interface InsertedImage {
  path: string
  /** `![<path>](id=a)`: each test puts it in a new tab, so its id is `a`. */
  reference: string
  /** The doc range of the reference. */
  from: number
  to: number
}

function shownPastedImage (image: InsertedImage): ShownImage {
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

  async function docAndCaret (): Promise<DocAndCaret> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('docAndCaret: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return { doc: view.state.doc.toString(), caret: view.state.selection.main.head }
    })
  }

  async function shownImages (): Promise<ShownImage[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll<HTMLImageElement>('.cm-content .dez-image__img'),
      (img) => ({ alt: img.alt, width: img.naturalWidth, height: img.naturalHeight }),
    ))
  }

  // The overlay of each image that the editor shows (or of its "Image not
  // found" box), in doc order. It is shown when it is fully opaque
  // (`.dez-image__overlay` in dezTheme).
  async function imageOverlays (): Promise<ImageOverlay[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .dez-image'),
      (image) => {
        const overlay = image.querySelector('.dez-image__overlay')
        return {
          id: overlay?.querySelector('.dez-image__id')?.textContent ?? null,
          trash: overlay?.querySelector('button.dez-image__trash') != null,
          shown: overlay !== null && getComputedStyle(overlay).opacity === '1',
        }
      },
    ))
  }

  // The center of the image (or of its "Image not found" box) that the
  // editor shows at `index`, in doc order.
  async function imageCenter (index: number): Promise<Point> {
    return browser.execute((at: number) => {
      const box = document.querySelectorAll('.cm-content .dez-image')[at]?.firstElementChild
      if (!box) throw new Error(`imageCenter: no image ${at}`)
      const rect = box.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, index)
  }

  // The center of the overlay item `selector` (`.dez-image__id` or
  // `.dez-image__trash`) of the image (or of the "Image not found" box) at
  // `index`, in doc order.
  async function overlayItemCenter (index: number, selector: string): Promise<Point> {
    return browser.execute((at: number, wanted: string) => {
      const item = document.querySelectorAll('.cm-content .dez-image')[at]?.querySelector(wanted)
      if (!item) throw new Error(`overlayItemCenter: no ${wanted} on image ${at}`)
      const rect = item.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, index, selector)
  }

  // Moves the pointer onto the overlay item `selector` of the image (or of
  // the "Image not found" box) at `index`, in doc order. The pointer first
  // goes onto the image, as a user's does, which shows the overlay.
  async function hoverOverlayItem (index: number, selector: string): Promise<void> {
    await movePointer(browser, await imageCenter(index))
    await movePointer(browser, await overlayItemCenter(index, selector))
  }

  // Clicks the trash of the image (or of the "Image not found" box) at
  // `index`, in doc order, after the pointer went onto the image.
  async function clickTrash (index: number): Promise<void> {
    await movePointer(browser, await imageCenter(index))
    await pointerClickAt(browser, await overlayItemCenter(index, '.dez-image__trash'))
  }

  // Where the overlay of the image at `index` (doc order) sits, once the
  // pointer is on the image and the overlay's entrance (a short fade and
  // slide, `.dez-image__overlay` in dezTheme) is over.
  async function overlayLayout (index: number): Promise<OverlayLayout> {
    await waitForValue(browser, `overlay of image ${index} in place`, () => browser.execute((at: number) => {
      const overlay = document.querySelectorAll('.cm-content .dez-image')[at]?.querySelector('.dez-image__overlay')
      if (!overlay) return false
      const style = getComputedStyle(overlay)
      return style.opacity === '1' && style.transform === 'none'
    }, index), true)
    return browser.execute((at: number) => {
      const wrapper = document.querySelectorAll('.cm-content .dez-image')[at]
      const image = wrapper?.querySelector('.dez-image__img')?.getBoundingClientRect()
      const overlay = wrapper?.querySelector('.dez-image__overlay')?.getBoundingClientRect()
      const line = wrapper?.closest('.cm-line')?.getBoundingClientRect()
      if (!image || !overlay || !line) throw new Error(`overlayLayout: image ${at}, its overlay, or its line not found`)
      return {
        top: overlay.top - image.top,
        left: overlay.left - image.left,
        right: image.right - overlay.right,
        imageHeight: image.height,
        lineHeight: line.height,
      }
    }, index)
  }

  // The overlay item tooltips that show (`.dez-image-tooltip`; at most one).
  async function overlayTooltips (): Promise<OverlayTooltip[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.cm-tooltip.dez-image-tooltip'),
      (tip) => ({
        title: tip.querySelector('.dez-image-tooltip__title')?.textContent ?? '',
        text: tip.querySelector('.dez-image-tooltip__text')?.textContent ?? '',
      }),
    ))
  }

  // Whether the overlay item tooltip that shows is inside the editor's
  // visible area (its scroller; the tab bar above it would hide a part of
  // the tooltip), and clear of the toolbar of the image at `index`, so that
  // it never covers the item it explains.
  async function tooltipPlacement (index: number): Promise<{ inEditor: boolean, clearOfToolbar: boolean }> {
    return browser.execute((at: number) => {
      const tip = document.querySelector('.cm-tooltip.dez-image-tooltip')?.getBoundingClientRect()
      const editor = document.querySelector('.cm-scroller')?.getBoundingClientRect()
      const toolbar = document.querySelectorAll('.cm-content .dez-image')[at]?.querySelector('.dez-image__overlay')?.getBoundingClientRect()
      if (!tip || !editor || !toolbar) throw new Error(`tooltipPlacement: no tooltip, no editor, or no toolbar on image ${at}`)
      return {
        inEditor: tip.left >= editor.left && tip.top >= editor.top && tip.right <= editor.right && tip.bottom <= editor.bottom,
        clearOfToolbar: tip.bottom <= toolbar.top || tip.top >= toolbar.bottom,
      }
    }, index)
  }

  async function promptState (): Promise<PromptState> {
    return browser.execute(() => {
      const dialog = document.querySelector('.confirm-dialog')
      const active = document.activeElement
      const focus: PromptState['focus'] = active?.matches('.confirm-btn--confirm')
        ? 'yes'
        : active?.matches('.confirm-btn--cancel')
          ? 'no'
          : active?.closest('.cm-editor') ? 'editor' : 'other'
      return {
        message: dialog?.querySelector('.confirm-message')?.textContent ?? null,
        buttons: Array.from(dialog?.querySelectorAll('button') ?? [], (button) => button.textContent?.trim() ?? ''),
        focus,
      }
    })
  }

  // Puts `text` at the end of the doc as typed text, which gets no image ids
  // (only a paste or a drop does), as in a reference saved before ids.
  async function typeAtEnd (text: string): Promise<void> {
    await browser.execute((insert: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('typeAtEnd: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent: 'input.type' })
    }, text)
  }

  async function activeTabTitle (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.tab--active .tab-title')?.textContent ?? null)
  }

  async function activeConversationId (): Promise<string> {
    // `dez.model/tab` returns the tab record of the store.
    const tab = await sbpCall(browser, 'dez.model/tab', await activeTabId(browser)) as { conversationId: string }
    return tab.conversationId
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
    await waitForValue(browser, 'dropped reference', async () => REFERENCE.test(await editorDoc(browser)), true)
    const { doc, caret } = await docAndCaret()
    const reference = doc.slice('Before '.length, doc.length - 'after'.length)
    expect(doc).toBe(`Before ${reference}after`)
    expect(caret).toBe('Before '.length + reference.length)
    const fileName = path.basename(referencePath(reference))
    expect(reference).toBe(`![${path.join(imagesDir(), fileName)}](id=a)`)
    expect(await storedImages()).toEqual([...before, fileName].sort())
    expect(await fs.promises.readFile(path.join(imagesDir(), fileName))).toEqual(DROPPED_PNG)
    await waitForValue(browser, 'shown image', shownImages, [{ alt: fileName, width: 40, height: 24 }])
  }

  async function newTab (): Promise<void> {
    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'new tab', () => threadSections(browser), [{ role: 'user', text: '' }])
  }

  // Types `before` in the empty active tab, pastes PASTED_PNG, waits for
  // its reference (the tab's first image, so its id is `a`), then types
  // `after`, which lands after the image only when the paste left the caret
  // there.
  async function insertPastedImage (before: string, after: string): Promise<InsertedImage> {
    await focusEditor(browser)
    await typeKeys(browser, before)
    await pasteImage(PASTED_PNG)
    await waitForValue(browser, 'pasted reference', async () => REFERENCE.test(await editorDoc(browser)), true)
    const pasted = await docAndCaret()
    const reference = pasted.doc.slice(before.length)
    expect(pasted.doc.slice(0, before.length)).toBe(before)
    expect(reference).toBe(`![${referencePath(reference)}](id=a)`)
    expect(pasted.caret).toBe(pasted.doc.length)
    await typeKeys(browser, after)
    await waitForValue(browser, 'text after the image', () => editorDoc(browser), before + reference + after)
    return { path: referencePath(reference), reference, from: before.length, to: before.length + reference.length }
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
    await waitForValue(browser, 'shown image', shownImages, [shownPastedImage(image)])
  })

  it('gives each image of a conversation its own id, shown with a trash at its top-right corner while the pointer is on the image', async () => {
    await newTab()
    const first = await insertPastedImage('', ' and ')
    const firstLine = `${first.reference} and `
    await pasteImage(PASTED_PNG)
    await waitForValue(browser, 'second reference', async () => (await editorDoc(browser)).length > firstLine.length, true)
    const second = (await editorDoc(browser)).slice(firstLine.length)
    const secondPath = referencePath(second)
    expect(second).toBe(`![${secondPath}](id=b)`)
    expect(secondPath).not.toBe(first.path)

    // A reference with no id, as saved before ids existed, gets only the
    // trash; this one is to an image wider than its overlay. The overlay of
    // an image whose file is gone is in its box.
    const wide = path.join(imagesDir(), 'wide.png')
    await fs.promises.writeFile(wide, WIDE_PNG)
    await typeAtEnd(`\n![${wide}]()\n![${path.join(imagesDir(), 'gone.png')}](id=c)`)
    await waitForValue(browser, 'shown images', shownImages, [
      shownPastedImage(first),
      { alt: path.basename(secondPath), width: 48, height: 32 },
      { alt: 'wide.png', width: 200, height: 60 },
    ])
    await waitForValue(browser, 'missing image box', () => browser.execute(
      () => document.querySelector('.cm-content .dez-image-missing')?.firstChild?.textContent ?? null,
    ), 'Image not found: gone.png')
    // `hovered`: the index of the image under the pointer.
    const overlays = (hovered: number | null): ImageOverlay[] => ['a', 'b', null, 'c'].map(
      (id, index) => ({ id, trash: true, shown: index === hovered }),
    )
    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    await waitForValue(browser, 'overlays with the pointer off the images', imageOverlays, overlays(null))

    await movePointer(browser, await imageCenter(1))
    await waitForValue(browser, 'overlays with the pointer on image b', imageOverlays, overlays(1))
    // Image b is narrower than its overlay: the overlay starts as far from
    // the image's left edge as from its top edge, and hangs out on the
    // right. It adds no height to the line.
    const narrow = await overlayLayout(1)
    expect(narrow.top).toBeGreaterThan(0)
    expect(narrow.left).toBeCloseTo(narrow.top, 1)
    expect(narrow.right).toBeLessThan(0)
    expect(narrow.lineHeight).toBe(narrow.imageHeight)

    await movePointer(browser, await imageCenter(2))
    await waitForValue(browser, 'overlays with the pointer on the image with no id', imageOverlays, overlays(2))
    // On a wide image, in its top-right corner, as far from its right edge
    // as from its top edge.
    const onWide = await overlayLayout(2)
    expect(onWide.top).toBeGreaterThan(0)
    expect(onWide.right).toBeCloseTo(onWide.top, 1)
    expect(onWide.left).toBeGreaterThan(onWide.right)
    expect(onWide.lineHeight).toBe(onWide.imageHeight)

    await movePointer(browser, await imageCenter(3))
    await waitForValue(browser, 'overlays with the pointer on the box of image c', imageOverlays, overlays(3))
    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    await waitForValue(browser, 'overlays after the pointer left', imageOverlays, overlays(null))
  })

  it('explains the id badge and the trash in tooltips while the pointer is on them', async () => {
    await newTab()
    await insertPastedImage('See ', ' here')
    await typeAtEnd(`\n![${path.join(imagesDir(), 'gone.png')}](id=b)`)
    await waitForValue(browser, 'missing image box', () => browser.execute(
      () => document.querySelector('.cm-content .dez-image-missing')?.firstChild?.textContent ?? null,
    ), 'Image not found: gone.png')
    // No overlay item has a native `title`, which would show a second
    // tooltip next to Dez's.
    expect(await browser.execute(() => document.querySelectorAll('.cm-content .dez-image [title]').length)).toBe(0)

    const offImages = await elementCenter(browser, 'header.tab-bar')
    const trashTooltip: OverlayTooltip = {
      title: 'Delete image',
      text: 'Removes the image from the conversation and deletes its file from the Dez folder. Dez asks you first. You cannot undo this.',
    }
    // [what, its image's index in doc order, its selector, its tooltip]
    const items: Array<[string, number, string, OverlayTooltip]> = [
      ['the id badge', 0, '.dez-image__id', {
        title: 'Image id: a',
        text: 'The short name of this image in this conversation. It is saved in the image\u2019s markdown as id=a.',
      }],
      ['the trash', 0, '.dez-image__trash', trashTooltip],
      // The file is gone, so the trash can remove only the text.
      ['the trash of the missing image', 1, '.dez-image__trash', {
        title: 'Delete image',
        text: 'The image file is not found, so this removes only the image from the conversation. Dez asks you first. You cannot undo this.',
      }],
    ]
    for (const [label, index, selector, tooltip] of items) {
      await hoverOverlayItem(index, selector)
      await waitForValue(browser, `tooltip on ${label}`, overlayTooltips, [tooltip])
      // CM puts a new tooltip at top: -10000px and moves it into place in
      // its next measure (an animation frame), after the text is there.
      await waitForValue(browser, `place of the tooltip on ${label}`, () => tooltipPlacement(index), { inEditor: true, clearOfToolbar: true })
      await movePointer(browser, offImages)
      await waitForValue(browser, `tooltip after the pointer left ${label}`, overlayTooltips, [])
    }

    // A press on the trash opens the prompt, which the tooltip does not
    // outlive.
    await hoverOverlayItem(0, '.dez-image__trash')
    await waitForValue(browser, 'tooltip on the trash before the press', overlayTooltips, [trashTooltip])
    await pointerClickAt(browser, await overlayItemCenter(0, '.dez-image__trash'))
    await waitForValue(browser, 'prompt', async () => (await promptState()).focus, 'yes')
    expect(await overlayTooltips()).toEqual([])
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'prompt after Esc', async () => (await promptState()).message, null)
    await movePointer(browser, offImages)
    await waitForValue(browser, 'tooltip after the pointer left the trash', overlayTooltips, [])
  })

  it('asks before the trash deletes an image, and keeps it on No, Esc, or a click outside the prompt', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    const shown = [shownPastedImage(image)]
    await waitForValue(browser, 'shown image', shownImages, shown)
    // The trash takes its own press, so the caret stays where it is.
    const unchanged = { doc: `See ${image.reference} here`, caret: 2 }
    await setCaret(browser, unchanged.caret)

    const cancels: Array<[string, () => Promise<unknown>]> = [
      ['No', () => pointerClick(browser, '.confirm-btn--cancel')],
      ['Esc', () => browser.keys(Key.Escape)],
      // Off the dialog, on the overlay around it.
      ['a click outside', () => pointerClickAt(browser, { x: 20, y: 300 })],
    ]
    for (const [label, cancel] of cancels) {
      await clickTrash(0)
      await waitForValue(browser, `prompt before ${label}`, promptState, {
        message: 'Are you sure you want to delete this image?',
        buttons: ['No', 'Yes'],
        focus: 'yes',
      })
      expect(await docAndCaret()).toEqual(unchanged)

      await cancel()
      await waitForValue(browser, `prompt after ${label}`, promptState, { message: null, buttons: [], focus: 'editor' })
      expect(await docAndCaret()).toEqual(unchanged)
      expect(await storedImages()).toContain(path.basename(image.path))
      expect(await shownImages()).toEqual(shown)
    }
  })

  it('deletes the file and the reference of an image on Yes or Enter, with no undo, and the text of a missing image', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    const gone = `![${path.join(imagesDir(), 'gone.png')}]()`
    await typeAtEnd(`\n${gone}`)
    await waitForValue(browser, 'shown image', shownImages, [shownPastedImage(image)])
    await waitForValue(browser, 'missing image box', () => browser.execute(
      () => document.querySelector('.cm-content .dez-image-missing')?.firstChild?.textContent ?? null,
    ), 'Image not found: gone.png')
    // The caret in the first text of the doc, which the removal right after
    // the prompt moved to the doc start before `syncDomSelection`
    // (src/view/editor/focus.ts).
    await setCaret(browser, 2)
    const otherImages = (await storedImages()).filter((name) => name !== path.basename(image.path))
    const closed: PromptState = { message: null, buttons: [], focus: 'editor' }

    // The file goes, then the reference; the rest of its line stays.
    await clickTrash(0)
    await waitForValue(browser, 'prompt', async () => (await promptState()).focus, 'yes')
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'doc after Yes', docAndCaret, { doc: `See  here\n${gone}`, caret: 2 })
    expect(await storedImages()).toEqual(otherImages)
    expect(await shownImages()).toEqual([])
    await waitForValue(browser, 'prompt after Yes', promptState, closed)

    // A missing image has no file to delete: only its text goes, with its
    // line, as it is the only text there.
    await clickTrash(0)
    await waitForValue(browser, 'prompt', async () => (await promptState()).focus, 'yes')
    await browser.keys(Key.Enter)
    await waitForValue(browser, 'doc after Enter', docAndCaret, { doc: 'See  here', caret: 2 })
    expect(await storedImages()).toEqual(otherImages)
    await waitForValue(browser, 'prompt after Enter', promptState, closed)

    // The removals are not undo steps: undo takes back the typed ` here`
    // (the last typed text that is left), and no reference comes back.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after undo', () => editorDoc(browser), 'See ')
  })

  it('shows the source on Backspace after an image, and the image again on `)`, undo, and redo', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    const shown = [shownPastedImage(image)]
    const withImage = { doc: `See ${image.reference} here`, caret: image.to }
    const source = { doc: `See ${image.reference.slice(0, -1)} here`, caret: image.to - 1 }
    await waitForValue(browser, 'shown image', shownImages, shown)
    await setCaret(browser, image.to)

    await browser.pause(UNDO_STEP_MS)
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'doc after Backspace', docAndCaret, source)
    await waitForValue(browser, 'images after Backspace', shownImages, [])

    await browser.pause(UNDO_STEP_MS)
    await typeKeys(browser, ')')
    await waitForValue(browser, 'doc after `)`', docAndCaret, withImage)
    await waitForValue(browser, 'images after `)`', shownImages, shown)

    // Undo the `)`, then the Backspace; redo both.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after one undo', docAndCaret, source)
    await waitForValue(browser, 'images after one undo', shownImages, [])
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after two undos', docAndCaret, withImage)
    await waitForValue(browser, 'images after two undos', shownImages, shown)
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after one redo', docAndCaret, source)
    await waitForValue(browser, 'images after one redo', shownImages, [])
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after two redos', docAndCaret, withImage)
    await waitForValue(browser, 'images after two redos', shownImages, shown)
  })

  it('moves the caret over an image with one arrow key press', async () => {
    await newTab()
    const image = await insertPastedImage('See ', ' here')
    await waitForValue(browser, 'shown image', shownImages, [shownPastedImage(image)])
    await setCaret(browser, image.from)
    const caret = async (): Promise<number> => (await docAndCaret()).caret

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
    const shown = [shownPastedImage(image)]
    await waitForValue(browser, 'shown image', shownImages, shown)
    await setCaret(browser, image.from)

    await browser.keys(Key.Delete)
    await waitForValue(browser, 'doc after Delete', docAndCaret, { doc: `See ${image.reference.slice(1)} here`, caret: image.from })
    await waitForValue(browser, 'images after Delete', shownImages, [])

    await typeKeys(browser, '!')
    await waitForValue(browser, 'doc after `!`', () => editorDoc(browser), `See ${image.reference} here`)
    await waitForValue(browser, 'images after `!`', shownImages, shown)
  })

  it('puts a dropped image at the drop point', async () => {
    const before = await storedImages()
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Before after')

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
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Some text')
    const before = await storedImages()

    const accepted = await dropFiles(await docPoint('Some '.length), [
      { name: 'notes.txt', type: 'text/plain', base64: Buffer.from('notes').toString('base64') },
    ])
    expect(accepted).toEqual({ dragover: true, drop: true })
    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === NOT_AN_IMAGE_MESSAGE), true)
    expect(await editorDoc(browser)).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // Outside the editor, the window refuses every file drop, so the
    // webview does not open the file in place of the app.
    const refused = await dropFiles(await elementCenter(browser, 'header.tab-bar'), [
      { name: 'red.png', type: 'image/png', base64: PASTED_PNG.toString('base64') },
    ])
    expect(refused).toEqual({ dragover: true, drop: true })
    expect(await editorDoc(browser)).toBe('Some text')
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
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Before after')

    await nativeDrop(await docPoint('Before '.length), [source])
    await expectDroppedImage(before)
  })

  it('leaves out a native-dropped file that is not an image, and puts a dropped link in as text', async () => {
    await newTab()
    await focusEditor(browser)
    await typeKeys(browser, 'Some text')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Some text')
    const before = await storedImages()

    await nativeDrop(await docPoint('Some '.length), [path.join(setup.app.home, 'notes.txt')])
    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === NOT_AN_IMAGE_MESSAGE), true)
    expect(await editorDoc(browser)).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // wry passes on a URI that is not a `file://` URI as it is.
    const link = 'https://example.com/page'
    await nativeDrop(await docPoint('Some '.length), [link])
    await waitForValue(browser, 'dropped link', docAndCaret, { doc: `Some ${link}text`, caret: 'Some '.length + link.length })
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
    expect(await openToasts(browser, 'warning')).toEqual([{
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
    await waitForValue(browser, 'shown image', shownImages, [shownPastedImage(image)])
    expect(await activeTabTitle()).toBe(`[image]${QUESTION}`)
  })
})
