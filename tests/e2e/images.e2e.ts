import fs from 'node:fs'
import path from 'node:path'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { openAiSystemMessage, sentImageUrls } from './harness/chatBody'
import { consoleErrors, elementCenter, movePointer, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue, type Point } from './harness/dom'
import { dropFiles, linkedDropDir, nativeDrop } from './harness/drops'
import { appFilePath, conversationFilePath, filesIn, storedFileName, writeTestFile } from './harness/fixtures'
import { colorDistance, decodedImage, pasteImage, pasteImageReference, referencePath, shownImages, solidPng, STRIPE_COLORS, stripedPng, type ShownImage } from './harness/images'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabTitle, closeToasts, copySelection, docPos, docPosPoint, editorCaret, editorDoc, focusEditor, newTab, openToasts, pasteText, pickModel, pressRolePill, sbpCall, setCaret, threadSections, waitForThread } from './harness/thread'

// Images in a conversation, driven through the real app: a paste or a drop
// stores the file and puts its reference, with a new image id, in the doc,
// the editor shows the image (through the asset protocol) with its id and a
// trash button in a hover toolbar at its top-right corner, each with a
// tooltip that says what it is for, and keeps its delete rules, the trash
// asks first and then deletes the file and the reference, an image that is
// pasted as text from another tab gets a new id (as do the pasted mentions
// of it) when the tab has an image with its id, a paste of mentions of an
// image of another tab asks first (Yes puts a copy of the image at the top
// of the paste, or gives the mentions the id of the same image in the tab;
// No pastes the text as it is), both API formats
// get the image in the request body after its reference's text with the id
// and no path, every user message keeps its images in each later request
// as the same bytes, an image goes one time in a request (a later message
// that names it with `@a` goes as text), an image with a side of more than
// 1,568 pixels goes as a smaller JPEG copy that is the same in each
// request and after a relaunch, a model that does not read
// images gets only that text and the user a warning, no request holds an
// image path (also not a reference that shows its source or an image in a
// reply), a native drop of a file out of every temp folder links the file
// in place (shown, sent with no path, removed with no file delete) but
// copies it into an agent message, a user message that links a file does
// not switch to Agent, and a relaunch shows the saved image and the linked
// image again.
//
// WebDriver can send neither clipboard data nor an OS drag, so the paste
// and drop events are synthetic DOM events built in the page. The PNG bytes
// are built here and cross `browser.execute` as base64.
//
// One app session serves the whole file. Each test opens a new tab. The
// relaunch test reopens the conversations of earlier tests, so it runs
// last.

const VISION: MockProvider = { id: 'vision', name: 'Vision Mock', modelId: 'vision-model', modelName: 'Vision Model' }
// A second model of Vision Mock, which does not read images.
const TEXT_MODEL = { id: 'text-model', name: 'Text Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }

// Longer than CodeMirror's history group delay (500 ms): two edits with
// this pause between them are two undo steps.
const UNDO_STEP_MS = 600

const QUESTION = ' What color?'
const NOT_AN_IMAGE_OR_CLIP_MESSAGE = 'Only images and audio and video clips can be dropped into a conversation. Clips must be mp4, webm, mov, mp3, wav, ogg, flac, m4a, aac, or opus files.'
const PASTED_PNG = solidPng(48, 32, [220, 40, 40])
const DROPPED_PNG = solidPng(40, 24, [40, 90, 220])
// PASTED_PNG as an OpenAI-format image part.
const PASTED_IMAGE_URL_PART = { type: 'image_url', image_url: { url: `data:image/png;base64,${PASTED_PNG.toString('base64')}` } }
// Wider than an image's overlay toolbar (its facts make it wide), which is
// wider than PASTED_PNG.
const WIDE_PNG = solidPng(400, 60, [30, 30, 30])
// 3000 x 200 pixels in three stripes: wider than the largest side of an
// image of a chat request (`CHAT_IMAGE_SIDE`, 1568).
const LARGE_PNG = stripedPng(1000, 200, STRIPE_COLORS)

/** A Dez image reference in the doc, `![id=<letters>](<absolute path>)`. */
const REFERENCE = /!\[id=[a-z]+\]\([^\s()]+\)/

interface DocAndCaret {
  doc: string
  caret: number
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

interface InsertedImage {
  path: string
  /** `![id=a](<path>)`: each test puts it in a new tab, so its id is `a`. */
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
  // The first user message and conversation of the linked image test, for
  // the relaunch test.
  let sentLinkedImage: { message: string, conversationId: string } | null = null
  // The conversation of the large image test, the sections of its thread,
  // and the data URL of the copy of the image that its requests sent, for
  // the relaunch test.
  let sentLargeImage: { conversationId: string, thread: Array<{ role: string, text: string }>, url: string } | null = null
  // The folder of the files that a drop links, out of every temp folder.
  let linkedDir: string

  function imagesDir (): string {
    return appFilePath(setup.app.home, 'assets', 'images')
  }

  // The file names in the image folder, sorted.
  async function storedImages (): Promise<string[]> {
    return filesIn(imagesDir())
  }

  async function docAndCaret (): Promise<DocAndCaret> {
    return { doc: await editorDoc(browser), caret: await editorCaret(browser) }
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

  // The three ways to close a confirm prompt with No.
  function promptCancels (): Array<[string, () => Promise<unknown>]> {
    return [
      ['No', () => pointerClick(browser, '.confirm-btn--cancel')],
      ['Esc', () => browser.keys(Key.Escape)],
      // Off the dialog, on the overlay around it.
      ['a click outside', () => pointerClickAt(browser, { x: 20, y: 300 })],
    ]
  }

  // WebKit can move the DOM caret to the editor start a few ms after the
  // editor gets the focus back, when CodeMirror has already put its own
  // caret there. Seen on a click outside the prompt under CPU load: the
  // caret then went to the doc start. This makes the same move on the next
  // focus of the editor, so that each run checks that Dez puts the caret
  // back (`focusKeepingScroll`, src/view/editor/focus.ts).
  // `startCaretSettled` is true when CodeMirror has read the DOM selection
  // again since the move: in the `selectionchange` of the move, in its focus
  // timer (10 ms), and in the measure frame after that timer.
  async function moveCaretToStartAfterFocus (): Promise<void> {
    await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('moveCaretToStartAfterFocus: .cm-content not found')
      Reflect.set(window, 'startCaretSettled', false)
      content.addEventListener('focus', () => setTimeout(() => {
        document.getSelection()?.collapse(content, 0)
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          Reflect.set(window, 'startCaretSettled', true)
        })), 20)
      }), { once: true })
    })
  }

  async function startCaretSettled (): Promise<boolean> {
    return browser.execute(() => Reflect.get(window, 'startCaretSettled') === true)
  }

  // Puts `text` at the end of the doc as typed text, which gets no image ids
  // (only a paste or a drop does).
  async function typeAtEnd (text: string): Promise<void> {
    await browser.execute((insert: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('typeAtEnd: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent: 'input.type' })
    }, text)
  }

  // A viewport point just inside the char after doc position `pos`, on the
  // middle of its line: CodeMirror maps it back to `pos`.
  async function docPoint (pos: number): Promise<Point> {
    const point = await docPosPoint(browser, pos, 1)
    return { x: point.x + 1, y: point.y }
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
    expect(reference).toBe(`![id=a](${path.join(imagesDir(), fileName)})`)
    expect(await storedImages()).toEqual([...before, fileName].sort())
    expect(await fs.promises.readFile(path.join(imagesDir(), fileName))).toEqual(DROPPED_PNG)
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: fileName, width: 40, height: 24 }])
  }

  // Types `before` in the empty active tab, pastes PASTED_PNG, waits for
  // its reference (the tab's first image, so its id is `a`), then types
  // `after`, which lands after the image only when the paste left the caret
  // there.
  async function insertPastedImage (before: string, after: string): Promise<InsertedImage> {
    await focusEditor(browser)
    await typeKeys(browser, before)
    await pasteImage(browser, PASTED_PNG)
    await waitForValue(browser, 'pasted reference', async () => REFERENCE.test(await editorDoc(browser)), true)
    const pasted = await docAndCaret()
    const reference = pasted.doc.slice(before.length)
    expect(pasted.doc.slice(0, before.length)).toBe(before)
    expect(reference).toBe(`![id=a](${referencePath(reference)})`)
    expect(pasted.caret).toBe(pasted.doc.length)
    await typeKeys(browser, after)
    await waitForValue(browser, 'text after the image', () => editorDoc(browser), before + reference + after)
    return { path: referencePath(reference), reference, from: before.length, to: before.length + reference.length }
  }

  // In a new tab: pastes PASTED_PNG (`a`), types ` Make @a blue` after it,
  // and copies only that text, with no image.
  async function copyMentionOnly (): Promise<{ image: InsertedImage, copied: string }> {
    await newTab(browser)
    const image = await insertPastedImage('', ' Make @a blue')
    await setCaret(browser, image.to + 1, (await editorDoc(browser)).length)
    const copied = await copySelection(browser)
    expect(copied).toBe('Make @a blue')
    return { image, copied }
  }

  // In a new tab: an image `a` of the tab's own, text that names it, and a
  // second line `Note: `, with the caret at its end.
  async function tabWithOwnImage (): Promise<{ image: InsertedImage, beforePaste: string }> {
    await newTab(browser)
    const image = await insertPastedImage('See @a: ', '')
    await browser.keys(Key.Enter)
    await typeKeys(browser, 'Note: ')
    const beforePaste = `See @a: ${image.reference}\nNote: `
    await waitForValue(browser, 'doc before the paste', docAndCaret, { doc: beforePaste, caret: beforePaste.length })
    return { image, beforePaste }
  }

  // Sends the active tab with Ctrl+Enter and takes its request, with the
  // body as sent and parsed.
  async function sendRequest (): Promise<{ path: string, rawBody: string, body: unknown, reply: HeldRequest['reply'] }> {
    await browser.keys([Key.Control, Key.Enter])
    const request = await setup.mock.waitForRequest(browser)
    return { path: request.path, rawBody: request.body, body: JSON.parse(request.body), reply: request.reply }
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(VISION, {
      models: [
        { id: VISION.modelId, name: VISION.modelName },
        { id: TEXT_MODEL.id, name: TEXT_MODEL.name, imageInput: false },
      ],
    }, { moreProviders: [{ provider: CLAUDE }] })
    browser = setup.browser
    linkedDir = await linkedDropDir('images')
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    // The non-image toast of one drop test stays open into the next.
    await closeToasts(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('stores a pasted image, puts its reference at the caret, and shows the image', async () => {
    const before = await storedImages()
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')

    const fileName = path.basename(image.path)
    expect(fileName).toMatch(storedFileName('png'))
    expect(image.path).toBe(path.join(imagesDir(), fileName))
    expect(await storedImages()).toEqual([...before, fileName].sort())
    expect(await fs.promises.readFile(image.path)).toEqual(PASTED_PNG)
    await waitForValue(browser, 'shown image', () => shownImages(browser), [shownPastedImage(image)])
  })

  it('gives each image of a conversation its own id, shown with a trash at its top-right corner while the pointer is on the image', async () => {
    await newTab(browser)
    const first = await insertPastedImage('', ' and ')
    const firstLine = `${first.reference} and `
    await pasteImage(browser, PASTED_PNG)
    await waitForValue(browser, 'second reference', async () => (await editorDoc(browser)).length > firstLine.length, true)
    const second = (await editorDoc(browser)).slice(firstLine.length)
    const secondPath = referencePath(second)
    expect(second).toBe(`![id=b](${secondPath})`)
    expect(secondPath).not.toBe(first.path)

    // A reference with no id gets only the trash; this one is to an image
    // wider than its overlay. The overlay of an image whose file is gone is
    // in its box.
    const wide = path.join(imagesDir(), 'wide.png')
    await fs.promises.writeFile(wide, WIDE_PNG)
    await typeAtEnd(`\n![](${wide})\n![id=c](${path.join(imagesDir(), 'gone.png')})`)
    await waitForValue(browser, 'shown images', () => shownImages(browser), [
      shownPastedImage(first),
      { alt: path.basename(secondPath), width: 48, height: 32 },
      { alt: 'wide.png', width: 400, height: 60 },
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

  it('gives an image that is pasted from another tab a new id, and the pasted mentions of it too, when the tab has an image with its id', async () => {
    // The first tab: an image, which is `a` there, and text that names it.
    await newTab(browser)
    const copiedImage = await insertPastedImage('', ' edit @a, not @a-team')
    await setCaret(browser, 0, (await editorDoc(browser)).length)
    const copied = await copySelection(browser)
    expect(copied).toContain(`${copiedImage.reference} edit @a, not @a-team`)

    // The second tab has an image `a` of its own, and text that names it.
    await newTab(browser)
    const ownImage = await insertPastedImage('See @a: ', '')
    await browser.keys(Key.Enter)
    const beforePaste = `See @a: ${ownImage.reference}\n`
    await waitForValue(browser, 'doc before the paste', () => editorDoc(browser), beforePaste)
    await pasteText(browser, copied)

    // The pasted image is `b` here, and so is its mention. `@a-team` is no
    // mention, and the tab's own `@a` was not pasted.
    const afterPaste = `${beforePaste}![id=b](${copiedImage.path}) edit @b, not @a-team`
    await waitForValue(browser, 'doc after the paste', docAndCaret, { doc: afterPaste, caret: afterPaste.length })
    await waitForValue(browser, 'shown images', () => shownImages(browser), [shownPastedImage(ownImage), shownPastedImage(copiedImage)])
    expect((await imageOverlays()).map((overlay) => overlay.id)).toEqual(['a', 'b'])

    // One undo takes back the paste and its new ids.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after undo', () => editorDoc(browser), beforePaste)
  })

  it('asks before a paste of mentions of an image of another tab, and on Enter (Yes) puts a copy of the image at the top of the paste, with a new id that the mentions take', async () => {
    const { image: copiedImage, copied } = await copyMentionOnly()
    const { image: ownImage, beforePaste } = await tabWithOwnImage()
    await pasteText(browser, copied)
    await waitForValue(browser, 'prompt', promptState, {
      message: 'The pasted text names an asset of another conversation. Add it at the top of the paste, and change the names in the text to fit this conversation? Choose No to paste the text as it is.',
      buttons: ['No', 'Yes'],
      focus: 'yes',
    })
    expect(await editorDoc(browser)).toBe(beforePaste)

    // The tab has an image `a` of its own, so the copy is `b`, on a line of
    // its own at the start of the paste's line.
    await browser.keys(Key.Enter)
    const afterPaste = `See @a: ${ownImage.reference}\n![id=b](${copiedImage.path})\nNote: Make @b blue`
    await waitForValue(browser, 'doc after Enter', docAndCaret, { doc: afterPaste, caret: afterPaste.length })
    await waitForValue(browser, 'prompt after Enter', promptState, { message: null, buttons: [], focus: 'editor' })
    await waitForValue(browser, 'shown images', () => shownImages(browser), [shownPastedImage(ownImage), shownPastedImage(copiedImage)])
    expect((await imageOverlays()).map((overlay) => overlay.id)).toEqual(['a', 'b'])

    // One undo takes back the paste, the copy, and the new ids.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after undo', () => editorDoc(browser), beforePaste)
  })

  it('gives the pasted mentions of an image of another tab the id of the same image in this tab, on Yes, and adds no copy', async () => {
    const { image: copiedImage, copied } = await copyMentionOnly()
    await newTab(browser)
    const ownImage = await insertPastedImage('', '')
    // The file of the copied image, as typed text: it keeps its id.
    const sameImage = `![id=b](${copiedImage.path})`
    await typeAtEnd(`\n${sameImage}\nNote: `)
    const beforePaste = `${ownImage.reference}\n${sameImage}\nNote: `
    await setCaret(browser, beforePaste.length)
    const shown = [shownPastedImage(ownImage), shownPastedImage(copiedImage)]
    await waitForValue(browser, 'shown images before the paste', () => shownImages(browser), shown)

    await pasteText(browser, copied)
    await waitForValue(browser, 'prompt', promptState, {
      message: 'This conversation has the assets that the pasted text names, under other ids. Change the names in the text to these ids? Choose No to paste the text as it is.',
      buttons: ['No', 'Yes'],
      focus: 'yes',
    })
    await pointerClick(browser, '.confirm-btn--confirm')
    // `@a` would name the tab's own image.
    const afterPaste = `${beforePaste}Make @b blue`
    await waitForValue(browser, 'doc after Yes', docAndCaret, { doc: afterPaste, caret: afterPaste.length })
    expect(await shownImages(browser)).toEqual(shown)
  })

  it('pastes mentions of an image of another tab as they are on No, Esc, or a click outside the prompt', async () => {
    const { copied } = await copyMentionOnly()
    const { image: ownImage, beforePaste } = await tabWithOwnImage()
    for (const [label, cancel] of promptCancels()) {
      await pasteText(browser, copied)
      await waitForValue(browser, `prompt before ${label}`, async () => (await promptState()).focus, 'yes')
      await cancel()
      const afterPaste = `${beforePaste}Make @a blue`
      await waitForValue(browser, `doc after ${label}`, docAndCaret, { doc: afterPaste, caret: afterPaste.length })
      await waitForValue(browser, `prompt after ${label}`, promptState, { message: null, buttons: [], focus: 'editor' })
      expect(await shownImages(browser)).toEqual([shownPastedImage(ownImage)])

      await browser.keys([Key.Control, 'z'])
      await waitForValue(browser, `doc after the undo of the paste on ${label}`, docAndCaret, { doc: beforePaste, caret: beforePaste.length })
    }
  })

  it('explains the id badge and the trash in tooltips while the pointer is on them', async () => {
    await newTab(browser)
    await insertPastedImage('See ', ' here')
    await typeAtEnd(`\n![id=b](${path.join(imagesDir(), 'gone.png')})`)
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
        text: 'Refer to this image in a message as image @a.',
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
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')
    const shown = [shownPastedImage(image)]
    await waitForValue(browser, 'shown image', () => shownImages(browser), shown)
    // The trash takes its own press, so the caret stays where it is.
    const unchanged = { doc: `See ${image.reference} here`, caret: 2 }
    await setCaret(browser, unchanged.caret)

    for (const [label, cancel] of promptCancels()) {
      await clickTrash(0)
      await waitForValue(browser, `prompt before ${label}`, promptState, {
        message: 'Are you sure you want to delete this image?',
        buttons: ['No', 'Yes'],
        focus: 'yes',
      })
      expect(await docAndCaret()).toEqual(unchanged)

      await moveCaretToStartAfterFocus()
      await cancel()
      await waitForValue(browser, `prompt after ${label}`, promptState, { message: null, buttons: [], focus: 'editor' })
      await waitForValue(browser, `the caret move after ${label}`, startCaretSettled, true)
      expect(await docAndCaret()).toEqual(unchanged)
      expect(await storedImages()).toContain(path.basename(image.path))
      expect(await shownImages(browser)).toEqual(shown)
    }
  })

  it('deletes the file and the reference of an image on Yes or Enter, with no undo, and the text of a missing image', async () => {
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')
    const gone = `![](${path.join(imagesDir(), 'gone.png')})`
    await typeAtEnd(`\n${gone}`)
    await waitForValue(browser, 'shown image', () => shownImages(browser), [shownPastedImage(image)])
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
    expect(await shownImages(browser)).toEqual([])
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

  it('puts back the New Tab title when the trash deletes the only content of a tab, an image', async () => {
    await newTab(browser)
    await insertPastedImage('', '')
    await waitForValue(browser, 'title with the image', () => activeTabTitle(browser), '[image]')

    await clickTrash(0)
    await waitForValue(browser, 'prompt', async () => (await promptState()).focus, 'yes')
    await browser.keys(Key.Enter)
    await waitForValue(browser, 'doc after Enter', () => editorDoc(browser), '')
    await waitForValue(browser, 'title after the delete', () => activeTabTitle(browser), 'New Tab')
  })

  it('shows the source on Backspace after an image, and the image again on `)`, undo, and redo', async () => {
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')
    const shown = [shownPastedImage(image)]
    const withImage = { doc: `See ${image.reference} here`, caret: image.to }
    const source = { doc: `See ${image.reference.slice(0, -1)} here`, caret: image.to - 1 }
    await waitForValue(browser, 'shown image', () => shownImages(browser), shown)
    await setCaret(browser, image.to)

    await browser.pause(UNDO_STEP_MS)
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'doc after Backspace', docAndCaret, source)
    await waitForValue(browser, 'images after Backspace', () => shownImages(browser), [])

    await browser.pause(UNDO_STEP_MS)
    await typeKeys(browser, ')')
    await waitForValue(browser, 'doc after `)`', docAndCaret, withImage)
    await waitForValue(browser, 'images after `)`', () => shownImages(browser), shown)

    // Undo the `)`, then the Backspace; redo both.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after one undo', docAndCaret, source)
    await waitForValue(browser, 'images after one undo', () => shownImages(browser), [])
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after two undos', docAndCaret, withImage)
    await waitForValue(browser, 'images after two undos', () => shownImages(browser), shown)
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after one redo', docAndCaret, source)
    await waitForValue(browser, 'images after one redo', () => shownImages(browser), [])
    await browser.keys([Key.Control, Key.Shift, 'z'])
    await waitForValue(browser, 'doc after two redos', docAndCaret, withImage)
    await waitForValue(browser, 'images after two redos', () => shownImages(browser), shown)
  })

  it('moves the caret over an image with one arrow key press', async () => {
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')
    await waitForValue(browser, 'shown image', () => shownImages(browser), [shownPastedImage(image)])
    await setCaret(browser, image.from)

    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'caret after one ArrowRight', () => editorCaret(browser), image.to)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'caret after two ArrowRights', () => editorCaret(browser), image.to + 1)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after one ArrowLeft', () => editorCaret(browser), image.to)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after two ArrowLefts', () => editorCaret(browser), image.from)
  })

  it('shows the source on Delete before an image, and the image again when `!` is typed', async () => {
    await newTab(browser)
    const image = await insertPastedImage('See ', ' here')
    const shown = [shownPastedImage(image)]
    await waitForValue(browser, 'shown image', () => shownImages(browser), shown)
    await setCaret(browser, image.from)

    await browser.keys(Key.Delete)
    await waitForValue(browser, 'doc after Delete', docAndCaret, { doc: `See ${image.reference.slice(1)} here`, caret: image.from })
    await waitForValue(browser, 'images after Delete', () => shownImages(browser), [])

    await typeKeys(browser, '!')
    await waitForValue(browser, 'doc after `!`', () => editorDoc(browser), `See ${image.reference} here`)
    await waitForValue(browser, 'images after `!`', () => shownImages(browser), shown)
  })

  it('puts a dropped image at the drop point', async () => {
    const before = await storedImages()
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Before after')

    const accepted = await dropFiles(browser, await docPoint('Before '.length), [
      { name: 'blue.png', type: 'image/png', base64: DROPPED_PNG.toString('base64') },
    ])
    expect(accepted).toEqual({ dragover: true, drop: true })
    await expectDroppedImage(before)
  })

  it('stores and inserts no dropped file that is not an image, and says so', async () => {
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'Some text')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Some text')
    const before = await storedImages()

    const accepted = await dropFiles(browser, await docPoint('Some '.length), [
      { name: 'notes.txt', type: 'text/plain', base64: Buffer.from('notes').toString('base64') },
    ])
    expect(accepted).toEqual({ dragover: true, drop: true })
    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === NOT_AN_IMAGE_OR_CLIP_MESSAGE), true)
    expect(await editorDoc(browser)).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // Outside the editor, the window refuses every file drop, so the
    // webview does not open the file in place of the app.
    const refused = await dropFiles(browser, await elementCenter(browser, 'header.tab-bar'), [
      { name: 'red.png', type: 'image/png', base64: PASTED_PNG.toString('base64') },
    ])
    expect(refused).toEqual({ dragover: true, drop: true })
    expect(await editorDoc(browser)).toBe('Some text')
    expect(await storedImages()).toEqual(before)
  })

  it('puts an image of a native file drop at the drop point', async () => {
    // The app's home is in the temp folder, so the drop copies the file.
    const source = await writeTestFile(path.join(imagesDir(), 'native-drop-source.png'), DROPPED_PNG)
    const before = await storedImages()
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Before after')

    await nativeDrop(browser, await docPoint('Before '.length), [source])
    await expectDroppedImage(before)
  })

  it('leaves out a native-dropped file that is not an image, and puts a dropped link in as text', async () => {
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'Some text')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Some text')
    const before = await storedImages()

    await nativeDrop(browser, await docPoint('Some '.length), [path.join(setup.app.home, 'notes.txt')])
    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === NOT_AN_IMAGE_OR_CLIP_MESSAGE), true)
    expect(await editorDoc(browser)).toBe('Some text')
    expect(await storedImages()).toEqual(before)

    // wry passes on a URI that is not a `file://` URI as it is.
    const link = 'https://example.com/page'
    await nativeDrop(browser, await docPoint('Some '.length), [link])
    await waitForValue(browser, 'dropped link', docAndCaret, { doc: `Some ${link}text`, caret: 'Some '.length + link.length })
    expect(await storedImages()).toEqual(before)
  })

  // A file in a dot folder, with a space and parens in its name: the asset
  // scope takes every file, and the reference takes such a path.
  it('links an image of a native file drop from a folder that is not a temp folder, shows it, and sends it with no path', async () => {
    const source = await writeTestFile(path.join(linkedDir, '.dot folder', 'My photo (1).png'), DROPPED_PNG)
    const before = await storedImages()
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'Before after')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Before after')

    await nativeDrop(browser, await docPoint('Before '.length), [source])
    // The path has a space and parens, so it is in `<…>`.
    const message = `Before ![id=a](<${source}>)after`
    await waitForValue(browser, 'linked reference', docAndCaret, { doc: message, caret: message.length - 'after'.length })
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: 'My photo (1).png', width: 40, height: 24 }])
    expect(await storedImages()).toEqual(before)

    const request = await sendRequest()
    expect(request.rawBody).not.toContain(linkedDir)
    expect(request.rawBody).not.toContain('My photo')
    expect(request.body).toHaveProperty('messages', [openAiSystemMessage(VISION), {
      role: 'user',
      content: [
        { type: 'text', text: 'Before ![id=a](image)' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${DROPPED_PNG.toString('base64')}` } },
        { type: 'text', text: 'after' },
      ],
    }])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: message },
      { role: 'agent', text: replyText(VISION.modelName) },
      { role: 'user', text: '' },
    ])
    const conversationId = await activeConversationId(browser)
    await waitForValue(browser, 'saved reference', async () => {
      const content = await fs.promises.readFile(conversationFilePath(setup.app.home, conversationId), 'utf8').catch(() => '')
      return content.split('\n').includes(message)
    }, true)
    sentLinkedImage = { message, conversationId }
  })

  it('asks before the trash removes a linked image, keeps its file, and brings the image back on undo', async () => {
    const source = await writeTestFile(path.join(linkedDir, 'kept.png'), DROPPED_PNG)
    await newTab(browser)
    await focusEditor(browser)
    await typeKeys(browser, 'See  here')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'See  here')
    await nativeDrop(browser, await docPoint('See '.length), [source])
    await waitForValue(browser, 'shown image', () => shownImages(browser), [{ alt: 'kept.png', width: 40, height: 24 }])
    expect(await editorDoc(browser)).toBe(`See ![id=a](${source}) here`)
    await setCaret(browser, 2)

    await clickTrash(0)
    await waitForValue(browser, 'prompt', promptState, {
      message: 'Are you sure you want to remove this image from the conversation? Its file stays where it is.',
      buttons: ['No', 'Yes'],
      focus: 'yes',
    })
    await browser.keys(Key.Enter)
    await waitForValue(browser, 'doc after Enter', docAndCaret, { doc: 'See  here', caret: 2 })
    await waitForValue(browser, 'prompt after Enter', promptState, { message: null, buttons: [], focus: 'editor' })
    expect(await fs.promises.readFile(source)).toEqual(DROPPED_PNG)

    // The file stays, so the removal is an undo step.
    await browser.keys([Key.Control, 'z'])
    await waitForValue(browser, 'doc after undo', () => editorDoc(browser), `See ![id=a](${source}) here`)
    await waitForValue(browser, 'image after undo', () => shownImages(browser), [{ alt: 'kept.png', width: 40, height: 24 }])
  })

  // A linked path counts only in a user message.
  it('copies a file dropped into an agent message, and keeps a user message that links a file from a switch to Agent', async () => {
    const source = await writeTestFile(path.join(linkedDir, 'switch.png'), DROPPED_PNG)
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'Hi')
    await waitForValue(browser, 'typed text', () => editorDoc(browser), 'Hi')
    const request = await sendRequest()
    await sendChatReply(request.reply, VISION.modelName)
    const reply = replyText(VISION.modelName)
    await waitForThread(browser, [{ role: 'user', text: 'Hi' }, { role: 'agent', text: reply }, { role: 'user', text: '' }])

    const before = await storedImages()
    await nativeDrop(browser, await docPoint(await docPos(browser, reply)), [source])
    await waitForValue(browser, 'stored copy', async () => (await storedImages()).length, before.length + 1)
    const fileName = (await storedImages()).find((name) => !before.includes(name)) ?? ''
    expect(await fs.promises.readFile(path.join(imagesDir(), fileName))).toEqual(DROPPED_PNG)
    const copied = `![id=a](${path.join(imagesDir(), fileName)})${reply}`
    const copiedImage = { alt: fileName, width: 40, height: 24 }
    await waitForThread(browser, [{ role: 'user', text: 'Hi' }, { role: 'agent', text: copied }, { role: 'user', text: '' }])
    await waitForValue(browser, 'shown copy', () => shownImages(browser), [copiedImage])

    await nativeDrop(browser, await docPoint((await editorDoc(browser)).length), [source])
    const sections = [{ role: 'user', text: 'Hi' }, { role: 'agent', text: copied }, { role: 'user', text: `![id=b](${source})` }]
    const shown = [copiedImage, { alt: 'switch.png', width: 40, height: 24 }]
    await waitForThread(browser, sections)
    await waitForValue(browser, 'shown images', () => shownImages(browser), shown)

    await pressRolePill(browser, 2, '.dez-role-separator__label', { shiftKey: true })
    await waitForValue(browser, 'warning', async () => (await openToasts(browser, 'warning')).map((toast) => toast.title), ['Message not switched to Agent'])
    expect(await threadSections(browser)).toEqual(sections)
    expect(await shownImages(browser)).toEqual(shown)
  })

  it('sends a pasted image to an OpenAI-format model as a data URL, and titles the tab with [image]', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(VISION))
    expect(request.body).toHaveProperty('messages', [openAiSystemMessage(VISION), {
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
        PASTED_IMAGE_URL_PART,
        { type: 'text', text: QUESTION },
      ],
    }])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: image.reference + QUESTION },
      { role: 'agent', text: replyText(VISION.modelName) },
      { role: 'user', text: '' },
    ])
    expect(await activeTabTitle(browser)).toBe(`[image]${QUESTION}`)

    const conversationId = await activeConversationId(browser)
    await waitForValue(browser, 'saved reference', async () => {
      const content = await fs.promises.readFile(conversationFilePath(setup.app.home, conversationId), 'utf8').catch(() => '')
      return content.split('\n').includes(image.reference + QUESTION)
    }, true)
    sentImage = { image, conversationId }
  })

  it('sends a pasted image to an Anthropic-format model as an image block', async () => {
    await newTab(browser)
    await pickModel(browser, CLAUDE.name, CLAUDE.modelName)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(CLAUDE))
    // The last block of the last user message carries a cache breakpoint
    // (`withCacheBreakpoints` in src/model/providers/apiFormats.ts).
    expect(request.body).toHaveProperty('messages', [{
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
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

  it('sends only the text of an image reference, with no path, to a model that does not read images, and warns', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, TEXT_MODEL.name)
    const image = await insertPastedImage('', QUESTION)

    const request = await sendRequest()
    expect(request.path).toBe(mockChatPath(VISION))
    expect(request.body).toHaveProperty('messages', [
      openAiSystemMessage({ ...VISION, modelId: TEXT_MODEL.id }),
      { role: 'user', content: `![id=a](image)${QUESTION}` },
    ])
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

  // The report: references in a code fence to files that are gone showed
  // "Image not found" boxes. Code is text (src/model/chat/codeRanges.ts).
  it('shows a reference in code as its text, with no image and no "Image not found" box', async () => {
    await newTab(browser)
    await focusEditor(browser)
    const gone = `![id=a](${path.join(imagesDir(), 'gone.png')})`
    const typed = `Code:\n\`\`\`\n${gone}\n\`\`\`\nand \`${gone}\`\n\n    ${gone}\n\nNot code: ${gone}`
    await typeAtEnd(typed)
    await waitForValue(browser, 'typed doc', () => editorDoc(browser), typed)
    // Only the reference out of code gets a box.
    await waitForValue(browser, 'missing image boxes', () => browser.execute(
      () => Array.from(document.querySelectorAll('.cm-content .dez-image-missing'), (box) => box.firstChild?.textContent ?? null),
    ), ['Image not found: gone.png'])
    expect(await browser.execute(() => document.querySelectorAll('.cm-content .dez-image').length)).toBe(1)
    const shownText = await browser.execute(() => document.querySelector('.cm-content')?.textContent ?? '')
    expect(shownText.split(gone).length - 1).toBe(3)
  })

  it('shows and sends only the image whose reference is out of code, with no toast, and the code with no path', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    const image = await insertPastedImage('', '')
    const code = `\n\`\`\`\n${image.reference}\n\`\`\`\nand \`${image.reference}\``
    await typeAtEnd(code)
    await waitForValue(browser, 'doc with the copies in code', () => editorDoc(browser), image.reference + code)
    await waitForValue(browser, 'shown image', () => shownImages(browser), [shownPastedImage(image)])

    const request = await sendRequest()
    expect(request.body).toHaveProperty('messages', [openAiSystemMessage(VISION), {
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
        PASTED_IMAGE_URL_PART,
        { type: 'text', text: '\n```\n![id=a](image)\n```\nand `![id=a](image)`' },
      ],
    }])
    expect(request.rawBody).not.toContain(imagesDir())
    expect(await openToasts(browser)).toEqual([])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: image.reference + code },
      { role: 'agent', text: replyText(VISION.modelName) },
      { role: 'user', text: '' },
    ])
  })

  it('sends no image path, also for a reference that shows its source and an image in a reply', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    const first = await insertPastedImage('', ' and ')
    const firstLine = `${first.reference} and `
    await pasteImage(browser, PASTED_PNG)
    await waitForValue(browser, 'second reference', async () => (await editorDoc(browser)).length > firstLine.length, true)
    const second = (await editorDoc(browser)).slice(firstLine.length)
    expect(second).toBe(`![id=b](${referencePath(second)})`)

    const firstRequest = await sendRequest()
    expect(firstRequest.body).toHaveProperty('messages', [openAiSystemMessage(VISION), {
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
        PASTED_IMAGE_URL_PART,
        { type: 'text', text: ' and ![id=b](image)' },
        PASTED_IMAGE_URL_PART,
      ],
    }])
    const reply = replyText(VISION.modelName)
    await sendChatReply(firstRequest.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: firstLine + second },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])

    // An image pasted at the end of the reply.
    const replyEnd = (await editorDoc(browser)).indexOf(reply) + reply.length
    await focusEditor(browser)
    await setCaret(browser, replyEnd)
    await pasteImage(browser, PASTED_PNG)
    const thirdReference = /^!\[id=c\]\([^\s()]+\)/
    await waitForValue(browser, 'reference in the reply', async () => thirdReference.test((await editorDoc(browser)).slice(replyEnd)), true)
    const [third = ''] = thirdReference.exec((await editorDoc(browser)).slice(replyEnd)) ?? []

    // Image b shows its source, `![id=b](<path>`.
    await setCaret(browser, firstLine.length + second.length)
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'source of image b', async () => (await threadSections(browser))[0]?.text ?? null, firstLine + second.slice(0, -1))

    await setCaret(browser, (await editorDoc(browser)).length)
    await typeKeys(browser, 'Compare.')
    await waitForValue(browser, 'thread before the second send', () => threadSections(browser), [
      { role: 'user', text: firstLine + second.slice(0, -1) },
      { role: 'agent', text: reply + third },
      { role: 'user', text: 'Compare.' },
    ])

    const request = await sendRequest()
    expect(request.rawBody).not.toContain('assets/images')
    expect(request.rawBody).not.toContain(setup.app.home)
    // The first message keeps the image of its whole reference. The
    // reference that shows its source and the image of the reply go as
    // text.
    expect(request.body).toHaveProperty('messages', [
      openAiSystemMessage(VISION),
      { role: 'user', content: [{ type: 'text', text: '![id=a](image)' }, PASTED_IMAGE_URL_PART, { type: 'text', text: ' and ![id=b](image' }] },
      { role: 'assistant', content: `${reply}![id=c](image)` },
      { role: 'user', content: 'Compare.' },
    ])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      { role: 'user', text: firstLine + second.slice(0, -1) },
      { role: 'agent', text: reply + third },
      { role: 'user', text: 'Compare.' },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
  })

  it('sends the image of a message again in each later request as the same bytes, and only one time when a later message names it with `@a`', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    const image = await insertPastedImage('', QUESTION)
    const reply = replyText(VISION.modelName)
    const assistant = { role: 'assistant', content: reply }
    const thread = [{ role: 'user', text: image.reference + QUESTION }]
    // Types the next user message at the end of the thread.
    const typeMessage = async (text: string) => {
      await setCaret(browser, (await editorDoc(browser)).length)
      await typeKeys(browser, text)
      thread.push({ role: 'user', text })
      await waitForValue(browser, `thread with ${JSON.stringify(text)}`, () => threadSections(browser), thread)
    }
    // The messages of the request before, each as JSON text in the key
    // order of the body as sent: equal texts mean equal bytes.
    let sentBefore: string[] = []
    // Sends the tab, checks the messages of the request after the system
    // message, and answers it. The request must start with the messages of
    // the request before as the same bytes: the provider's prompt cache
    // reads a request only up to its first byte that differs.
    const sendTurn = async (messages: unknown[]) => {
      const request = await sendRequest()
      expect(request.body).toHaveProperty('messages', [openAiSystemMessage(VISION), ...messages])
      const sent = (request.body as { messages: unknown[] }).messages.map((message) => JSON.stringify(message))
      expect(sent.slice(0, sentBefore.length)).toEqual(sentBefore)
      sentBefore = sent
      await sendChatReply(request.reply, VISION.modelName)
      thread.push({ role: 'agent', text: reply })
      await waitForThread(browser, [...thread, { role: 'user', text: '' }])
    }

    const withImage = {
      role: 'user',
      content: [{ type: 'text', text: '![id=a](image)' }, PASTED_IMAGE_URL_PART, { type: 'text', text: QUESTION }],
    }
    await sendTurn([withImage])

    // The message with the image keeps it in every later request.
    const earlier = [withImage, assistant, { role: 'user', content: 'Why?' }, assistant]
    await typeMessage('Why?')
    await sendTurn(earlier.slice(0, 3))
    await typeMessage('Sure?')
    await sendTurn([...earlier, { role: 'user', content: 'Sure?' }])

    // The first message carries the image, so a later message that names
    // it goes as text: an image goes one time in a request.
    await typeMessage('Is @a red?')
    await sendTurn([
      ...earlier,
      { role: 'user', content: 'Sure?' },
      assistant,
      { role: 'user', content: 'Is @a red?' },
    ])

    await typeMessage('Thanks.')
    await sendTurn([
      ...earlier,
      { role: 'user', content: 'Sure?' },
      assistant,
      { role: 'user', content: 'Is @a red?' },
      assistant,
      { role: 'user', content: 'Thanks.' },
    ])
  })

  it('sends an image with a side of more than 1,568 pixels as a smaller JPEG copy, the same one in each request, and keeps its file', async () => {
    await newTab(browser)
    await pickModel(browser, VISION.name, VISION.modelName)
    await focusEditor(browser)
    await pasteImageReference(browser, LARGE_PNG, 'a')
    const reference = await editorDoc(browser)
    await typeKeys(browser, QUESTION)
    await waitForValue(browser, 'text after the image', () => editorDoc(browser), reference + QUESTION)

    const first = await sendRequest()
    const [url = ''] = sentImageUrls(first.rawBody)
    expect(first.body).toHaveProperty('messages', [openAiSystemMessage(VISION), {
      role: 'user',
      content: [{ type: 'text', text: '![id=a](image)' }, { type: 'image_url', image_url: { url } }, { type: 'text', text: QUESTION }],
    }])
    // The copy has the shape of the image and fits in 1,568 by 1,568
    // pixels: 3000 x 200 gives 1568 x 105. Its stripes are those of the
    // image; a JPEG keeps colors only near to their values.
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    const copy = await decodedImage(browser, url, [261, 784, 1306])
    expect({ width: copy.width, height: copy.height }).toEqual({ width: 1568, height: 105 })
    STRIPE_COLORS.forEach((color, index) => {
      expect(colorDistance(copy.pixels[index], color), `color of stripe ${index}`).toBeLessThanOrEqual(12)
    })
    const reply = replyText(VISION.modelName)
    const thread = [{ role: 'user', text: reference + QUESTION }, { role: 'agent', text: reply }]
    await sendChatReply(first.reply, VISION.modelName)
    await waitForThread(browser, [...thread, { role: 'user', text: '' }])

    // The next request sends the same copy, so the provider's prompt cache
    // reads the first message again.
    await setCaret(browser, (await editorDoc(browser)).length)
    await typeKeys(browser, 'Sure?')
    const second = await sendRequest()
    expect(sentImageUrls(second.rawBody)).toEqual([url])
    await sendChatReply(second.reply, VISION.modelName)
    thread.push({ role: 'user', text: 'Sure?' }, { role: 'agent', text: reply })
    await waitForThread(browser, [...thread, { role: 'user', text: '' }])

    // Dez keeps the copy in memory only: the file of the image is as the
    // user pasted it.
    expect(await fs.promises.readFile(referencePath(reference))).toEqual(LARGE_PNG)

    const conversationId = await activeConversationId(browser)
    await waitForValue(browser, 'saved second reply', async () => {
      const content = await fs.promises.readFile(conversationFilePath(setup.app.home, conversationId), 'utf8').catch(() => '')
      return content.split(reply).length - 1
    }, 2)
    sentLargeImage = { conversationId, thread, url }
  })

  it('shows the saved image, the linked image, and the [image] tab title after a relaunch, and sends a large image as the same copy as before', async () => {
    if (!sentImage) throw new Error('The OpenAI test saved no conversation with an image')
    if (!sentLinkedImage) throw new Error('The linked image test saved no conversation with an image')
    if (!sentLargeImage) throw new Error('The large image test saved no conversation')
    const { image, conversationId } = sentImage
    const lastActive = await activeConversationId(browser)
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    // The restore sets the active tab after the tab bar shows; switch only
    // after it, or the restore switches back.
    await waitForValue(browser, 'restored active tab', () => activeConversationId(browser), lastActive)
    await sbpCall(browser, 'dez.model/tabs/openConversation', conversationId)
    await waitForValue(browser, 'reopened conversation', async () => (await threadSections(browser))[0]?.text ?? null, image.reference + QUESTION)
    await waitForValue(browser, 'shown image', () => shownImages(browser), [shownPastedImage(image)])
    expect(await activeTabTitle(browser)).toBe(`[image]${QUESTION}`)

    await sbpCall(browser, 'dez.model/tabs/openConversation', sentLinkedImage.conversationId)
    await waitForValue(browser, 'reopened linked image conversation', async () => (await threadSections(browser))[0]?.text ?? null, sentLinkedImage.message)
    await waitForValue(browser, 'shown linked image', () => shownImages(browser), [{ alt: 'My photo (1).png', width: 40, height: 24 }])

    // The app has no copy of the large image after its start, so it draws
    // a new one. That one must have the bytes of the one before, or the
    // provider's prompt cache could not read the conversation after an
    // app start.
    await sbpCall(browser, 'dez.model/tabs/openConversation', sentLargeImage.conversationId)
    await waitForThread(browser, [...sentLargeImage.thread, { role: 'user', text: '' }])
    await focusEditor(browser)
    await setCaret(browser, (await editorDoc(browser)).length)
    await typeKeys(browser, 'And now?')
    const request = await sendRequest()
    expect(sentImageUrls(request.rawBody)).toEqual([sentLargeImage.url])
    await sendChatReply(request.reply, VISION.modelName)
    await waitForThread(browser, [
      ...sentLargeImage.thread,
      { role: 'user', text: 'And now?' },
      { role: 'agent', text: replyText(VISION.modelName) },
      { role: 'user', text: '' },
    ])
  })
})
