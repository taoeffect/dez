import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { startMockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, type HoldingChatMock, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { sbpCall, submit, waitForThread } from './harness/thread'

// The tab bar colors of a reply, through the real app against a mock server
// in this process:
// - a tab is busy while its reply streams, also in the background;
// - a reply that ends in the background makes its tab done until the user
//   selects the tab;
// - a reply that ends in the active tab leaves no color.
//
// One app session serves the whole file; each test starts in a new tab.

const PROVIDER: MockProvider = { id: 'activity', name: 'Activity Mock', modelId: 'activity-model', modelName: 'Activity Model' }

interface TabLook {
  title: string
  active: boolean
  /** The reply color that the tab shows: its background is the busy or the
   *  done theme color, or neither. `changing` while a transition runs. */
  color: 'busy' | 'done' | 'changing' | null
}

describe('tab activity colors', () => {
  let browser: E2EBrowser
  let mock: HoldingChatMock
  let stopApp: (() => Promise<void>) | undefined

  async function activeTabId (): Promise<string> {
    return await sbpCall(browser, 'dez.model/tabs/activeId') as string
  }

  // The tab bar draws the tabs in the order of the model's tab list.
  async function tabSelector (tabId: string): Promise<string> {
    const tabs = await sbpCall(browser, 'dez.model/tabs/list') as Array<{ id: string }>
    return `.tab-strip .tab:nth-child(${tabs.findIndex((tab) => tab.id === tabId) + 1})`
  }

  async function tabLook (tabId: string): Promise<TabLook> {
    return browser.execute((selector: string) => {
      const tab = document.querySelector<HTMLElement>(selector)
      if (!tab) throw new Error(`tabLook: ${selector} not found`)
      // A theme variable as the computed color string of a background.
      const themeColor = (variable: string): string => {
        const probe = document.createElement('div')
        probe.style.backgroundColor = `var(${variable})`
        document.body.append(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      }
      const background = getComputedStyle(tab).backgroundColor
      const settled = tab.getAnimations().every((animation) => animation.playState === 'finished')
      let color: TabLook['color'] = null
      if (!settled) color = 'changing'
      else if (background === themeColor('--color-tab-busy')) color = 'busy'
      else if (background === themeColor('--color-tab-done')) color = 'done'
      return {
        title: tab.querySelector('.tab-title')?.textContent ?? '',
        active: tab.classList.contains('tab--active'),
        color,
      }
    }, await tabSelector(tabId))
  }

  beforeAll(async () => {
    ({ browser, mock, stop: stopApp } = await startMockProviderApp(PROVIDER))
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
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await stopApp?.()
  })

  it('shows busy in the background, done when the reply ends there, and no color once the user selects the tab', async () => {
    await submit(browser, 'Background question')
    const request = await mock.waitForRequest(browser)
    const tabId = await activeTabId()
    await waitForValue(browser, 'tab while its reply streams', () => tabLook(tabId), { title: 'Background question', active: true, color: 'busy' })

    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'tab in the background while its reply streams', () => tabLook(tabId), { title: 'Background question', active: false, color: 'busy' })

    await sendChatReply(request.reply, 'the background')
    await waitForValue(browser, 'tab in the background after its reply', () => tabLook(tabId), { title: 'Background question', active: false, color: 'done' })

    await click(browser, await tabSelector(tabId))
    await waitForValue(browser, 'selected tab', () => tabLook(tabId), { title: 'Background question', active: true, color: null })
    await waitForThread(browser, [
      { role: 'user', text: 'Background question' },
      { role: 'agent', text: replyText('the background') },
      { role: 'user', text: '' },
    ])

    // The color does not come back when the tab goes to the background again.
    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'tab in the background again', () => tabLook(tabId), { title: 'Background question', active: false, color: null })
  })

  it('shows busy in the active tab, and no color when the reply ends there', async () => {
    await submit(browser, 'Foreground question')
    const request = await mock.waitForRequest(browser)
    const tabId = await activeTabId()
    await waitForValue(browser, 'tab while its reply streams', () => tabLook(tabId), { title: 'Foreground question', active: true, color: 'busy' })

    await sendChatReply(request.reply, 'the foreground')
    await waitForThread(browser, [
      { role: 'user', text: 'Foreground question' },
      { role: 'agent', text: replyText('the foreground') },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'tab after its reply', () => tabLook(tabId), { title: 'Foreground question', active: true, color: null })
  })
})
