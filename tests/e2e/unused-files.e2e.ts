import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, promptMessage, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, conversationFilePath, makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { solidPng } from './harness/images'
import { silentWav } from './harness/media'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeTabId, newTab, openToasts, sbpCall } from './harness/thread'

// Settings › General › Unused files, driven through the real app: the
// button scans the stored files (pasted, dropped, and generated images and
// clips) and shows a progress bar, a prompt states the count and the size
// of the files that nothing uses, and a "Yes" deletes them.
//
// The seeded stored files, with what must happen to each one:
// - an image that a saved conversation refers to: stays;
// - a clip that a saved conversation's media tag names: stays;
// - an image that only an open tab names, in text that is not on disk:
//   stays;
// - an image and a video that no text names: deleted;
// - an image that no text names, with a new file time: stays (a paste
//   writes its file before its text);
// - a file in an image folder that is not an image: stays.
//
// One app session serves the whole file, and the tests run in order.

const HOUR_MS = 60 * 60 * 1000
const UNUSED_IMAGE_BYTES = 300_000
const UNUSED_VIDEO_BYTES = 1_800_000
const DELETE_PROMPT = 'Are you sure you want to delete 2 unused files? This frees 2.0 MB, and it cannot be undone.'

const KEPT_FILES = [
  'assets/generated/audio/clip-saved.wav',
  'assets/generated/images/image-tab.png',
  'assets/images/image-saved.png',
  'assets/images/image-young.png',
  'assets/images/notes.txt',
]
const UNUSED_FILES = ['assets/generated/video/video-unused.webm', 'assets/images/image-unused.png']

/** One state of the row while a cleanup runs. */
interface RunStep {
  /** The `aria-valuenow` of the progress bar. */
  percent: string | null
  buttonOff: boolean
}

describe('Settings: delete unused files', () => {
  let app: RunningApp
  let browser: E2EBrowser
  // The conversation of the tab whose text is only in memory.
  let unsavedConversationId: string

  // Writes the stored file `relative` with a file time of one hour ago.
  function seedStoredFile (relative: string, bytes: Buffer): void {
    const file = appFilePath(app.home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    const old = new Date(Date.now() - HOUR_MS)
    fs.utimesSync(file, old, old)
  }

  // The files of the four stored-file folders that this spec seeds,
  // relative to the app folder.
  function storedFiles (): string[] {
    return ['assets/images', 'assets/generated/images', 'assets/generated/audio', 'assets/generated/video']
      .flatMap((folder) => fs.readdirSync(appFilePath(app.home, folder)).map((name) => `${folder}/${name}`))
      .sort()
  }

  // The bar's percent (null with no bar) and whether the button is off.
  async function rowState (): Promise<RunStep> {
    return browser.execute(() => ({
      percent: document.querySelector('.settings-progress')?.getAttribute('aria-valuenow') ?? null,
      buttonOff: document.querySelector<HTMLButtonElement>('.unused-files-btn')?.disabled ?? false,
    }))
  }

  // Records each state of the row in which the bar shows a new percent.
  // The scan of this spec's few files ends between two WebDriver commands,
  // so the page records the steps itself.
  async function recordRunSteps (): Promise<void> {
    await browser.execute(() => {
      const section = document.querySelector('.settings-section')
      if (!section) throw new Error('recordRunSteps: no Settings section')
      const steps: RunStep[] = []
      Reflect.set(window, '__e2eRunSteps', steps)
      new MutationObserver(() => {
        const bar = section.querySelector('.settings-progress')
        const percent = bar?.getAttribute('aria-valuenow') ?? null
        if (!bar || steps.at(-1)?.percent === percent) return
        steps.push({ percent, buttonOff: section.querySelector<HTMLButtonElement>('.unused-files-btn')?.disabled ?? false })
      }).observe(section, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuenow'] })
    })
  }

  async function runSteps (): Promise<RunStep[]> {
    return browser.execute(() => Reflect.get(window, '__e2eRunSteps') as RunStep[])
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      seedStoredFile('assets/images/image-saved.png', solidPng(4, 4, [200, 0, 0]))
      seedStoredFile('assets/generated/audio/clip-saved.wav', silentWav(1))
      seedStoredFile('assets/generated/images/image-tab.png', solidPng(4, 4, [0, 200, 0]))
      seedStoredFile('assets/images/image-unused.png', Buffer.alloc(UNUSED_IMAGE_BYTES))
      seedStoredFile('assets/generated/video/video-unused.webm', Buffer.alloc(UNUSED_VIDEO_BYTES))
      seedStoredFile('assets/images/image-young.png', solidPng(4, 4, [0, 0, 200]))
      seedStoredFile('assets/images/notes.txt', Buffer.from('notes'))
      await seedConversation(app.home, makeConversation({
        id: 'with-image',
        title: 'With image',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: `Look at ![${appFilePath(app.home, 'assets/images/image-saved.png')}](id=a)` }] }],
      }))
      await seedConversation(app.home, makeConversation({
        id: 'with-clip',
        title: 'With clip',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: 'Say hello' }] },
          { role: 'agent', nodes: [{ kind: 'text', text: `<dez:audio id="a" type="audio/wav" src="${appFilePath(app.home, 'assets/generated/audio/clip-saved.wav')}"/>` }] },
          { role: 'user', nodes: [{ kind: 'text', text: '' }] },
        ],
      }))
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await resetConsoleErrors(browser)

    // Text that is only in memory: the store of a tab that is not in view
    // changes, and only the editor of the tab in view saves a conversation.
    const firstTab = await activeTabId(browser)
    unsavedConversationId = (await sbpCall(browser, 'dez.model/tab', firstTab) as { conversationId: string }).conversationId
    await newTab(browser)
    await sbpCall(browser, 'dez.model/tabs/replaceSections', firstTab, [{
      id: 'u1',
      role: 'user',
      content: [{ kind: 'text', text: `Draft with ![${appFilePath(app.home, 'assets/generated/images/image-tab.png')}](id=a)` }],
    }])

    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.unused-files-btn', 10_000)
    await recordRunSteps()
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('shows the progress of the scan, then asks with the count and the size, and deletes nothing on a No', async () => {
    // A file time of now, as a paste that just stored its file gives.
    const now = new Date()
    fs.utimesSync(appFilePath(app.home, 'assets/images/image-young.png'), now, now)
    expect(await rowState()).toStrictEqual({ percent: null, buttonOff: false })

    await pointerClick(browser, '.unused-files-btn')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), DELETE_PROMPT)

    // One step for the start, and one for each of the two conversation
    // files.
    expect(await runSteps()).toStrictEqual([
      { percent: '0', buttonOff: true },
      { percent: '50', buttonOff: true },
      { percent: '100', buttonOff: true },
    ])
    expect(await rowState()).toStrictEqual({ percent: '100', buttonOff: true })

    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'row after No', rowState, { percent: null, buttonOff: false })
    expect(await promptMessage(browser)).toBeNull()
    expect(storedFiles()).toStrictEqual([...KEPT_FILES, ...UNUSED_FILES].sort())
    expect(await openToasts(browser)).toEqual([])
  })

  it('deletes on a Yes only the old files that no conversation and no open tab names', async () => {
    await pointerClick(browser, '.unused-files-btn')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), DELETE_PROMPT)
    await pointerClick(browser, '.confirm-btn--confirm')

    await waitForValue(browser, 'result toast', () => openToasts(browser), [{ title: '', message: 'Deleted 2 unused files (2.0 MB).' }])
    await waitForValue(browser, 'row after the delete', rowState, { percent: null, buttonOff: false })
    expect(storedFiles()).toStrictEqual(KEPT_FILES)
    // The tab's text was never on disk, so only the texts in memory kept
    // its image.
    expect(fs.existsSync(conversationFilePath(app.home, unsavedConversationId))).toBe(false)
  })

  it('tells that there are no unused files, with no prompt', async () => {
    await pointerClick(browser, '.unused-files-btn')

    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === 'No unused files found'), true)
    await waitForValue(browser, 'row after the scan', rowState, { percent: null, buttonOff: false })
    expect(await promptMessage(browser)).toBeNull()
    expect(storedFiles()).toStrictEqual(KEPT_FILES)
    expect(await consoleErrors(browser)).toEqual([])
  })
})
