import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { ageApp, seedApp } from './harness/apps'
import { consoleErrors, pointerClick, promptMessage, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, conversationFilePath, makeConversation, mediaTempDir, seedAppState, seedConversation, workDir } from './harness/fixtures'
import { solidPng } from './harness/images'
import { silentWav } from './harness/media'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeTabId, newTab, openToasts, sbpCall } from './harness/thread'

// Settings › General › Unreferenced files and Unreferenced apps, driven
// through the real app. Each button scans and shows a progress bar, a
// prompt states the count and the size of what nothing uses (and names
// each app), and a "Yes" deletes them. Delete Unreferenced Files scans the
// stored files (pasted, dropped, and generated images and clips) and the
// cache folder, and never deletes an app. Delete Unreferenced Apps scans
// only the apps.
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
// The seeded entries of the cache folder:
// - a temp copy of a clip that a saved conversation's media tag names:
//   stays;
// - a temp copy that no text names, the part file of a download that did
//   not end, and a work folder with its files: deleted;
// - a work folder with a new file time: stays (a run can be in it).
// The seeded apps (folders of `apps/` in the app folder):
// - an app that a saved conversation shows with its tag: stays;
// - an app that no text names: deleted, with all its files, by Delete
//   Unreferenced Apps only;
// - an app that no text names, with one file that has a new file time:
//   stays (`apps init` writes the files of an app before the block of its
//   call names it).
//
// One app session serves the whole file, and the tests run in order.

const HOUR_MS = 60 * 60 * 1000
const UNUSED_IMAGE_BYTES = 300_000
const UNUSED_VIDEO_BYTES = 1_800_000
const UNUSED_COPY_BYTES = 100_000
const PART_BYTES = 50_000
// The two files of the work folder that no run holds.
const WORK_INPUT_BYTES = 200_000
const WORK_OUTPUT_BYTES = 300_000
// The code file of each seeded app.
const APP_CODE_FILE = 'main.ts'
// The size of that file in the app that no text names. Its manifest adds
// less than 100 B.
const LEFT_APP_BYTES = 150_000
// Two stored files, two cache files, and one work folder: 2_750_000 B.
const FILES_PROMPT = 'Are you sure you want to delete 5 unreferenced files? This frees 2.6 MB, and it cannot be undone.'
// The app that no text names: a bit more than 150_000 B.
const APPS_PROMPT = 'Are you sure you want to delete 1 unreferenced app (left-app) with all its files? This frees 147 KB, and it cannot be undone.'

const KEPT_FILES = [
  'assets/generated/audio/clip-saved.wav',
  'assets/generated/images/image-tab.png',
  'assets/images/image-saved.png',
  'assets/images/image-young.png',
  'assets/images/notes.txt',
]
const UNUSED_FILES = ['assets/generated/video/video-unused.webm', 'assets/images/image-unused.png']

// The entries of the cache folder that this spec seeds, relative to it.
const KEPT_CACHE_ENTRIES = ['media/copy-used.webm', 'work/work-young/in.webm']
const UNUSED_CACHE_ENTRIES = ['media/copy-unused.webm', 'media/download-left.part', 'work/work-left/in.webm', 'work/work-left/out.webm']

const KEPT_APPS = ['shown-app', 'young-app']
const UNUSED_APPS = ['left-app']

/** One state of the two cleanup rows. */
interface RowState {
  /** The `aria-label` of the progress bar that shows, or null with no
   *  bar. One cleanup runs at a time, so at most one bar shows. */
  bar: string | null
  /** The `aria-valuenow` of that bar. */
  percent: string | null
  /** Whether Delete Unreferenced Files is off. */
  filesOff: boolean
  /** Whether Delete Unreferenced Apps is off. */
  appsOff: boolean
}

const IDLE: RowState = { bar: null, percent: null, filesOff: false, appsOff: false }
const FILES_BAR = 'Looking for unreferenced files'
const APPS_BAR = 'Looking for unreferenced apps'

describe('Settings: delete unreferenced files and apps', () => {
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

  // Writes the cache file `relative` (in the media folder or a work
  // folder). Its file time is one hour ago with `old`, else now. The time
  // of a work folder is the last change of its list, so the folder gets
  // the time of its file.
  function seedCacheFile (relative: string, bytes: Buffer, { old }: { old: boolean }): void {
    const file = path.join(path.dirname(mediaTempDir(app.home)), relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    if (!old) return
    const time = new Date(Date.now() - HOUR_MS)
    fs.utimesSync(file, time, time)
    if (relative.startsWith('work/')) fs.utimesSync(path.dirname(file), time, time)
  }

  // Writes the app `name` with the code file `code`. Its folder and its
  // files get a file time of one hour ago.
  async function seedOldApp (name: string, code: string): Promise<void> {
    const appsDir = appFilePath(app.home, 'apps')
    await seedApp(appsDir, { name, description: `The app ${name}`, kind: 'script' }, { [APP_CODE_FILE]: code })
    await ageApp(appsDir, name, HOUR_MS)
  }

  // The folders of the apps.
  function appFolders (): string[] {
    return fs.readdirSync(appFilePath(app.home, 'apps')).sort()
  }

  // The files of the media folder and of the work folders of the cache
  // folder, relative to it.
  function cacheFiles (): string[] {
    const media = fs.readdirSync(mediaTempDir(app.home)).map((name) => `media/${name}`)
    const work = fs.readdirSync(workDir(app.home))
      .flatMap((folder) => fs.readdirSync(path.join(workDir(app.home), folder)).map((name) => `work/${folder}/${name}`))
    return [...media, ...work].sort()
  }

  // The files of the four stored-file folders that this spec seeds,
  // relative to the app folder.
  function storedFiles (): string[] {
    return ['assets/images', 'assets/generated/images', 'assets/generated/audio', 'assets/generated/video']
      .flatMap((folder) => fs.readdirSync(appFilePath(app.home, folder)).map((name) => `${folder}/${name}`))
      .sort()
  }

  // The state of the two rows. The page reads it, as the recorder below
  // does.
  async function rowState (): Promise<RowState> {
    return browser.execute(() => {
      const bar = document.querySelector('.settings-progress')
      return {
        bar: bar?.getAttribute('aria-label') ?? null,
        percent: bar?.getAttribute('aria-valuenow') ?? null,
        filesOff: document.querySelector<HTMLButtonElement>('.unused-files-btn')?.disabled ?? false,
        appsOff: document.querySelector<HTMLButtonElement>('.unused-apps-btn')?.disabled ?? false,
      }
    })
  }

  // Records each state of the rows in which a bar shows a new percent, or
  // the bar of the other cleanup. The scan of this spec's few files ends
  // between two WebDriver commands, so the page records the steps itself.
  async function recordRunSteps (): Promise<void> {
    await browser.execute(() => {
      const section = document.querySelector('.settings-section')
      if (!section) throw new Error('recordRunSteps: no Settings section')
      const steps: RowState[] = []
      Reflect.set(window, '__e2eRunSteps', steps)
      new MutationObserver(() => {
        const bar = section.querySelector('.settings-progress')
        if (!bar) return
        const label = bar.getAttribute('aria-label')
        const percent = bar.getAttribute('aria-valuenow')
        const last = steps.at(-1)
        if (last?.bar === label && last.percent === percent) return
        steps.push({
          bar: label,
          percent,
          filesOff: section.querySelector<HTMLButtonElement>('.unused-files-btn')?.disabled ?? false,
          appsOff: section.querySelector<HTMLButtonElement>('.unused-apps-btn')?.disabled ?? false,
        })
      }).observe(section, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-valuenow'] })
    })
  }

  // Gives the steps that the recorder took since the last call, and
  // forgets them.
  async function takeRunSteps (): Promise<RowState[]> {
    return browser.execute(() => (Reflect.get(window, '__e2eRunSteps') as RowState[]).splice(0))
  }

  // The steps of a scan of the two conversation files: one for the start,
  // and one for each file. Both buttons are off for the whole run.
  function scanSteps (bar: string): RowState[] {
    return ['0', '50', '100'].map((percent) => ({ bar, percent, filesOff: true, appsOff: true }))
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
      seedCacheFile('media/copy-used.webm', Buffer.alloc(10), { old: true })
      seedCacheFile('media/copy-unused.webm', Buffer.alloc(UNUSED_COPY_BYTES), { old: true })
      seedCacheFile('media/download-left.part', Buffer.alloc(PART_BYTES), { old: true })
      seedCacheFile('work/work-left/in.webm', Buffer.alloc(WORK_INPUT_BYTES), { old: true })
      seedCacheFile('work/work-left/out.webm', Buffer.alloc(WORK_OUTPUT_BYTES), { old: true })
      seedCacheFile('work/work-young/in.webm', Buffer.alloc(10), { old: false })
      await seedOldApp('shown-app', 'export default () => "shown"\n')
      await seedOldApp('left-app', `// ${'x'.repeat(LEFT_APP_BYTES - 4)}\n`)
      await seedOldApp('young-app', 'export default () => "young"\n')
      await seedConversation(app.home, makeConversation({
        id: 'with-image',
        title: 'With image',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: `Look at ![id=a](${appFilePath(app.home, 'assets/images/image-saved.png')})` }] }],
      }))
      await seedConversation(app.home, makeConversation({
        id: 'with-clip',
        title: 'With clip',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: 'Say hello' }] },
          {
            role: 'agent',
            nodes: [{
              kind: 'text',
              text: `<dez:audio id="a" type="audio/wav" src="${appFilePath(app.home, 'assets/generated/audio/clip-saved.wav')}"/>\n`
                + `<dez:video id="b" type="video/webm" src="${path.join(mediaTempDir(app.home), 'copy-used.webm')}"/>\n`
                + '<dez:app name="shown-app"/>',
            }],
          },
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
      content: [{ kind: 'text', text: `Draft with ![id=a](${appFilePath(app.home, 'assets/generated/images/image-tab.png')})` }],
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

  it('shows the progress of the scan of the files, then asks with the count and the size, and deletes nothing on a No', async () => {
    // A file time of now, as a paste that just stored its file gives, and
    // as a write of a file of an app gives.
    const now = new Date()
    fs.utimesSync(appFilePath(app.home, 'assets/images/image-young.png'), now, now)
    fs.utimesSync(appFilePath(app.home, 'apps', 'young-app', APP_CODE_FILE), now, now)
    expect(await rowState()).toStrictEqual(IDLE)

    await pointerClick(browser, '.unused-files-btn')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), FILES_PROMPT)

    expect(await takeRunSteps()).toStrictEqual(scanSteps(FILES_BAR))
    expect(await rowState()).toStrictEqual({ bar: FILES_BAR, percent: '100', filesOff: true, appsOff: true })

    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'row after No', rowState, IDLE)
    expect(await promptMessage(browser)).toBeNull()
    expect(storedFiles()).toStrictEqual([...KEPT_FILES, ...UNUSED_FILES].sort())
    expect(cacheFiles()).toStrictEqual([...KEPT_CACHE_ENTRIES, ...UNUSED_CACHE_ENTRIES].sort())
    expect(appFolders()).toStrictEqual([...KEPT_APPS, ...UNUSED_APPS].sort())
    expect(await openToasts(browser)).toEqual([])
  })

  it('deletes on a Yes only the old files that no conversation and no open tab names, and the old cache entries that nothing uses, and no app', async () => {
    await pointerClick(browser, '.unused-files-btn')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), FILES_PROMPT)
    await pointerClick(browser, '.confirm-btn--confirm')

    await waitForValue(browser, 'result toast', () => openToasts(browser), [{ title: '', message: 'Deleted 5 unreferenced files (2.6 MB).' }])
    await waitForValue(browser, 'row after the delete', rowState, IDLE)
    expect(storedFiles()).toStrictEqual(KEPT_FILES)
    expect(cacheFiles()).toStrictEqual(KEPT_CACHE_ENTRIES)
    expect(fs.existsSync(path.join(workDir(app.home), 'work-left'))).toBe(false)
    expect(appFolders()).toStrictEqual([...KEPT_APPS, ...UNUSED_APPS].sort())
    // The tab's text was never on disk, so only the texts in memory kept
    // its image.
    expect(fs.existsSync(conversationFilePath(app.home, unsavedConversationId))).toBe(false)
  })

  it('tells that there are no unreferenced files, with no prompt', async () => {
    await pointerClick(browser, '.unused-files-btn')

    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === 'No unreferenced files found'), true)
    await waitForValue(browser, 'row after the scan', rowState, IDLE)
    expect(await promptMessage(browser)).toBeNull()
    expect(storedFiles()).toStrictEqual(KEPT_FILES)
    expect(cacheFiles()).toStrictEqual(KEPT_CACHE_ENTRIES)
    expect(appFolders()).toStrictEqual([...KEPT_APPS, ...UNUSED_APPS].sort())
  })

  it('shows the progress of the scan of the apps, asks with the name of each app and the size, and deletes on a Yes only the old apps that no text names', async () => {
    await takeRunSteps()
    await pointerClick(browser, '.unused-apps-btn')
    await waitForValue(browser, 'prompt', () => promptMessage(browser), APPS_PROMPT)

    expect(await takeRunSteps()).toStrictEqual(scanSteps(APPS_BAR))
    expect(await rowState()).toStrictEqual({ bar: APPS_BAR, percent: '100', filesOff: true, appsOff: true })

    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'result toast', async () => (await openToasts(browser)).some((toast) => toast.message === 'Deleted 1 unreferenced app (147 KB).'), true)
    await waitForValue(browser, 'row after the delete', rowState, IDLE)
    expect(appFolders()).toStrictEqual(KEPT_APPS)
    expect(storedFiles()).toStrictEqual(KEPT_FILES)
    expect(cacheFiles()).toStrictEqual(KEPT_CACHE_ENTRIES)
  })

  it('tells that there are no unreferenced apps, with no prompt', async () => {
    await pointerClick(browser, '.unused-apps-btn')

    await waitForValue(browser, 'toast', async () => (await openToasts(browser)).some((toast) => toast.message === 'No unreferenced apps found'), true)
    await waitForValue(browser, 'row after the scan', rowState, IDLE)
    expect(await promptMessage(browser)).toBeNull()
    expect(appFolders()).toStrictEqual(KEPT_APPS)
    expect(await consoleErrors(browser)).toEqual([])
  })
})
