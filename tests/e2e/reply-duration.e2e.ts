import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { longDuration, shortDuration } from '../../src/view/thread/pillDuration'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { makeConversation, seedConversation } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabStreaming, newTab, rolePillHeights, savedPillLines, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// The reply time at the end of agent role pills, through the real app
// against a mock server in this process: no time while a reply streams, the
// time after it ends, in the conversation file, and again after a relaunch.
//
// One app session serves the whole file. The relaunch test reopens the
// conversation of the first test.

const PROVIDER: MockProvider = { id: 'duration', name: 'Duration Mock', modelId: 'duration-model', modelName: 'Duration Model' }
const MODEL_KEY = `${PROVIDER.id}/${PROVIDER.modelId}`
// The mock holds the reply open this long, so the time is over a second.
const HOLD_MS = 1200

/** The reply time part of a role pill, or null when the pill shows none. */
interface PillTime {
  text: string
  title: string
  ariaLabel: string
}

interface PillView {
  index: number
  role: string
  time: PillTime | null
}

function expectedTime (durationMs: number): PillTime {
  const description = `Reply took ${longDuration(durationMs)}`
  return { text: shortDuration(durationMs), title: description, ariaLabel: description }
}

describe('reply duration', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The conversation and the reply time of the first test, for the relaunch.
  let timedReply: { conversationId: string, durationMs: number } | null = null

  // Every role pill of the active editor, with its reply time.
  async function pills (): Promise<PillView[]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-role-separator')).map((separator) => {
        const time = separator.querySelector<HTMLElement>('.dez-role-separator__label .dez-role-separator__duration')
        return {
          index: Number(separator.dataset.sectionIndex),
          role: separator.dataset.role ?? '',
          time: time ? { text: time.textContent ?? '', title: time.title, ariaLabel: time.getAttribute('aria-label') ?? '' } : null,
        }
      })
    )
  }

  async function activeTab (): Promise<{ conversationId: string, sections: Array<{ durationMs?: number }> }> {
    return await sbpCall(browser, 'dez.model/tab', await sbpCall(browser, 'dez.model/tabs/activeId')) as { conversationId: string, sections: Array<{ durationMs?: number }> }
  }

  // Every pill is as tall as the first one, so a separator does not move
  // when a time appears on its pill.
  async function expectEqualPillHeights (count: number): Promise<void> {
    const [first, ...rest] = await rolePillHeights(browser)
    expect(rest).toHaveLength(count - 1)
    for (const height of rest) expect(height).toBeCloseTo(first, 1)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER)
    browser = setup.browser
  })

  beforeEach(async () => {
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

  it('shows no time while the reply streams, then the time it took, and saves it', async () => {
    await submit(browser, 'How long?')
    const request = await setup.mock.waitForRequest(browser)
    let release = (): void => {}
    const sending = sendChatReply(request.reply, 'the timer', new Promise<void>((resolve) => { release = resolve }))
    try {
      await waitForValue(browser, 'held reply', async () => (await threadSections(browser))[1]?.text ?? null, replyText('the timer'))
      expect(await activeTabStreaming(browser)).toBe(true)
      expect(await pills()).toEqual([{ index: 1, role: 'agent', time: null }])
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    } finally {
      release()
    }
    await sending
    await waitForThread(browser, [
      { role: 'user', text: 'How long?' },
      { role: 'agent', text: replyText('the timer') },
      { role: 'user', text: '' },
    ])

    const tab = await activeTab()
    const durationMs = tab.sections[1]?.durationMs
    if (durationMs === undefined) throw new Error('The reply has no duration')
    expect(durationMs).toBeGreaterThanOrEqual(HOLD_MS)
    await waitForValue(browser, 'pills after the reply', pills, [
      { index: 1, role: 'agent', time: expectedTime(durationMs) },
      { index: 2, role: 'user', time: null },
    ])
    await expectEqualPillHeights(2)
    await waitForValue(browser, 'saved pills', () => savedPillLines(setup.app.home, tab.conversationId), [
      '<dez:pill type="user"/>',
      `<dez:pill type="agent" model="${MODEL_KEY}" duration-ms="${durationMs}"/>`,
      '<dez:pill type="user"/>',
    ])
    timedReply = { conversationId: tab.conversationId, durationMs }
  })

  it('shows the time in a pill with no model, and none for a reply without one', async () => {
    // A tab of its own: the relaunch test needs the first test's tab as it
    // was.
    await newTab(browser)
    await seedConversation(setup.app.home, makeConversation({
      id: 'timed',
      title: 'Timed',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'First question' }] },
        // A time with no model: only a paste or a hand edit makes one.
        { role: 'agent', nodes: [{ kind: 'text', text: 'Pasted answer' }], durationMs: 65_000 },
        { role: 'user', nodes: [{ kind: 'text', text: 'Second question' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: 'Quick answer' }], model: { providerId: PROVIDER.id, modelId: PROVIDER.modelId }, durationMs: 4213 },
        { role: 'user', nodes: [{ kind: 'text', text: 'Third question' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: 'Untimed answer' }], model: { providerId: PROVIDER.id, modelId: PROVIDER.modelId } },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'timed')
    await waitForValue(browser, 'seeded pills', pills, [
      { index: 1, role: 'agent', time: expectedTime(65_000) },
      { index: 2, role: 'user', time: null },
      { index: 3, role: 'agent', time: expectedTime(4213) },
      { index: 4, role: 'user', time: null },
      { index: 5, role: 'agent', time: null },
    ])
    await expectEqualPillHeights(5)
  })

  it('shows the time again after a relaunch', async () => {
    if (!timedReply) throw new Error('The first test saved no timed reply')
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    // The tab bar shows before the app restores the saved tabs, and the
    // restore sets the active tab: the tab of the test before. Switch only
    // after it, or the restore switches back.
    await waitForValue(browser, 'restored active tab', async () => (await activeTab()).conversationId, 'timed')
    await sbpCall(browser, 'dez.model/tabs/openConversation', timedReply.conversationId)
    await waitForValue(browser, 'pills after the relaunch', pills, [
      { index: 1, role: 'agent', time: expectedTime(timedReply.durationMs) },
      { index: 2, role: 'user', time: null },
    ])
  })
})
