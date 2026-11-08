import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, focusedArea } from './harness/thread'

// Markdown links in the thread editor, driven through the real app.
//
// A link that Dez can open (`http`, `https`, `mailto`, `tel`) shows only its
// text, as a link; its markup is hidden but stays in the doc. A caret or a
// selection that touches the link shows all its source again. Hovering a
// rendered link shows its full URL in a tooltip, and a plain click opens
// it with `dez.controller/openUrl` and leaves the caret and the focus where
// they are.
//
// The spec stops every `dez.controller/openUrl` call with an SBP filter and
// records its URL, so no real browser opens.
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

interface Point {
  x: number
  y: number
}

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

  async function caret (): Promise<number> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('caret: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return view.state.selection.main.head
    })
  }

  // Doc position of `text` plus `offset`; fails if `text` is not in the doc.
  async function docPos (text: string, offset = 0): Promise<number> {
    const index = await browser.execute((wanted: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('docPos: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return String(view.state.doc).indexOf(wanted)
    }, text)
    if (index < 0) throw new Error(`docPos: ${JSON.stringify(text)} is not in the doc`)
    return index + offset
  }

  // Puts the caret at doc position `pos`, as code does: the tests move it
  // with real keys from there.
  async function setCaret (pos: number): Promise<void> {
    await browser.execute((anchor: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('setCaret: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ selection: { anchor } })
    }, pos)
    await waitForValue(browser, `caret at ${pos}`, caret, pos)
  }

  // Viewport point at doc position `pos`: x is the caret position (`side`
  // picks the char before or after it), y the middle of its line.
  async function pointAt (pos: number, side: -1 | 1): Promise<Point> {
    return browser.execute((target: number, bias: -1 | 1) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('pointAt: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const coords = view.coordsAtPos(target, bias)
      if (!coords) throw new Error(`pointAt: no coords for ${target}`)
      return { x: coords.left, y: (coords.top + coords.bottom) / 2 }
    }, pos, side)
  }

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

  // The URLs that `dez.controller/openUrl` got since the last reset.
  async function openedUrls (): Promise<string[]> {
    return browser.execute(() => [...Reflect.get(window, '__e2eOpenedUrls') as string[]])
  }

  // Moves the mouse pointer to `point` (viewport px), with no button down.
  async function movePointer (point: Point): Promise<void> {
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
      .perform()
  }

  // Clicks at `point` (viewport px) with real pointer events.
  async function clickAt (point: Point): Promise<void> {
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })
      .down({ button: 0 })
      .up({ button: 0 })
      .perform()
  }

  // A point off the editor text, where no tooltip can open: the middle of
  // the tab bar.
  async function offTextPoint (): Promise<Point> {
    return browser.execute(() => {
      const bar = document.querySelector('header.tab-bar')
      if (!bar) throw new Error('offTextPoint: header.tab-bar not found')
      const box = bar.getBoundingClientRect()
      return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
    })
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
    await waitForValue(browser, `fixture ${id} open`, () => docPos(`\n${id}`).then(() => true, () => false), true)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    await waitForValue(browser, 'caret at the doc start', caret, 0)
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
    // A filter that returns false stops the selector call.
    await browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      const opened: string[] = []
      Reflect.set(window, '__e2eOpenedUrls', opened)
      sbp('sbp/filters/selector/add', 'dez.controller/openUrl', (_domain: string, _selector: string, data: unknown[]) => {
        opened.push(String(data[0]))
        return false
      })
    })
  })

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
    await browser.execute(() => {
      (Reflect.get(window, '__e2eOpenedUrls') as string[]).length = 0
    })
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
    expect(await docPos(TEXT)).toBeGreaterThanOrEqual(0)
    expect(await docPos(REPLY_SOURCE)).toBeGreaterThan(0)
  })

  it('shows the source of a link while the caret touches it and renders the link again when the caret leaves', async () => {
    await openFixture()
    const from = await docPos(DOCS_LINK)
    const to = from + DOCS_LINK.length
    // Only the touched link shows its source; the autolink on the same line
    // stays rendered.
    const docsSource = `Read ${DOCS_LINK} and https://example.org/a now.`

    await setCaret(from - 1)
    expect(await shownLine('Read')).toBe(READ_SHOWN)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'line with the caret at the link start', () => shownLine('Read'), docsSource)
    expect(await caret()).toBe(from)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line with the caret left of the link', () => shownLine('Read'), READ_SHOWN)

    await setCaret(to + 1)
    expect(await shownLine('Read')).toBe(READ_SHOWN)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line with the caret at the link end', () => shownLine('Read'), docsSource)
    expect(await caret()).toBe(to)
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'line with the caret right of the link', () => shownLine('Read'), READ_SHOWN)

    // An edit in the source shows in the link once the caret leaves it.
    await setCaret(from)
    await browser.keys(Key.ArrowRight)
    await typeKeys(browser, 'all ')
    await waitForValue(browser, 'line after typing in the link', () => shownLine('Read'), docsSource.replace('[the', '[all the'))
    for (let i = 0; i < 5; i++) await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret at the edited link start', caret, from)
    expect(await shownLine('Read')).toBe(docsSource.replace('[the', '[all the'))
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'line after the caret left the edited link', () => shownLine('Read'), 'Read all the docs and https://example.org/a now.')
  })

  it('shows the full URL in a tooltip above a rendered link while the pointer is on it', async () => {
    await openFixture()
    await movePointer(await offTextPoint())
    await waitForValue(browser, 'no tooltip', tooltip, null)

    // A link that shows its source gets no tooltip.
    const raw = await docPos('[file]', 2)
    await movePointer(await pointAt(raw, 1))
    await browser.pause(NO_TOOLTIP_WAIT_MS)
    expect(await tooltip()).toBeNull()

    const docs = await linkBox('the docs')
    await movePointer(docs)
    await waitForValue(browser, 'tooltip on the docs link', tooltipText, 'https://example.com/docs')
    expect((await tooltip())?.bottom).toBeLessThanOrEqual(docs.top + 1)
    await movePointer(await offTextPoint())
    await waitForValue(browser, 'tooltip after the pointer left', tooltip, null)

    // An email autolink opens as `mailto:`, so its tooltip says so.
    await movePointer(await linkBox('ann@example.com'))
    await waitForValue(browser, 'tooltip on the email link', tooltipText, 'mailto:ann@example.com')

    // The caret going into the link shows its source and closes the tooltip.
    const mail = await docPos('<ann@')
    await setCaret(mail - 1)
    expect(await tooltipText()).toBe('mailto:ann@example.com')
    await browser.keys(Key.ArrowRight)
    await waitForValue(browser, 'tooltip with the caret in the link', tooltip, null)
    expect(await shownLine('Mail')).toBe('Mail <ann@example.com> or call support.')
    await movePointer(await offTextPoint())
  })

  it('opens a rendered link on a plain click and keeps the caret and the focus where they are', async () => {
    await openFixture()
    await setCaret(3)

    await clickAt(await linkBox('the docs'))
    await waitForValue(browser, 'opened URLs', openedUrls, ['https://example.com/docs'])
    expect(await caret()).toBe(3)
    expect(await focusedArea(browser)).toBe('editor')
    expect(await renderedLinkTexts()).toEqual(RENDERED)

    await clickAt(await linkBox('ann@example.com'))
    await clickAt(await linkBox('support'))
    await clickAt(await linkBox('a reply link'))
    await waitForValue(browser, 'opened URLs', openedUrls, [
      'https://example.com/docs',
      'mailto:ann@example.com',
      'tel:+15551234',
      'https://example.com/reply',
    ])
    expect(await caret()).toBe(3)

    // A press on a link that is released off it opens nothing.
    const docs = await linkBox('the docs')
    const offLink = await pointAt(1, 1)
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(docs.x), y: Math.round(docs.y), origin: 'viewport' })
      .down({ button: 0 })
      .move({ x: Math.round(offLink.x), y: Math.round(offLink.y), origin: 'viewport' })
      .up({ button: 0 })
      .perform()
    // A click after it shows that the released press opened nothing.
    await clickAt(await linkBox('support'))
    await waitForValue(browser, 'opened URLs after a release off the link', async () => (await openedUrls()).length, 5)
    expect((await openedUrls()).at(-1)).toBe('tel:+15551234')
    expect(await caret()).toBe(3)

    // With the focus off the editor, a click opens the link and leaves the
    // focus off the editor.
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur()
    })
    expect(await focusedArea(browser)).toBe('body')
    await clickAt(await linkBox('the docs'))
    await waitForValue(browser, 'opened URLs after a click with no focus', async () => (await openedUrls()).length, 6)
    expect(await focusedArea(browser)).toBe('body')
  })

  it('leaves a Shift+click on a link to the editor, which selects into the link and shows its source', async () => {
    await openFixture()
    await setCaret(3)
    const docs = await linkBox('the docs')
    // One `actions` call, so Shift is down for the whole click.
    await browser.actions([
      browser.action('key').down(Key.Shift).pause(0).pause(0).pause(0).up(Key.Shift),
      browser.action('pointer', { parameters: { pointerType: 'mouse' } })
        .move({ x: Math.round(docs.x), y: Math.round(docs.y), origin: 'viewport' })
        .pause(0)
        .down({ button: 0 })
        .up({ button: 0 }),
    ])
    await waitForValue(browser, 'line after the Shift+click', () => shownLine('Read'), `Read ${DOCS_LINK} and https://example.org/a now.`)
    const selection = await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('selection: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { anchor, head } = view.state.selection.main
      return { anchor, head }
    })
    const from = await docPos(DOCS_LINK)
    expect(selection.anchor).toBe(3)
    expect(selection.head).toBeGreaterThan(from)
    expect(selection.head).toBeLessThan(from + DOCS_LINK.length)
    expect(await openedUrls()).toEqual([])
  })
})
