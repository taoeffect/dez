import { isDeepStrictEqual } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import type { ActiveModel } from '../../src/model/chat/types'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabId, docPos, focusEditor, newTab, sbpCall, setCaret, submit, waitForThread } from './harness/thread'

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
  // test expects. The digits of an estimate (a text with `~`) show as `#`:
  // its number changes with each change of the system prompt and the tools.
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
      .map(({ text, whole }) => `${whole ? '' : '(cut) '}${text.startsWith('~') ? text.replace(/[\d.]+/, '#') : text}`)
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

  it('gives way to Submit in a bar with too little room: first the cost goes, then the token count', async () => {
    await askAndAnswer('Question', 'the model', 0.5)
    await waitForValue(browser, 'label in a bar with room', usageTexts, ['9', DOT, '$0.50'])
    const model = await sbpCall(browser, 'dez.model/activeModel') as ActiveModel
    const rect = await browser.getWindowRect()
    const pageWidth = (): Promise<number> => browser.execute(() => window.innerWidth)
    const widePage = await pageWidth()
    // What the label showed while the model name got longer; a new entry
    // for each change.
    const shown: string[][] = []
    try {
      // The least width of the window (`minWidth`, tauri.conf.json).
      await browser.setWindowRect(null, null, 600, rect.height)
      await waitForValue(browser, 'narrow page', async () => await pageWidth() <= 600, true)
      // The model name gets one narrow character longer in each step, so
      // it takes the room of the label bit by bit, and no state of the
      // label is left out.
      for (let dots = 40; dots < 250 && shown.at(-1)?.length !== 0; dots += 1) {
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
    expect(shown).toEqual([['9', DOT, '$0.50'], ['9'], []])
  })
})
