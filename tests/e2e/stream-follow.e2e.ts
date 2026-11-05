import type http from 'node:http'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedConversation, seedRawAppState } from './harness/fixtures'
import { mockChatPath, mockProviderConfig, startChatMock, startEventStream, writeChatFrame, type MockProvider, type MockServer } from './harness/mockServer'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeTabStreaming, openErrorToasts, pickModel, sbpCall, submit, threadSections } from './harness/thread'

// How the thread editor scrolls while a reply streams, driven through the
// real app against a mock server in this process:
// - when a reply starts, the view goes to the bottom and follows the reply,
//   wherever the view was;
// - a scroll up by the user stops the follow: the reply streams on, and the
//   view stays where the user put it, also when the reply ends;
// - a scroll back to the very bottom starts the follow again.
//
// The mock holds each reply open, and the test sends each part of it, so a
// check runs between two parts. The scrolls are `scrollTop` changes, which
// fire the same scroll events as a wheel or the scrollbar.
//
// One app session and one tab serve the whole file. The tests run in order:
// each adds a reply to the conversation of the one before.

const PROVIDER: MockProvider = { id: 'follow', name: 'Follow Mock', modelId: 'follow-model', modelName: 'Follow Model' }
const CONVERSATION_ID = 'long-thread'

/** What a view at its bottom may still have below it: scroll positions
 *  can be fractions of a pixel. */
const AT_BOTTOM_PX = 1

interface MockState {
  /** The number of chat requests so far. */
  requests: number
  /** The open stream of the latest chat request, until the test ends it. */
  reply: http.ServerResponse | null
}

/** Where the editor's view is, read two frames after the last change so
 *  that the scroll work of that change is done. */
interface ScrollView {
  scrollTop: number
  /** The distance from the bottom of the view to the bottom of the
   *  scrollable area. */
  fromBottom: number
  /** The number of the doc line at the top of the view. */
  topLine: number
}

// Text that is taller than the editor, so the view can scroll.
function longText (label: string): string {
  return Array.from({ length: 40 }, (_, i) => `${label} line ${i + 1}`).join('\n')
}

describe('stream follow', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let server: MockServer
  const mock: MockState = { requests: 0, reply: null }

  function sendFrame (delta: Record<string, string>, finishReason: string | null = null): void {
    if (!mock.reply) throw new Error('sendFrame: no open reply')
    writeChatFrame(mock.reply, delta, finishReason)
  }

  function endReply (): void {
    if (!mock.reply) return
    sendFrame({ content: '' }, 'stop')
    mock.reply.end('data: [DONE]\n\n')
    mock.reply = null
  }

  async function waitForReply (count: number): Promise<void> {
    await waitForValue(browser, `chat request ${count}`, async () => mock.requests === count && mock.reply !== null, true)
  }

  // Sends answer text and waits until the editor shows it.
  async function sendAnswer (text: string): Promise<void> {
    sendFrame({ content: text })
    await waitForValue(browser, `editor text ${JSON.stringify(text)}`, () => browser.execute((tail: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('sendAnswer: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return view.state.doc.sliceString(Math.max(0, view.state.doc.length - tail.length)) === tail
    }, text), true)
  }

  // Sends thinking text and waits until the open thinking panel shows it.
  async function sendThinking (text: string): Promise<void> {
    sendFrame({ reasoning_content: text })
    await waitForValue(browser, `thinking ${JSON.stringify(text)}`, () => browser.execute((tail: string) => {
      const fields = document.querySelectorAll<HTMLTextAreaElement>('.cm-content textarea.dez-role-separator__thinking-text')
      return fields[fields.length - 1]?.value.endsWith(tail) ?? false
    }, text), true)
  }

  async function scrollView (): Promise<ScrollView> {
    return browser.execute(() => new Promise<ScrollView>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const content = document.querySelector('.cm-content')
        if (!content) throw new Error('scrollView: .cm-content not found')
        const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
        const scroll = view.scrollDOM
        const block = view.lineBlockAtHeight(scroll.getBoundingClientRect().top - view.documentTop)
        resolve({
          scrollTop: scroll.scrollTop,
          fromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          topLine: view.state.doc.lineAt(block.from).number,
        })
      }))
    }))
  }

  // Scrolls the editor so that its view ends `fromBottom` pixels above the
  // bottom, as a wheel or a scrollbar drag does.
  async function scrollTo (fromBottom: number): Promise<ScrollView> {
    await browser.execute((distance: number) => {
      const scroll = document.querySelector<HTMLElement>('.cm-scroller')
      if (!scroll) throw new Error('scrollTo: .cm-scroller not found')
      scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - distance
    }, fromBottom)
    return scrollView()
  }

  async function expectAtBottom (label: string): Promise<void> {
    const view = await scrollView()
    expect(view.fromBottom, `${label}: distance from the bottom`).toBeLessThanOrEqual(AT_BOTTOM_PX)
  }

  // The view did not move since `before`, and the reply grew below it.
  async function expectStayed (label: string, before: ScrollView): Promise<void> {
    const view = await scrollView()
    expect(view.scrollTop, `${label}: scrollTop`).toBe(before.scrollTop)
    expect(view.topLine, `${label}: top line`).toBe(before.topLine)
    expect(view.fromBottom, `${label}: distance from the bottom`).toBeGreaterThan(before.fromBottom)
  }

  async function waitForReplyEnd (): Promise<void> {
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    await waitForValue(browser, 'trailing user section', async () => (await threadSections(browser)).at(-1), { role: 'user', text: '' })
    expect(await openErrorToasts(browser)).toEqual([])
    // The editor rebuilds its state from the store a tick after the end,
    // then scrolls in a later frame. Give a wrong scroll time to happen.
    await browser.pause(300)
  }

  beforeAll(async () => {
    // Keeps each reply open for the test.
    server = await startChatMock([mockChatPath(PROVIDER)], (_req, res) => {
      mock.requests++
      startEventStream(res)
      mock.reply = res
    })
    app = await startApp()
    try {
      await seedRawAppState(app.home, {
        customProviders: [{ ...mockProviderConfig(PROVIDER, server.url), thinking: {} }],
      })
      await seedConversation(app.home, makeConversation({
        id: CONVERSATION_ID,
        title: 'Long thread',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: longText('Question') }] },
          { role: 'agent', nodes: [{ kind: 'text', text: longText('Answer') }] },
          { role: 'user', nodes: [{ kind: 'text', text: 'Question 1' }] },
        ],
      }))
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await sbpCall(browser, 'dez.model/tabs/openConversation', CONVERSATION_ID)
    await waitForValue(browser, 'opened conversation', async () => (await threadSections(browser)).at(-1), { role: 'user', text: 'Question 1' })
    await pickModel(browser, PROVIDER.name, PROVIDER.modelName)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    endReply()
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
    await server?.stop()
  })

  it('scrolls to the bottom when a reply starts, wherever the view was, and follows the reply to its end', async () => {
    // The caret and the view at the top, as after a click on the first line.
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      if (!content) throw new Error('.cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      content.focus()
      view.dispatch({ selection: { anchor: 0 } })
      view.scrollDOM.scrollTop = 0
    })
    expect((await scrollView()).scrollTop).toBe(0)
    await browser.keys([Key.Control, Key.Enter])
    await waitForReply(1)

    await sendAnswer('Reply 1 starts.')
    await expectAtBottom('first part')
    for (let line = 1; line <= 3; line++) {
      await sendAnswer(`\nReply 1 line ${line}`)
      await expectAtBottom(`line ${line}`)
    }
    endReply()
    await waitForReplyEnd()
    await expectAtBottom('after the end')
  })

  it('stops the follow on a short scroll up, and keeps the view there while the reply streams and after it ends', async () => {
    await submit(browser, 'Question 2')
    await waitForReply(2)
    await sendAnswer('Reply 2 starts.')
    await expectAtBottom('first part')

    // A short scroll up, as one wheel step gives.
    const scrolled = await scrollTo(40)
    for (let line = 1; line <= 3; line++) {
      await sendAnswer(`\nReply 2 line ${line}`)
      await expectStayed(`line ${line}`, scrolled)
    }
    expect(await activeTabStreaming(browser)).toBe(true)

    const higher = await scrollTo(400)
    await sendAnswer('\nReply 2 line 4')
    await expectStayed('line 4', higher)

    endReply()
    await waitForReplyEnd()
    const ended = await scrollView()
    expect(ended.topLine, 'top line after the end').toBe(higher.topLine)
    expect(ended.fromBottom, 'distance from the bottom after the end').toBeGreaterThan(AT_BOTTOM_PX)
  })

  it('starts the follow again only at the bottom', async () => {
    await submit(browser, 'Question 3')
    await waitForReply(3)
    await sendAnswer('Reply 3 starts.')
    await expectAtBottom('first part')

    const up = await scrollTo(300)
    await sendAnswer('\nReply 3 line 1')
    await expectStayed('line 1', up)

    // Near the bottom is not the bottom.
    const near = await scrollTo(40)
    await sendAnswer('\nReply 3 line 2')
    await expectStayed('line 2', near)

    await scrollTo(0)
    for (let line = 3; line <= 4; line++) {
      await sendAnswer(`\nReply 3 line ${line}`)
      await expectAtBottom(`line ${line}`)
    }

    // Ctrl+End puts the caret at the doc end and scrolls it into view. That
    // stops a few pixels above the bottom of the scroller's padding, and
    // still counts as the bottom.
    const upAgain = await scrollTo(300)
    await sendAnswer('\nReply 3 line 5')
    await expectStayed('line 5', upAgain)
    await browser.keys([Key.Control, Key.End])
    await scrollView()
    await sendAnswer('\nReply 3 line 6')
    await expectAtBottom('line 6')

    endReply()
    await waitForReplyEnd()
    await expectAtBottom('after the end')
  })

  it('applies the same rule to thinking that grows the open thinking panel', async () => {
    await submit(browser, 'Question 4')
    await waitForReply(4)
    sendFrame({ reasoning_content: 'Plan:' })
    // Only the pill of the section that streams has `data-streaming`. A
    // mousedown on its triangle opens the thinking panel of reply 4.
    const streamingTriangle = '.cm-content .dez-role-separator__label[data-streaming="1"] > .dez-role-separator__disclosure'
    await waitFor(browser, streamingTriangle, 10_000)
    await browser.execute((selector: string) => {
      const triangle = document.querySelector(selector)
      if (!triangle) throw new Error('no disclosure triangle on the streaming pill')
      triangle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    }, streamingTriangle)
    await waitFor(browser, '.cm-content textarea.dez-role-separator__thinking-text', 10_000)

    for (let step = 1; step <= 3; step++) {
      await sendThinking(`\n- step ${step}`)
      await expectAtBottom(`thinking step ${step}`)
    }

    const scrolled = await scrollTo(60)
    await sendThinking('\n- step 4')
    await expectStayed('thinking step 4', scrolled)
    // The first answer text hides the busy dots below the editor, which
    // makes the scroller taller. So the answer adds lines, or the distance
    // from the bottom would get smaller while the view stays still.
    await sendAnswer('Reply 4.\nReply 4 line 1\nReply 4 line 2')
    await expectStayed('answer', scrolled)

    endReply()
    await waitForReplyEnd()
    const ended = await scrollView()
    expect(ended.topLine, 'top line after the end').toBe(scrolled.topLine)
    expect(ended.fromBottom, 'distance from the bottom after the end').toBeGreaterThan(AT_BOTTOM_PX)
  })
})
