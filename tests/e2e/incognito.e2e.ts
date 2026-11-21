import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { INCOGNITO_STAYS_ON, INCOGNITO_TOO_LATE } from '../../src/controller/tabs'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { consoleErrors, pointerClick, promptButtons, promptMessage, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { conversationFilePath, readAppState } from './harness/fixtures'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabId, newTab, pickModel, sbpCall, submit, waitForThread } from './harness/thread'

// Incognito tabs, through the real app against a mock server in this
// process:
// - a click on the mask of the bottom bar turns incognito on in a tab that
//   has sent nothing, with no prompt; its requests have no system prompt
//   and no tools of Dez, in both wire formats;
// - incognito never goes off, and it goes on only before the first request
//   of a tab (also one that the user stopped before any reply text): a
//   click then shows a notice with one OK button and changes nothing;
// - a provider with a system prompt of its own (`providerSystemPrompt`)
//   gets its off value in a normal request and its on value in an
//   incognito one;
// - the mark stays after a relaunch, also in an empty tab (only
//   app_state.json keeps it), and when History opens the conversation again
//   (its file keeps it).
//
// The seed sets `incognitoOption`, which shows the mask; the mask after the
// relaunch shows that the saves of the app kept it. One app session serves
// the whole file. The relaunch test goes on in the incognito tab of the
// first test.

const PROVIDER: MockProvider = { id: 'masked', name: 'Masked Mock', modelId: 'masked-model', modelName: 'Masked Model' }
// An Anthropic-format provider with a system prompt of its own.
const OWN: MockProvider = { id: 'own', name: 'Own Prompt Mock', modelId: 'own-model', modelName: 'Own Model', apiFormat: 'anthropic' }
const OWN_PROMPT = { bodyPath: 'own.prompt', onValue: 'on', offValue: 'off' }

describe('incognito tabs', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The incognito tab of the first test, with one reply, for the relaunch.
  let incognitoTab: { tabId: string, conversationId: string } | null = null

  // Whether the mask shows the active tab as incognito; null with no mask.
  async function maskOn (): Promise<boolean | null> {
    return browser.execute(() => {
      const mask = document.querySelector('.incognito-button')
      return mask ? mask.getAttribute('aria-pressed') === 'true' : null
    })
  }

  async function incognito (tabId: string): Promise<boolean> {
    return await sbpCall(browser, 'dez.model/tabs/incognito', tabId) as boolean
  }

  // A new tab with the model of `provider`, which a click on the mask
  // turns incognito, with no prompt.
  async function newIncognitoTab (provider: MockProvider): Promise<string> {
    await newTab(browser)
    await pickModel(browser, provider.name, provider.modelName)
    expect(await maskOn()).toBe(false)
    await pointerClick(browser, '.incognito-button')
    await waitForValue(browser, 'mask', maskOn, true)
    expect(await promptMessage(browser)).toBeNull()
    const tabId = await activeTabId(browser)
    expect(await incognito(tabId)).toBe(true)
    return tabId
  }

  // A click on the mask shows the notice `message` with one OK button, and
  // OK closes it: the active tab stays incognito when `on`, else normal.
  async function expectNotice (message: string, on: boolean): Promise<void> {
    await pointerClick(browser, '.incognito-button')
    await waitForValue(browser, 'notice', () => promptMessage(browser), message)
    expect(await promptButtons(browser)).toStrictEqual(['OK'])
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'notice after OK', () => promptMessage(browser), null)
    expect(await maskOn()).toBe(on)
    expect(await incognito(await activeTabId(browser))).toBe(on)
  }

  // How many times the saved file of `conversationId` holds `text`.
  async function savedCount (conversationId: string, text: string): Promise<number> {
    const content = await fs.promises.readFile(conversationFilePath(setup.app.home, conversationId), 'utf8').catch(() => '')
    return content.split(text).length - 1
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER, {}, {
      moreProviders: [{ provider: OWN, config: { providerSystemPrompt: OWN_PROMPT } }],
      appState: { incognitoOption: true },
    })
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

  it('sends no system prompt and no tools of Dez from an incognito tab, and stays incognito', async () => {
    const tabId = await newIncognitoTab(PROVIDER)
    await submit(browser, 'Hello')
    const request = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [{ role: 'user', content: 'Hello' }], { incognito: true }))
    await sendChatReply(request.reply, PROVIDER.modelName)
    await waitForThread(browser, [
      { role: 'user', text: 'Hello' },
      { role: 'agent', text: replyText(PROVIDER.modelName) },
      { role: 'user', text: '' },
    ])
    await expectNotice(INCOGNITO_STAYS_ON, true)
    incognitoTab = { tabId, conversationId: await activeConversationId(browser) }
  })

  it('refuses incognito in a tab that has a reply, or whose request the user stopped', async () => {
    await newTab(browser)
    await pickModel(browser, PROVIDER.name, PROVIDER.modelName)
    await submit(browser, 'Plain')
    const request = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [{ role: 'user', content: 'Plain' }]))
    await sendChatReply(request.reply, PROVIDER.modelName)
    await waitForThread(browser, [
      { role: 'user', text: 'Plain' },
      { role: 'agent', text: replyText(PROVIDER.modelName) },
      { role: 'user', text: '' },
    ])
    await expectNotice(INCOGNITO_TOO_LATE, false)

    // A stop before any reply text leaves no agent section, but the request
    // went out with the system prompt and the tools of Dez.
    await newTab(browser)
    await pickModel(browser, PROVIDER.name, PROVIDER.modelName)
    await submit(browser, 'Stopped')
    await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [{ role: 'user', content: 'Stopped' }]))
    await sbpCall(browser, 'dez.stream/stop', await activeTabId(browser))
    await waitForThread(browser, [{ role: 'user', text: 'Stopped' }])
    await expectNotice(INCOGNITO_TOO_LATE, false)
  })

  it('sends the off value of a provider\'s own system prompt from a normal tab, and the on value from an incognito one', async () => {
    await newTab(browser)
    await pickModel(browser, OWN.name, OWN.modelName)
    await submit(browser, 'Normal')
    const normal = await takeRequest(setup, mockChatPath(OWN), { ...anthropicChatBody(OWN, [anthropicMarkedUser('Normal')]), own: { prompt: 'off' } })
    sendAnthropicReply(normal.reply, OWN.modelName)
    await waitForThread(browser, [
      { role: 'user', text: 'Normal' },
      { role: 'agent', text: replyText(OWN.modelName) },
      { role: 'user', text: '' },
    ])

    await newIncognitoTab(OWN)
    await submit(browser, 'Secret')
    const masked = await takeRequest(setup, mockChatPath(OWN), { ...anthropicChatBody(OWN, [anthropicMarkedUser('Secret')], { incognito: true }), own: { prompt: 'on' } })
    sendAnthropicReply(masked.reply, OWN.modelName)
    await waitForThread(browser, [
      { role: 'user', text: 'Secret' },
      { role: 'agent', text: replyText(OWN.modelName) },
      { role: 'user', text: '' },
    ])
  })

  it('keeps incognito after a relaunch, also in an empty tab, and when History opens the conversation again', async () => {
    if (!incognitoTab) throw new Error('The first test made no incognito tab')
    const { tabId, conversationId } = incognitoTab
    const reply = replyText(PROVIDER.modelName)
    const emptyTabId = await newIncognitoTab(PROVIDER)
    await waitForValue(browser, 'saved marks of the incognito tabs', async () => {
      const tabs = ((await readAppState(setup.app.home))?.tabs ?? []) as Array<{ id: string, incognito?: true }>
      return [tabId, emptyTabId].map((id) => tabs.find((tab) => tab.id === id)?.incognito ?? null)
    }, [true, true])
    await waitForValue(browser, 'saved reply', () => savedCount(conversationId, reply), 1)

    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)
    // The tab bar shows before the app restores the saved tabs, and the
    // restore sets the active tab: the empty tab. Switch only after it, or
    // the restore switches back.
    await waitForValue(browser, 'restored active tab', () => activeTabId(browser), emptyTabId)
    // With no mask (a save that dropped `incognitoOption`), maskOn is null.
    await waitForValue(browser, 'mask of the empty tab', maskOn, true)

    // The next request of the tab with a reply has no system prompt and no
    // tools either.
    await sbpCall(browser, 'dez.model/tabs/switch', tabId)
    const thread = [{ role: 'user', text: 'Hello' }, { role: 'agent', text: reply }]
    await waitForThread(browser, [...thread, { role: 'user', text: '' }])
    expect(await maskOn()).toBe(true)
    await submit(browser, 'Still there?')
    const request = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: reply },
      { role: 'user', content: 'Still there?' },
    ], { incognito: true }))
    await sendChatReply(request.reply, PROVIDER.modelName)
    thread.push({ role: 'user', text: 'Still there?' }, { role: 'agent', text: reply })
    await waitForThread(browser, [...thread, { role: 'user', text: '' }])

    // A conversation that History opens has no entry in app_state.json: its
    // file keeps the mark.
    await waitForValue(browser, 'saved second reply', () => savedCount(conversationId, reply), 2)
    await sbpCall(browser, 'dez.controller/closeTab', tabId)
    const reopened = await sbpCall(browser, 'dez.model/tabs/openConversation', conversationId) as { id: string } | null
    if (!reopened) throw new Error('History did not open the conversation')
    expect(reopened.id).not.toBe(tabId)
    await waitForThread(browser, [...thread, { role: 'user', text: '' }])
    expect(await incognito(reopened.id)).toBe(true)
    expect(await maskOn()).toBe(true)
  })
})
