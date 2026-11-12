import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, elementCenter, movePointer, pointerRightClickAt, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, mediaTempDir, seedAppState, writeTestFile } from './harness/fixtures'
import { shownImages, solidPng } from './harness/images'
import { NOT_A_CLIP, WEBM_VIDEO, clipTag, problemCards, shownPlayers, silentWav, startClipServer, type ClipServer } from './harness/media'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { assetPartPoint, editorDoc, editorSelection, focusEditor, focusedArea, openSeededConversation, setCaret } from './harness/thread'

// The asset menu, driven through the real app: a right-click on an image
// (or on its "Image not found" box) or on a player asks
// `dez.controller/menu/popupAsset` for the native menu with "Reveal in File
// Manager", with the asset's file: the stored image, the saved clip, or the
// clip's temp copy, also when this computer cannot play it. A missing
// image, a clip that plays from its URL only, and a clip whose file is gone
// give no file (the item is disabled). The click cancels the webview's own
// menu, and it leaves the editor's selection, focus, and doc alone. Text,
// and the text of a clock's tooltip, keep the webview's own menu.
//
// WebDriver cannot drive a native menu, so an SBP filter stops each
// `popupAsset` call and records its file (`src/controller/menu.test.ts`
// covers the menu that the selector builds). A real right-click is sent
// only where the page cancels the menu: elsewhere the webview opens its
// own menu, which WebDriver cannot close, so the spec sends a `contextmenu`
// event there.
//
// One app session serves the whole file.

const HOUR_MS = 60 * 60 * 1000
const TONE = silentWav(2)
const PNG = solidPng(40, 24, [40, 120, 220])

/** The editor's main selection, and where the focus is. */
interface EditorState {
  anchor: number
  head: number
  focus: string
  doc: string
}

describe('asset menu', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let clips: ClipServer

  async function editorState (): Promise<EditorState> {
    return { ...await editorSelection(browser), focus: await focusedArea(browser), doc: await editorDoc(browser) }
  }

  // The files of the `popupAsset` calls, and whether each `contextmenu`
  // event was canceled after every listener of the page ran, since the
  // last reset.
  async function menuRecord (): Promise<{ files: Array<string | null>, canceled: boolean[] }> {
    return browser.execute(() => ({
      files: [...Reflect.get(window, '__e2eAssetMenus') as Array<string | null>],
      canceled: [...Reflect.get(window, '__e2eContextMenus') as boolean[]],
    }))
  }

  async function resetMenuRecord (): Promise<void> {
    await browser.execute(() => {
      (Reflect.get(window, '__e2eAssetMenus') as unknown[]).length = 0;
      (Reflect.get(window, '__e2eContextMenus') as unknown[]).length = 0
    })
  }

  // Right-clicks the element `part` of each asset of `asset`, in doc order,
  // and checks that each click asked for the menu with the file of
  // `files[index]`, canceled the webview's menu, and left the editor as
  // `before` had it. The pointer comes from off the assets: the toolbar of
  // a small image hangs over the line below while it shows, and then it
  // takes the clicks there.
  async function expectMenus (asset: string, part: (index: number) => string, files: Array<string | null>, before: EditorState): Promise<void> {
    for (const [index, file] of files.entries()) {
      await resetMenuRecord()
      await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
      await pointerRightClickAt(browser, await assetPartPoint(browser, asset, index, part(index)))
      await waitForValue(browser, `menu of ${asset} ${index}`, menuRecord, { files: [file], canceled: [true] })
      expect(await editorState(), `editor after a right-click on ${asset} ${index}`).toStrictEqual(before)
    }
  }

  beforeAll(async () => {
    clips = await startClipServer({ 'tone.wav': { type: 'audio/wav', bytes: TONE } })
    app = await startApp()
    try {
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    // A filter that returns false stops the selector call, so no native
    // menu opens. The window listener runs after every listener of the
    // page, so it sees whether one of them canceled the webview's menu.
    await browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      const files: Array<string | null> = []
      const canceled: boolean[] = []
      Reflect.set(window, '__e2eAssetMenus', files)
      Reflect.set(window, '__e2eContextMenus', canceled)
      sbp('sbp/filters/selector/add', 'dez.controller/menu/popupAsset', (_domain: string, _selector: string, data: unknown[]) => {
        files.push(data[0] as string | null)
        return false
      })
      window.addEventListener('contextmenu', (event) => canceled.push(event.defaultPrevented))
    })
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await resetMenuRecord()
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    if (browser) await destroySession(browser)
    await app?.stop()
    await clips?.stop()
  })

  it('pops up the menu with the file of a stored image, and with no file for a missing image', async () => {
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'stored.png'), PNG)
    const missing = appFilePath(app.home, 'assets', 'images', 'missing.png')
    const text = `Images:\n![${stored}](id=a)\n![${missing}](id=b)\nEnd of the images.`
    await openSeededConversation(browser, app.home, 'asset-menu-images', [{ role: 'user', text }])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [{ alt: 'stored.png', width: 40, height: 24 }])
    await waitFor(browser, '.cm-content .dez-image-missing')

    // A selection in the text: a right-click that moved the caret would end
    // it.
    await focusEditor(browser)
    await setCaret(browser, 0, 'Images'.length)
    const before = await editorState()
    expect(before).toMatchObject({ anchor: 0, head: 6, focus: 'editor' })

    await expectMenus('.dez-image', () => ':scope > *', [stored, null], before)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('pops up the menu with the file of a saved clip or a temp copy, and with no file for a clip that has none here', async () => {
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const url = clips.clipUrl('tone.wav')
    // The temp copies are new files, so the cleanup of old ones leaves them.
    const temp = await writeTestFile(path.join(mediaTempDir(app.home), 'menu-copy.wav'), TONE)
    const saved = await writeTestFile(appFilePath(app.home, 'assets', 'generated', 'video', 'menu-saved.webm'), WEBM_VIDEO)
    const unplayable = await writeTestFile(path.join(mediaTempDir(app.home), 'menu-text.webm'), NOT_A_CLIP)
    const gone = path.join(mediaTempDir(app.home), 'menu-gone.wav')
    const reply = [
      clipTag('audio', { id: 'a', type: 'audio/wav', src: url, url, expires }),
      clipTag('audio', { id: 'b', type: 'audio/wav', src: temp, expires }),
      clipTag('video', { id: 'c', type: 'video/webm', src: saved }),
      clipTag('video', { id: 'd', type: 'video/webm', src: unplayable, expires }),
      clipTag('audio', { id: 'e', type: 'audio/wav', src: gone, expires }),
    ].join('\n\n')
    await openSeededConversation(browser, app.home, 'asset-menu-clips', [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: reply },
      { role: 'user', text: 'Thanks' },
    ])
    // The menu of a clip whose file is gone is known only after the read of
    // the file failed, and that of a file that cannot play is known after
    // its media error.
    const playing = { available: true, seconds: 2 }
    const notPlaying = { available: false, seconds: null }
    await waitForValue(browser, 'players', async () => (await shownPlayers(browser)).map(({ available, seconds }) => ({ available, seconds })), [
      playing, playing, playing, notPlaying, notPlaying,
    ])
    expect((await problemCards(browser)).map((card) => card.cause)).toStrictEqual(['cannot-play', 'gone'])

    await focusEditor(browser)
    const doc = await editorDoc(browser)
    await setCaret(browser, doc.length - 'Thanks'.length, doc.length)
    const before = await editorState()
    expect(before.focus).toBe('editor')

    // The time of an audio clip, the picture of a video, and the card of a
    // clip that does not play.
    const parts = ['.media-player__time', '.media-player__time', '.media-player__video', '.media-player__unavailable', '.media-player__unavailable']
    await expectMenus('.media-player', (index) => parts[index], [null, temp, saved, unplayable, null], before)

    // Only the two clips that do not play gave errors.
    const errors = await consoleErrors(browser)
    expect(errors.filter((error) => !error.startsWith('[MediaPlayer] The '))).toStrictEqual([])
  })

  it('leaves the webview\'s menu on text and on the text of a clock\'s tooltip', async () => {
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const temp = await writeTestFile(path.join(mediaTempDir(app.home), 'menu-tooltip.wav'), TONE)
    await openSeededConversation(browser, app.home, 'asset-menu-text', [
      { role: 'user', text: 'Plain words' },
      { role: 'agent', text: clipTag('audio', { id: 'a', type: 'audio/wav', src: temp, expires }) },
      { role: 'user', text: '' },
    ])
    await waitFor(browser, '.cm-content .media-player .media-player__tooltip--selectable .media-player__tooltip-text')

    // Whether a `contextmenu` event on each place was not canceled, so that
    // the webview's own menu would open. The tooltip is in the DOM also
    // while it is closed.
    const notCanceled = await browser.execute(() => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line')).find((el) => el.textContent === 'Plain words')
      const tooltipText = document.querySelector('.cm-content .media-player__tooltip--selectable .media-player__tooltip-text')
      return [line, tooltipText].map((target) => {
        if (!target) throw new Error('no line or no tooltip text')
        return target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      })
    })
    expect(notCanceled).toStrictEqual([true, true])
    expect(await menuRecord()).toStrictEqual({ files: [], canceled: [false, false] })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // macOS selects the word next to the pointer at a context click, before
  // its `contextmenu` event; that selection starts with `selectstart`.
  // Linux makes no such selection, so the spec sends the event.
  it('cancels the selection that a context click starts on an image or a player, but not in a clock\'s tooltip', async () => {
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'select.png'), PNG)
    const temp = await writeTestFile(path.join(mediaTempDir(app.home), 'menu-select.wav'), TONE)
    await openSeededConversation(browser, app.home, 'asset-menu-select', [
      { role: 'user', text: `See ![${stored}](id=a)` },
      { role: 'agent', text: clipTag('audio', { id: 'b', type: 'audio/wav', src: temp, expires }) },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [{ alt: 'select.png', width: 40, height: 24 }])
    await waitFor(browser, '.cm-content .media-player .media-player__tooltip--selectable .media-player__tooltip-text')

    // The targets: the image, the player's time, and the text of the
    // clock's tooltip, which can be selected. A `selectstart` event on text
    // targets the text node.
    const notCanceled = await browser.execute(() => {
      const image = document.querySelector('.cm-content .dez-image__img')
      const time = document.querySelector('.cm-content .media-player__time')
      const tooltipText = document.querySelector('.cm-content .media-player__tooltip--selectable .media-player__tooltip-text')?.firstChild
      return [image, time, tooltipText].map((target) => {
        if (!target) throw new Error('no image, no time, or no tooltip text')
        return target.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))
      })
    })
    expect(notCanceled).toStrictEqual([false, false, true])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
