import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { appTagText } from '../../src/model/chat/appTags'
import { inRunningApp, runningAppPoint, seedApp, shownAppCards, shownAppFrames, type ShownAppCard } from './harness/apps'
import { consoleErrors, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, typeKeys, waitFor, waitForValue } from './harness/dom'
import { appFilePath } from './harness/fixtures'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import {
  activeTabId,
  editorDoc,
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
// - an app whose frame goes to another page is stopped.
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

const RUN = '.cm-content .dez-app[data-app="notes"] .dez-app__run'
const FRAME = '.cm-scroller > .dez-app-frame[data-app="notes"] iframe'
const STOP = '.cm-scroller > .dez-app-frame[data-app="notes"] .dez-app-frame__stop'

// What a test reads of the page of `notes`; each part is null while the
// page loads.
interface NotesPage {
  load: string | null
  text: string | null
  ownEscape: string | null
}

describe('apps in a conversation', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

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

  beforeAll(async () => {
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    const appsDir = appFilePath(setup.app.home, 'apps')
    await seedApp(appsDir, { name: 'notes', description: 'Keeps notes.', kind: 'ui' }, NOTES_FILES)
    await seedApp(appsDir, { name: 'timer', description: 'Counts down.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>Timer</p>\n' })
    await seedApp(appsDir, { name: 'sum', description: 'Adds numbers.', kind: 'script' }, { 'main.ts': 'export default () => 1\n' })
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
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
    // The editor draws no card that is far below the view.
    await scrollEditorToEnd(browser)
    await waitForValue(browser, 'the last poster', async () => (await cards()).at(-1), { app: 'gone', state: 'note' })
    // No app runs before its Run.
    expect(await shownAppFrames(browser)).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs an app in a frame over its card, gives it the keyboard, and takes both back', async () => {
    await openNotes('app-host-run')
    await focusEditor(browser)
    const { run } = await runNotes()

    // The frame covers the card, which is an empty placeholder now.
    expect(await shownAppCards(browser)).toStrictEqual([{ app: 'notes', state: 'running', text: '' }])
    expect(await framesInPlace()).toStrictEqual([{ app: 'notes', run, inPlace: true }])

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
    await openNotes('app-host-stays', Array.from({ length: 300 }, (_, index) => `Line ${index + 1}`).join('\n'))
    await pickModel(browser, CALLER.name, CALLER.modelName)
    const { run, page: loaded } = await runNotes()
    await enterNotesText()
    await typeKeys(browser, 'abc')
    const page: NotesPage = { ...loaded, text: 'abc' }
    await waitForValue(browser, 'the page of the app', notesPage, page)
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

  // The last test: its toast stays open for some seconds.
  it('stops an app whose frame goes to another page, and tells the user', async () => {
    await openNotes('app-host-moves')
    await runNotes()

    // The page of another app: no guard of the webview stops this move.
    await inRunningApp(browser, 'notes', () => browser.execute(() => { location.href = '../timer/index.html' }))

    await waitForValue(browser, 'the frames after the move', () => shownAppFrames(browser), [])
    expect(await shownAppCards(browser)).toStrictEqual([NOTES_POSTER])
    expect((await openToasts(browser, 'warning')).map((toast) => toast.title)).toStrictEqual(['Dez stopped the app notes'])
    expect(await focusedArea(browser)).toBe('editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
