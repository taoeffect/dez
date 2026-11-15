import { isDeepStrictEqual } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import type { ActiveModel } from '../../src/model/chat/types'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { LARGE_TOKENS, openAiToolCall, replyText, sendChatReply, sendChatText, sendToolCalls, toolResult, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabId, docPos, endedReply, focusEditor, newTab, sbpCall, setCaret, submit, waitForThread } from './harness/thread'

// The usage label of the bottom bar (the token count, a dot, the cost),
// through the real app against a mock server in this process:
// - no cost before the first counted request of the conversation;
// - the sum of the provider's prices, with `+` after a request that has no
//   known price;
// - the busy look while a reply of the active tab runs;
// - ` (?)` and italic once the user changed the text of a reply;
// - the token count left of the cost: Dez's estimate with `~`, and the
//   count of the provider with none;
// - the label is the one of the active tab;
// - after a compaction, each part shows the number of the buffer (the
//   conversation since the compaction), then the number of the whole
//   conversation in parentheses, each with its own tooltip and its own
//   `+`; a model reads the same numbers with the `conversation_info` tool;
// - in a bar with too little room, the label hides whole parts, and Submit
//   stays in the window.
//
// One app session serves the whole file; each test starts in a new tab.

const PROVIDER: MockProvider = { id: 'costs', name: 'Cost Mock', modelId: 'cost-model', modelName: 'Cost Model' }

interface LabelLook {
  /** The text of the part; null when the label does not have it. */
  text: string | null
  /** `busy`: a color that is not the text color (a reply runs); `idle`:
   *  the text color; `changing` while a transition runs. */
  look: 'busy' | 'idle' | 'changing' | null
  italic: boolean
}

const NO_LABEL: LabelLook = { text: null, look: null, italic: false }

// The dot of the usage label, which stands only between its two parts.
const DOT = '·'

describe('usage label', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // The look of one part of the usage label: the cost, or the token count.
  async function labelLook (part: 'cost' | 'token' = 'cost'): Promise<LabelLook> {
    return browser.execute((selector: string) => {
      const label = document.querySelector<HTMLElement>(selector)
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
    }, `.bottom-bar .${part}-label`)
  }

  // The texts of the parts of the usage label that show, left to right. A
  // part that does not fit is on a line that the label cuts off, so it is
  // not in the list; a part that shows only partly gets `(cut)`, which no
  // test expects. The numbers of an estimate (a text with `~`) show as
  // `#`: they change with each change of the system prompt and the tools.
  async function usageTexts (): Promise<string[]> {
    const parts = await browser.execute(() => {
      const label = document.querySelector<HTMLElement>('.bottom-bar .usage-label')
      if (!label) return []
      const box = label.getBoundingClientRect()
      return Array.from(label.querySelectorAll<HTMLElement>('.token-label, .usage-label__dot, .cost-label'), (part) => {
        const rect = part.getBoundingClientRect()
        return {
          text: part.textContent ?? '',
          left: rect.left,
          onShownLine: rect.top < box.bottom,
          // Half a pixel for the rounding of the layout.
          whole: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.bottom <= box.bottom + 0.5,
        }
      })
    })
    return parts
      .filter(({ onShownLine }) => onShownLine)
      .sort((a, b) => a.left - b.left)
      .map(({ text, whole }) => `${whole ? '' : '(cut) '}${text.startsWith('~') ? text.replace(/[\d.]+/g, '#') : text}`)
  }

  // The first line of each tooltip of the usage label: of the two parts,
  // and of the number in parentheses of each part (`total`), which only
  // the label of a compacted conversation has. Null for a tooltip that the
  // label does not have.
  async function tooltipStarts (): Promise<Record<'token' | 'tokenTotal' | 'cost' | 'costTotal', string | null>> {
    return browser.execute(() => {
      const start = (selector: string): string | null => document.querySelector<HTMLElement>(`.bottom-bar ${selector}`)?.title.split('\n')[0] ?? null
      return {
        token: start('.token-label'),
        tokenTotal: start('.token-label .usage-label__total'),
        cost: start('.cost-label'),
        costTotal: start('.cost-label .usage-label__total'),
      }
    })
  }

  // What the label of the active tab shows while the model name next to it
  // takes its room bit by bit, in a window of the least width: one entry
  // for each change, to the label that shows nothing. Submit must stay in
  // the window all the time.
  async function textsWhileRoomGoes (): Promise<string[][]> {
    const model = await sbpCall(browser, 'dez.model/activeModel') as ActiveModel
    const rect = await browser.getWindowRect()
    const pageWidth = (): Promise<number> => browser.execute(() => window.innerWidth)
    const widePage = await pageWidth()
    const shown: string[][] = []
    try {
      // The least width of the window (`minWidth`, tauri.conf.json).
      await browser.setWindowRect(null, null, 600, rect.height)
      await waitForValue(browser, 'narrow page', async () => await pageWidth() <= 600, true)
      // The model name gets one narrow character longer in each step, so
      // it takes the room of the label bit by bit, and no state of the
      // label is left out.
      for (let dots = 0; dots < 250 && shown.at(-1)?.length !== 0; dots += 1) {
        await sbpCall(browser, 'dez.model/setActiveModel', model.providerId, model.modelId, `Model ${'.'.repeat(dots)}`)
        const texts = await usageTexts()
        if (!isDeepStrictEqual(texts, shown.at(-1))) shown.push(texts)
        const submitInWindow = await browser.execute(() => document.querySelector('.bottom-bar-end')!.getBoundingClientRect().right <= document.documentElement.clientWidth)
        expect(submitInWindow, `Submit in the window, with ${dots} dots in the model name`).toBe(true)
      }
    } finally {
      await sbpCall(browser, 'dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
      await browser.setWindowRect(null, null, rect.width, rect.height)
      await waitForValue(browser, 'page width after the window size is back', pageWidth, widePage)
    }
    return shown
  }

  // Asks `question` in the active tab and answers it with `sendChatReply`;
  // with `usd`, the provider gives that price.
  async function askAndAnswer (question: string, name: string, usd?: number): Promise<void> {
    await submit(browser, question)
    await sendChatReply((await setup.mock.waitForRequest(browser)).reply, name, { usd })
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
    await sendChatReply(first.reply, 'the first', { usd: 0.0031 })
    await waitForThread(browser, [
      { role: 'user', text: 'First question' },
      { role: 'agent', text: replyText('the first') },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'label after a priced reply', labelLook, { text: '$0.0031', look: 'idle', italic: false })

    await submit(browser, 'Second question')
    const second = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'label while a reply runs', labelLook, { text: '$0.0031', look: 'busy', italic: false })
    // The mock model has no list price, so this request has no known price.
    await sendChatReply(second.reply, 'the second')
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
    await sendChatReply(next.reply, 'the next', { usd: 0.25 })
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
    await sendChatReply(background.reply, 'the background', { usd: 0.2 })
    await waitForValue(browser, 'background tab activity', async () => (await sbpCall(browser, 'dez.model/tabs/activity') as Record<string, string>)[backgroundTab], 'done')
    expect(await labelLook()).toEqual({ text: '$0.12', look: 'idle', italic: false })
    await sbpCall(browser, 'dez.model/tabs/switch', backgroundTab)
    await waitForValue(browser, 'label of the background tab', labelLook, { text: '$0.20', look: 'idle', italic: false })
  })

  it('shows the token count left of the cost: an estimate with ~, and the count of the provider with none', async () => {
    // A new tab: the system prompt and the tools of its first request,
    // which no provider counted. No cost, so no dot.
    await waitForValue(browser, 'label of a new tab', usageTexts, ['~#k'])

    await submit(browser, 'Question')
    const request = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'token count while a reply runs', async () => (await labelLook('token')).look, 'busy')
    // The provider counts 5 input and 4 output tokens.
    await sendChatReply(request.reply, 'the model', { usd: 0.5 })
    await waitForValue(browser, 'label after a counted reply', usageTexts, ['9', DOT, '$0.50'])
    await waitForValue(browser, 'token count after the reply', async () => (await labelLook('token')).look, 'idle')
    const countedTab = await activeTabId(browser)

    // The label is the one of the active tab.
    await newTab(browser)
    await waitForValue(browser, 'label of the next new tab', usageTexts, ['~#k'])
    await sbpCall(browser, 'dez.model/tabs/switch', countedTab)
    await waitForValue(browser, 'label of the counted tab', usageTexts, ['9', DOT, '$0.50'])

    // Text that came after the count is an estimate again.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await typeKeys(browser, 'A new message that no provider counted')
    await waitForValue(browser, 'label after new text', usageTexts, ['~#', DOT, '$0.50'])
  })

  it('shows the buffer, then the whole conversation in parentheses, after a compaction, and conversation_info tells a model the same numbers', async () => {
    // The first request is near the context window of the model, so the
    // next request of the conversation is due for a compaction.
    await submit(browser, 'Question')
    await sendChatReply((await setup.mock.waitForRequest(browser)).reply, 'the model', { promptTokens: LARGE_TOKENS, usd: 0.5 })
    await endedReply(browser)
    await waitForValue(browser, 'label before the compaction', usageTexts, ['140k', DOT, '$0.50'])
    expect(await tooltipStarts()).toEqual({
      token: 'Size of this conversation: 140,004 tokens',
      tokenTotal: null,
      cost: 'Cost of this conversation: about $0.50',
      costTotal: null,
    })

    await submit(browser, 'Go on.')
    const compaction = await setup.mock.waitForRequest(browser)
    sendChatText(compaction.reply, '## Summary\nThe notes of the work.\n', { promptTokens: LARGE_TOKENS + 1000, usd: 0.3 })

    // The notes took the place of the conversation. The buffer has no
    // counted request yet: its size is an estimate, and it cost nothing.
    // The compaction request is in the cost of the whole conversation.
    const first = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'label right after the compaction', usageTexts, ['~#k (#k)', DOT, '$0.00 ($0.80)'])
    expect((await tooltipStarts()).cost).toBe('Cost of this buffer (the conversation since its last compaction): nothing yet')

    // The model of the reply asks Dez for the numbers.
    sendToolCalls(first.reply, [openAiToolCall('call_info', 'conversation_info', {})], { usd: 0.05 })
    const second = await setup.mock.waitForRequest(browser)
    const info = toolResult(second, 'call_info')
    expect(info).toMatch(/^Compactions so far: 1\. /m)
    expect(info.split('\n').filter((line) => line.startsWith('Cost of the conversation'))).toEqual([
      'Cost of the conversation since its newest compaction (an estimate): $0.05 for 1 request.',
      'Cost of the conversation so far (an estimate): $0.85 for 3 requests.',
    ])
    expect(info).not.toContain(setup.app.home)

    // The provider counts 9 tokens for the last request of the reply, and
    // the conversation had 141,000 at its compaction.
    await sendChatReply(second.reply, 'the reader of the notes', { usd: 0.02 })
    await endedReply(browser, 3)
    await waitForValue(browser, 'label after the reply', usageTexts, ['9 (141k)', DOT, '$0.07 ($0.87)'])
    expect(await tooltipStarts()).toEqual({
      token: 'Size of this buffer: 9 tokens',
      tokenTotal: 'Size of the whole conversation: 141,009 tokens',
      cost: 'Cost of this buffer (the conversation since its last compaction): about $0.07',
      costTotal: 'Cost of the whole conversation: about $0.87',
    })

    // The mark of an edited reply is the last text of the cost, and each
    // sum has its own `+`: the next request has a usage chunk with no
    // price.
    await focusEditor(browser)
    await setCaret(browser, await docPos(browser, replyText('the reader of the notes'), replyText('the reader of the notes').length))
    await typeKeys(browser, ' Edited')
    await waitForValue(browser, 'label after the edit', labelLook, { text: '$0.07 ($0.87) (?)', look: 'idle', italic: true })
    await submit(browser, 'Next question')
    await sendChatReply((await setup.mock.waitForRequest(browser)).reply, 'the next', { promptTokens: 5 })
    await endedReply(browser, 5)
    const withMarks = ['9 (141k)', DOT, '$0.07+ ($0.87+) (?)']
    await waitForValue(browser, 'label after a reply with no price', usageTexts, withMarks)

    // The two numbers of a part stay together: a part goes whole.
    expect(await textsWhileRoomGoes()).toEqual([withMarks, ['9 (141k)'], []])
  })

  it('gives way to Submit in a bar with too little room: first the cost goes, then the token count', async () => {
    await askAndAnswer('Question', 'the model', 0.5)
    await waitForValue(browser, 'label in a bar with room', usageTexts, ['9', DOT, '$0.50'])
    expect(await textsWhileRoomGoes()).toEqual([['9', DOT, '$0.50'], ['9'], []])
  })
})
