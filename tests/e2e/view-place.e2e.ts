import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import type { SectionData, StoredViewPlace } from '../../src/model/persistence/types'
import { startApp, type RunningApp } from './harness/app'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { appFilePath, makeConversation, readAppState, seedAppState, seedConversation, writeTestFile } from './harness/fixtures'
import { shownImages, solidPng } from './harness/images'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeConversationId, editorDoc, focusEditor, sbpCall, setCaret, viewPlace, type ViewPlace } from './harness/thread'

// The view place of the active tab after a restart of Dez: the line at the
// top edge of the view, the px of that edge into its line, and the caret
// come back from `app_state.json` (`dez.model/viewPlace/*`,
// `src/view/editor/viewPlace.ts`). A restart ends the session, which kills
// the app: no code of Dez runs at that quit, as at a crash.
//
// The console record starts after the page loads, so an error of the start
// itself is not in it; the place that the start shows, and the place that
// it then writes, tell that the start went well.

const TALL_HEIGHT = 2000
const TALL_PNG = solidPng(40, TALL_HEIGHT, [40, 90, 220])

// One user message of `lines` lines, and its reply.
function longText (name: string, lines: number): SectionData[] {
  const text = Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}`).join('\n')
  return [
    { role: 'user', nodes: [{ kind: 'text', text }] },
    { role: 'agent', nodes: [{ kind: 'text', text: 'Reply.' }] },
  ]
}

// Scrolls the view so that its top edge is `offset` px below the top of the
// line block at `pos`, as a scroll of the user does: with a wheel event,
// then a scroll event. The view keeps the place that a start showed until
// an input of the user, and a write of the scrollTop alone is none.
async function scrollTo (browser: E2EBrowser, pos: number, offset: number): Promise<void> {
  await browser.execute((at: number, down: number) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('scrollTo: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    view.scrollDOM.scrollTop += view.lineBlockAt(at).top + down - top
  }, pos, offset)
}

// The doc position of the start of the line that starts with `text`.
async function lineStart (browser: E2EBrowser, text: string): Promise<number> {
  const at = (await editorDoc(browser)).indexOf(`\n${text}`)
  if (at < 0) throw new Error(`lineStart: no line ${text}`)
  return at + 1
}

// The height of the line block at `pos`, read two frames after the last
// change, with CodeMirror's due measure done first (`lineBlockAtHeight`).
async function blockHeight (browser: E2EBrowser, pos: number): Promise<number> {
  return browser.execute((at: number) => new Promise<number>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const content = document.querySelector('.cm-content')
      if (!content) {
        reject(new Error('blockHeight: .cm-content not found'))
        return
      }
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.lineBlockAtHeight(0)
      resolve(view.lineBlockAt(at).height)
    }))
  }), pos)
}

// The place in `app_state.json`, without its offset, which a check reads
// with a margin.
async function storedPlace (home: string): Promise<Omit<StoredViewPlace, 'offset'> | null> {
  const place = (await readAppState(home))?.viewPlace
  if (!place) return null
  const { conversationId, pos, anchor, head } = place
  return { conversationId, pos, anchor, head }
}

describe('view place after a restart', () => {
  let app: RunningApp
  let browser: E2EBrowser | undefined

  function session (): E2EBrowser {
    if (!browser) throw new Error('No e2e session: the restart failed')
    return browser
  }

  // Ends the session (which kills the app) and starts the app again on the
  // same HOME. `whileDown` runs while no app runs.
  async function restart (whileDown?: () => Promise<void>): Promise<E2EBrowser> {
    await destroySession(browser)
    browser = undefined
    await whileDown?.()
    const next = await createSession(app.binary, app.port)
    browser = next
    await waitFor(next, 'header.tab-bar', 60_000)
    await resetConsoleErrors(next)
    return next
  }

  // Scrolls to `offset` px into the line that starts with `line`, puts the
  // caret `caretLine` lines below it, and waits until `app_state.json` holds
  // that place. Gives the place.
  async function leavePlace (conversationId: string, line: string, offset: number, caretLine: string): Promise<ViewPlace> {
    const b = session()
    await scrollTo(b, await lineStart(b, line), offset)
    const caret = await lineStart(b, caretLine) + 3
    await setCaret(b, caret)
    const place = await viewPlace(b)
    expect(place.offset, 'the top edge is inside a line').toBeGreaterThan(2)
    expect(place).toMatchObject({ anchor: caret, head: caret })
    await waitForValue(b, 'stored place', () => storedPlace(app.home), { conversationId, pos: place.pos, anchor: caret, head: caret })
    expect((await readAppState(app.home))?.viewPlace?.offset).toBeCloseTo(place.offset, 0)
    return place
  }

  // After a restart, the view of `conversationId` shows `place`, its offset
  // within 1 px.
  async function expectPlace (conversationId: string, place: ViewPlace): Promise<void> {
    const b = session()
    await waitForValue(b, 'active conversation', () => activeConversationId(b), conversationId)
    const { pos, anchor, head } = place
    let shown = place
    await waitForValue(b, 'place after the restart', async () => {
      shown = await viewPlace(b)
      return { pos: shown.pos, anchor: shown.anchor, head: shown.head }
    }, { pos, anchor, head })
    expect(Math.abs(shown.offset - place.offset), `offset ${shown.offset}, was ${place.offset}`).toBeLessThanOrEqual(1)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedConversation(app.home, makeConversation({ id: 'conv-a', title: 'A', sections: longText('A', 200) }))
      await seedConversation(app.home, makeConversation({ id: 'conv-b', title: 'B', sections: longText('B', 200) }))
      const image = await writeTestFile(appFilePath(app.home, 'assets', 'images', 'tall.png'), TALL_PNG)
      const lines = (from: number) => Array.from({ length: 40 }, (_, i) => `I line ${from + i}`).join('\n')
      await seedConversation(app.home, makeConversation({
        id: 'conv-image',
        title: 'Image',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: `${lines(1)}\n![id=a](${image})\n${lines(41)}` }] },
          { role: 'agent', nodes: [{ kind: 'text', text: 'Reply.' }] },
        ],
      }))
      await seedAppState(app.home, {
        tabs: [
          { id: 'tab-a', title: 'A', conversationId: 'conv-a', activeModel: null, createdAt: Date.now() },
          { id: 'tab-b', title: 'B', conversationId: 'conv-b', activeModel: null, createdAt: Date.now() },
        ],
        activeTabId: 'tab-a',
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(session(), 'header.tab-bar', 60_000)
    await waitForValue(session(), 'tab A active', () => activeConversationId(session()), 'conv-a')
  })

  beforeEach(async () => {
    await resetConsoleErrors(session())
  })

  afterEach(async (ctx) => {
    if (!browser) return
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('shows the active tab at its line, its px into that line, and its caret', async () => {
    const place = await leavePlace('conv-a', 'A line 120', 7, 'A line 125')
    await restart()
    await expectPlace('conv-a', place)
  })

  it('keeps the place of the tab that is active at the quit', async () => {
    await leavePlace('conv-a', 'A line 40', 5, 'A line 44')
    await click(session(), '.tab-strip > .tab:nth-child(2)')
    await waitForValue(session(), 'tab B active', () => activeConversationId(session()), 'conv-b')
    const place = await leavePlace('conv-b', 'B line 150', 9, 'B line 152')
    await restart()
    await expectPlace('conv-b', place)
  })

  it('keeps the place when the top edge of the view is inside an image', async () => {
    const b = session()
    await sbpCall(b, 'dez.model/tabs/openConversation', 'conv-image')
    await waitForValue(b, 'image tab active', () => activeConversationId(b), 'conv-image')
    const imageLine = await lineStart(b, '![id=a]')
    // CodeMirror draws only the lines near the view.
    await scrollTo(b, imageLine, 0)
    await waitForValue(b, 'image loaded', async () => (await shownImages(b)).map(({ height }) => height), [TALL_HEIGHT])
    // The load and the measure of its new height are in different frames.
    await waitForValue(b, 'image line measured', async () => await blockHeight(b, imageLine) > 300, true)
    await scrollTo(b, imageLine, 150)
    const caret = await lineStart(b, 'I line 45') + 2
    await setCaret(b, caret)
    const place = await viewPlace(b)
    expect(place).toMatchObject({ pos: imageLine, anchor: caret, head: caret })
    expect(place.offset).toBeGreaterThan(140)
    await waitForValue(b, 'stored place', () => storedPlace(app.home), { conversationId: 'conv-image', pos: imageLine, anchor: caret, head: caret })

    const next = await restart()
    await waitForValue(next, 'image loaded after the restart', async () => (await shownImages(next)).map(({ height }) => height), [TALL_HEIGHT])
    await expectPlace('conv-image', place)
    // The place that the start shows is also the one that it writes.
    await waitForValue(next, 'stored place after the restart', () => storedPlace(app.home), { conversationId: 'conv-image', pos: imageLine, anchor: caret, head: caret })
  })

  it('keeps a stored place that is past the end of the doc within the doc', async () => {
    let conversationId = ''
    const b = await restart(async () => {
      const state = await readAppState(app.home)
      if (!state?.viewPlace) throw new Error('app_state.json has no view place')
      conversationId = state.viewPlace.conversationId
      await seedAppState(app.home, { ...state, viewPlace: { conversationId, pos: 999_999, offset: 12, anchor: 999_999, head: 999_998 } })
    })
    await waitForValue(b, 'active conversation', () => activeConversationId(b), conversationId)
    // The doc of the boot tab, before the start shows the restored tab, has
    // its caret at its end too.
    await waitForValue(b, 'doc of the restored tab', async () => (await editorDoc(b)).includes('Reply.'), true)
    const length = (await editorDoc(b)).length
    await waitForValue(b, 'caret at the doc end', async () => {
      const { anchor, head } = await viewPlace(b)
      return { anchor, head }
    }, { anchor: length, head: length })
    expect((await viewPlace(b)).fromBottom).toBeLessThanOrEqual(1)
    await waitForValue(b, 'stored place within the doc', async () => {
      const place = await storedPlace(app.home)
      return place && { anchor: place.anchor, head: place.head }
    }, { anchor: length, head: length })
  })

  // The editor gets its last height only after the start shows the place
  // (the parts of the window around it get their sizes). A place near the
  // doc end that the first height cannot reach must come back after that.
  it('shows a view at the doc end at the doc end again', async () => {
    const b = session()
    const conversationId = await activeConversationId(b)
    await focusEditor(b)
    await b.keys([Key.Control, Key.End])
    const length = (await editorDoc(b)).length
    const place = await viewPlace(b)
    expect(place).toMatchObject({ anchor: length, head: length })
    await waitForValue(b, 'stored place', () => storedPlace(app.home), { conversationId, pos: place.pos, anchor: length, head: length })
    expect((await readAppState(app.home))?.viewPlace?.offset).toBeCloseTo(place.offset, 0)
    const below = (await viewPlace(b)).fromBottom
    await restart()
    await expectPlace(conversationId, place)
    expect(Math.abs((await viewPlace(session())).fromBottom - below)).toBeLessThanOrEqual(1)
  })
})
