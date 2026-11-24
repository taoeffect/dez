import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { appTagText } from '../../src/model/chat/appTags'
import { noAppSelectorText, SAVE_NEEDS_DRAFT_TEXT, SAVE_NEEDS_USER_TEXT } from '../../src/model/tools/appBridge'
import {
  appFolderSize,
  inRunningApp,
  movingAppFiles,
  pageFrameGuards,
  runningAppHost,
  runningAppPoint,
  seedApp,
  shownAppBars,
  shownAppCards,
  shownAppCorners,
  shownAppFrames,
  uiAppFiles,
  waitForAppFullscreen,
  type ShownAppCard,
  type ShownAppFrame,
} from './harness/apps'
import {
  consoleErrors,
  elementCenter,
  isOnTop,
  movePointer,
  pointerClick,
  pointerClickAt,
  pointerRightClickAt,
  promptMessage,
  resetConsoleErrors,
  screenshotOnFailure,
  themeColor,
  typeKeys,
  waitFor,
  waitForValue,
  type Point,
} from './harness/dom'
import { DROPPED_FILES_TEXT, expectNoLinkedFile, linkedDropDir, openDroppedFiles } from './harness/drops'
import { appFilePath, filesIn, newFileIn, storedFileName } from './harness/fixtures'
import { colorDistance, generatedImagesDir, screenPixels, shownImages, solidPng, STRIPES_PNG } from './harness/images'
import { WEBM_VIDEO } from './harness/media'
import { menuRecord, recordAssetMenus, resetMenuRecord, type MenuRecord } from './harness/menus'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import {
  activeTabId,
  assetPartPoint,
  editorDoc,
  editorScrollTop,
  editorSelection,
  endedReply,
  focusEditor,
  focusedArea,
  newTab,
  openSeededConversation,
  pickModel,
  openToasts,
  sbpCall,
  scrollEditorToEnd,
  scrollEditorToTop,
  setCaret,
  submit,
  threadSections,
} from './harness/thread'

// The apps that run in a conversation, driven through the real app:
// - the card of an app in the editor is a poster, and the app starts only
//   on a click on Run;
// - the page of an app that runs is in a frame over its card, and stays
//   there, with no new load, while the conversation changes around it;
// - the keyboard goes to the app on Run, and back to the editor on Escape
//   and on Stop;
// - the corner of a poster and the bar of an app that runs tell the size of
//   the folder of the app, and have the trash, which deletes the app after
//   a prompt;
// - the bar shows the app over the conversation view (the expanded view)
//   and over the screen (fullscreen), with the page of the app as it is,
//   and Escape goes one step back for each key;
// - a context click on a card, on a bar, and in the page of an app asks
//   for the menu of the app, with its folder (harness/menus.ts);
// - the page of an app reads the bytes of each image and clip of its
//   conversation, also of a file that the user linked, and calls nothing
//   else of Dez: Dez drops each message of the page that it does not know;
// - each side of the bridge takes a message only from the other side: an
//   app that runs cannot call a handler of another app, answer its calls,
//   or get its answers;
// - a save of the page goes into the message that the user writes, as a
//   stored file with a new id, only while the user works in the app and
//   while the conversation ends with that message;
// - an app whose frame goes to another page is stopped, also when its
//   page goes while it loads.
// The pages come from the real scheme of the app frames, with Dez's client
// script (`~dez.js`). The guards of a frame have their own audit
// (app-frames.e2e.ts).
//
// A menu accelerator of GTK cannot be sent (vitest.e2e.config.ts), so the
// spec calls the selector that the menu items call.
//
// A read of the page of an app gives the keyboard to its frame for
// WebDriver (`inFrame`, harness/appFrames.ts). So a test reads the page of
// an app only while the app has the keyboard, or after its last key.
//
// One app session serves the whole file; each test opens its own
// conversation in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The page of the app `notes`. Its script gives each load of the page a
// new value (`data-load` of the body), so a test can tell a page that
// stayed from one that loaded again.
const NOTES_FILES = {
  'index.html': [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>notes</title></head>',
    '<body>',
    '<textarea id="text"></textarea>',
    '<input id="own-escape">',
    '<script src="~dez.js"></script>',
    '<script src="main.js"></script>',
    '</body></html>',
    '',
  ].join('\n'),
  'main.js': [
    'document.body.dataset.load = String(Math.random())',
    '// A field that takes Escape for itself, as a field with an open list does.',
    "document.getElementById('own-escape').addEventListener('keydown', (event) => {",
    "  if (event.key === 'Escape') event.preventDefault()",
    '})',
    '',
  ].join('\n'),
}

const NOTES_POSTER: ShownAppCard = { app: 'notes', state: 'run', text: 'notes\nKeeps notes.' }

// A reply text that is much longer than the view.
const LONG_TEXT = Array.from({ length: 300 }, (_, index) => `Line ${index + 1}`).join('\n')

// The part `part` of the frame host of the app `app` that runs.
const hostPart = (app: string, part: string): string => `${runningAppHost(app)} ${part}`

const NOTES_CARD = '.cm-content .dez-app[data-app="notes"]'
const RUN = `${NOTES_CARD} .dez-app__run`
const FRAME = hostPart('notes', 'iframe')
const BAR_NAME = hostPart('notes', '.dez-app-frame__name')
const EXPAND = hostPart('notes', '[data-action="expand"]')
const FULLSCREEN = hostPart('notes', '[data-action="fullscreen"]')
const STOP = hostPart('notes', '.dez-app-frame__stop')

const deletePrompt = (app: string): string =>
  `Are you sure you want to delete the app ${app}? Dez deletes the folder of the app with all its files. No conversation can run the app after that.`

// The image that the app `board` saves.
const BOARD_PNG = solidPng(16, 16, [200, 120, 40])

// The script of the page of the app `board`, which calls Dez (the frame
// bridge, src/model/tools/appBridge.ts). A test calls its functions in
// the page, and a click on the button of the page saves `BOARD_PNG`, as
// the app of a model saves at a click of the user.
const BOARD_MAIN = [
  `const PNG = Uint8Array.from(atob("${BOARD_PNG.toString('base64')}"), (char) => char.charCodeAt(0))`,
  '// What a call of Dez gave: its value, or the message of its error.',
  'function outcome (call) {',
  '  return call.then((value) => ({ value }), (error) => ({ refused: error.message }))',
  '}',
  '// What the read of the asset `id` gave: the facts of its Blob.',
  'async function read (id) {',
  '  const got = await outcome(dez.sbp("dez.app/readAsset", id))',
  '  if (!(got.value instanceof Blob)) return got',
  '  const bytes = new Uint8Array(await got.value.arrayBuffer())',
  '  return { value: { type: got.value.type, size: got.value.size, isFile: got.value instanceof File, base64: btoa(String.fromCharCode(...bytes)) } }',
  '}',
  'function save (bytes) {',
  '  return outcome(dez.sbp("dez.app/saveAsset", bytes))',
  '}',
  'function savePng () {',
  '  return save(new Blob([PNG]))',
  '}',
  'document.getElementById("save").addEventListener("click", async () => {',
  '  document.getElementById("saved").textContent = JSON.stringify(await savePng())',
  '})',
  '',
].join('\n')

const BOARD_BODY = '<button id="save">Save</button>\n<pre id="saved"></pre>'

const BOARD_RUN = '.cm-content .dez-app[data-app="board"] .dez-app__run'

// What a call of Dez gave the page of `board` (`outcome` in `BOARD_MAIN`).
type Outcome<T> = { value: T } | { refused: string }

// A function of `BOARD_MAIN` that calls Dez.
type BoardCall<T> = (value?: unknown) => Promise<Outcome<T>>

// What the page of `board` tells of a Blob that it read (`read` in
// `BOARD_MAIN`).
interface ReadBlob {
  type: string
  size: number
  isFile: boolean
  base64: string
}

// What Dez answers a save of `BOARD_PNG` that it stored as the asset `id`.
const savedPng = (id: string): Outcome<unknown> => ({ value: { id, kind: 'image', type: 'image/png' } })

// The red, green, blue, and alpha of a computed CSS color.
function colorParts (color: string): number[] {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? []
  return parts.length === 3 ? [...parts, 1] : parts
}

// The color (red, green, blue) that the color `tint` (with its alpha)
// gives over the color `under`.
function tintedColor (under: readonly number[], [red, green, blue, alpha]: readonly number[]): number[] {
  return [red, green, blue].map((value, index) => Math.round(value * alpha + under[index] * (1 - alpha)))
}

// What a test reads of the page of `notes`; each part is null while the
// page loads.
interface NotesPage {
  load: string | null
  text: string | null
  ownEscape: string | null
}

// The size that the host of one app that runs shows in, and whether the
// host is at the place of that size: over the placeholder of its run
// (`card`), over the conversation view (`expanded`), or over the window
// (`fullscreen`). A place can be a fraction of a pixel.
interface FrameView {
  run: string | null
  view: ShownAppFrame['view']
  inPlace: boolean
}

describe('apps in a conversation', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The folder of the apps of the test HOME.
  let appsDir: string
  // The folder of the images that Dez stores for a tool or an app.
  let imagesDir: string
  // A folder that is not in the test HOME, so that the app links a file of
  // it in place.
  let linkedDir: string

  const notesPage = (): Promise<NotesPage> => inRunningApp(browser, 'notes', () => browser.execute(() => ({
    load: document.body?.dataset.load ?? null,
    text: document.querySelector<HTMLTextAreaElement>('#text')?.value ?? null,
    ownEscape: document.querySelector<HTMLInputElement>('#own-escape')?.value ?? null,
  })))

  const notesText = async (): Promise<string | null> => (await notesPage()).text

  const firstSectionText = async (): Promise<string> => (await threadSections(browser))[0].text

  // The apps that run, and whether the frame of each covers the placeholder
  // of its run. A place can be a fraction of a pixel.
  const framesInPlace = async (): Promise<Array<{ app: string | null, run: string | null, inPlace: boolean }>> =>
    (await shownAppFrames(browser)).map(({ app, run, offPlace }) => ({ app, run, inPlace: offPlace !== null && offPlace <= 1 }))

  const frameViews = async (): Promise<FrameView[]> =>
    (await shownAppFrames(browser)).map(({ run, view, offPlace, offCover }) => {
      const off = view === 'card' ? offPlace : offCover
      return { run, view, inPlace: off !== null && off <= 1 }
    })

  const helpOpen = (): Promise<boolean> => browser.execute(() => document.querySelector('.help-overlay') !== null)

  // A wheel turn down at the center of the element `selector`.
  async function wheelAt (selector: string): Promise<void> {
    const { x, y } = await elementCenter(browser, selector)
    await browser.action('wheel').scroll({ x, y, deltaY: 300 }).perform()
  }

  // The center of the part `part` of the card `index` of the app `app`.
  const cardPoint = (app: string, index: number, part: string): Promise<Point> =>
    assetPartPoint(browser, `.dez-app[data-app="${app}"]`, index, part)

  // Opens a conversation whose reply shows the app `notes`, with `after` as
  // the text of the reply after the card.
  async function openNotes (id: string, after = 'Here is the app.'): Promise<void> {
    await openSeededConversation(browser, setup.app.home, id, [
      { role: 'user', text: 'Show me the notes app.' },
      { role: 'agent', text: `${appTagText('notes')}\n\n${after}` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'the poster', () => shownAppCards(browser), [NOTES_POSTER])
  }

  // Clicks Run of the card of `notes`, waits for the page of the app, and
  // gives the id of the run and what the page shows.
  async function runNotes (): Promise<{ run: string | null, page: NotesPage }> {
    await pointerClick(browser, RUN)
    await waitFor(browser, FRAME)
    await waitForValue(browser, 'the page of the app', async () => (await notesPage()).load !== null, true)
    const [{ run }] = await shownAppFrames(browser)
    return { run, page: await notesPage() }
  }

  // Puts the keyboard into the text field of `notes` with the Tab key, as
  // a user can after Run. The page cannot do this itself at its load:
  // WebKit ignores a `focus()` call of a script in a frame of another
  // origin until the first key or click of the user in that frame.
  async function enterNotesText (): Promise<void> {
    await browser.keys(Key.Tab)
    await waitForValue(browser, 'the field with the keyboard', () => inRunningApp(browser, 'notes', () => browser.execute(() => document.activeElement?.id ?? null)), 'text')
  }

  // Runs `notes` and types into its text field, so that a later read of
  // the page tells a page that stayed from one that loaded again. Gives
  // the id of the run and what the page shows.
  async function runNotesWithText (): Promise<{ run: string | null, page: NotesPage }> {
    const { run, page: loaded } = await runNotes()
    await enterNotesText()
    await typeKeys(browser, 'abc')
    const page: NotesPage = { ...loaded, text: 'abc' }
    await waitForValue(browser, 'the page of the app', notesPage, page)
    return { run, page }
  }

  // Opens a conversation whose reply shows the app `board`. The message
  // that the user writes has the files of `openDroppedFiles`.
  async function openBoard (id: string): Promise<void> {
    await openDroppedFiles(setup, CALLER, linkedDir, id, [
      { role: 'user', text: 'Show me the board app.' },
      { role: 'agent', text: appTagText('board') },
    ])
    await waitForValue(browser, 'the poster', async () => (await shownAppCards(browser)).map((card) => card.state), ['run'])
  }

  // Clicks Run of the card of `board`, and waits for the script of its
  // page.
  async function runBoard (): Promise<void> {
    await pointerClick(browser, BOARD_RUN)
    await waitFor(browser, hostPart('board', 'iframe'))
    await waitForValue(browser, 'the page of the app', () => inRunningApp(browser, 'board', () => browser.execute(() => typeof Reflect.get(window, 'savePng'))), 'function')
  }

  // Clicks the button of the page of `board`, which saves `BOARD_PNG`. The
  // card is at the start of the conversation, and a reply can have moved
  // the view.
  async function clickBoardSave (): Promise<void> {
    await scrollEditorToTop(browser)
    await pointerClickAt(browser, await runningAppPoint(browser, 'board', '#save'))
  }

  // What Dez answered the last click on the button of `board`; null before
  // the first answer.
  async function boardSaved (): Promise<Outcome<unknown> | null> {
    const text = await inRunningApp(browser, 'board', () => browser.execute(() => document.querySelector('#saved')?.textContent ?? ''))
    return text === '' ? null : JSON.parse(text) as Outcome<unknown>
  }

  beforeAll(async () => {
    linkedDir = await linkedDropDir('app-host')
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    appsDir = appFilePath(setup.app.home, 'apps')
    imagesDir = generatedImagesDir(setup.app.home)
    await seedApp(appsDir, { name: 'notes', description: 'Keeps notes.', kind: 'ui' }, NOTES_FILES)
    await seedApp(appsDir, { name: 'timer', description: 'Counts down.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>Timer</p>\n' })
    await seedApp(appsDir, { name: 'sum', description: 'Adds numbers.', kind: 'script' }, { 'main.ts': 'export default () => 1\n' })
    await seedApp(appsDir, { name: 'board', description: 'Works with pictures.', kind: 'ui' }, uiAppFiles(BOARD_MAIN, BOARD_BODY))
    await seedApp(appsDir, { name: 'hop', description: 'Goes away.', kind: 'ui' }, movingAppFiles('board'))
    await recordAssetMenus(browser)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await resetMenuRecord(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('shows each app as a poster, with Run only for an app that Dez can start', async () => {
    await openSeededConversation(browser, setup.app.home, 'app-host-posters', [
      { role: 'user', text: `My apps:\n${appTagText('notes')}` },
      // A script app has no page, and no app has the last name.
      { role: 'agent', text: `${appTagText('sum')}\n\n${appTagText('gone')}` },
      { role: 'user', text: '' },
    ])

    const cards = async (): Promise<Array<Pick<ShownAppCard, 'app' | 'state'>>> =>
      (await shownAppCards(browser)).map(({ app, state }) => ({ app, state }))
    await waitForValue(browser, 'the first posters', async () => (await cards()).slice(0, 2), [
      { app: 'notes', state: 'run' },
      { app: 'sum', state: 'note' },
    ])
    expect((await shownAppCards(browser))[0]).toStrictEqual(NOTES_POSTER)
    // The corner of a poster tells the size of the folder of its app, also
    // for an app that Dez cannot start.
    expect((await shownAppCorners(browser)).slice(0, 2)).toStrictEqual([
      { app: 'notes', size: await appFolderSize(appsDir, 'notes'), trash: 'Delete the app notes' },
      { app: 'sum', size: await appFolderSize(appsDir, 'sum'), trash: 'Delete the app sum' },
    ])
    // The editor draws no card that is far below the view.
    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the last poster', async () => (await cards()).at(-1), { app: 'gone', state: 'note' })
    expect((await shownAppCorners(browser)).at(-1)).toStrictEqual({ app: 'gone', size: null, trash: 'Remove the card of the app gone' })
    // No app runs before its Run.
    expect(await shownAppFrames(browser)).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs an app in a frame over its card, gives it the keyboard, and takes both back', async () => {
    await openNotes('app-host-run')
    await focusEditor(browser)
    const { run } = await runNotes()

    // The frame covers the card, which is an empty placeholder now. It is
    // a sandboxed frame of the scheme of the app frames. The bar above the
    // frame has the name and the size of the app, and its controls.
    expect(await pageFrameGuards(browser)).toStrictEqual([{ sandbox: 'allow-scripts', src: 'dezapp://localhost/notes/index.html' }])
    expect(await shownAppCards(browser)).toStrictEqual([{ app: 'notes', state: 'running', text: '' }])
    expect(await framesInPlace()).toStrictEqual([{ app: 'notes', run, inPlace: true }])
    expect(await shownAppBars(browser)).toStrictEqual([{
      app: 'notes',
      text: `notes\n${await appFolderSize(appsDir, 'notes')}`,
      buttons: ['Expand the app over the conversation', 'Fullscreen', 'Stop the app notes', 'Delete the app notes'],
    }])

    // Run gives the keyboard to the app: the keys go to its page only, with
    // no click in the page.
    const doc = await editorDoc(browser)
    expect(await focusedArea(browser)).toBe('iframe')
    await enterNotesText()
    await typeKeys(browser, 'abc')
    await waitForValue(browser, 'the text of the app', notesText, 'abc')
    expect(await editorDoc(browser)).toBe(doc)

    // Escape gives the keyboard back to the editor. The spec reads nothing
    // of the app from here until the app has the keyboard again (`inFrame`).
    const ownEscape = await runningAppPoint(browser, 'notes', '#own-escape')
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')
    await typeKeys(browser, 'x')
    await waitForValue(browser, 'the text of the editor', firstSectionText, 'xShow me the notes app.')

    // A click in the app gives it the keyboard again, and a field of the
    // app that takes Escape for itself keeps it.
    const typed = await editorDoc(browser)
    await pointerClickAt(browser, ownEscape)
    await waitForValue(browser, 'the focus after a click in the app', () => focusedArea(browser), 'iframe')
    await browser.keys(Key.Escape)
    await typeKeys(browser, 'k')
    await waitForValue(browser, 'the fields of the app', async () => {
      const page = await notesPage()
      return { text: page.text, ownEscape: page.ownEscape }
    }, { text: 'abc', ownEscape: 'k' })
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await editorDoc(browser)).toBe(typed)

    // Stop ends the app: the poster is back, and so is the keyboard, with
    // the caret where it was.
    await pointerClick(browser, STOP)
    await waitForValue(browser, 'the frames after Stop', () => shownAppFrames(browser), [])
    expect(await shownAppCards(browser)).toStrictEqual([NOTES_POSTER])
    expect(await focusedArea(browser)).toBe('editor')
    await typeKeys(browser, 'y')
    await waitForValue(browser, 'the text of the editor after Stop', firstSectionText, 'xyShow me the notes app.')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('keeps an app that runs, with its page as it is, through edits, the end of a reply, and a far scroll', async () => {
    await openNotes('app-host-stays', LONG_TEXT)
    await pickModel(browser, CALLER.name, CALLER.modelName)
    const { run, page } = await runNotesWithText()
    const inPlace = [{ app: 'notes', run, inPlace: true }]
    expect(await framesInPlace()).toStrictEqual(inPlace)
    const [{ top }] = await shownAppFrames(browser)

    // New lines above the card move the card, and the frame with it. The
    // keys of this test that go to the editor come first, and the reads of
    // the page of the app after them (`inFrame`).
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')
    await setCaret(browser, 0)
    for (let line = 0; line < 3; line++) await browser.keys(Key.Enter)
    await waitForValue(browser, 'the frame after the edit', framesInPlace, inPlace)
    expect((await shownAppFrames(browser))[0].top).toBeGreaterThan(top + 30)

    // The end of a reply gives the editor a new state: the app runs on,
    // with the page that it had before the edit.
    await submit(browser, 'Go on.')
    const request = await takeRequest(setup, CHAT_PATH)
    await sendChatReply(request.reply, CALLER.modelName)
    await endedReply(browser, 3)
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'the frame after the reply', framesInPlace, inPlace)
    expect(await notesPage()).toStrictEqual(page)

    // Far out of view the editor draws no card, and the frame stays.
    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the frame far out of view', async () => (await shownAppFrames(browser)).map((frame) => ({ run: frame.run, offPlace: frame.offPlace })), [{ run, offPlace: null }])
    expect((await shownAppFrames(browser))[0].top).toBeLessThan(-1000)
    expect(await notesPage()).toStrictEqual(page)
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'the frame back in view', framesInPlace, inPlace)
    expect(await openToasts(browser)).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('stops the apps of a conversation when the user goes to another tab', async () => {
    await openNotes('app-host-tabs')
    const tab = await activeTabId(browser)
    await runNotes()

    await newTab(browser)
    await waitForValue(browser, 'the frames in the new tab', () => shownAppFrames(browser), [])
    await sbpCall(browser, 'dez.model/tabs/switch', tab)
    await waitForValue(browser, 'the card back in its tab', () => shownAppCards(browser), [NOTES_POSTER])
    expect(await shownAppFrames(browser)).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives an edit command of the menu to the app that has the keyboard, and not to the editor', async () => {
    await openNotes('app-host-menu')
    // An edit that an Undo of the editor would take back.
    await focusEditor(browser)
    await typeKeys(browser, 'x')
    await waitForValue(browser, 'the text of the editor', firstSectionText, 'xShow me the notes app.')
    const doc = await editorDoc(browser)
    const selection = await editorSelection(browser)
    await runNotes()
    await enterNotesText()
    await typeKeys(browser, 'abc')
    await waitForValue(browser, 'the text of the app', notesText, 'abc')

    // On Linux the menu takes the keys of its items before a page gets
    // them, and each item calls this selector.
    expect(await sbpCall(browser, 'dez.editor/runKeyBinding', 'selectAll', 'selectAll')).toBe(true)
    await waitForValue(browser, 'the selection of the app', () => inRunningApp(browser, 'notes', () => browser.execute(() => {
      const field = document.querySelector<HTMLTextAreaElement>('#text')
      return field ? [field.selectionStart, field.selectionEnd] : null
    })), [0, 3])
    await typeKeys(browser, 'z')
    await waitForValue(browser, 'the text of the app after Select All', notesText, 'z')
    expect(await sbpCall(browser, 'dez.editor/runKeyBinding', 'undo', 'undo')).toBe(true)
    await waitForValue(browser, 'the text of the app after Undo', notesText, 'abc')
    // A command of the editor that a text field does not have runs nowhere.
    expect(await sbpCall(browser, 'dez.editor/runKeyBinding', 'deleteLine', 'none')).toBe(false)

    expect(await editorDoc(browser)).toBe(doc)
    expect(await editorSelection(browser)).toStrictEqual(selection)
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows an app over the conversation view, with its page as it is, and closes the view on Escape', async () => {
    await openNotes('app-host-expand', LONG_TEXT)
    const { run, page } = await runNotesWithText()
    const atCard: FrameView[] = [{ run, view: 'card', inPlace: true }]
    const expanded: FrameView[] = [{ run, view: 'expanded', inPlace: true }]
    expect(await frameViews()).toStrictEqual(atCard)

    // The control of the wheel check below: over an app at the size of its
    // card, a wheel turn that the app does not take scrolls the
    // conversation.
    await wheelAt(FRAME)
    await waitForValue(browser, 'the conversation after a wheel turn over the card', async () => await editorScrollTop(browser) > 0, true)
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'the frame back in view', frameViews, atCard)

    // Expand puts the host over the conversation view. The page of the app
    // is the same one (no new load), and the app keeps the keyboard.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the expanded view', frameViews, expanded)
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await notesPage()).toStrictEqual(page)
    expect((await shownAppBars(browser))[0].buttons[0]).toBe('Close the expanded view')

    // The conversation under the app does not scroll.
    await wheelAt(FRAME)
    await wheelAt(BAR_NAME)
    // A wrong scroll would come in the next frames.
    await browser.pause(300)
    expect(await editorScrollTop(browser)).toBe(0)

    // Escape in the app closes the view, and the app keeps the keyboard.
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the app after Escape', frameViews, atCard)
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await notesPage()).toStrictEqual(page)

    // A panel of Dez shows over the expanded view. Its button leaves the
    // keyboard in the app, and Escape there closes the panel first.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the expanded view under Help', frameViews, expanded)
    await pointerClick(browser, '.help-button')
    await waitForValue(browser, 'Help over the app', () => isOnTop(browser, '.help-overlay'), true)
    expect(await focusedArea(browser)).toBe('iframe')
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'Help after Escape', helpOpen, false)
    expect(await frameViews()).toStrictEqual(expanded)

    // The button of the bar closes the view too. At the size of its card,
    // Escape in the app gives the keyboard to the editor.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the app after its button', frameViews, atCard)
    expect(await focusedArea(browser)).toBe('iframe')
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')

    // The editor never has the keyboard under an app that covers it: the
    // view closes when the editor gets the keyboard.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the expanded view again', frameViews, expanded)
    await waitForValue(browser, 'the focus in the expanded view', () => focusedArea(browser), 'iframe')
    await focusEditor(browser)
    await waitForValue(browser, 'the app after a focus of the editor', frameViews, atCard)
    expect(await focusedArea(browser)).toBe('editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tints the card of an app in a selection, also over the page of an app that runs, and not an app over the conversation view', async () => {
    // Whether the card of `notes` has the selected look (`data-selected`,
    // src/view/editor/assetSelection.ts).
    const cardSelected = (): Promise<boolean> =>
      browser.execute((card: string) => document.querySelector(card)?.hasAttribute('data-selected') ?? false, NOTES_CARD)
    // How the window shows the point `at`: 'clear' in the color `clear`
    // that it has with no selection, 'tinted' in the color of the tint
    // `tint` over that color, else its pixel.
    const screenLook = async (at: Point, clear: readonly number[], tint: readonly number[]): Promise<'clear' | 'tinted' | number[]> => {
      const [pixel] = await screenPixels(browser, [at])
      if (colorDistance(pixel, clear.slice(0, 3)) <= 3) return 'clear'
      if (colorDistance(pixel, tintedColor(clear, tint)) <= 3) return 'tinted'
      return pixel
    }

    await openNotes('app-host-selection')
    const tint = colorParts(await themeColor(browser, '--color-selection-tint'))
    // A point of the box of the card near its left edge, in its middle
    // row: on no part of the poster, and in the page of the app that runs.
    const point = await browser.execute((card: string) => {
      const box = document.querySelector(`${card} .dez-app__box`)?.getBoundingClientRect()
      if (!box) throw new Error('no box of the card of notes')
      return { x: Math.round(box.left + 24), y: Math.round(box.top + box.height / 2) }
    }, NOTES_CARD)

    // The poster gets the tint of an image, with no other color under it.
    const [poster] = await screenPixels(browser, [point])
    await focusEditor(browser)
    await browser.keys([Key.Alt, 'a'])
    await waitForValue(browser, 'the poster in Select All', cardSelected, true)
    await waitForValue(browser, 'the tint over the poster', () => screenLook(point, poster, tint), 'tinted')
    await setCaret(browser, 0)
    await waitForValue(browser, 'the poster with a caret', () => screenLook(point, poster, tint), 'clear')

    // The page of an app that runs gets the tint too: the frame host is
    // over the card, and the tint is over the host.
    const { run } = await runNotes()
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')
    const [page] = await screenPixels(browser, [point])
    await browser.keys([Key.Alt, 'a'])
    await waitForValue(browser, 'the card of the app in Select All', cardSelected, true)
    await waitForValue(browser, 'the tint over the app', () => screenLook(point, page, tint), 'tinted')

    // The app over the conversation view covers the tint of its card: the
    // point looks the same with the selection and with a caret.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the expanded view', frameViews, [{ run, view: 'expanded', inPlace: true }])
    expect(await cardSelected()).toBe(true)
    const [covered] = await screenPixels(browser, [point])
    await setCaret(browser, 0)
    await waitForValue(browser, 'the card with a caret', cardSelected, false)
    expect(await screenLook(point, covered, tint)).toBe('clear')

    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the app at its card', frameViews, [{ run, view: 'card', inPlace: true }])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows an app over the whole screen, with its page as it is, and goes one step back on Escape', async () => {
    await openNotes('app-host-fullscreen', LONG_TEXT)
    const { run, page } = await runNotesWithText()
    const shownAs = (view: FrameView['view']): FrameView[] => [{ run, view, inPlace: true }]

    await pointerClick(browser, FULLSCREEN)
    await waitForAppFullscreen(browser, 'notes', true)
    await waitForValue(browser, 'the app over the screen', frameViews, shownAs('fullscreen'))
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await notesPage()).toStrictEqual(page)
    expect((await shownAppBars(browser))[0].buttons[1]).toBe('Leave fullscreen')
    // The conversation under the app does not scroll.
    await wheelAt(FRAME)
    // A wrong scroll would come in the next frames.
    await browser.pause(300)
    expect(await editorScrollTop(browser)).toBe(0)

    // The button of the bar puts the app back over its card.
    await pointerClick(browser, FULLSCREEN)
    await waitForAppFullscreen(browser, 'notes', false)
    await waitForValue(browser, 'the app back over its card', frameViews, shownAs('card'))
    expect(await focusedArea(browser)).toBe('iframe')

    // Escape goes one step back for each key: from the screen to the
    // expanded view, to the card, and then the editor gets the keyboard.
    await pointerClick(browser, EXPAND)
    await waitForValue(browser, 'the expanded view', frameViews, shownAs('expanded'))
    await pointerClick(browser, FULLSCREEN)
    await waitForAppFullscreen(browser, 'notes', true)
    await waitForValue(browser, 'the expanded app over the screen', frameViews, shownAs('fullscreen'))
    await browser.keys(Key.Escape)
    await waitForAppFullscreen(browser, 'notes', false)
    await waitForValue(browser, 'the expanded view after Escape', frameViews, shownAs('expanded'))
    expect(await focusedArea(browser)).toBe('iframe')
    expect(await notesPage()).toStrictEqual(page)
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the card after Escape', frameViews, shownAs('card'))
    expect(await focusedArea(browser)).toBe('iframe')
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after the last Escape', () => focusedArea(browser), 'editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('deletes an app from the trash of its card and of its bar, after a prompt', async () => {
    await seedApp(appsDir, { name: 'draft', description: 'A draft.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>Draft</p>\n' })
    await seedApp(appsDir, { name: 'scratch', description: 'A scratch pad.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>Scratch</p>\n' })
    const replyWith = (cards: string): Array<{ role: 'user' | 'agent', text: string }> => [
      { role: 'user', text: 'Show me my apps.' },
      { role: 'agent', text: `${cards}Done.` },
      { role: 'user', text: '' },
    ]
    const scratchTag = appTagText('scratch')
    const thread = replyWith(`${appTagText('draft')}\nFirst:\n${scratchTag}\nSecond:\n${scratchTag}\n`)
    await openSeededConversation(browser, setup.app.home, 'app-host-delete', thread)
    const cards = async (): Promise<Array<Pick<ShownAppCard, 'app' | 'state'>>> =>
      (await shownAppCards(browser)).map(({ app, state }) => ({ app, state }))
    // The editor draws no card that is far below the view: the last one
    // comes when the first one is gone.
    await waitForValue(browser, 'the first posters', cards, [
      { app: 'draft', state: 'run' },
      { app: 'scratch', state: 'run' },
    ])
    const scratchPart = (part: string): string => hostPart('scratch', part)
    const runningApps = async (): Promise<Array<string | null>> => (await shownAppFrames(browser)).map((frame) => frame.app)

    // "No" deletes nothing.
    await pointerClickAt(browser, await cardPoint('draft', 0, '.dez-app__trash'))
    await waitForValue(browser, 'the prompt of a card', () => promptMessage(browser), deletePrompt('draft'))
    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'the prompt after No', () => promptMessage(browser), null)
    expect(await filesIn(appsDir)).toContain('draft')
    expect(await threadSections(browser)).toStrictEqual(thread)

    // "Yes" deletes the folder of the app, and takes the line of the card
    // out of the conversation.
    await pointerClickAt(browser, await cardPoint('draft', 0, '.dez-app__trash'))
    await waitForValue(browser, 'the prompt of a card again', () => promptMessage(browser), deletePrompt('draft'))
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'the apps after the delete of a card', async () => (await filesIn(appsDir)).includes('draft'), false)
    await waitForValue(browser, 'the conversation after the delete of a card', () => threadSections(browser), replyWith(`First:\n${scratchTag}\nSecond:\n${scratchTag}\n`))
    await waitForValue(browser, 'the posters after the delete of a card', cards, [
      { app: 'scratch', state: 'run' },
      { app: 'scratch', state: 'run' },
    ])

    // The trash of the bar of an app that fills the screen: the prompt is
    // not a part of the app, so the app leaves fullscreen first. "No"
    // leaves the app as it runs.
    await pointerClickAt(browser, await cardPoint('scratch', 1, '.dez-app__run'))
    await waitFor(browser, scratchPart('iframe'))
    await pointerClick(browser, scratchPart('[data-action="fullscreen"]'))
    await waitForAppFullscreen(browser, 'scratch', true)
    await pointerClick(browser, scratchPart('[data-action="delete"]'))
    await waitForValue(browser, 'the prompt of a bar', () => promptMessage(browser), deletePrompt('scratch'))
    await waitForAppFullscreen(browser, 'scratch', false)
    expect(await isOnTop(browser, '.confirm-dialog')).toBe(true)
    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'the prompt of a bar after No', () => promptMessage(browser), null)
    expect(await runningApps()).toStrictEqual(['scratch'])

    // The prompt shows over an expanded app. "Yes" ends the run, and takes
    // out the line of its card. The other card of the app stays, and tells
    // that the app is gone.
    await pointerClick(browser, scratchPart('[data-action="expand"]'))
    await waitForValue(browser, 'the expanded view', async () => (await shownAppFrames(browser)).map((frame) => frame.view), ['expanded'])
    await pointerClick(browser, scratchPart('[data-action="delete"]'))
    await waitForValue(browser, 'the prompt of an expanded app', () => promptMessage(browser), deletePrompt('scratch'))
    expect(await isOnTop(browser, '.confirm-dialog')).toBe(true)
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'the running apps after the delete', runningApps, [])
    await waitForValue(browser, 'the conversation after the delete of a run', () => threadSections(browser), replyWith(`First:\n${scratchTag}\nSecond:\n`))
    expect(await filesIn(appsDir)).not.toContain('scratch')
    await waitForValue(browser, 'the card that stays', () => shownAppCards(browser), [
      { app: 'scratch', state: 'note', text: 'scratch\nThis app is gone: its folder is not there any more.' },
    ])
    expect(await shownAppCorners(browser)).toStrictEqual([{ app: 'scratch', size: null, trash: 'Remove the card of the app scratch' }])
    expect(await focusedArea(browser)).toBe('editor')
    expect(await openToasts(browser)).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('asks for the menu of an app at a context click on its card, on its bar, and in its page', async () => {
    await openSeededConversation(browser, setup.app.home, 'app-host-context', [
      { role: 'user', text: 'Show me my apps.' },
      { role: 'agent', text: `${appTagText('notes')}\n${appTagText('gone')}` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'the posters', async () => (await shownAppCards(browser)).map((card) => card.state), ['run', 'note'])
    const folder = appFilePath(setup.app.home, 'apps', 'notes')
    const record: MenuRecord = { menus: [], canceled: [] }
    // A context click at `point` of Dez's page, which asks for the menu
    // with `file`. An app is no asset, so its menu has no Export.
    const expectMenu = async (label: string, point: Point, file: string | null): Promise<void> => {
      await pointerRightClickAt(browser, point)
      record.menus.push({ file })
      record.canceled.push(true)
      await waitForValue(browser, `the menu of ${label}`, () => menuRecord(browser), record)
    }

    // The menu of a card has the folder of its app, and no file for an app
    // that is gone.
    await expectMenu('a card', await cardPoint('notes', 0, '.dez-app__name'), folder)
    await expectMenu('the card of an app that is gone', await cardPoint('gone', 0, '.dez-app__name'), null)
    // The read of the last card scrolled the conversation.
    await scrollEditorToTop(browser)
    await runNotes()
    await expectMenu('a bar', await elementCenter(browser, BAR_NAME), folder)

    // In the page of an app, the script of Dez asks for the menu. The
    // click is an event of that page, not of Dez's page.
    await pointerRightClickAt(browser, await elementCenter(browser, FRAME))
    record.menus.push({ file: folder })
    await waitForValue(browser, 'the menu of the page of an app', () => menuRecord(browser), record)

    // The webview keeps its own menu in a text field of the app. No real
    // click here: WebDriver cannot close that menu.
    const contextMenuKept = (selector: string): Promise<boolean> => inRunningApp(browser, 'notes', () => browser.execute((target: string) => {
      const element = document.querySelector(target)
      if (!element) throw new Error(`no ${target} in the page of the app`)
      return element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    }, selector))
    expect(await contextMenuKept('#text')).toBe(true)
    // The page of an app gets no menu while the pointer is not over it.
    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    expect(await contextMenuKept('body')).toBe(false)
    // A wrong menu would come in the next frames.
    await browser.pause(300)
    expect(await menuRecord(browser)).toStrictEqual(record)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives a shown app the bytes of each image and clip of its conversation, also of a linked file, and nothing else of Dez', async () => {
    await openBoard('app-host-reads')
    const doc = await editorDoc(browser)
    const before = await filesIn(imagesDir)
    await runBoard()

    // A read gives a Blob with the type of its asset, and no file name.
    // The id can have its `@`.
    const reads = await inRunningApp(browser, 'board', () => browser.execute(async () => {
      const read = Reflect.get(window, 'read') as BoardCall<ReadBlob>
      return [await read('a'), await read('@b'), await read('c'), await read('z'), await read('a b'), await read()]
    }))
    const blob = (type: string, bytes: Buffer): Outcome<ReadBlob> => ({ value: { type, size: bytes.length, isFile: false, base64: bytes.toString('base64') } })
    const noId: Outcome<ReadBlob> = { refused: 'dez.app/readAsset takes the id of an image or a clip, as in dez.sbp(\'dez.app/readAsset\', \'a\'). It got no such id.' }
    expect(reads).toStrictEqual([
      blob('image/png', STRIPES_PNG),
      blob('image/png', STRIPES_PNG),
      blob('video/webm', WEBM_VIDEO),
      { refused: 'Dez gave no bytes for @z: it names no image and no clip of this conversation. The conversation has the image @a, the image @b, the video clip @c.' },
      noId,
      noId,
    ])

    // The page calls no selector of Dez's own page.
    const refused = (selector: string): Outcome<unknown> => ({ refused: noAppSelectorText(selector) })
    expect(await inRunningApp(browser, 'board', () => browser.execute(async () => {
      const outcome = Reflect.get(window, 'outcome') as (call: Promise<unknown>) => Promise<Outcome<unknown>>
      const dez = Reflect.get(window, 'dez') as { sbp: (selector: string, ...args: unknown[]) => Promise<unknown> }
      return [await outcome(dez.sbp('dez.model/tabs/list')), await outcome(dez.sbp('dez.controller/apps/delete', 'notes'))]
    }))).toStrictEqual([refused('dez.model/tabs/list'), refused('dez.controller/apps/delete')])
    expect(fs.existsSync(path.join(appsDir, 'notes', 'index.html'))).toBe(true)

    // The page can post any message to Dez with no help of Dez's script.
    // Dez drops each one that is no message of the bridge, and answers a
    // call as it answers one of its script.
    const answers = await inRunningApp(browser, 'board', () => browser.execute(async () => {
      const got: Array<[unknown, unknown, unknown]> = []
      const listen = (event: MessageEvent): void => {
        const message = event.data as { dez?: unknown, id?: unknown, ok?: unknown, error?: unknown } | null
        if (message?.dez === 'answer') got.push([message.id, message.ok, message.error ?? null])
      }
      window.addEventListener('message', listen)
      const messages: unknown[] = [
        'call',
        null,
        { dez: 'call' },
        { dez: 'call', id: '901', selector: 'dez.app/readAsset', args: ['a'] },
        { dez: 'call', id: 902, selector: `dez.app/readAsset${' '.repeat(100)}`, args: ['a'] },
        { dez: 'call', id: 903, selector: 'dez.app/readAsset' },
        { dez: 'read', id: 905, selector: 'dez.app/readAsset', args: ['a'] },
        // The answer of a call that Dez did not make.
        { dez: 'answer', id: 906, ok: true, value: 'x', log: 'x' },
        { dez: 'call', id: 904, selector: 'dez.model/tabs/list', args: [] },
      ]
      for (const message of messages) parent.postMessage(message, '*')
      // Dez answers the last message at once. A read that it did for a
      // message before that one would take a moment more.
      while (!got.some(([id]) => id === 904)) await new Promise((resolve) => setTimeout(resolve, 20))
      await new Promise((resolve) => setTimeout(resolve, 300))
      window.removeEventListener('message', listen)
      return got
    }))
    expect(answers).toStrictEqual([[904, false, noAppSelectorText('dez.model/tabs/list')]])

    // A save puts a file into the message of the user, so Dez takes none
    // while the user does not work in the app: the editor has the keyboard,
    // and the pointer is not over the app.
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')
    await movePointer(browser, await elementCenter(browser, 'header.tab-bar'))
    expect(await inRunningApp(browser, 'board', () => browser.execute(() => (Reflect.get(window, 'savePng') as BoardCall<unknown>)()))).toStrictEqual({ refused: SAVE_NEEDS_USER_TEXT })
    expect(await filesIn(imagesDir)).toStrictEqual(before)
    expect(await editorDoc(browser)).toBe(doc)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The window of an app can post to the window of each other app that
  // runs (`parent[index]`). No other window can post to an app or to Dez:
  // the sandbox, the policy, and the navigation guard leave the page of an
  // app no frame of its own that runs code.
  it('takes a message of the bridge only from its other side, and not from another app that runs', async () => {
    await openSeededConversation(browser, setup.app.home, 'app-host-two-apps', [
      { role: 'user', text: 'Show me the apps.' },
      { role: 'agent', text: `${appTagText('notes')}\n\n${appTagText('board')}` },
      { role: 'user', text: '' },
    ])
    await runNotes()
    // At `go`, the page of `notes` posts to the app that asked: a call of
    // a handler, and an answer for each call of that app that can wait.
    // It also calls Dez itself.
    await inRunningApp(browser, 'notes', () => browser.execute(() => {
      window.addEventListener('message', (event) => {
        const other = event.source
        if (event.data !== 'go' || !other) return
        other.postMessage({ dez: 'call', id: 1, selector: 'app/probe', args: [] }, { targetOrigin: '*' })
        for (let id = 0; id <= 100; id++) other.postMessage({ dez: 'answer', id, ok: true, value: 'forged' }, { targetOrigin: '*' })
        parent.postMessage({ dez: 'call', id: 907, selector: 'dez.model/tabs/list', args: [] }, '*')
        other.postMessage('posted', { targetOrigin: '*' })
      })
    }))
    await pointerClickAt(browser, await cardPoint('board', 0, '.dez-app__run'))
    await waitFor(browser, hostPart('board', 'iframe'))
    await waitForValue(browser, 'the page of the app', () => inRunningApp(browser, 'board', () => browser.execute(() => typeof Reflect.get(window, 'outcome'))), 'function')

    const refused = noAppSelectorText('dez.model/tabs/list')
    expect(await inRunningApp(browser, 'board', () => browser.execute(async () => {
      const outcome = Reflect.get(window, 'outcome') as (call: Promise<unknown>) => Promise<Outcome<unknown>>
      const dez = Reflect.get(window, 'dez') as { sbp: (selector: string, ...args: unknown[]) => Promise<unknown> }
      let handlerRan = false
      void dez.sbp('sbp/selectors/register', { 'app/probe': () => { handlerRan = true } })
      // What came to this page, in its order.
      const came: string[] = []
      const listen = (event: MessageEvent): void => {
        const message = event.data as { dez?: unknown, id?: unknown } | string | null
        if (message === 'posted') came.push('the posts of the other app')
        else if (event.source === parent && typeof message === 'object' && message?.dez === 'answer') {
          came.push(message.id === 907 ? 'the answer of Dez for the other app' : 'the answer of Dez')
        }
      }
      window.addEventListener('message', listen)
      // The other app gets `go` before Dez gets the call of this page, so
      // its posts come while the call waits for the answer of Dez.
      for (let index = 0; index < parent.length; index++) {
        if (parent[index] !== window) parent[index].postMessage('go', '*')
      }
      const got = await outcome(dez.sbp('dez.model/tabs/list'))
      for (let tries = 0; tries < 250 && came.length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 20))
      await new Promise((resolve) => setTimeout(resolve, 300))
      window.removeEventListener('message', listen)
      return { handlerRan, got, came }
    }))).toStrictEqual({ handlerRan: false, got: { refused }, came: ['the posts of the other app', 'the answer of Dez'] })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('puts a save of a shown app into the message that the user writes, as a stored file with a new id, and refuses a save that has no place', async () => {
    await openBoard('app-host-save')
    const before = await filesIn(imagesDir)
    const draft = (await threadSections(browser))[2].text
    expect(draft.endsWith(`\n${DROPPED_FILES_TEXT}`)).toBe(true)
    await runBoard()

    // Dez checks the bytes of a save before it writes a file: the type by
    // the first bytes, and the size.
    const bad = await inRunningApp(browser, 'board', () => browser.execute(async () => {
      const save = Reflect.get(window, 'save') as BoardCall<unknown>
      return [await save(new TextEncoder().encode('no image')), await save(new Blob([])), await save('a')]
    }))
    expect(bad).toStrictEqual([
      {
        refused: 'Dez saved nothing: the bytes are no file of a type that Dez stores. '
          + 'Dez reads the type from the first bytes, and it stores only these types '
          + '(an image: PNG, JPEG, GIF, WebP, or SVG; a clip: MP4, MOV, WebM, WAV, MP3, M4A, AAC, FLAC, or Ogg).',
      },
      { refused: 'Dez saved nothing: the save has no bytes.' },
      { refused: 'dez.app/saveAsset takes the bytes of one image or clip: a Blob, an ArrayBuffer, or a typed array, as in dez.sbp(\'dez.app/saveAsset\', blob). It got none of them.' },
    ])
    expect(await filesIn(imagesDir)).toStrictEqual(before)
    expect((await threadSections(browser))[2].text).toBe(draft)

    // A click of the user in the app saves. The file is a stored file, and
    // its reference is on a line of its own after the text of the message,
    // with the next id of the conversation.
    await clickBoardSave()
    await waitForValue(browser, 'the answer of the save', boardSaved, savedPng('d'))
    const first = await newFileIn(browser, imagesDir, before)
    expect(first).toMatch(storedFileName('png'))
    expect(fs.readFileSync(path.join(imagesDir, first)).equals(BOARD_PNG)).toBe(true)
    await waitForValue(browser, 'the message with the saved image', async () => (await threadSections(browser)).at(-1), {
      role: 'user',
      text: `${draft}\n![id=d](${path.join(imagesDir, first)})`,
    })
    // The editor draws no image that is far below the view.
    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the saved image in the editor', async () => {
      const shown = (await shownImages(browser)).at(-1)
      return { width: shown?.width, height: shown?.height }
    }, { width: 16, height: 16 })

    // While a reply runs, the last section is that reply: a save has no
    // message of the user to go into. The pointer is over the app, so the
    // user works in it.
    await browser.keys(Key.Escape)
    await waitForValue(browser, 'the focus after Escape', () => focusedArea(browser), 'editor')
    // The text has no capital letter: in a run of the whole file, WebDriver
    // types one as a small letter here.
    await submit(browser, ' and go on.')
    const request = await takeRequest(setup, CHAT_PATH)
    await clickBoardSave()
    await waitForValue(browser, 'the answer of the save in a reply', boardSaved, { refused: SAVE_NEEDS_DRAFT_TEXT })
    expect(await filesIn(imagesDir)).toStrictEqual([...before, first].sort())

    // After the reply, the save goes into the new message of the user.
    await sendChatReply(request.reply, CALLER.modelName)
    await endedReply(browser, 3)
    await clickBoardSave()
    await waitForValue(browser, 'the answer of the save after the reply', boardSaved, savedPng('e'))
    const second = await newFileIn(browser, imagesDir, [...before, first])
    expect(fs.readFileSync(path.join(imagesDir, second)).equals(BOARD_PNG)).toBe(true)
    await waitForValue(browser, 'the new message with the saved image', async () => (await threadSections(browser)).at(-1), {
      role: 'user',
      text: `![id=e](${path.join(imagesDir, second)})`,
    })
    expect((await threadSections(browser))[2].text).toBe(`${draft}\n![id=d](${path.join(imagesDir, first)}) and go on.`)
    expectNoLinkedFile([request], linkedDir)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The last test: its toasts stay open for some seconds.
  it('stops an app whose frame goes to another page, also while its page loads, and tells the user', async () => {
    const hopPoster: ShownAppCard = { app: 'hop', state: 'run', text: 'hop\nGoes away.' }
    await openSeededConversation(browser, setup.app.home, 'app-host-moves', [
      { role: 'user', text: 'Show me the apps.' },
      { role: 'agent', text: `${appTagText('notes')}\n\n${appTagText('hop')}` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'the posters', () => shownAppCards(browser), [NOTES_POSTER, hopPoster])
    const stopToastTitles = async (): Promise<string[]> => (await openToasts(browser, 'warning')).map((toast) => toast.title)
    await runNotes()

    // The page of another app: no guard of the webview stops this move.
    await inRunningApp(browser, 'notes', () => browser.execute(() => { location.href = '../timer/index.html' }))

    await waitForValue(browser, 'the frames after the move', () => shownAppFrames(browser), [])
    expect(await shownAppCards(browser)).toStrictEqual([NOTES_POSTER, hopPoster])
    expect(await stopToastTitles()).toStrictEqual(['Dez stopped the app notes'])
    expect(await focusedArea(browser)).toBe('editor')

    // A page that goes while it loads gives its frame only one load, that
    // of the other page. Dez's script in that page tells Dez where it is.
    await pointerClickAt(browser, await cardPoint('hop', 0, '.dez-app__run'))
    await waitForValue(browser, 'the toasts of the stopped apps', stopToastTitles, ['Dez stopped the app notes', 'Dez stopped the app hop'])
    expect(await shownAppFrames(browser)).toStrictEqual([])
    expect(await shownAppCards(browser)).toStrictEqual([NOTES_POSTER, hopPoster])
    expect(await focusedArea(browser)).toBe('editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
