import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import type { RunningApp } from './harness/app'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { conversationFilePath } from './harness/fixtures'
import { startMockProviderApp } from './harness/mockProviderApp'
import { startEventStream, writeChatFrame, type HeldRequest, type HoldingChatMock, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabId, activeTabStreaming, editorDoc, openToasts, sbpCall, submit, threadSections } from './harness/thread'

// Errors of a chat request, driven through the real app against a mock
// server in this process:
// - an error before any output leaves the tab as the user typed it: no agent
//   section, no trailing user section, no error text, also on disk;
// - an error after some output keeps that output and adds the trailing user
//   section, with no error text;
// - each error shows in a red error toast at the lower right that stays
//   until the user closes it, fits its text, and names a background tab.
//
// One app session serves the whole file; each test starts in a new tab.

const PROVIDER: MockProvider = { id: 'errors', name: 'Errors Mock', modelId: 'errors-model', modelName: 'Errors Model' }

interface ToastBox {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  windowWidth: number
  windowHeight: number
  hasProgressBar: boolean
  /** The message is taller than its box. */
  messageOverflows: boolean
  messageOverflowY: string
}

describe('stream errors', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let mock: HoldingChatMock
  let stopApp: (() => Promise<void>) | undefined

  function answerStatus (request: HeldRequest, status: number, body: string): void {
    request.reply.writeHead(status, { 'Content-Type': 'application/json' })
    request.reply.end(body)
  }

  // The box of the open error toast. The entry animation scales the card,
  // so the box is read only after the animation ends.
  async function toastBox (): Promise<ToastBox> {
    await waitForValue(browser, 'toast entry animation done', () => browser.execute(() =>
      document.querySelector('.toast-card--error:not(.toast-card--closing)')
        ?.getAnimations().every((animation) => animation.playState === 'finished') ?? false
    ), true)
    return browser.execute(() => {
      const card = document.querySelector('.toast-card--error:not(.toast-card--closing)')
      const message = card?.querySelector<HTMLElement>('.toast-message')
      if (!card || !message) throw new Error('toastBox: no open error toast')
      const rect = card.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        hasProgressBar: card.querySelector('.toast-progress') !== null,
        messageOverflows: message.scrollHeight > message.clientHeight,
        messageOverflowY: getComputedStyle(message).overflowY,
      }
    })
  }

  function expectInWindow (box: ToastBox): void {
    expect(box.left, 'toast left edge').toBeGreaterThanOrEqual(0)
    expect(box.top, 'toast top edge').toBeGreaterThanOrEqual(0)
    expect(box.right, 'toast right edge').toBeLessThanOrEqual(box.windowWidth)
    expect(box.bottom, 'toast bottom edge').toBeLessThanOrEqual(box.windowHeight)
  }

  async function closeErrorToasts (): Promise<void> {
    await browser.execute(() => {
      document.querySelectorAll<HTMLElement>('.toast-card--error .toast-close').forEach((button) => button.click())
    })
    await waitForValue(browser, 'error toasts closed', () => browser.execute(() => document.querySelectorAll('.toast-card--error').length), 0)
  }

  beforeAll(async () => {
    ({ app, browser, mock, stop: stopApp } = await startMockProviderApp(PROVIDER))
  })

  beforeEach(async () => {
    // A new tab gets the last used model, which startMockProviderApp picked.
    await sbpCall(browser, 'dez.model/tabs/create')
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await mock.dropOpenReplies(browser)
    // Close the sticky toasts also after a failure, so that the next test
    // starts with none.
    await closeErrorToasts()
    if (ctx.task.result?.state === 'fail') return
    // Each test makes one failed request, which the app logs.
    const errors = await consoleErrors(browser)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Chat request failed:/)
  })

  afterAll(async () => {
    await stopApp?.()
  })

  it('leaves the text as typed when the request fails before any output, and shows a sticky error toast', async () => {
    await submit(browser, 'who are you now?')
    answerStatus(await mock.waitForRequest(browser), 401, '{"error":"Authentication failed"}')

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [
      { title: 'Request failed', message: 'Errors Mock returned HTTP 401: {"error":"Authentication failed"}' },
    ])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    expect(await threadSections(browser)).toEqual([{ role: 'user', text: 'who are you now?' }])
    // The editor rebuilds its state from the store a tick after the end.
    await waitForValue(browser, 'editor doc', () => editorDoc(browser), 'who are you now?')

    // The save at the stream end writes only the user section.
    const file = conversationFilePath(app.home, await activeConversationId(browser))
    await waitForValue(browser, 'saved section markers', async () => {
      const text = await fs.promises.readFile(file, 'utf8').catch(() => '')
      return text.includes('who are you now?') ? text.match(/<dez:pill [^>]*>/g) : null
    }, ['<dez:pill type="user"/>'])

    // Typing after the error adds to the user's text, not to a new section.
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, ' Hello')
    await waitForValue(browser, 'thread after typing', () => threadSections(browser), [{ role: 'user', text: 'who are you now? Hello' }])

    const box = await toastBox()
    // ToastCard closes a toast by itself only when its progress bar animation
    // ends, and it draws the bar only for a toast with a duration. So no bar
    // means that the toast stays open until the user closes it.
    expect(box.hasProgressBar, 'a self-closing toast has a progress bar').toBe(false)
    expectInWindow(box)
    // Lower right: the toast pocket is 16 px from the window's right edge.
    expect(box.windowWidth - box.right).toBeCloseTo(16, 0)
    expect(box.bottom, 'toast in the lower half').toBeGreaterThan(box.windowHeight / 2)
    expect(box.width).toBeGreaterThanOrEqual(360)
    expect(box.width).toBeLessThanOrEqual(560)

    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })

  it('keeps the answer text that came before an error, with no error text, and adds a user section', async () => {
    await submit(browser, 'Question')
    const { reply } = await mock.waitForRequest(browser)
    startEventStream(reply)
    writeChatFrame(reply, { content: 'Partial answer' })
    await waitForValue(browser, 'partial answer', async () => (await threadSections(browser)).at(-1), { role: 'agent', text: 'Partial answer' })
    // The connection drops in the middle of the body.
    reply.destroy()

    await waitForValue(browser, 'error toasts', async () => (await openToasts(browser, 'error')).map((toast) => toast.title), ['Request failed'])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    expect(await threadSections(browser)).toEqual([
      { role: 'user', text: 'Question' },
      { role: 'agent', text: 'Partial answer' },
      { role: 'user', text: '' },
    ])
  })

  it('fits a long message: the toast grows to its widest, stays in the window, and the message scrolls', async () => {
    await submit(browser, 'Long error')
    // An HTML error page, as a proxy sends it: a long first line, then many
    // short lines. The message keeps its line breaks, so the long line makes
    // the card as wide as it can be. The app keeps the first 1000
    // characters of the body.
    const doctype = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'
    const page = [doctype, ...Array.from({ length: 120 }, (_, i) => `<p>line ${i + 1}</p>`)].join('\n')
    answerStatus(await mock.waitForRequest(browser), 502, page)

    await waitForValue(browser, 'error toasts', async () => (await openToasts(browser, 'error')).length, 1)
    const box = await toastBox()
    expectInWindow(box)
    expect(box.width).toBeCloseTo(Math.min(560, box.windowWidth - 32), 0)
    expect(box.messageOverflows, 'the message is taller than its box').toBe(true)
    expect(box.messageOverflowY).toBe('auto')
  })

  it('names a tab in the background in the toast title, and that tab ends with the typed text', async () => {
    await submit(browser, 'Background question')
    const request = await mock.waitForRequest(browser)
    const backgroundTabId = await activeTabId(browser)
    await sbpCall(browser, 'dez.model/tabs/create')

    answerStatus(request, 500, '{"error":"Server error"}')
    await waitForValue(browser, 'error toasts', () => openToasts(browser, 'error'), [
      { title: 'Request failed in "Background question"', message: 'Errors Mock returned HTTP 500: {"error":"Server error"}' },
    ])
    await waitForValue(browser, 'background tab sections', async () => {
      const tab = await sbpCall(browser, 'dez.model/tab', backgroundTabId) as { sections: unknown[] }
      return tab.sections.length
    }, 1)

    await sbpCall(browser, 'dez.model/tabs/switch', backgroundTabId)
    await waitForValue(browser, 'editor doc of the background tab', () => editorDoc(browser), 'Background question')
    expect(await threadSections(browser)).toEqual([{ role: 'user', text: 'Background question' }])
  })
})
