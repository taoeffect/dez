import fs from 'node:fs'
import path from 'node:path'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor } from './harness/thread'

// A click that gives the editor its focus again must keep the scroll that
// the user chose (`focusKeepingScroll` in src/view/editor/focus.ts).
//
// The macOS report: in a long doc, select upward from the bottom, drag the
// scrollbar thumb to the top, Shift-click near the top. The view jumped
// back to the bottom, and the selection ran to a line there. The press on
// the scrollbar moves the focus to `.cm-scroller`, so the Shift-click must
// focus the editor again. In WebKit that focus scrolls to the old DOM
// selection even with `preventScroll`. CodeMirror puts the scroll back
// after its focus only when the user agent has `Version/26` or more.
// WebKitGTK sends `Version/60.5`, so on Linux CodeMirror puts it back;
// macOS WKWebView sends no `Version/`, so there the jump stays.
//
// To get the macOS result here, each test replaces `focus()` of the
// editor's content element in the page: it calls the real focus (which
// does scroll in WebKitGTK too) and, when that focus scrolled, drops the
// next `scrollTop` write in the same task. That write is CodeMirror's own
// put-back, so the jump stays, as on macOS. A put-back that Dez does after
// CodeMirror's is the second write, so it still applies. The tests also
// check that the real focus scrolled, so a WebKit that stops scrolling
// cannot make them pass without a check.
//
// The wheel test is the control: a wheel scroll keeps the focus in the
// editor, so the Shift-click does not focus it again.
//
// Clicks, drags, the scrollbar drag, and the wheel are real WebDriver
// input. Page code reads the CodeMirror view only to find click points and
// to check the selection and the scroll.

// CodeMirror lines of the selection that the drag makes near the doc end,
// and of the clicks near the doc start.
const DRAG_FROM_LINE = 297
const DRAG_TO_LINE = 285
const CLICK_LINE = 5

const LONG_TEXT = Array.from({ length: 300 }, (_, i) => `Line ${i} with some words to make it a bit longer.`).join('\n')

interface Point {
  x: number
  y: number
}

interface EditorSnapshot {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  hasFocus: boolean
  scrollerHasFocus: boolean
  anchorLine: number
  headLine: number
  empty: boolean
}

// GTK draws overlay scrollbars unless `overlay-scrolling` is off. The app's
// HOME is the harness temp dir, so the setting goes in a GSettings keyfile
// (GTK reads GSettings on Wayland) and in settings.ini (X11 with no
// XSETTINGS manager, as under xvfb-run); see settings-scrollbars.e2e.ts.
function seedOverlayScrolling (home: string, overlay: boolean): void {
  const gsettingsDir = path.join(home, '.config', 'glib-2.0', 'settings')
  fs.mkdirSync(gsettingsDir, { recursive: true })
  fs.writeFileSync(path.join(gsettingsDir, 'keyfile'), `[org/gnome/desktop/interface]\noverlay-scrolling=${overlay}\n`)
  const gtkDir = path.join(home, '.config', 'gtk-3.0')
  fs.mkdirSync(gtkDir, { recursive: true })
  fs.writeFileSync(path.join(gtkDir, 'settings.ini'), `[Settings]\ngtk-overlay-scrolling=${overlay}\n`)
}

describe.each([
  { scrollbars: 'overlay', overlay: true },
  { scrollbars: 'classic', overlay: false },
])('Selection and scroll after the editor loses its focus ($scrollbars scrollbars)', ({ overlay }) => {
  let app: RunningApp
  let browser: E2EBrowser
  let fixtureCount = 0

  async function snapshot (): Promise<EditorSnapshot> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('snapshot: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { doc, selection } = view.state
      const scroller = view.scrollDOM
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        hasFocus: view.hasFocus,
        scrollerHasFocus: document.activeElement === scroller,
        anchorLine: doc.lineAt(selection.main.anchor).number,
        headLine: doc.lineAt(selection.main.head).number,
        empty: selection.main.empty,
      }
    })
  }

  async function lineCenter (lineNumber: number): Promise<Point> {
    return browser.execute((n: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineCenter: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const coords = view.coordsAtPos(view.state.doc.line(n).from + 10, 1)
      if (!coords) throw new Error(`lineCenter: line ${n} is not drawn`)
      return { x: Math.round(coords.left), y: Math.round((coords.top + coords.bottom) / 2) }
    }, lineNumber)
  }

  // The scroll changes of the real `focus()` calls since the emulation was
  // put in (see the file comment).
  async function focusScrolls (): Promise<number[]> {
    return browser.execute(() => Reflect.get(window, '__e2eFocusScrolls') as number[])
  }

  // Seed a long user section, open it in a new tab, and put the caret at
  // the doc end, which scrolls the lines of the drag into view. The agent
  // section ends with the fixture id, so the wait cannot match an older
  // tab's editor.
  async function openLongFixture (): Promise<void> {
    const id = `selection-scroll-e2e-${++fixtureCount}`
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: LONG_TEXT }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `Reply.\n${id}` }] },
      ],
    }))
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, id)
    await waitForValue(browser, `fixture ${id} open`, () => browser.execute((suffix: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) return false
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return view.state.doc.toString().endsWith(suffix)
    }, `\n${id}`), true)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await waitForValue(browser, 'drag lines in view', () => browser.execute((lines: number[]) => {
      const content = document.querySelector('.cm-content')
      if (!content) return false
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const box = view.scrollDOM.getBoundingClientRect()
      return lines.every((n) => {
        const coords = view.coordsAtPos(view.state.doc.line(n).from)
        return coords !== null && coords.top >= box.top && coords.bottom <= box.bottom
      })
    }, [DRAG_TO_LINE, DRAG_FROM_LINE]), true)
  }

  // See the file comment: make the editor's focus keep its scroll jump, as
  // CodeMirror's focus does in macOS WKWebView.
  async function emulateMacFocus (): Promise<void> {
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')
      if (!content || !scroller) throw new Error('emulateMacFocus: editor not found')
      const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
      if (!scrollTop?.get || !scrollTop.set) throw new Error('emulateMacFocus: no scrollTop accessor')
      const { get: readScrollTop, set: writeScrollTop } = scrollTop
      const focusScrolls: number[] = []
      Reflect.set(window, '__e2eFocusScrolls', focusScrolls)
      let dropNextWrite = false
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get () { return readScrollTop.call(scroller) },
        set (value: number) {
          if (dropNextWrite) {
            dropNextWrite = false
            return
          }
          writeScrollTop.call(scroller, value)
        },
      })
      const realFocus = HTMLElement.prototype.focus
      content.focus = (options?: FocusOptions) => {
        const before = readScrollTop.call(scroller)
        realFocus.call(content, options)
        const after = readScrollTop.call(scroller)
        if (after === before) return
        focusScrolls.push(after - before)
        dropNextWrite = true
        setTimeout(() => { dropNextWrite = false })
      }
    })
  }

  // Drag-select upward from near the doc end.
  async function selectUpwardFromBottom (): Promise<void> {
    const from = await lineCenter(DRAG_FROM_LINE)
    const to = await lineCenter(DRAG_TO_LINE)
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: from.x, y: from.y, origin: 'viewport' })
      .down({ button: 0 })
      .move({ x: to.x, y: to.y, origin: 'viewport', duration: 200 })
      .up({ button: 0 })
      .perform()
    await waitForValue(browser, 'selection from the drag', async () => {
      const { anchorLine, headLine } = await snapshot()
      return { anchorLine, headLine }
    }, { anchorLine: DRAG_FROM_LINE, headLine: DRAG_TO_LINE })
  }

  // Press the scrollbar thumb and drag it past the top of the scroller.
  // An overlay scrollbar takes no layout width and shows when the pointer
  // comes near, so the press is at the right edge of the padding box after
  // a hover; a classic scrollbar is outside the padding box.
  async function dragScrollbarToTop (): Promise<void> {
    const bar = await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')
      if (!scroller) throw new Error('dragScrollbarToTop: .cm-scroller not found')
      const rect = scroller.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        right: rect.right,
        paddingBoxRight: rect.left + scroller.clientLeft + scroller.clientWidth,
        barWidth: scroller.offsetWidth - scroller.clientWidth,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      }
    })
    const x = Math.round(bar.barWidth > 0 ? bar.right - bar.barWidth / 2 : bar.paddingBoxRight - 5)
    const track = bar.bottom - bar.top
    const thumb = Math.max(track * bar.clientHeight / bar.scrollHeight, 30)
    const thumbTop = bar.top + (track - thumb) * bar.scrollTop / (bar.scrollHeight - bar.clientHeight)
    const y = Math.round(thumbTop + thumb / 2)
    await browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: x - 30, y, origin: 'viewport' })
      .move({ x, y, origin: 'viewport', duration: 200 })
      .pause(400)
      .down({ button: 0 })
      .move({ x, y: Math.round(bar.top - 40), origin: 'viewport', duration: 400 })
      .up({ button: 0 })
      .perform()
    await waitForValue(browser, 'view at the doc start', async () => (await snapshot()).scrollTop, 0)
  }

  async function wheelToTop (): Promise<void> {
    const { scrollHeight } = await snapshot()
    const at = await lineCenter(DRAG_TO_LINE)
    await browser.action('wheel')
      .scroll({ x: at.x, y: at.y, deltaY: -scrollHeight, duration: 200 })
      .perform()
    await waitForValue(browser, 'view at the doc start', async () => (await snapshot()).scrollTop, 0)
  }

  async function clickLine (lineNumber: number, shift: boolean): Promise<void> {
    const at = await lineCenter(lineNumber)
    const pointer = browser.action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: at.x, y: at.y, origin: 'viewport' })
      .down({ button: 0 })
      .up({ button: 0 })
    if (!shift) {
      await pointer.perform()
      return
    }
    // Key and pointer sources run tick by tick: the pauses hold Shift down
    // through the move, press, and release.
    await browser.actions([
      browser.action('key').down(Key.Shift).pause(50).pause(50).pause(50).up(Key.Shift),
      pointer.pause(50),
    ])
  }

  beforeAll(async () => {
    app = await startApp({ env: { GSETTINGS_BACKEND: 'keyfile' } })
    try {
      seedOverlayScrolling(app.home, overlay)
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
  beforeEach(async () => {
    await resetConsoleErrors(browser)
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

  it('a Shift-click after a scrollbar drag extends the selection where the user clicks', async () => {
    await openLongFixture()
    await emulateMacFocus()
    await selectUpwardFromBottom()
    await dragScrollbarToTop()
    // The press on the scrollbar took the focus from the editor.
    expect(await snapshot()).toMatchObject({ hasFocus: false, scrollerHasFocus: true })

    await clickLine(CLICK_LINE, true)
    await waitForValue(browser, 'selection after the Shift-click', async () => {
      const { anchorLine, headLine } = await snapshot()
      return { anchorLine, headLine }
    }, { anchorLine: DRAG_FROM_LINE, headLine: CLICK_LINE })
    expect(await snapshot()).toMatchObject({ scrollTop: 0, hasFocus: true })
    // The real focus scrolled down to the old selection.
    expect((await focusScrolls()).some((change) => change > 0)).toBe(true)
  })

  it('a click after a scrollbar drag puts the caret where the user clicks', async () => {
    await openLongFixture()
    await emulateMacFocus()
    await selectUpwardFromBottom()
    await dragScrollbarToTop()
    expect(await snapshot()).toMatchObject({ hasFocus: false, scrollerHasFocus: true })

    await clickLine(CLICK_LINE, false)
    await waitForValue(browser, 'caret after the click', async () => {
      const { anchorLine, headLine, empty } = await snapshot()
      return { anchorLine, headLine, empty }
    }, { anchorLine: CLICK_LINE, headLine: CLICK_LINE, empty: true })
    expect(await snapshot()).toMatchObject({ scrollTop: 0, hasFocus: true })
    expect((await focusScrolls()).some((change) => change > 0)).toBe(true)
  })

  it('a Shift-click after a wheel scroll extends the selection where the user clicks', async () => {
    await openLongFixture()
    await emulateMacFocus()
    await selectUpwardFromBottom()
    await wheelToTop()
    // The wheel does not move the focus, so the click needs no focus.
    expect(await snapshot()).toMatchObject({ hasFocus: true, scrollerHasFocus: false })

    await clickLine(CLICK_LINE, true)
    await waitForValue(browser, 'selection after the Shift-click', async () => {
      const { anchorLine, headLine } = await snapshot()
      return { anchorLine, headLine }
    }, { anchorLine: DRAG_FROM_LINE, headLine: CLICK_LINE })
    expect(await snapshot()).toMatchObject({ scrollTop: 0, hasFocus: true })
    expect(await focusScrolls()).toEqual([])
  })
})
