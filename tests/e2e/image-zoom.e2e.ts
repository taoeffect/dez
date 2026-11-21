import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { ZOOM_MARGIN_PX } from '../../src/view/editor/imageZoom'
import { startApp, type RunningApp } from './harness/app'
import { closeSettings, consoleErrors, elementCenter, isOnTop, movePointer, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { FIND_FIELD, findDropdownOpen } from './harness/find'
import { appFilePath, seedAppState, writeTestFile } from './harness/fixtures'
import { colorDistance, screenPixels, shownImages, solidPng, type Rgb } from './harness/images'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeTabId, assetPartPoint, editorCaret, editorScrollTop, focusEditor, newTab, openPicker, openSeededConversation, sbpCall, setCaret } from './harness/thread'

// The image zoom, driven through the real app: the magnifier of an image's
// toolbar shows the image over the conversation view, as large as it fits
// inside a margin, at its aspect ratio, over a backdrop, with the keyboard
// in the zoom. The X, Escape, or a click on the backdrop closes it, and the
// editor gets the keyboard back with its caret and scroll as they were.
// Settings, Help, and the model picker show over the zoom, and Escape
// closes them first. The zoom fits itself to a new size of the view, stays
// through a rebuild of its tab, and closes when its reference goes or
// another tab shows.
//
// One app session serves the whole file. Each test opens its conversation
// in a new tab.

const COLOR: Rgb = [40, 120, 220]
// Wider than tall, and smaller than the view: the zoom grows it.
const PNG = solidPng(160, 90, COLOR)
// Lines around the image, so that the conversation scrolls.
const LINES = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}.`).join('\n')

const ZOOM = '.dez-image-zoom'
const ZOOM_IMAGE = '.dez-image-zoom__img'
const ZOOM_CLOSE = '.dez-image-zoom__close'

/** The state of the zoom: `opening` until its image shows and its
 *  animations are over. */
type ZoomPhase = 'none' | 'opening' | 'open' | 'closing'

interface Edges {
  left: number
  top: number
  right: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

/** The open zoom as the page draws it. */
interface ZoomLayout {
  role: string | null
  modal: string | null
  label: string | null
  /** Whether the layer is a child of the editor's root. */
  inEditorRoot: boolean
  /** How far each edge of the layer is in from that edge of the
   *  conversation view (`.cm-scroller`), in px. */
  offView: Edges
  /** The room between the zoomed image and each edge of the layer, in px. */
  gaps: Edges
  size: Size
  natural: Size
}

// What is wrong with the place of the zoom and of its image: the layer
// covers the conversation view, and the image is in its middle, at its
// aspect ratio, as large as it fits inside the margin. Empty when it fits.
function fitProblems ({ offView, gaps, size, natural }: ZoomLayout): string[] {
  const problems: string[] = []
  // The layer and the image get whole px; the view's box can have parts.
  const near = (a: number, b: number, slack: number): boolean => Math.abs(a - b) <= slack
  if (Object.values(offView).some((off) => !near(off, 0, 0.5))) problems.push(`layer off the view: ${JSON.stringify(offView)}`)
  if (!near(gaps.left, gaps.right, 1.5) || !near(gaps.top, gaps.bottom, 1.5)) problems.push(`image off center: ${JSON.stringify(gaps)}`)
  if (Math.min(...Object.values(gaps)) < ZOOM_MARGIN_PX - 1.5 || !near(Math.min(gaps.left, gaps.top), ZOOM_MARGIN_PX, 1.5)) {
    problems.push(`image not as large as the room in the margin: ${JSON.stringify(gaps)}`)
  }
  if (!near(size.width * natural.height, size.height * natural.width, Math.max(natural.width, natural.height))) {
    problems.push(`image ${size.width} x ${size.height} not at the aspect ratio of ${natural.width} x ${natural.height}`)
  }
  return problems
}

describe('image zoom', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let imageFile: string

  async function zoomPhase (): Promise<ZoomPhase> {
    return browser.execute(() => {
      const layer = document.querySelector('.dez-image-zoom')
      if (!layer) return 'none'
      if (layer.hasAttribute('data-closing')) return 'closing'
      const image = layer.querySelector<HTMLElement>('.dez-image-zoom__img')
      const shown = image !== null && image.style.visibility !== 'hidden' && layer.getAnimations({ subtree: true }).length === 0
      return shown ? 'open' : 'opening'
    })
  }

  async function zoomLayout (): Promise<ZoomLayout> {
    return browser.execute(() => {
      const layer = document.querySelector('.dez-image-zoom')
      const image = layer?.querySelector<HTMLImageElement>('.dez-image-zoom__img')
      const view = document.querySelector('.cm-scroller')?.getBoundingClientRect()
      if (!layer || !image || !view) throw new Error('zoomLayout: no zoom, or no conversation view')
      const box = layer.getBoundingClientRect()
      const shown = image.getBoundingClientRect()
      return {
        role: layer.getAttribute('role'),
        modal: layer.getAttribute('aria-modal'),
        label: layer.getAttribute('aria-label'),
        inEditorRoot: layer.parentElement?.classList.contains('cm-editor') === true,
        offView: { left: box.left - view.left, top: box.top - view.top, right: view.right - box.right, bottom: view.bottom - box.bottom },
        gaps: { left: shown.left - box.left, top: shown.top - box.top, right: box.right - shown.right, bottom: box.bottom - shown.bottom },
        size: { width: shown.width, height: shown.height },
        natural: { width: image.naturalWidth, height: image.naturalHeight },
      }
    })
  }

  // Where the keyboard is: the zoom's layer, its X, the editor, or the tag
  // name of another element.
  async function zoomFocus (): Promise<string> {
    return browser.execute(() => {
      const focused = document.activeElement
      if (!focused) return 'none'
      if (focused.classList.contains('dez-image-zoom')) return 'layer'
      if (focused.classList.contains('dez-image-zoom__close')) return 'close'
      if (focused.matches('.cm-content')) return 'editor'
      return focused.tagName.toLowerCase()
    })
  }

  // The images that the editor draws, and those of them that it hides
  // because the zoom shows them.
  async function drawnImages (): Promise<{ drawn: number, hidden: number }> {
    return browser.execute(() => ({
      drawn: document.querySelectorAll('.cm-content .dez-image__img').length,
      hidden: document.querySelectorAll('.cm-content .dez-image__img[data-zoomed]').length,
    }))
  }

  async function pageSize (): Promise<string> {
    return browser.execute(() => `${window.innerWidth}x${window.innerHeight}`)
  }

  // Opens the conversation `id` in a new tab: `LINES`, the references of
  // `ids` (each on its line, all of `imageFile`), and `LINES` again. Then
  // scrolls the first reference to the middle of the view, where the
  // editor draws the images, and waits until they are loaded.
  async function openImages (id: string, ids: readonly string[] = ['a']): Promise<void> {
    const text = `${LINES}\n${ids.map((imageId) => `![id=${imageId}](${imageFile})`).join('\n')}\n${LINES}`
    await openSeededConversation(browser, app.home, id, [{ role: 'user', text }])
    await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('openImages: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const line = view.lineBlockAt(view.state.doc.toString().indexOf('![id='))
      view.scrollDOM.scrollTop = line.top - view.scrollDOM.clientHeight / 2
    })
    await waitForValue(browser, 'the images', () => shownImages(browser), ids.map(() => ({ alt: 'zoom.png', width: 160, height: 90 })))
  }

  // Opens the zoom of the image at `index` (doc order) from its magnifier,
  // as a user does: the pointer goes to the image, its toolbar shows, and
  // a click on the magnifier. Waits until the zoom shows the image.
  async function openZoom (index = 0): Promise<void> {
    await movePointer(browser, await assetPartPoint(browser, '.dez-image', index, '.dez-image__img'))
    await waitForValue(browser, `the toolbar of image ${index}`, () => browser.execute((at: number) => {
      const toolbar = document.querySelectorAll('.cm-content .dez-image')[at]?.querySelector('.dez-image__overlay')
      return toolbar != null && getComputedStyle(toolbar).opacity === '1' && getComputedStyle(toolbar).transform === 'none'
    }, index), true)
    await pointerClickAt(browser, await assetPartPoint(browser, '.dez-image', index, '.dez-image__zoom'))
    await waitForValue(browser, `the zoom of image ${index}`, zoomPhase, 'open')
  }

  async function expectFitted (label: string): Promise<ZoomLayout> {
    const layout = await zoomLayout()
    expect(fitProblems(layout), label).toStrictEqual([])
    return layout
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      imageFile = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'zoom.png'), PNG)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    if (browser) await destroySession(browser)
    await app?.stop()
  })

  it('opens from the magnifier over the conversation view, with the image as large as it fits, and closes from its X with the editor as it was', async () => {
    await openImages('image-zoom-x')
    await focusEditor(browser)
    await setCaret(browser, 0)

    await openZoom()
    const layout = await expectFitted('the open zoom')
    expect(layout).toMatchObject({ role: 'dialog', modal: 'true', label: 'Zoom of image a', inEditorRoot: true, natural: { width: 160, height: 90 } })
    // The image grew: the room is far larger than the image.
    expect(layout.size.width).toBeGreaterThan(160)
    expect(await isOnTop(browser, ZOOM_IMAGE)).toBe(true)
    expect(await isOnTop(browser, ZOOM_CLOSE)).toBe(true)
    const [pixel] = await screenPixels(browser, [await elementCenter(browser, ZOOM_IMAGE)])
    expect(colorDistance(pixel, COLOR), `the middle of the zoomed image: ${JSON.stringify(pixel)}`).toBeLessThanOrEqual(3)
    // The image in the text keeps its room, empty, while the zoom shows it.
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 1 })
    expect(await zoomFocus()).toBe('layer')

    // A click on the image itself does not close the zoom.
    const scrollTop = await editorScrollTop(browser)
    await pointerClick(browser, ZOOM_IMAGE)
    // A wrong close would start in the next frames.
    await browser.pause(300)
    expect(await zoomPhase()).toBe('open')

    await pointerClick(browser, ZOOM_CLOSE)
    await waitForValue(browser, 'the zoom after a click on the X', zoomPhase, 'none')
    expect(await zoomFocus()).toBe('editor')
    expect(await editorCaret(browser)).toBe(0)
    expect(await editorScrollTop(browser)).toBe(scrollTop)
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 0 })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('keeps the keyboard in the zoom, closes Find, and closes on Escape and on a click on the backdrop', async () => {
    await openImages('image-zoom-keys')
    await focusEditor(browser)
    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)

    // Find has no text to show under the zoom.
    await openZoom()
    expect(await findDropdownOpen(browser)).toBe(false)
    expect(await zoomFocus()).toBe('layer')
    await browser.keys([Key.Control, 'f'])
    // A wrong Find would open in the next frames.
    await browser.pause(300)
    expect(await findDropdownOpen(browser)).toBe(false)

    // Tab puts the keyboard on the X, the only control, and keeps it there.
    await browser.keys(Key.Tab)
    expect(await zoomFocus()).toBe('close')
    await browser.keys(Key.Tab)
    expect(await zoomFocus()).toBe('close')
    await browser.keys([Key.Shift, Key.Tab])
    expect(await zoomFocus()).toBe('close')

    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the zoom after Escape', zoomPhase, 'none')
    expect(await zoomFocus()).toBe('editor')

    // A click on the backdrop, out in the margin of the image.
    await openZoom()
    const corner = await browser.execute((zoom: string) => {
      const box = document.querySelector(zoom)?.getBoundingClientRect()
      if (!box) throw new Error('no zoom layer')
      return { x: box.left + 20, y: box.top + 20 }
    }, ZOOM)
    await pointerClickAt(browser, corner)
    await waitForValue(browser, 'the zoom after a click on the backdrop', zoomPhase, 'none')
    expect(await zoomFocus()).toBe('editor')
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 0 })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows Settings, Help, and the model picker over the zoom, and Escape closes each of them before the zoom', async () => {
    await openImages('image-zoom-layers')
    await openZoom()

    await browser.keys([Key.Control, ','])
    await waitFor(browser, '.settings-overlay', 10_000)
    expect(await isOnTop(browser, '.settings-overlay')).toBe(true)
    await closeSettings(browser)
    expect(await zoomPhase()).toBe('open')

    await pointerClick(browser, '.help-button')
    await waitFor(browser, '.help-overlay', 10_000)
    expect(await isOnTop(browser, '.help-overlay')).toBe(true)
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'Help after Escape', () => browser.execute(() => document.querySelector('.help-overlay') !== null), false)
    expect(await zoomPhase()).toBe('open')

    // The picker opens upward from the bottom bar, over the conversation
    // view.
    await openPicker(browser)
    expect(await isOnTop(browser, '.model-dropdown')).toBe(true)
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the model picker after Escape', () => browser.execute(() => document.querySelector('.model-dropdown') !== null), false)
    expect(await zoomPhase()).toBe('open')

    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the zoom after the last Escape', zoomPhase, 'none')
    expect(await zoomFocus()).toBe('editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('fits the zoom to a new size of the window, and keeps it through a rebuild of the tab', async () => {
    await openImages('image-zoom-fit')
    await openZoom()
    const before = await expectFitted('the zoom before the resize')

    // WebDriver's window rect sets back the exact size that it read
    // (tables.e2e.ts tells why the window API does not).
    const page = await pageSize()
    const rect = await browser.getWindowRect()
    try {
      await browser.setWindowRect(null, null, rect.width - 240, rect.height - 120)
      await waitForValue(browser, 'a smaller page', async () => await pageSize() !== page, true)
      await waitForValue(browser, 'the zoom on the smaller view', async () => fitProblems(await zoomLayout()), [])
      const after = await zoomLayout()
      expect(after.size.width).toBeLessThan(before.size.width)
      expect(after.size.height).toBeLessThan(before.size.height)
    } finally {
      await browser.setWindowRect(null, null, rect.width, rect.height)
      await waitForValue(browser, 'page size after the window size is back', pageSize, page)
    }
    await waitForValue(browser, 'the zoom on the view as it was', async () => fitProblems(await zoomLayout()), [])
    expect((await zoomLayout()).size).toStrictEqual(before.size)

    // The end of a stream or a compaction gives the editor a new state of
    // the same tab, with the image still in it: the zoom stays, and the
    // image that the editor draws anew stays hidden.
    expect(await sbpCall(browser, 'dez.editor/rebuildIfVisible', await activeTabId(browser))).toBe(true)
    // A wrong close would start in the next frames.
    await browser.pause(300)
    expect(await zoomPhase()).toBe('open')
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 1 })

    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the zoom after Escape', zoomPhase, 'none')
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 0 })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('closes when another tab shows, and when its own reference goes, not that of another image of the same file', async () => {
    await openImages('image-zoom-follow', ['a', 'b'])
    const tabId = await activeTabId(browser)
    // Removes `text` from the doc with a change of code, as a stream or a
    // model write does: the keys of the user go to the zoom.
    const removeText = async (text: string): Promise<void> => {
      await browser.execute((removed: string) => {
        const content = document.querySelector('.cm-content')
        if (!content) throw new Error('removeText: .cm-content not found')
        const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
        const from = view.state.doc.toString().indexOf(removed)
        if (from < 0) throw new Error(`removeText: ${removed} is not in the doc`)
        view.dispatch({ changes: { from, to: from + removed.length } })
      }, text)
    }

    await openZoom(0)
    // Only the image of the zoom hides: the other one has another id.
    expect(await drawnImages()).toStrictEqual({ drawn: 2, hidden: 1 })
    expect((await zoomLayout()).label).toBe('Zoom of image a')

    await newTab(browser)
    await waitForValue(browser, 'the zoom in another tab', zoomPhase, 'none')
    await sbpCall(browser, 'dez.model/tabs/switch', tabId)
    await waitForValue(browser, 'the images back in their tab', drawnImages, { drawn: 2, hidden: 0 })
    expect(await zoomPhase()).toBe('none')

    await openZoom(0)
    await removeText(`\n![id=b](${imageFile})`)
    await waitForValue(browser, 'the images after the reference of b went', async () => (await drawnImages()).drawn, 1)
    expect(await zoomPhase()).toBe('open')
    expect(await drawnImages()).toStrictEqual({ drawn: 1, hidden: 1 })

    await removeText(`\n![id=a](${imageFile})`)
    await waitForValue(browser, 'the zoom after its reference went', zoomPhase, 'none')
    expect(await zoomFocus()).toBe('editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
