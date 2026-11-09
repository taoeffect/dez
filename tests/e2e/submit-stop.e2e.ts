import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { openAiSystemMessage } from './harness/chatBody'
import { click, consoleErrors, openHistoryPanel, pointerClick, pointerDoubleClick, resetConsoleErrors, screenshotOnFailure, typeInto, typeKeys, waitFor, waitForValue } from './harness/dom'
import { startMockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, startEventStream, writeChatFrame, type HeldRequest, type HoldingChatMock, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabStreaming, editorCaret, editorDoc, focusEditor, focusedArea, openPicker, openToasts, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// Esc and the Submit/Stop button of the bottom bar stop the stream of the
// active tab, through the real app against a mock server in this process.
// Esc closes an open model dropdown, prompt autocomplete, find, or modal
// first (also with the focus inside the modal), and the stream goes on; the
// next Esc stops it. A stop keeps the answer so far, adds the trailing user
// section, and closes the request. A stop before any answer text (thinking
// does not count) removes the agent section instead. A double-click on the
// button acts once.
//
// One app session serves the whole file; each test starts in a new tab.

const PROVIDER: MockProvider = { id: 'stop', name: 'Stop Mock', modelId: 'stop-model', modelName: 'Stop Model' }

// A human double-click. It is long enough for the stop of the first click
// (one IPC round trip) to end, so the second click sees the new face.
const DOUBLE_CLICK_GAP_MS = 150

describe('submit and stop a streaming reply', () => {
  let browser: E2EBrowser
  let mock: HoldingChatMock
  let stopApp: (() => Promise<void>) | undefined

  // Submits `text` and streams `answer` as the first part of the reply,
  // which stays open.
  async function startHeldReply (text: string, answer: string): Promise<HeldRequest> {
    await submit(browser, text)
    const request = await mock.waitForRequest(browser)
    startEventStream(request.reply)
    writeChatFrame(request.reply, { content: answer })
    await waitForValue(browser, 'first answer part', async () => (await threadSections(browser)).at(-1), { role: 'agent', text: answer })
    return request
  }

  // Streams one more part and waits for it: the stream still runs.
  async function expectStreamGoesOn (request: HeldRequest, textSoFar: string): Promise<void> {
    expect(await activeTabStreaming(browser), 'streaming').toBe(true)
    writeChatFrame(request.reply, { content: ' more' })
    await waitForValue(browser, 'next answer part', async () => (await threadSections(browser)).at(-1), { role: 'agent', text: `${textSoFar} more` })
  }

  async function expectStopped (request: HeldRequest, sections: Array<{ role: string, text: string }>): Promise<void> {
    await waitForThread(browser, sections)
    await waitForValue(browser, 'request closed by the app', async () => request.closed, true)
  }

  async function exists (selector: string): Promise<boolean> {
    return browser.execute((sel: string) => document.querySelector(sel) !== null, selector)
  }

  async function focusElement (selector: string): Promise<void> {
    await browser.execute((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) throw new Error(`focusElement: ${sel} not found`)
      el.focus()
    }, selector)
  }

  async function selectionRangeCount (): Promise<number> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('selectionRangeCount: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return view.state.selection.ranges.length
    })
  }

  // What the Submit/Stop button in the bottom bar shows, and its
  // accessible name.
  async function submitButtonFace (): Promise<{ label: string, keycap: string, name: string }> {
    return browser.execute(() => {
      const button = document.querySelector('.submit-button')
      if (!button) throw new Error('submitButtonFace: .submit-button not found')
      return {
        label: button.querySelector('.submit-button-label')?.textContent ?? '',
        keycap: button.querySelector('.submit-button-keycap')?.textContent ?? '',
        name: button.getAttribute('aria-label') ?? '',
      }
    })
  }

  const SUBMIT_FACE = { label: 'Submit', keycap: 'Ctrl+↩', name: 'Submit (Ctrl+Enter)' }
  const STOP_FACE = { label: 'Stop', keycap: 'Esc', name: 'Stop (Esc)' }

  beforeAll(async () => {
    // Thinking support, so the app reads `reasoning_content` frames.
    ({ browser, mock, stop: stopApp } = await startMockProviderApp(PROVIDER, { thinking: {} }))
  })

  beforeEach(async () => {
    // A new tab gets the last used model, which startMockProviderApp picked.
    await sbpCall(browser, 'dez.model/tabs/create')
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    // A stop is not an error.
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await stopApp?.()
  })

  it('stops with Esc in the editor, keeps the answer so far, and adds a user section', async () => {
    const request = await startHeldReply('Stop in the editor', 'Partial')
    expect(await focusedArea(browser)).toBe('editor')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop in the editor' },
      { role: 'agent', text: 'Partial' },
      { role: 'user', text: '' },
    ])

    // With no stream, Esc keeps its editor action: it collapses multiple
    // cursors.
    await browser.keys([Key.Control, Key.Shift, Key.ArrowUp])
    await waitForValue(browser, 'cursors added', selectionRangeCount, 2)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'cursors after Esc', selectionRangeCount, 1)
  })

  it('closes find first, from the editor and from the search field; the next Esc stops', async () => {
    const request = await startHeldReply('Stop after find', 'Partial')

    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, '.find-dropdown', 10_000)
    await focusEditor(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'find open after Esc in the editor', () => exists('.find-dropdown'), false)
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, '.find-field', 10_000)
    await typeInto(browser, '.find-field', 'Part', { clear: true })
    expect(await focusedArea(browser)).toBe('find')
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'find open after Esc in the search field', () => exists('.find-dropdown'), false)
    await expectStreamGoesOn(request, 'Partial more')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop after find' },
      { role: 'agent', text: 'Partial more more' },
      { role: 'user', text: '' },
    ])
  })

  it('closes the model dropdown first; the next Esc stops', async () => {
    const request = await startHeldReply('Stop after the dropdown', 'Partial')

    await openPicker(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'dropdown open after Esc', () => exists('.model-dropdown'), false)
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop after the dropdown' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('closes Settings first, with the focus in the editor; the next Esc stops', async () => {
    const request = await startHeldReply('Stop after Settings', 'Partial')

    await browser.keys([Key.Control, ','])
    await waitFor(browser, '.settings-overlay', 10_000)
    expect(await focusedArea(browser)).toBe('editor')
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Settings open after Esc', () => exists('.settings-overlay'), false)
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop after Settings' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('closes Settings first when the focus is inside Settings; the next Esc stops', async () => {
    const request = await startHeldReply('Stop after Settings focus', 'Partial')

    await browser.keys([Key.Control, ','])
    await waitFor(browser, '.settings-overlay', 10_000)
    await focusElement('.settings-close')
    expect(await focusedArea(browser)).toBe('button')
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Settings open after Esc', () => exists('.settings-overlay'), false)
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop after Settings focus' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('closes History first when the focus is in its search field; the next Esc stops', async () => {
    const request = await startHeldReply('Stop after History', 'Partial')

    await openHistoryPanel(browser)
    await focusElement('.history-search')
    expect(await focusedArea(browser)).toBe('input')
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'History open after Esc', () => exists('.history-overlay'), false)
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: 'Stop after History' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('closes the prompt autocomplete first; the next Esc stops', async () => {
    await sbpCall(browser, 'dez.model/prompts/add', 'Greeting', 'Hello there')
    const request = await startHeldReply('Stop after autocomplete', 'Partial')

    // Puts the caret before the user text, where `/prompt ` opens the
    // autocomplete.
    await browser.execute((text: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('caret: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const at = view.state.doc.toString().indexOf(text)
      if (at < 0) throw new Error(`caret: ${text} not found`)
      view.dispatch({ selection: { anchor: at } })
      view.focus()
    }, 'Stop after autocomplete')
    await typeKeys(browser, '/prompt ')
    await waitFor(browser, '.prompt-autocomplete', 10_000)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'autocomplete open after Esc', () => exists('.prompt-autocomplete'), false)
    // Each doc change, also a streamed token, opens the autocomplete again
    // while the caret is just after `/prompt `.
    await browser.keys([Key.Control, Key.End])
    await expectStreamGoesOn(request, 'Partial')

    await browser.keys([Key.Escape])
    await expectStopped(request, [
      { role: 'user', text: '/prompt Stop after autocomplete' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('stops with Esc when the focus is outside the editor, also before any answer text', async () => {
    await submit(browser, 'Stop from outside')
    const request = await mock.waitForRequest(browser)
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await focusedArea(browser)).toBe('body')
    expect(await activeTabStreaming(browser), 'streaming').toBe(true)

    await browser.keys([Key.Escape])
    await expectStopped(request, [{ role: 'user', text: 'Stop from outside' }])
  })

  it('removes the agent pill when Esc stops a reply that only thought, and puts the caret back at the end of the user text', async () => {
    const question = 'Stop while thinking'
    await submit(browser, question)
    const request = await mock.waitForRequest(browser)
    startEventStream(request.reply)
    writeChatFrame(request.reply, { reasoning_content: 'Let me think' })
    await waitForValue(browser, 'thinking so far', async () => {
      const sections = await sbpCall(browser, 'dez.model/thread/sections') as Array<{ thinking?: { text: string } }>
      return sections.at(-1)?.thinking?.text
    }, 'Let me think')
    expect(await focusedArea(browser)).toBe('editor')

    await browser.keys([Key.Escape])
    await expectStopped(request, [{ role: 'user', text: question }])
    // The editor rebuilds its state from the store a tick after the stop.
    await waitForValue(browser, 'editor doc', () => editorDoc(browser), question)
    expect(await editorCaret(browser)).toBe(question.length)

    await typeKeys(browser, ' again')
    await waitForValue(browser, 'thread after typing', () => threadSections(browser), [{ role: 'user', text: `${question} again` }])
  })

  it('submits with the button, which turns into Stop while the reply streams and back after a stop', async () => {
    expect(await submitButtonFace()).toEqual(SUBMIT_FACE)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, 'Sent by the button')
    await pointerClick(browser, '.submit-button')

    const request = await mock.waitForRequest(browser)
    expect(JSON.parse(request.body).messages).toEqual([openAiSystemMessage(PROVIDER), { role: 'user', content: 'Sent by the button' }])
    expect(await focusedArea(browser), 'focus after the click').toBe('editor')
    await waitForValue(browser, 'button while streaming', submitButtonFace, STOP_FACE)
    const stopButtons = await browser.execute(() => Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent?.includes('Stop')
    ).length)
    expect(stopButtons, 'Stop buttons').toBe(1)

    startEventStream(request.reply)
    writeChatFrame(request.reply, { content: 'Partial' })
    await waitForValue(browser, 'first answer part', async () => (await threadSections(browser)).at(-1), { role: 'agent', text: 'Partial' })
    await pointerClick(browser, '.submit-button')
    await expectStopped(request, [
      { role: 'user', text: 'Sent by the button' },
      { role: 'agent', text: 'Partial' },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'button after the stop', submitButtonFace, SUBMIT_FACE)
  })

  it('stops once on a double-click on Stop, and sends no new request', async () => {
    const request = await startHeldReply('Double-click Stop', 'Partial')
    await waitForValue(browser, 'button while streaming', submitButtonFace, STOP_FACE)

    await pointerDoubleClick(browser, '.submit-button', DOUBLE_CLICK_GAP_MS)
    await expectStopped(request, [
      { role: 'user', text: 'Double-click Stop' },
      { role: 'agent', text: 'Partial' },
      { role: 'user', text: '' },
    ])
    expect(await activeTabStreaming(browser), 'streaming').toBe(false)
    expect(mock.hasWaitingRequest(), 'new chat request').toBe(false)
    expect(await submitButtonFace()).toEqual(SUBMIT_FACE)
  })

  it('submits once on a double-click on Submit, and the reply streams on', async () => {
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, 'Double-click Submit')
    await pointerDoubleClick(browser, '.submit-button', DOUBLE_CLICK_GAP_MS)

    const request = await mock.waitForRequest(browser)
    expect(JSON.parse(request.body).messages).toEqual([openAiSystemMessage(PROVIDER), { role: 'user', content: 'Double-click Submit' }])
    startEventStream(request.reply)
    writeChatFrame(request.reply, { content: 'Partial' })
    await waitForValue(browser, 'first answer part', async () => (await threadSections(browser)).at(-1), { role: 'agent', text: 'Partial' })
    await expectStreamGoesOn(request, 'Partial')
    expect(request.closed, 'request closed').toBe(false)
    expect(mock.hasWaitingRequest(), 'second chat request').toBe(false)
    expect(await submitButtonFace()).toEqual(STOP_FACE)

    // A later single click still stops.
    await pointerClick(browser, '.submit-button')
    await expectStopped(request, [
      { role: 'user', text: 'Double-click Submit' },
      { role: 'agent', text: 'Partial more' },
      { role: 'user', text: '' },
    ])
  })

  it('submits the editor text with the button when the focus is outside the editor', async () => {
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, 'Sent from outside')
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
    await pointerClick(browser, '.submit-button')

    const request = await mock.waitForRequest(browser)
    expect(JSON.parse(request.body).messages).toEqual([openAiSystemMessage(PROVIDER), { role: 'user', content: 'Sent from outside' }])
    await sendChatReply(request.reply, 'the button')
    await waitForThread(browser, [
      { role: 'user', text: 'Sent from outside' },
      { role: 'agent', text: replyText('the button') },
      { role: 'user', text: '' },
    ])
    expect(await submitButtonFace()).toEqual(SUBMIT_FACE)
  })

  it('keeps a sticky error toast above the bottom bar, so it does not cover the button', async () => {
    await sbpCall(browser, 'dez.ui/toast', 'app-global', {
      variant: 'error',
      title: 'Request failed',
      message: 'The provider returned a long error. '.repeat(30),
    })
    await waitFor(browser, '.toast-card--error', 10_000)
    // The entry animation scales the card; measure it at its final size.
    await waitForValue(browser, 'toast entry animation finished', () => browser.execute(() =>
      (document.querySelector('.toast-card--error')?.getAnimations() ?? []).every((animation) => animation.playState === 'finished')
    ), true)

    const layout = await browser.execute(() => {
      const rect = (selector: string): DOMRect => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`layout: ${selector} not found`)
        return el.getBoundingClientRect()
      }
      const button = rect('.submit-button')
      const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2)
      return {
        cardBottom: rect('.toast-card--error').bottom,
        barTop: rect('.bottom-bar').top,
        buttonHit: hit !== null && hit.closest('.submit-button') !== null,
      }
    })
    expect(layout.cardBottom).toBeLessThanOrEqual(layout.barTop)
    expect(layout.buttonHit, 'the button center is clickable').toBe(true)

    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'open error toasts', () => openToasts(browser, 'error'), [])
  })
})
