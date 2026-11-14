import type http from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { replyText, startEventStream, writeChatFrame, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabId, docPos, focusEditor, newTab, sbpCall, setCaret, submit, waitForThread } from './harness/thread'

// The cost label of the bottom bar, through the real app against a mock
// server in this process:
// - no label before the first counted request of the conversation;
// - the sum of the provider's prices, with `+` after a request that has no
//   known price;
// - the busy look while a reply of the active tab runs;
// - ` (?)` and italic once the user changed the text of a reply;
// - the label is the one of the active tab.
//
// One app session serves the whole file; each test starts in a new tab.

const PROVIDER: MockProvider = { id: 'costs', name: 'Cost Mock', modelId: 'cost-model', modelName: 'Cost Model' }

interface LabelLook {
  /** The text of the label; null when there is no label. */
  text: string | null
  /** `busy`: a color that is not the text color (a reply runs); `idle`:
   *  the text color; `changing` while a transition runs. */
  look: 'busy' | 'idle' | 'changing' | null
  italic: boolean
}

const NO_LABEL: LabelLook = { text: null, look: null, italic: false }

// Streams the reply that names `name` and ends it. With `usd`, a usage
// chunk with that price comes before the end, as OpenRouter sends it;
// without it the request has no known price (the mock model has no list
// price).
function sendReply (res: http.ServerResponse, name: string, usd?: number): void {
  startEventStream(res)
  writeChatFrame(res, { content: replyText(name) })
  if (usd !== undefined) {
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, cost: usd } })}\n\n`)
  }
  res.end('data: [DONE]\n\n')
}

describe('cost label', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  async function labelLook (): Promise<LabelLook> {
    return browser.execute(() => {
      const label = document.querySelector<HTMLElement>('.bottom-bar .cost-label')
      if (!label) return { text: null, look: null, italic: false }
      const probe = document.createElement('div')
      probe.style.color = 'var(--color-text)'
      document.body.append(probe)
      const textColor = getComputedStyle(probe).color
      probe.remove()
      const style = getComputedStyle(label)
      const settled = label.getAnimations().every((animation) => animation.playState === 'finished')
      let look: LabelLook['look'] = 'changing'
      if (settled) look = style.color === textColor ? 'idle' : 'busy'
      return { text: label.textContent, look, italic: style.fontStyle === 'italic' }
    })
  }

  // Asks `question` in the active tab and answers it with `sendReply`.
  async function askAndAnswer (question: string, name: string, usd?: number): Promise<void> {
    await submit(browser, question)
    sendReply((await setup.mock.waitForRequest(browser)).reply, name, usd)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER)
    browser = setup.browser
  })

  beforeEach(async () => {
    // A new tab gets the last used model, which startMockProviderApp picked.
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('shows the sum of the prices, the busy look while a reply runs, and + after a request with no price', async () => {
    expect(await labelLook()).toEqual(NO_LABEL)
    await submit(browser, 'First question')
    const first = await setup.mock.waitForRequest(browser)
    // A request counts at its end.
    expect(await labelLook()).toEqual(NO_LABEL)
    sendReply(first.reply, 'the first', 0.0031)
    await waitForThread(browser, [
      { role: 'user', text: 'First question' },
      { role: 'agent', text: replyText('the first') },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'label after a priced reply', labelLook, { text: '$0.0031', look: 'idle', italic: false })

    await submit(browser, 'Second question')
    const second = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'label while a reply runs', labelLook, { text: '$0.0031', look: 'busy', italic: false })
    sendReply(second.reply, 'the second')
    await waitForValue(browser, 'label after a reply with no price', labelLook, { text: '$0.0031+', look: 'idle', italic: false })
  })

  it('marks the sum once the user changed the text of a reply', async () => {
    await askAndAnswer('Question', 'the model', 0.5)
    await waitForValue(browser, 'label after the reply', labelLook, { text: '$0.50', look: 'idle', italic: false })

    await focusEditor(browser)
    await setCaret(browser, await docPos(browser, replyText('the model'), replyText('the model').length))
    await typeKeys(browser, ' Edited')
    await waitForValue(browser, 'label after the edit', labelLook, { text: '$0.50 (?)', look: 'idle', italic: true })

    // The mark stays, also in the busy look of the next reply.
    await submit(browser, 'Next question')
    const next = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'edited label while a reply runs', labelLook, { text: '$0.50 (?)', look: 'busy', italic: true })
    sendReply(next.reply, 'the next', 0.25)
    await waitForValue(browser, 'edited label after the next reply', labelLook, { text: '$0.75 (?)', look: 'idle', italic: true })
  })

  it('shows the cost of the active tab, busy only while a reply of that tab runs', async () => {
    await askAndAnswer('Priced question', 'the priced tab', 0.12)
    await waitForValue(browser, 'label of the priced tab', labelLook, { text: '$0.12', look: 'idle', italic: false })
    const pricedTab = await activeTabId(browser)

    await newTab(browser)
    expect(await labelLook()).toEqual(NO_LABEL)
    await submit(browser, 'Background question')
    const background = await setup.mock.waitForRequest(browser)
    const backgroundTab = await activeTabId(browser)

    await sbpCall(browser, 'dez.model/tabs/switch', pricedTab)
    await waitForValue(browser, 'label of the priced tab while another tab is busy', labelLook, { text: '$0.12', look: 'idle', italic: false })

    // The price of a background reply goes to its own tab.
    sendReply(background.reply, 'the background', 0.2)
    await waitForValue(browser, 'background tab activity', async () => (await sbpCall(browser, 'dez.model/tabs/activity') as Record<string, string>)[backgroundTab], 'done')
    expect(await labelLook()).toEqual({ text: '$0.12', look: 'idle', italic: false })
    await sbpCall(browser, 'dez.model/tabs/switch', backgroundTab)
    await waitForValue(browser, 'label of the background tab', labelLook, { text: '$0.20', look: 'idle', italic: false })
  })
})
