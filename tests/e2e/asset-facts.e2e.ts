import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, elementCenter, movePointer, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, mediaTempDir, seedAppState, writeTestFile } from './harness/fixtures'
import { shownImages, solidPng } from './harness/images'
import { NOT_A_CLIP, WEBM_VIDEO, clipTag, problemCards, shownPlayers, silentWav, startClipServer, type ClipServer } from './harness/media'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { assetPartPoint, openSeededConversation } from './harness/thread'

// The facts of an asset in its hover toolbar, driven through the real app:
// next to the id badge, an image shows its pixels, its format, and the size
// of its file; a clip shows its length, its format, and the size of its
// file. A fact that Dez does not know is left out: a clip that plays from
// its URL has no file size here, and a clip that this computer cannot play
// has no length. A missing image and a clip whose file is gone show no
// facts.
//
// One app session serves the whole file.

const HOUR_MS = 60 * 60 * 1000
// 16044 bytes: 2 s at 8000 one-byte samples a second, and the header.
const TONE = silentWav(2)
const PNG = solidPng(40, 24, [40, 120, 220])

describe('asset facts', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let clips: ClipServer

  // The items of the toolbar of each asset (`.dez-image` or
  // `.media-player`), in doc order, as `<class>` or `<class>: <text>` for
  // the facts. The tooltip of a player's badge is no item: it takes no room.
  async function toolbars (asset: string): Promise<string[][]> {
    return browser.execute((selector: string) => Array.from(
      document.querySelectorAll(`.cm-content ${selector}`),
      (element) => Array.from(
        element.querySelector('.dez-image__overlay, .media-player__overlay')?.children ?? [],
        (item) => {
          const name = item.classList[0] ?? item.localName
          return name.endsWith('__facts') ? `${name}: ${item.textContent ?? ''}` : name
        },
      ).filter((item) => !item.startsWith('media-player__tooltip')),
    ), asset)
  }

  // Whether the facts of the asset at `index` show in its toolbar while the
  // pointer is on the asset: the toolbar is fully opaque, and the facts are
  // inside it and in the asset's box.
  async function factsShown (asset: string, index: number): Promise<boolean> {
    return browser.execute((selector: string, at: number) => {
      const element = document.querySelectorAll(`.cm-content ${selector}`)[at]
      const toolbar = element?.querySelector('.dez-image__overlay, .media-player__overlay')
      const facts = toolbar?.querySelector('.dez-image__facts, .media-player__facts')?.getBoundingClientRect()
      const box = element?.getBoundingClientRect()
      if (!toolbar || !facts || !box) return false
      const bar = toolbar.getBoundingClientRect()
      const inside = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left && inner.right <= outer.right
        && inner.top >= outer.top && inner.bottom <= outer.bottom
      return getComputedStyle(toolbar).opacity === '1' && facts.width > 0 && inside(facts, bar) && inside(bar, box)
    }, asset, index)
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
    await clips?.stop()
  })

  it('shows the pixels, the format, and the file size of an image between its id and its trash, and no facts for a missing image', async () => {
    const stored = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'facts.png'), PNG)
    const missing = appFilePath(app.home, 'assets', 'images', 'facts-missing.png')
    await openSeededConversation(browser, app.home, 'asset-facts-images', [{ role: 'user', text: `Images:\n![${stored}](id=a)\n![${missing}](id=b)\nEnd.` }])
    await waitForValue(browser, 'shown images', () => shownImages(browser), [{ alt: 'facts.png', width: 40, height: 24 }])
    await waitFor(browser, '.cm-content .dez-image-missing')

    // The file size comes in after the image loaded.
    expect(PNG.length).toBeLessThan(1024)
    await waitForValue(browser, 'image toolbars', () => toolbars('.dez-image'), [
      ['dez-image__id', `dez-image__facts: 40 × 24 · PNG · ${PNG.length} B`, 'dez-image__trash'],
      ['dez-image__id', 'dez-image__trash'],
    ])

    // The image is narrower than its toolbar, which hangs out on the right;
    // the facts are still in the toolbar.
    await movePointer(browser, await elementCenter(browser, '.cm-content .dez-image__img'))
    await waitForValue(browser, 'toolbar of the image in place', () => browser.execute(() => {
      const toolbar = document.querySelector('.cm-content .dez-image__overlay')
      return toolbar !== null && getComputedStyle(toolbar).opacity === '1' && getComputedStyle(toolbar).transform === 'none'
    }), true)
    expect(await browser.execute(() => {
      const facts = document.querySelector('.cm-content .dez-image__facts')?.getBoundingClientRect()
      const toolbar = document.querySelector('.cm-content .dez-image__overlay')?.getBoundingClientRect()
      return facts !== undefined && toolbar !== undefined && facts.width > 0
        && facts.left >= toolbar.left && facts.right <= toolbar.right
    })).toBe(true)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows the length, the format, and the file size of a clip after its id, each when known, and no facts for a clip that is gone', async () => {
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const url = clips.clipUrl('tone.wav')
    // The temp copies are new files, so the cleanup of old ones leaves them.
    const temp = await writeTestFile(path.join(mediaTempDir(app.home), 'facts-copy.wav'), TONE)
    const saved = await writeTestFile(appFilePath(app.home, 'assets', 'generated', 'video', 'facts-saved.webm'), WEBM_VIDEO)
    const unplayable = await writeTestFile(path.join(mediaTempDir(app.home), 'facts-text.webm'), NOT_A_CLIP)
    const gone = path.join(mediaTempDir(app.home), 'facts-gone.wav')
    const reply = [
      clipTag('audio', { id: 'a', type: 'audio/wav', src: url, url, expires }),
      clipTag('audio', { id: 'b', type: 'audio/wav', src: temp, expires }),
      clipTag('video', { id: 'c', type: 'video/webm', src: saved }),
      clipTag('video', { id: 'd', type: 'video/webm', src: unplayable, expires }),
      clipTag('audio', { id: 'e', type: 'audio/wav', src: gone, expires }),
    ].join('\n\n')
    await openSeededConversation(browser, app.home, 'asset-facts-clips', [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: reply },
      { role: 'user', text: 'Thanks' },
    ])
    const playing = { available: true, seconds: 2 }
    const notPlaying = { available: false, seconds: null }
    await waitForValue(browser, 'players', async () => (await shownPlayers(browser)).map(({ available, seconds }) => ({ available, seconds })), [
      playing, playing, playing, notPlaying, notPlaying,
    ])
    expect((await problemCards(browser)).map((card) => card.cause)).toStrictEqual(['cannot-play', 'gone'])

    expect(WEBM_VIDEO.length).toBeLessThan(1024)
    await waitForValue(browser, 'player toolbars', () => toolbars('.media-player'), [
      // From its URL: no file here, so no file size.
      ['media-player__id', 'media-player__facts: 0:02 · WAV'],
      ['media-player__id', 'media-player__facts: 0:02 · WAV · 16 KB'],
      ['media-player__id', `media-player__facts: 0:02 · WebM · ${WEBM_VIDEO.length} B`],
      // The computer cannot play it, so it has no length.
      ['media-player__id', `media-player__facts: WebM · ${NOT_A_CLIP.length} B`],
      ['media-player__id'],
    ])

    // Over the picture of a video and beside an audio card, the facts show
    // in the toolbar while the pointer is on the player.
    for (const [index, part] of [[2, '.media-player__video'], [1, '.media-player__time']] as const) {
      await movePointer(browser, await assetPartPoint(browser, '.media-player', index, part))
      await waitForValue(browser, `facts of player ${index} shown`, () => factsShown('.media-player', index), true)
    }

    // Only the two clips that do not play gave errors.
    const errors = await consoleErrors(browser)
    expect(errors.filter((error) => !error.startsWith('[MediaPlayer] The '))).toStrictEqual([])
  })
})
