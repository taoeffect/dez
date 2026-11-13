import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { clearOpenedUrls, consoleErrors, elementCenter, movePointer, openedUrls, pointerClickAt, pointerShiftClickAt, resetConsoleErrors, screenshotOnFailure, stopOpenUrl, typeKeys, waitFor, waitForValue, type Point } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, docPosPoint, editorCaret, focusEditor, focusedArea, setCaret } from './harness/thread'

// Markdown links in the thread editor, driven through the real app.
//
// A link that Dez can open (`http`, `https`, `mailto`, `tel`) shows only its
// text, as a link; its markup is hidden but stays in the doc. A caret or a
// selection that touches the link shows all its source again. Hovering a
// rendered link shows its full URL in a tooltip, and a plain click opens
// it with `dez.controller/openUrl` and leaves the caret and the focus where
// they are.
//
// The spec stops every `dez.controller/openUrl` call (`stopOpenUrl`), so no
// real browser opens.
//
// One app session serves the whole file. Each test opens its fixture in a
// new tab, so no test depends on the edits of another.

const DOCS_LINK = '[the docs](https://example.com/docs "Docs")'
const READ_SOURCE = `Read ${DOCS_LINK} and <https://example.org/a> now.`
const READ_SHOWN = 'Read the docs and https://example.org/a now.'
const MAIL_SOURCE = 'Mail <ann@example.com> or call [support](tel:+15551234).'
const MAIL_SHOWN = 'Mail ann@example.com or call support.'
// Links whose destination Dez does not open (a `file:` URL, and a Dez image
// reference that lost its `!`) and a link in a code span stay source.
const RAW_SOURCE = 'Raw [file](file:///etc/hosts), [pic.png](id=a), and `[code](https://example.com/code)`.'
// A table row line never shows a link: hiding its markup would add a cell.
const TABLE_ROW = '| Ex | [row link](https://example.net/row) |'
const TEXT = ['Links fixture.', '', READ_SOURCE, MAIL_SOURCE, RAW_SOURCE, '', '| Site | Link |', '|------|------|', TABLE_ROW].join('\n')

const REPLY_SOURCE = 'Reply with [a reply link](https://example.com/reply).'
const REPLY_SHOWN = 'Reply with a reply link.'

// The text of every rendered link in TEXT and the reply, in doc order.
const RENDERED = ['the docs', 'https://example.org/a', 'ann@example.com', 'support', 'a reply link']

// CodeMirror opens a hover tooltip 300 ms after the pointer stops on its
// target (`hoverTime`). A check that no tooltip opens waits well past that.
const NO_TOOLTIP_WAIT_MS = 800

interface LinkBox extends Point {
  top: number
}

interface Tooltip {
  text: string
  bottom: number
}

let fixtureCount = 0

describe('markdown links', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // The text of each rendered link, in doc order.
  async function renderedLinkTexts (): Promise<string[]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll('.cm-content .dez-link')).map((link) => link.textContent ?? '')
    )
  }

  // The center and the top of the rendered link whose text is `text`.
  async function linkBox (text: string): Promise<LinkBox> {
    return browser.execute((wanted: string) => {
      const link = Array.from(document.querySelectorAll('.cm-content .dez-link')).find((el) => el.textContent === wanted)
      if (!link) throw new Error(`linkBox: no rendered link ${JSON.stringify(wanted)}`)
      const box = link.getBoundingClientRect()
      return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, top: box.top }
    }, text)
  }

  // The editor line as shown (hidden markup has no text) whose shown text
  // starts with `start`.
  async function shownLine (start: string): Promise<string> {
    return browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line'))
        .find((el) => (el.textContent ?? '').startsWith(wanted))
      if (!line) throw new Error(`shownLine: no line starts with ${JSON.stringify(wanted)}`)
      return line.textContent ?? ''
    }, start)
  }

  // The open link tooltip, or null when none is open.
  async function tooltip (): Promise<Tooltip | null> {
    return browser.execute(() => {
      const tip = document.querySelector('.cm-tooltip-hover .dez-link-tooltip')
      if (!tip) return null
      return { text: tip.textContent ?? '', bottom: tip.getBoundingClientRect().bottom }
    })
  }

  async function tooltipText (): Promise<string | null> {
    return (await tooltip())?.text ?? null
  }

  // A point off the editor text, where no tooltip can open: the middle of
  // the tab bar.
  async function offTextPoint (): Promise<Point> {
    return elementCenter(browser, 'header.tab-bar')
  }

  // Seeds TEXT as the user section and REPLY_SOURCE as the agent section of
  // a new conversation, opens it in a new tab, and puts the caret at the doc
  // start, which touches no link. The agent section ends with the fixture
  // id, so the wait cannot match an older tab's editor.
  async function openFixture (): Promise<void> {
    const id = `links-e2e-${++fixtureCount}`
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: TEXT }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `${REPLY_SOURCE}\n${id}` }] },
      ],
    }))
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, id)
    await waitForValue(browser, `fixture ${id} open`, () => docPos(browser, `\n${id}`).then(() => true, () => false), true)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    await waitForValue(browser, 'caret at the doc start', () => editorCaret(browser), 0)
    await waitForValue(browser, 'rendered links', renderedLinkTexts, RENDERED)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await stopOpenUrl(browser)
  })

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await clearOpenedUrls(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('shows openable links as their text and leaves the other links as source', async () => {
    await openFixture()

    expect(await shownLine('Read')).toBe(READ_SHOWN)
    expect(await shownLine('Mail')).toBe(MAIL_SHOWN)
    expect(await shownLine('Raw')).toBe(RAW_SOURCE)
    expect(await shownLine('Reply')).toBe(REPLY_SHOWN)
    // The table renders, and its row keeps the link source.
    const row = await browser.execute((wanted: string) => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line')).find((el) => el.textContent === wanted)
      return { inTable: Boolean(line?.closest('.dez-table')), links: line?.querySelectorAll('.dez-link').length ?? -1 }
    }, TABLE_ROW)
    expect(row).toEqual({ inTable: true, links: 0 })
    // The doc keeps every link's source.
    expect(await docPos(browser, TEXT)).toBeGreaterThanOrEqual(0)
    expect(await docPos(browser, REPLY_SOURCE)).toBeGreaterThan(0)
  })

  it('shows the source of a link while the caret touches it and renders the link again when the caret leaves', async () => {
    await openFixture()
    const from = await docPos(browser, DOCS_LINK)
    const to = from + DOCS_LINK.length
    // Only the touched link shows its source; the autolink on the same line
    // stays rendered.
    const docsSource = `Read ${DOCS_LINK} and https://example.org/a now.`

    await setCaret(browser, from - 1)
    expect(await shownLine('Read')).toBe(READ_SHOWN)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'line with the caret at the link start', () => shownLine('Read'), docsSource)
    expect(await editorCaret(browser)).toBe(from)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line with the caret left of the link', () => shownLine('Read'), READ_SHOWN)

    await setCaret(browser, to + 1)
    expect(await shownLine('Read')).toBe(READ_SHOWN)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line with the caret at the link end', () => shownLine('Read'), docsSource)
    expect(await editorCaret(browser)).toBe(to)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'line with the caret right of the link', () => shownLine('Read'), READ_SHOWN)

    // An edit in the source shows in the link once the caret leaves it.
    await setCaret(browser, from)
    await browser.keys(Key.ArrowRight)
    await typeKeys(browser, 'all ')
    await waitForValue(browser, 'line after typing in the link', () => shownLine('Read'), docsSource.replace('[the', '[all the'))
    for (let i = 0; i < 5; i++) await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret at the edited link start', () => editorCaret(browser), from)
    expect(await shownLine('Read')).toBe(docsSource.replace('[the', '[all the'))
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line after the caret left the edited link', () => shownLine('Read'), 'Read all the docs and https://example.org/a now.')
  })

  it('shows the full URL in a tooltip above a rendered link while the pointer is on it', async () => {
    await openFixture()
    await movePointer(browser, await offTextPoint())
    await waitForValue(browser, 'no tooltip', tooltip, null)

    // A link that shows its source gets no tooltip.
    const raw = await docPos(browser, '[file]', 2)
    await movePointer(browser, await docPosPoint(browser, raw, 1))
    await browser.pause(NO_TOOLTIP_WAIT_MS)
    expect(await tooltip()).toBeNull()

    const docs = await linkBox('the docs')
    await movePointer(browser, docs)
    await waitForValue(browser, 'tooltip on the docs link', tooltipText, 'https://example.com/docs')
    expect((await tooltip())?.bottom).toBeLessThanOrEqual(docs.top + 1)
    await movePointer(browser, await offTextPoint())
    await waitForValue(browser, 'tooltip after the pointer left', tooltip, null)

    // An email autolink opens as `mailto:`, so its tooltip says so.
    await movePointer(browser, await linkBox('ann@example.com'))
    await waitForValue(browser, 'tooltip on the email link', tooltipText, 'mailto:ann@example.com')

    // The caret going into the link shows its source and closes the tooltip.
    const mail = await docPos(browser, '<ann@')
    await setCaret(browser, mail - 1)
    expect(await tooltipText()).toBe('mailto:ann@example.com')
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'tooltip with the caret in the link', tooltip, null)
    expect(await shownLine('Mail')).toBe('Mail <ann@example.com> or call support.')
    await movePointer(browser, await offTextPoint())
  })

  it('opens a rendered link on a plain click and keeps the caret and the focus where they are', async () => {
    await openFixture()
    await setCaret(browser, 3)

    await pointerClickAt(browser, await linkBox('the docs'))
    await waitForValue(browser, 'opened URLs', () => openedUrls(browser), ['https://example.com/docs'])
    expect(await editorCaret(browser)).toBe(3)
    expect(await focusedArea(browser)).toBe('editor')
    expect(await renderedLinkTexts()).toEqual(RENDERED)

    await pointerClickAt(browser, await linkBox('ann@example.com'))
    await pointerClickAt(browser, await linkBox('support'))
    await pointerClickAt(browser, await linkBox('a reply link'))
    await waitForValue(browser, 'opened URLs', () => openedUrls(browser), [
      'https://example.com/docs',
      'mailto:ann@example.com',
      'tel:+15551234',
      'https://example.com/reply',
    ])
    expect(await editorCaret(browser)).toBe(3)

    // A press on a link that is released off it opens nothing.
    const docs = await linkBox('the docs')
    const offLink = await docPosPoint(browser, 1, 1)
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(docs.x), y: Math.round(docs.y), origin: 'viewport' })
      .down({ button: 0 })
      .move({ x: Math.round(offLink.x), y: Math.round(offLink.y), origin: 'viewport' })
      .up({ button: 0 })
      .perform()
    // A click after it shows that the released press opened nothing.
    await pointerClickAt(browser, await linkBox('support'))
    await waitForValue(browser, 'opened URLs after a release off the link', async () => (await openedUrls(browser)).length, 5)
    expect((await openedUrls(browser)).at(-1)).toBe('tel:+15551234')
    expect(await editorCaret(browser)).toBe(3)

    // With the focus off the editor, a click opens the link and leaves the
    // focus off the editor.
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur()
    })
    expect(await focusedArea(browser)).toBe('body')
    await pointerClickAt(browser, await linkBox('the docs'))
    await waitForValue(browser, 'opened URLs after a click with no focus', async () => (await openedUrls(browser)).length, 6)
    expect(await focusedArea(browser)).toBe('body')
  })

  it('leaves a Shift+click on a link to the editor, which selects into the link and shows its source', async () => {
    await openFixture()
    await setCaret(browser, 3)
    await pointerShiftClickAt(browser, await linkBox('the docs'))
    await waitForValue(browser, 'line after the Shift+click', () => shownLine('Read'), `Read ${DOCS_LINK} and https://example.org/a now.`)
    const selection = await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('selection: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { anchor, head } = view.state.selection.main
      return { anchor, head }
    })
    const from = await docPos(browser, DOCS_LINK)
    expect(selection.anchor).toBe(3)
    expect(selection.head).toBeGreaterThan(from)
    expect(selection.head).toBeLessThan(from + DOCS_LINK.length)
    expect(await openedUrls(browser)).toEqual([])
  })
})
