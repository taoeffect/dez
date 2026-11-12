import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClickAt, pointerDrag, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, mediaTempDir, seedAppState, writeTestFile } from './harness/fixtures'
import { shownImages, solidPng } from './harness/images'
import { WEBM_VIDEO, clipTag, shownPlayers, silentWav } from './harness/media'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, docPosPoint, editorDoc, editorSelection, focusEditor, openSeededConversation, setCaret } from './harness/thread'

// Images and players inside a text selection, driven through the real app:
// an asset looks selected (a tint of the selection color over it) only
// while a selection range holds all of it, with the focused or the
// not-focused selection color, and a selection change never draws the
// asset again (the same image and player elements stay). The "Image not
// found" box gets no tint: the selection shows through it.
//
// One app session serves the whole file.

const HOUR_MS = 60 * 60 * 1000
const PNG = solidPng(120, 60, [40, 120, 220])

/** How the editor shows one asset: whether it is marked as selected, and
 *  the color of the tint over it (null when it has none). */
interface AssetLook {
  selected: boolean
  tint: string | null
}

describe('assets in a selection', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // The look of each drawn image or player, in doc order. The tint of an
  // image is its own `::after`; the tint of a player is its card's.
  async function assetLooks (): Promise<AssetLook[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .dez-image, .cm-content .dez-media'),
      (root) => {
        const tinted = root.classList.contains('dez-media') ? root.querySelector('.media-player__card') : root
        const after = tinted ? getComputedStyle(tinted, '::after') : null
        const hasTint = after !== null && after.content !== 'none' && after.content !== 'normal'
        return { selected: root.hasAttribute('data-selected'), tint: hasTint ? after.backgroundColor : null }
      },
    ))
  }

  // The color of a CSS variable of the page, as a computed background.
  async function themeColor (name: string): Promise<string> {
    return browser.execute((variable: string) => {
      const probe = document.createElement('div')
      probe.style.background = `var(${variable})`
      document.body.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }, name)
  }

  // Marks the image and player elements that are in the page now, so that
  // `stillMarked` can tell whether the editor drew an asset again.
  async function markAssetElements (): Promise<void> {
    await browser.execute(() => {
      for (const element of document.querySelectorAll('.cm-content .dez-image__img, .cm-content .media-player__card, .cm-content audio, .cm-content video')) {
        Reflect.set(element, 'e2eMark', true)
      }
    })
  }

  // For each image and player element in the page, whether it is one that
  // `markAssetElements` marked.
  async function stillMarked (): Promise<boolean[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .dez-image__img, .cm-content .media-player__card, .cm-content audio, .cm-content video'),
      (element) => Reflect.get(element, 'e2eMark') === true,
    ))
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
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

  it('tints an image only while a selection holds all of it, in the focused or the not-focused color, and keeps its element', async () => {
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'selection.png'), PNG)
    const missing = appFilePath(app.home, 'assets', 'images', 'selection-missing.png')
    const reference = `![${stored}](id=a)`
    await openSeededConversation(browser, app.home, 'asset-selection-image', [{
      role: 'user',
      text: `Before the image.\n${reference}\nAfter the image.\n![${missing}](id=b)\nEnd.`,
    }])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [{ alt: 'selection.png', width: 120, height: 60 }])
    await waitFor(browser, '.cm-content .dez-image-missing')
    await markAssetElements()
    const focused = await themeColor('--color-selection-tint')
    const notFocused = await themeColor('--color-selection-tint-inactive')
    expect(focused).not.toBe(notFocused)
    const unselected = [{ selected: false, tint: null }, { selected: false, tint: null }]
    const firstSelected = [{ selected: true, tint: focused }, { selected: false, tint: null }]
    expect(await assetLooks()).toStrictEqual(unselected)

    const before = await docPos(browser, 'Before the image.')
    const imageFrom = await docPos(browser, reference)
    const imageTo = imageFrom + reference.length
    const afterEnd = await docPos(browser, 'After the image.', 'After the image.'.length)

    // A mouse drag from the line above to the end of the line below.
    await focusEditor(browser)
    const start = await docPosPoint(browser, before, 1)
    const end = await docPosPoint(browser, afterEnd, -1)
    await pointerDrag(browser, start, end.x, { toY: end.y })
    await waitForValue(browser, 'dragged selection', () => editorSelection(browser), { anchor: before, head: afterEnd })
    await waitForValue(browser, 'image in a drag', assetLooks, firstSelected)

    // A selection that ends where the image starts does not hold it.
    await setCaret(browser, before, imageFrom)
    await waitForValue(browser, 'selection up to the image', assetLooks, unselected)

    // Shift+Right from the image's start selects exactly the image.
    await setCaret(browser, imageFrom)
    await browser.keys([Key.Shift, Key.ArrowRight])
    await waitForValue(browser, 'image selected by Shift+Right', () => editorSelection(browser), { anchor: imageFrom, head: imageTo })
    await waitForValue(browser, 'image in its own selection', assetLooks, firstSelected)

    // A selection that starts where the image ends does not hold it.
    await setCaret(browser, imageTo, afterEnd)
    await waitForValue(browser, 'selection after the image', assetLooks, unselected)

    // A selection that ends where the image ends holds it; without the
    // focus, the tint is the not-focused color.
    await setCaret(browser, before, imageTo)
    await waitForValue(browser, 'selection to the image end', assetLooks, firstSelected)
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
    await waitForValue(browser, 'image without the focus', assetLooks, [{ selected: true, tint: notFocused }, { selected: false, tint: null }])
    await focusEditor(browser)
    await waitForValue(browser, 'image with the focus again', assetLooks, firstSelected)

    // A selection that holds only a part of the image's source does not.
    await setCaret(browser, imageFrom + 1, afterEnd)
    await waitForValue(browser, 'selection of a part of the image', assetLooks, unselected)

    // Select All (Alt+A on Linux): the missing image is selected too, with
    // no tint.
    await browser.keys([Key.Alt, 'a'])
    await waitForValue(browser, 'images in Select All', assetLooks, [{ selected: true, tint: focused }, { selected: true, tint: null }])

    expect(await stillMarked()).toStrictEqual([true])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tints the cards of players inside a selection and keeps their elements', async () => {
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    // A temp copy is a new file, so the cleanup of old ones leaves it.
    const tone = await writeTestFile(path.join(mediaTempDir(app.home), 'selection-tone.wav'), silentWav(2))
    const video = await writeTestFile(appFilePath(app.home, 'assets', 'generated', 'video', 'selection-video.webm'), WEBM_VIDEO)
    const reply = [
      clipTag('audio', { id: 'a', type: 'audio/wav', src: tone, expires }),
      clipTag('video', { id: 'b', type: 'video/webm', src: video }),
    ].join('\n\n')
    await openSeededConversation(browser, app.home, 'asset-selection-clips', [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: reply },
      { role: 'user', text: 'Thanks' },
    ])
    await waitForValue(browser, 'players', async () => (await shownPlayers(browser)).map(({ available, seconds }) => ({ available, seconds })), [
      { available: true, seconds: 2 },
      { available: true, seconds: 2 },
    ])
    await markAssetElements()
    const marks = await stillMarked()
    expect(marks.length).toBeGreaterThanOrEqual(4)
    const focused = await themeColor('--color-selection-tint')

    await focusEditor(browser)
    await browser.keys([Key.Alt, 'a'])
    await waitForValue(browser, 'players in Select All', assetLooks, [
      { selected: true, tint: focused },
      { selected: true, tint: focused },
    ])

    // A click in the text below (scrolled into view: the video is tall)
    // leaves a caret, which holds nothing.
    await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
    const thanks = await docPos(browser, 'Thanks', 3)
    await pointerClickAt(browser, await docPosPoint(browser, thanks, 1))
    await waitForValue(browser, 'players after a click', assetLooks, [
      { selected: false, tint: null },
      { selected: false, tint: null },
    ])

    expect(await stillMarked()).toStrictEqual(marks)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('marks an image that the editor draws after a scroll into a selection', async () => {
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'selection-far.png'), PNG)
    const lines = Array.from({ length: 200 }, (_, index) => `Line ${index + 1}`)
    await openSeededConversation(browser, app.home, 'asset-selection-far', [{ role: 'user', text: `${lines.join('\n')}\n![${stored}](id=a)\nEnd.` }])
    await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller')
      if (scroller) scroller.scrollTop = 0
    })
    // The image is far below the view, so the editor has not drawn it.
    await waitForValue(browser, 'images drawn at the top', assetLooks, [])

    await focusEditor(browser)
    await browser.keys([Key.Alt, 'a'])
    await waitForValue(browser, 'select all', () => editorSelection(browser), { anchor: 0, head: (await editorDoc(browser)).length })
    await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
    await waitForValue(browser, 'image drawn in the selection', assetLooks, [{ selected: true, tint: await themeColor('--color-selection-tint') }])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
