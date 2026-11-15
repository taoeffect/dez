import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextSize } from '../chat/contextSize'
import type { Compactions } from '../chat/compaction'
import { toolBlockText } from '../chat/toolBlocks'
import type { ActiveModel, ContentNode, ModelRef, Section, SectionThinking, Tab, ThinkingReplay } from '../chat/types'
import type { AppStatePayload, ConversationData, ModelCache } from '../persistence/types'
import { PRICE_LIFETIME_MS, type PriceQuote } from '../providers/modelPrices'
import type { ProviderConfig } from '../providers/config'
import type { ModelInfo, ModelRequest } from '../providers/types'
import type { SettingsSnapshot } from './index'
import { estimatedRequestTokens } from '../streams/contextEstimate'
import type { RequestMessages } from '../streams/types'
import type { Shortcut, ShortcutId } from '../shortcuts'
// Side-effect import: registers the dez.model/* selectors under test.
import './index'
import { appendThinkingToTabSection, appendTokenToTabSection, finalizeStreamSectionForTab, setThinkingReplayForTabSection } from './index'
import { finishStreamSession, startStreamSession } from './streams'
import { BUILT_IN_SYSTEM_PROMPT } from '../systemPrompt'
import { modelFamily } from '../providers/modelFamilies'
import { TOOL_DEFINITIONS } from '../tools/registry'

// Conversation ids that the stub disk load below was asked for. Reset in
// beforeEach.
let loadCalls: string[] = []

// Conversations that the stub disk load below returns instead of its default
// one. Reset in beforeEach.
const diskConversations = new Map<string, ConversationData>()

// What the stub app state load below returns, and each payload that the stub
// save got. Reset in beforeEach.
let diskAppState: AppStatePayload = {}
let savedAppStates: AppStatePayload[] = []

// Each model cache that the stub save got. Reset in beforeEach.
let savedModelCaches: ModelCache[] = []

// Stub the persistence selectors that the tab and settings selectors call.
// src/model/persistence/index.ts is never imported by this test, so these are
// the only dez.persistence/* registrations in the test process.
sbp('sbp/selectors/register', {
  async 'dez.persistence/loadConversation' (id: string): Promise<ConversationData> {
    loadCalls.push(id)
    const saved = diskConversations.get(id)
    if (saved) return saved
    return {
      id,
      title: `Title ${id}`,
      sections: [{ role: 'user', nodes: [{ kind: 'text', text: `disk text ${id}` }] }],
      activeModel: null,
      created_at: 1000,
    }
  },
  async 'dez.persistence/loadAppState' (): Promise<AppStatePayload> {
    return structuredClone(diskAppState)
  },
  async 'dez.persistence/saveAppState' (state: AppStatePayload): Promise<void> {
    // A JSON copy, as the real save writes: the payload holds store proxies,
    // which structuredClone refuses.
    savedAppStates.push(JSON.parse(JSON.stringify(state)) as AppStatePayload)
  },
  async 'dez.persistence/deleteConversation' (): Promise<void> {},
  async 'dez.persistence/loadModelCache' (): Promise<ModelCache> {
    return { providers: {}, version: 1 }
  },
  async 'dez.persistence/saveModelCache' (cache: ModelCache): Promise<void> {
    savedModelCaches.push(structuredClone(cache))
  },
  // dez.model/settings/init applies the loaded theme and font size.
  'dez.ui/applyTheme' (): void {},
  'dez.ui/applyEditorFontSize' (): void {},
})

function tabs (): Tab[] {
  return sbp('dez.model/tabs/list') as Tab[]
}

function activeId (): string {
  return sbp('dez.model/tabs/activeId') as string
}

async function openConversation (id: string): Promise<Tab | null> {
  return await sbp('dez.model/tabs/openConversation', id) as Tab | null
}

function activeTab (): Tab {
  return tabs().find((tab) => tab.id === activeId()) as Tab
}

// What the editor does when the user types: the text and the title change
// in the store only; nothing is saved to disk.
function typeText (tabId: string, text: string): void {
  sbp('dez.model/tabs/replaceSections', tabId, [{ id: crypto.randomUUID(), role: 'user', content: [{ kind: 'text', text }] }])
}

function tabWithText (text: string): Tab {
  const tab = sbp('dez.model/tabs/create') as Tab
  typeText(tab.id, text)
  return tab
}

beforeEach(() => {
  setActivePinia(createPinia())
  loadCalls = []
  diskConversations.clear()
  diskAppState = {}
  savedAppStates = []
  savedModelCaches = []
})

describe('dez.model/tabs/openConversation', () => {
  it('switches to the open tab of a conversation instead of adding a second tab', async () => {
    const opened = await openConversation('conv-a')
    sbp('dez.model/tabs/create')
    const tabCount = tabs().length

    const reopened = await openConversation('conv-a')

    expect(tabs()).toHaveLength(tabCount)
    expect(reopened?.id).toBe(opened?.id)
    expect(activeId()).toBe(opened?.id)
    // The open tab is the newest copy, so the file is not loaded again.
    expect(loadCalls).toEqual(['conv-a'])
  })

  it('adds one tab when two calls for the same conversation overlap', async () => {
    const tabCount = tabs().length

    const [first, second] = await Promise.all([openConversation('conv-a'), openConversation('conv-a')])

    expect(tabs()).toHaveLength(tabCount + 1)
    expect(second?.id).toBe(first?.id)
    expect(activeId()).toBe(first?.id)
  })

  // App state saved before the fix can hold several tabs with one
  // conversation id. They stay open; the active one wins, else the first.
  it('picks the active tab, else the first, among duplicate tabs', async () => {
    const tabData = (id: string, conversationId: string) => ({
      id,
      title: id,
      conversationId,
      activeModel: null,
      createdAt: 1000,
    })
    const savedTabs = [tabData('t1', 'conv-a'), tabData('t2', 'conv-b'), tabData('t3', 'conv-a')]

    await sbp('dez.model/appState/restore', { tabs: savedTabs, activeTabId: 't3' })
    expect((await openConversation('conv-a'))?.id).toBe('t3')
    expect(activeId()).toBe('t3')

    sbp('dez.model/tabs/switch', 't2')
    expect((await openConversation('conv-a'))?.id).toBe('t1')
    expect(activeId()).toBe('t1')

    expect(tabs().map((tab) => tab.id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('dez.model/tabs/reopenClosed', () => {
  function reopen (): boolean {
    return sbp('dez.model/tabs/reopenClosed') as boolean
  }

  function close (tabId: string): void {
    sbp('dez.model/tabs/close', tabId)
  }

  function titles (): string[] {
    return tabs().map((tab) => tab.title)
  }

  it('reopens the newest closed tab first, at its old place, active, with its unsent text', () => {
    const first = tabWithText('first')
    const second = tabWithText('second')
    tabWithText('third')
    close(first.id)
    close(second.id)
    expect(titles()).toEqual(['New Tab', 'third'])

    expect(reopen()).toBe(true)
    expect(titles()).toEqual(['New Tab', 'second', 'third'])
    expect(activeTab().title).toBe('second')
    expect(activeTab().conversationId).toBe(second.conversationId)
    expect(activeTab().sections.map((section) => section.content)).toEqual([[{ kind: 'text', text: 'second' }]])
    // A new id: a stream session of the closed tab must not attach to it.
    expect(activeTab().id).not.toBe(second.id)

    expect(reopen()).toBe(true)
    expect(titles()).toEqual(['New Tab', 'first', 'second', 'third'])
    expect(activeTab().title).toBe('first')
  })

  it('puts the tab last when fewer tabs are left than its old place', () => {
    tabWithText('a')
    const b = tabWithText('b')
    close(b.id)
    close(tabs()[0].id)
    expect(titles()).toEqual(['a'])

    expect(reopen()).toBe(true)
    expect(titles()).toEqual(['a', 'b'])
  })

  it('lists no empty tab, and the last tab never closes', () => {
    typeText(activeId(), 'only')
    close(activeId())
    close((sbp('dez.model/tabs/create') as Tab).id)

    expect(reopen()).toBe(false)
    expect(titles()).toEqual(['only'])
  })

  it('switches to an open tab of the conversation instead of adding a second one', async () => {
    const closed = tabWithText('kept')
    close(closed.id)
    const opened = await openConversation(closed.conversationId)
    sbp('dez.model/tabs/switch', tabs()[0].id)
    const tabCount = tabs().length

    expect(reopen()).toBe(true)
    expect(tabs()).toHaveLength(tabCount)
    expect(activeId()).toBe(opened?.id)
    expect(reopen()).toBe(false)
  })

  it('keeps only the newest closed copy of a conversation', async () => {
    const closed = tabWithText('old text')
    close(closed.id)
    const opened = await openConversation(closed.conversationId) as Tab
    typeText(opened.id, 'new text')
    close(opened.id)

    expect(reopen()).toBe(true)
    expect(activeTab().title).toBe('new text')
    expect(reopen()).toBe(false)
  })

  it('never brings back a deleted conversation', async () => {
    const closed = tabWithText('deleted')
    close(closed.id)
    await sbp('dez.model/tabs/deleteConversation', closed.conversationId)

    expect(reopen()).toBe(false)
  })

  it('remembers the last 20 closed tabs', () => {
    const closed = Array.from({ length: 21 }, (_, index) => tabWithText(`tab ${index}`))
    for (const tab of closed) close(tab.id)

    const reopened: string[] = []
    while (reopen()) reopened.push(activeTab().title)
    expect(reopened).toEqual(Array.from({ length: 20 }, (_, index) => `tab ${20 - index}`))
  })
})

describe('conversation cost and edited flag of a tab', () => {
  function conversationData (tabId: string): ConversationData {
    return sbp('dez.model/tabs/conversationData', tabId) as ConversationData
  }

  it('adds each request to its own tab, a known price to the sum and any other to the unpriced count', () => {
    const priced = tabWithText('priced')
    const other = tabWithText('other')

    for (const usd of [0.25, null, 0, 0.5, Number.NaN, -1]) sbp('dez.model/tabs/countRequestCost', priced.id, usd)
    sbp('dez.model/tabs/countRequestCost', 'missing', 1)

    expect(conversationData(priced.id).cost).toStrictEqual({ usd: 0.75, requests: 6, unpriced: 3 })
    expect(conversationData(other.id)).not.toHaveProperty('cost')
  })

  it('marks only the edited tab, and saves no mark for a tab that has none', () => {
    const edited = tabWithText('edited')
    const other = tabWithText('other')

    sbp('dez.model/tabs/markAgentTextEdited', edited.id)
    sbp('dez.model/tabs/markAgentTextEdited', 'missing')

    expect(sbp('dez.model/tabs/agentTextEdited', edited.id)).toBe(true)
    expect(sbp('dez.model/tabs/agentTextEdited', other.id)).toBe(false)
    expect(conversationData(edited.id).agentTextEdited).toBe(true)
    expect(conversationData(other.id)).not.toHaveProperty('agentTextEdited')
  })

  it('keeps the cost and the mark through a reload of the conversation and a reopen of the closed tab', async () => {
    const tab = tabWithText('kept')
    sbp('dez.model/tabs/countRequestCost', tab.id, 0.5)
    sbp('dez.model/tabs/markAgentTextEdited', tab.id)
    diskConversations.set('conv-copy', { ...conversationData(tab.id), id: 'conv-copy' })

    const reloaded = await openConversation('conv-copy') as Tab
    sbp('dez.model/tabs/close', tab.id)
    sbp('dez.model/tabs/reopenClosed')
    const reopened = activeTab()

    for (const copy of [reloaded, reopened]) {
      expect(copy.cost).toStrictEqual({ usd: 0.5, requests: 1, unpriced: 0 })
      expect(copy.agentTextEdited).toBe(true)
    }
  })

  // A copy that loses the numbers would show the cost of the whole
  // conversation as the cost of the part since its newest compaction.
  it('keeps the compaction numbers of a conversation through its load, its save, and a reopen of the closed tab, as copies', async () => {
    const compactions = { count: 2, tokens: 412000, cost: { usd: 0.3, requests: 5, unpriced: 1 } }
    diskConversations.set('conv-compacted', {
      id: 'conv-compacted',
      title: 'Compacted',
      sections: [{ role: 'agent', nodes: [{ kind: 'text', text: '<dez:compaction count="2"/>\nNotes' }] }, { role: 'user', nodes: [{ kind: 'text', text: 'Next' }] }],
      activeModel: null,
      created_at: 1000,
      compactions,
    })

    const loaded = await openConversation('conv-compacted') as Tab
    const saved = conversationData(loaded.id)
    sbp('dez.model/tabs/close', loaded.id)
    sbp('dez.model/tabs/reopenClosed')

    for (const copy of [loaded, saved, activeTab()]) {
      expect(copy.compactions).toStrictEqual(compactions)
      expect(copy.compactions).not.toBe(compactions)
      expect(copy.compactions?.cost).not.toBe(compactions.cost)
    }
    expect(loaded.sections[0].role).toBe('agent')
    expect(conversationData(tabWithText('plain').id)).not.toHaveProperty('compactions')
  })
})

describe('context size of a tab', () => {
  // A model of a family with 4 characters per token, and one with 2.5.
  const gpt: ModelRef = { providerId: 'local', modelId: 'gpt-5.4' }
  const claude: ModelRef = { providerId: 'local', modelId: 'claude-sonnet-4-5' }
  const size = (tabId: string) => sbp('dez.model/tabs/contextSize', tabId) as ContextSize | undefined
  const counted = (tabId: string) => (sbp('dez.model/tabs/conversationData', tabId) as ConversationData).context
  const letters = (count: number) => 'x'.repeat(count)

  // A new tab of `model` with one user message. The tab is the active one.
  function tabOf (model: ModelRef, text: string): Tab {
    const tab = tabWithText(text)
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelId)
    return tab
  }

  // With no system prompt and no tools, a request is only its messages,
  // so that a test can tell each count from the length of its text.
  beforeEach(() => {
    sbp('dez.model/settings/setSystemPrompt', '')
    sbp('dez.model/settings/setProviderSetting', 'local', 'tools', false)
  })

  it('estimates a tab that no request counted, by the family of its model', () => {
    const noModel = tabWithText(letters(100))
    const ofGpt = tabOf(gpt, letters(100))
    const ofClaude = tabOf(claude, letters(100))

    expect(size(noModel.id)).toStrictEqual({ tokens: 40, estimated: true })
    expect(size(ofGpt.id)).toStrictEqual({ tokens: 25, estimated: true })
    expect(size(ofClaude.id)).toStrictEqual({ tokens: 40, estimated: true })
    expect(size('missing')).toBeUndefined()
    expect(counted(ofGpt.id)).toBeUndefined()
  })

  it('counts the system prompt and the tools only of a request that sends them', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tab = tabOf(gpt, letters(100))
    const tokens = () => size(tab.id)?.tokens

    sbp('dez.model/settings/setSystemPrompt', letters(40))
    expect(tokens()).toBe(35)
    // No request goes with a template that has a problem.
    sbp('dez.model/settings/setSystemPrompt', 'Hi {{nope}}')
    expect(tokens()).toBe(25)
    expect(consoleError).not.toHaveBeenCalled()
    // A media model gets no system prompt and no tools.
    sbp('dez.model/settings/setSystemPrompt', letters(40))
    sbp('dez.model/settings/resetProviderSettings', 'local', ['tools'])
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, models: [{ id: gpt.modelId, name: 'G', provider: 'local', request: 'video' }] })
    expect(tokens()).toBe(25)

    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, models: [{ id: gpt.modelId, name: 'G', provider: 'local' }] })
    const withTools = estimatedRequestTokens({ system: letters(40), tools: TOOL_DEFINITIONS, messages: [{ role: 'user', content: letters(100) }] }, modelFamily(gpt.modelId))
    expect(tokens()).toBe(withTools)
    expect(withTools).toBeGreaterThan(35)
  })

  it('keeps the count of a request in its own tab, as a whole number, and nothing for a missing tab', () => {
    const tab = tabOf(gpt, letters(100))
    const other = tabOf(gpt, letters(100))

    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 5000.4)
    sbp('dez.model/tabs/countRequestContext', 'missing', gpt, 1)

    expect(counted(tab.id)).toStrictEqual({ tokens: 5000, estimate: 25 })
    expect(size(tab.id)).toStrictEqual({ tokens: 5000, estimated: false })
    expect(sbp('dez.model/tabs/conversationData', other.id)).not.toHaveProperty('context')
    expect(size(other.id)).toStrictEqual({ tokens: 25, estimated: true })
  })

  it('follows the text of the tab from the count of the provider', () => {
    const tab = tabOf(gpt, letters(100))
    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 5000)

    typeText(tab.id, letters(500))
    expect(size(tab.id)).toStrictEqual({ tokens: 5100, estimated: true })
    typeText(tab.id, letters(20))
    expect(size(tab.id)).toStrictEqual({ tokens: 4980, estimated: true })
    typeText(tab.id, letters(100))
    expect(size(tab.id)).toStrictEqual({ tokens: 5000, estimated: false })
    // A newer count replaces the older one.
    typeText(tab.id, letters(500))
    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 7000)
    expect(size(tab.id)).toStrictEqual({ tokens: 7000, estimated: false })
  })

  // The answer's calls are in its output tokens before the tab holds their
  // blocks: 40 characters of calls are 10 tokens of the estimate.
  it('takes the tool calls of the answer into the estimate of the count', () => {
    const tab = tabOf(gpt, letters(100))

    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 5000, [{ id: 'call_1', name: 'echo', argumentsText: letters(36) }])

    expect(counted(tab.id)).toStrictEqual({ tokens: 5000, estimate: 35 })
  })

  it('shows an estimate when the active model is not the one of the count', () => {
    const tab = tabOf(gpt, letters(100))
    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 5000)

    sbp('dez.model/setActiveModel', claude.providerId, claude.modelId, claude.modelId)

    expect(size(tab.id)).toStrictEqual({ tokens: 5015, estimated: true })
  })

  // A reply asks for the size of its own request, and the user can choose
  // another model for the tab while the reply runs.
  it('counts by the model that the caller names, in place of the active model of the tab', () => {
    const tab = tabOf(gpt, letters(100))

    expect(sbp('dez.model/tabs/contextSize', tab.id, claude)).toStrictEqual({ tokens: 40, estimated: true })
    expect(size(tab.id)).toStrictEqual({ tokens: 25, estimated: true })
  })

  // The requests of a reply that runs hold the pictures of its
  // `asset_view` calls; the request of the next reply holds none.
  it('counts the pictures of the reply that runs, each by the size of its copy, and not after the reply', () => {
    sbp('dez.model/settings/resetProviderSettings', 'local', ['tools'])
    const tab = tabOf(claude, letters(100))
    const pictures = [{ file: 'w1.jpg', label: letters(25), width: 800, height: 200, bytes: 3000 }]
    const view = (id: string) => toolBlockText({ id, name: 'asset_view', status: 'success', arguments: { assets: '@b' }, result: 'ok', pictures })
    sbp('dez.model/tabs/replaceSections', tab.id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: letters(100) }] },
      { id: 'a1', role: 'agent', model: claude, content: [{ kind: 'text', text: view('call_1') }] },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: letters(100) }] },
      { id: 'a2', role: 'agent', model: claude, content: [{ kind: 'text', text: view('call_2') }] },
    ])
    const withNoPicture = size(tab.id)?.tokens as number

    startStreamSession({ tabId: tab.id, sectionId: 'a2', model: { ...claude, modelName: 'Claude' }, messages: [] })
    // Only the picture of the section `a2`: its label (25 characters are
    // 10 tokens), and 800 by 200 pixels (232 tokens).
    expect(size(tab.id)).toStrictEqual({ tokens: withNoPicture + 242, estimated: true })

    finishStreamSession(tab.id)
    expect(size(tab.id)).toStrictEqual({ tokens: withNoPicture, estimated: true })
  })

  it('keeps the count through a reload of the conversation and a reopen of the closed tab', async () => {
    const tab = tabOf(gpt, letters(100))
    sbp('dez.model/tabs/countRequestContext', tab.id, gpt, 5000)
    diskConversations.set('conv-copy', { ...sbp('dez.model/tabs/conversationData', tab.id) as ConversationData, id: 'conv-copy' })

    const reloaded = await openConversation('conv-copy') as Tab
    sbp('dez.model/tabs/close', tab.id)
    sbp('dez.model/tabs/reopenClosed')
    const reopened = activeTab()

    for (const copy of [reloaded, reopened]) {
      expect(copy.context).toStrictEqual({ tokens: 5000, estimate: 25 })
      expect(size(copy.id)).toStrictEqual({ tokens: 5000, estimated: false })
    }
  })
})

describe('dez.model/tabs/compact', () => {
  const model: ModelRef = { providerId: 'local', modelId: 'gpt-5.4' }
  const section = (id: string, role: Section['role'], text: string): Section => ({ id, role, content: [{ kind: 'text', text }], ...(role === 'agent' && { model }) })
  const compact = (tabId: string, sections: Section[], tokens: number, replySectionId = 'b') => sbp('dez.model/tabs/compact', tabId, { sections, replySectionId, tokens }) as boolean
  const tabNow = (tabId: string) => tabs().find((tab) => tab.id === tabId) as Tab
  // What a compaction gives for the conversation of `conversation`: the
  // notes, the two messages of the user, and the empty reply.
  const compacted = (count = 1): Section[] => [
    section('notes', 'agent', `<dez:compaction count="${count}"/>\nThe notes.`),
    section('u1', 'user', 'First'),
    section('u2', 'user', 'Newest'),
    section('b', 'agent', ''),
  ]

  // A tab whose reply `b` runs.
  function conversation (): Tab {
    const tab = tabWithText('x')
    sbp('dez.model/tabs/replaceSections', tab.id, [
      section('u1', 'user', 'First'),
      section('a1', 'agent', 'An old reply'),
      section('u2', 'user', 'Newest'),
      section('b', 'agent', 'The reply so far'),
    ])
    return tab
  }

  it('puts the new sections in place of the sections up to the reply, with the numbers of the compaction', () => {
    const tab = conversation()
    sbp('dez.model/tabs/countRequestCost', tab.id, 0.5)
    sbp('dez.model/tabs/countRequestContext', tab.id, model, 150_000)

    expect(compact(tab.id, compacted(), 150_000.4)).toBe(true)

    const now = tabNow(tab.id)
    expect(now.sections).toStrictEqual(compacted())
    expect(now.title).toBe('First')
    expect(now.compactions).toStrictEqual({ count: 1, tokens: 150_000, cost: { usd: 0.5, requests: 1, unpriced: 0 } })
    // With the count of the old text, the size of the new text would be
    // near 0.
    expect(now).not.toHaveProperty('context')
    expect(sbp('dez.model/tabs/contextSize', tab.id, model)).toMatchObject({ estimated: true })
  })

  // The user can type a next message while the compaction request runs.
  it('keeps the sections of the tab after the reply as they are at the swap', () => {
    const tab = conversation()
    const typed = section('u3', 'user', 'Typed while the request ran')
    sbp('dez.model/tabs/replaceSections', tab.id, [...tabNow(tab.id).sections, typed])

    // The result holds that section as it was at the start of the request.
    expect(compact(tab.id, [...compacted(), section('u3', 'user', '')], 1000)).toBe(true)

    expect(tabNow(tab.id).sections).toStrictEqual([...compacted(), typed])
  })

  it('adds each compaction to the numbers, with the cost of the tab at the newest one', () => {
    const tab = conversation()

    compact(tab.id, compacted(), 150_000)
    // A tab that counted no request yet has a cost of nothing.
    expect(tabNow(tab.id).compactions).toStrictEqual({ count: 1, tokens: 150_000, cost: { usd: 0, requests: 0, unpriced: 0 } })
    sbp('dez.model/tabs/countRequestCost', tab.id, 0.25)
    sbp('dez.model/tabs/countRequestCost', tab.id, null)
    compact(tab.id, compacted(2), 90_000)

    expect(tabNow(tab.id).compactions).toStrictEqual({ count: 2, tokens: 240_000, cost: { usd: 0.25, requests: 2, unpriced: 1 } })
  })

  it('gives the numbers of the compactions of a tab as a copy, and nothing before its first one', () => {
    const tab = conversation()
    const numbers = () => sbp('dez.model/tabs/compactions', tab.id) as Compactions | undefined
    expect(numbers()).toBeUndefined()
    expect(sbp('dez.model/tabs/compactions', 'missing')).toBeUndefined()

    sbp('dez.model/tabs/countRequestCost', tab.id, 0.5)
    compact(tab.id, compacted(), 150_000)
    const read = numbers() as Compactions
    expect(read).toStrictEqual({ count: 1, tokens: 150_000, cost: { usd: 0.5, requests: 1, unpriced: 0 } })

    // A change of the read numbers changes nothing in the tab.
    read.cost.usd = 9
    read.tokens = 1
    expect(numbers()).toStrictEqual({ count: 1, tokens: 150_000, cost: { usd: 0.5, requests: 1, unpriced: 0 } })
  })

  it('changes nothing for a missing tab, and for a reply whose section is gone', () => {
    const tab = conversation()
    sbp('dez.model/tabs/countRequestContext', tab.id, model, 150_000)
    const before = tabNow(tab.id)

    expect(compact('missing', compacted(), 1000)).toBe(false)
    // The user merged the reply's section into the one before.
    expect(compact(tab.id, compacted(), 1000, 'gone')).toBe(false)
    expect(compact(tab.id, compacted().slice(0, 3), 1000)).toBe(false)

    expect(tabNow(tab.id)).toStrictEqual(before)
  })
})

describe('dez.model/heldTexts', () => {
  it('gives each text and prompt body of the open and the closed tabs, each saved prompt, and the system prompt template', () => {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      {
        id: 'u1',
        role: 'user',
        content: [
          { kind: 'text', text: 'open /a/one.png' },
          { kind: 'prompt', id: 'p1', promptId: 'saved', name: 'Review', body: 'body two.png' },
          { kind: 'text', text: 'tail' },
        ],
      },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: 'reply three.png' }] },
    ])
    const closed = sbp('dez.model/tabs/create') as Tab
    sbp('dez.model/tabs/replaceSections', closed.id, [{ id: 'u2', role: 'user', content: [{ kind: 'text', text: 'closed four.png' }] }])
    sbp('dez.model/tabs/close', closed.id)
    sbp('dez.model/prompts/add', 'Saved', 'prompt five.png')
    sbp('dez.model/settings/setSystemPrompt', 'system six.png')

    // One text for each node: a joined text would read `one.pngbody`.
    expect(sbp('dez.model/heldTexts')).toEqual([
      'open /a/one.png',
      'body two.png',
      'tail',
      'reply three.png',
      'closed four.png',
      'prompt five.png',
      'system six.png',
    ])
  })
})

describe('dez.model/tabs/move', () => {
  function move (tabId: string, toIndex: number): void {
    sbp('dez.model/tabs/move', tabId, toIndex)
  }

  function order (): string[] {
    return tabs().map((tab) => tab.id)
  }

  // Four tabs; the second one is active.
  function fourTabs (): string[] {
    for (let count = 0; count < 3; count++) sbp('dez.model/tabs/create')
    const ids = order()
    sbp('dez.model/tabs/switch', ids[1])
    return ids
  }

  it('puts the tab at the given index, forward and backward, and keeps the active tab', () => {
    const [a, b, c, d] = fourTabs()

    move(a, 1)
    expect(order()).toEqual([b, a, c, d])
    move(b, 2)
    expect(order()).toEqual([a, c, b, d])
    move(d, 0)
    expect(order()).toEqual([d, a, c, b])
    expect(activeId()).toBe(b)
  })

  it('clamps the index to the list', () => {
    const [a, b, c, d] = fourTabs()

    move(b, 99)
    expect(order()).toEqual([a, c, d, b])
    move(b, -5)
    expect(order()).toEqual([b, a, c, d])
  })

  it('changes nothing for a missing tab or the index the tab has', () => {
    const ids = fourTabs()

    move('missing', 0)
    move(ids[2], 2)
    expect(order()).toEqual(ids)
  })
})

describe('tab titles', () => {
  function titleFor (text: string): string {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: '  ' }] },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text }] },
    ])
    return activeTab().title
  }

  it('shows each image reference as [image], never its path', () => {
    const image = (name: string) => `/home/user/.config/dez/assets/images/${name}.png`

    expect(titleFor(`![${image('a')}]()`)).toBe('[image]')
    expect(titleFor(`Compare ![${image('a')}]() and ![${image('b')}]()`)).toBe('Compare [image] and [image]')
    expect(titleFor(`![${image('a')}]() ![${image('b')}]() Which one is brighter?`)).toBe('[image] [image] Which one is b…')
  })

  it('shows each clip tag of a dropped clip as its kind, never its path', () => {
    const tag = '<dez:video id="a" type="video/mp4" src="/home/user/.config/dez/assets/video/a.mp4"/>'

    expect(titleFor(`${tag}\nMake it dance`)).toBe('[video]\nMake it dance')
  })

  it('goes back to New Tab when no user text is left', () => {
    const image = '/home/user/.config/dez/assets/images/a.png'

    expect(titleFor(`![${image}](id=a)`)).toBe('[image]')
    expect(titleFor('')).toBe('New Tab')
    expect(titleFor('hi')).toBe('hi')
    expect(titleFor(' \n ')).toBe('New Tab')
  })
})

describe('section models', () => {
  const alpha: ModelRef = { providerId: 'local', modelId: 'alpha' }
  // submitTab passes the tab's ActiveModel; only the ref fields are stored.
  const beta: ActiveModel = { providerId: 'openrouter', modelId: 'vendor/beta', modelName: 'Beta' }
  const betaRef: ModelRef = { providerId: 'openrouter', modelId: 'vendor/beta' }

  function text (value: string): ContentNode[] {
    return [{ kind: 'text', text: value }]
  }

  function threadSections (): Section[] {
    return sbp('dez.model/thread/sections') as Section[]
  }

  // 'none' marks a section without the `key` field, so `model: undefined`
  // (or `thinking`, `durationMs`) fails the strict compares below.
  function stored<K extends 'model' | 'thinking' | 'durationMs'> (sections: Partial<Pick<Section, K>>[], key: K): (Section[K] | 'none')[] {
    return sections.map((section) => (key in section ? section[key] as Section[K] : 'none'))
  }

  function ensureAgentSection (model: ModelRef): Section {
    return sbp('dez.model/ensureTrailingAgentSectionForTab', activeId(), model) as Section
  }

  // What the editor does on a doc change: it writes every section back.
  function typeIntoLastSection (value: string): void {
    const sections = threadSections()
    sections[sections.length - 1].content = text(value)
    sbp('dez.model/tabs/replaceSections', activeId(), sections)
  }

  it('stamps each agent section with the model of its request across a model switch', () => {
    typeIntoLastSection('first question')
    const first = ensureAgentSection(alpha)
    appendTokenToTabSection(activeId(), first.id, 'first answer')
    finalizeStreamSectionForTab({ tabId: activeId(), sectionId: first.id, status: 'finished', model: { ...alpha, modelName: 'Alpha' }, startedAt: 1000, updatedAt: 1500, finishedAt: 1500, compacting: false })
    typeIntoLastSection('second question')
    const second = ensureAgentSection(beta)

    const sections = threadSections()
    expect([sections[1].id, sections[3].id]).toEqual([first.id, second.id])
    expect(sections.map((section) => section.role)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(stored(sections, 'model')).toStrictEqual(['none', alpha, 'none', betaRef])
  })

  it('gives a reused empty agent section the new model and changes the identity', () => {
    typeIntoLastSection('question')
    const first = ensureAgentSection(alpha)
    const identityBefore = sbp('dez.model/thread/sectionsIdentity') as string

    const second = ensureAgentSection(beta)

    expect(second.id).toBe(first.id)
    expect(threadSections()).toHaveLength(2)
    expect(stored(threadSections(), 'model')).toStrictEqual(['none', betaRef])
    expect(sbp('dez.model/thread/sectionsIdentity')).not.toBe(identityBefore)
  })

  it('keeps section models through conversationData and a reload of the conversation', async () => {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text('modeled answer'), model: alpha },
      { id: 'a2', role: 'agent', content: text('legacy answer') },
      { id: 'u2', role: 'user', content: text('') },
    ])

    const data = sbp('dez.model/tabs/conversationData', activeId()) as ConversationData
    expect(stored(data.sections, 'model')).toStrictEqual(['none', alpha, 'none', 'none'])

    diskConversations.set('conv-copy', { ...data, id: 'conv-copy' })
    const reopened = await openConversation('conv-copy')
    expect(reopened?.conversationId).toBe('conv-copy')
    expect(stored(reopened?.sections ?? [], 'model')).toStrictEqual(['none', alpha, 'none', 'none'])
  })

  it('keeps section thinking through edits, conversationData and a reload of the conversation', async () => {
    const thinking: SectionThinking = {
      text: 'step one\nstep two',
      replay: { kind: 'reasoningDetails', details: [{ type: 'reasoning.text', text: 'step one\n', index: 0 }], prefixHash: 'h' },
      rounds: [{ afterToolCall: 'call_1', from: 9, replay: { kind: 'field', field: 'reasoning' } }],
    }
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text('answer'), model: alpha, thinking },
      { id: 'u2', role: 'user', content: text('') },
    ])
    typeIntoLastSection('next question')

    expect(stored(threadSections(), 'thinking')).toStrictEqual(['none', thinking, 'none'])
    const data = sbp('dez.model/tabs/conversationData', activeId()) as ConversationData
    expect(stored(data.sections, 'thinking')).toStrictEqual(['none', thinking, 'none'])

    diskConversations.set('conv-copy', { ...data, id: 'conv-copy' })
    const reopened = await openConversation('conv-copy')
    expect(stored(reopened?.sections ?? [], 'thinking')).toStrictEqual(['none', thinking, 'none'])
  })

  it('clears the old thinking and duration of a reused empty agent section', () => {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text(''), model: alpha, thinking: { text: 'cut off' }, durationMs: 4213 },
    ])

    const reused = ensureAgentSection(beta)

    expect(reused.id).toBe('a1')
    expect(stored(threadSections(), 'thinking')).toStrictEqual(['none', 'none'])
    expect(stored(threadSections(), 'durationMs')).toStrictEqual(['none', 'none'])
  })

  // A reply that calls tools makes several request rounds. A later round's
  // thinking and replay go to its own entry, which starts where the text so
  // far ends; a round with neither gets no entry.
  it('adds a later round on its first thinking or replay and sets the replay of each round', () => {
    typeIntoLastSection('question')
    const agent = ensureAgentSection(alpha)
    const first: ThinkingReplay = { kind: 'field', field: 'reasoning_content' }
    const later: ThinkingReplay = { kind: 'copilot', opaque: 'op', prefixHash: 'h' }

    appendThinkingToTabSection(activeId(), agent.id, 'Plan.')
    setThinkingReplayForTabSection(activeId(), agent.id, first)
    appendThinkingToTabSection(activeId(), agent.id, 'Look', 'call_2')
    appendThinkingToTabSection(activeId(), agent.id, ' again.', 'call_2')
    setThinkingReplayForTabSection(activeId(), agent.id, later, 'call_2')
    setThinkingReplayForTabSection(activeId(), agent.id, later, 'call_3')

    expect(stored(threadSections(), 'thinking')).toStrictEqual(['none', {
      text: 'Plan.Look again.',
      replay: first,
      rounds: [{ afterToolCall: 'call_2', from: 5, replay: later }, { afterToolCall: 'call_3', from: 16, replay: later }],
    }])
  })

  it('makes the thinking of a later round when the first round had none', () => {
    typeIntoLastSection('question')
    const agent = ensureAgentSection(alpha)

    appendThinkingToTabSection(activeId(), agent.id, 'Look.', 'call_1')

    expect(stored(threadSections(), 'thinking')).toStrictEqual(['none', { text: 'Look.', rounds: [{ afterToolCall: 'call_1', from: 0 }] }])
  })

  it('changes the identity when a section gains thinking, a replay, or a round, or loses its thinking on reuse', () => {
    const sections = (thinking?: SectionThinking): Section[] => [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text(''), model: alpha, ...(thinking ? { thinking } : {}) },
    ]
    const identity = (): string => sbp('dez.model/thread/sectionsIdentity') as string
    const replay: ThinkingReplay = { kind: 'field', field: 'reasoning' }
    sbp('dez.model/tabs/replaceSections', activeId(), sections())
    const withoutThinking = identity()
    sbp('dez.model/tabs/replaceSections', activeId(), sections({ text: 'cut off' }))
    const withText = identity()
    sbp('dez.model/tabs/replaceSections', activeId(), sections({ text: 'cut off', replay }))
    const withReplay = identity()
    sbp('dez.model/tabs/replaceSections', activeId(), sections({ text: 'cut off', replay, rounds: [{ afterToolCall: 'call_1', from: 3 }] }))
    const withRound = identity()

    ensureAgentSection(alpha)

    expect(withText).not.toBe(withoutThinking)
    expect(withReplay).not.toBe(withText)
    expect(withRound).not.toBe(withReplay)
    expect(identity()).not.toBe(withRound)
  })

  it('keeps section durations through edits, conversationData and a reload of the conversation', async () => {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text('timed answer'), model: alpha, durationMs: 4213 },
      { id: 'a2', role: 'agent', content: text('legacy answer') },
      { id: 'u2', role: 'user', content: text('') },
    ])
    typeIntoLastSection('next question')

    expect(stored(threadSections(), 'durationMs')).toStrictEqual(['none', 4213, 'none', 'none'])
    const data = sbp('dez.model/tabs/conversationData', activeId()) as ConversationData
    expect(stored(data.sections, 'durationMs')).toStrictEqual(['none', 4213, 'none', 'none'])

    diskConversations.set('conv-copy', { ...data, id: 'conv-copy' })
    const reopened = await openConversation('conv-copy')
    expect(stored(reopened?.sections ?? [], 'durationMs')).toStrictEqual(['none', 4213, 'none', 'none'])
  })

  // The editor copies store metadata only when this identity changes, so a
  // duration stamped at the stream end, or dropped from a reused section,
  // must change it.
  it('changes the identity when a section gains or loses its duration', () => {
    const sections = (durationMs?: number): Section[] => [
      { id: 'u1', role: 'user', content: text('question') },
      { id: 'a1', role: 'agent', content: text('answer'), model: alpha, ...(durationMs === undefined ? {} : { durationMs }) },
    ]
    const identity = (): string => sbp('dez.model/thread/sectionsIdentity') as string
    sbp('dez.model/tabs/replaceSections', activeId(), sections())
    const untimed = identity()
    sbp('dez.model/tabs/replaceSections', activeId(), sections(4213))
    const timed = identity()
    sbp('dez.model/tabs/replaceSections', activeId(), sections())

    expect(timed).not.toBe(untimed)
    expect(identity()).toBe(untimed)
  })
})

describe('dez.model/customProviders/save', () => {
  // A config object that the store shares with its caller would change with
  // it (the Settings form edits its own copy).
  it('keeps the per-model fields of a config, and shares no object with the caller', () => {
    const config: ProviderConfig = {
      id: 'local',
      name: 'Local',
      baseUrl: 'http://localhost:8080/v1',
      apiFormat: 'openai',
      models: [{ id: 'm', thinking: false, contextWindow: 8192 }],
      fetchModels: true,
      modelThinking: { path: 'caps.thinks', missing: false },
      modelContextWindow: { paths: ['limits.window'] },
      modelImageLimit: { paths: ['limits.images'] },
      auth: 'apiKey',
      settings: [
        { key: 'search', label: 'Search', type: 'boolean', default: true, bodyPath: 'search', modelSupport: { path: 'caps.search' } },
        { key: 'plain', label: 'Plain', type: 'boolean', default: false, bodyPath: 'plain' },
      ],
      thinking: {},
      mediaApi: { format: 'openrouter', modelRequestBodies: [{ request: 'tts', modelIdPrefix: 'heygen/', body: { response_format: 'pcm' } }] },
    }
    const saved = structuredClone(config)

    sbp('dez.model/customProviders/save', config)
    // The caller changes its objects in place after the save.
    Object.assign(config.modelThinking ?? {}, { path: 'changed' })
    Object.assign(config.settings?.[0].modelSupport ?? {}, { path: 'changed' })
    Object.assign(config.mediaApi?.modelRequestBodies?.[0].body ?? {}, { response_format: 'changed' })
    config.modelContextWindow?.paths.push('changed')
    config.modelImageLimit?.paths.push('changed')

    // toStrictEqual: a setting with no `modelSupport` gets no such key.
    expect(sbp('dez.model/customProviders/list')).toStrictEqual([saved])
  })
})

describe('dez.model/customProviders/remove', () => {
  const local: ProviderConfig = {
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:8080/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
  }

  function settings (): SettingsSnapshot {
    return sbp('dez.model/settings/snapshot') as SettingsSnapshot
  }

  it('removes the config and every setting that names it, and nothing else', () => {
    sbp('dez.model/customProviders/save', local)
    sbp('dez.model/customProviders/save', { ...local, id: 'other', name: 'Other' })
    sbp('dez.model/settings/toggleFavorite', 'local', 'm1')
    sbp('dez.model/settings/toggleFavorite', 'openrouter', 'm2')
    sbp('dez.model/settings/setProviderSetting', 'local', 'flag', true)
    sbp('dez.model/settings/setProviderSetting', 'venice', 'webSearch', false)
    sbp('dez.model/settings/setModelParameter', { providerId: 'local', modelId: 'vendor/film' }, 'duration', 5)
    // A model id of another provider that starts like this provider's id.
    sbp('dez.model/settings/setModelParameter', { providerId: 'venice', modelId: 'local/film' }, 'duration', '5s')
    sbp('dez.model/settings/setDefaultNewTabModel', { providerId: 'local', modelId: 'm1' })
    sbp('dez.model/setActiveModel', 'local', 'm1', 'Model 1')

    expect(sbp('dez.model/customProviders/remove', 'local')).toBe(true)

    const snapshot = settings()
    expect(snapshot.customProviders.map((config) => config.id)).toEqual(['other'])
    expect(snapshot.favorites).toEqual([{ providerId: 'openrouter', modelId: 'm2' }])
    expect(snapshot.providerSettings).toEqual({ venice: { webSearch: false } })
    expect(snapshot.modelParameters).toStrictEqual({ 'venice/local/film': { duration: '5s' } })
    expect(snapshot.defaultNewTabModel).toBeNull()
    expect(snapshot.lastUsedModel).toBeNull()
  })

  it('changes nothing for an id that is not a custom provider', () => {
    sbp('dez.model/settings/toggleFavorite', 'openrouter', 'm2')
    sbp('dez.model/setActiveModel', 'openrouter', 'm2', 'Model 2')
    const before = settings()

    expect(sbp('dez.model/customProviders/remove', 'openrouter')).toBe(false)
    expect(settings()).toEqual(before)
  })
})

describe('dez.model/settings overlay panels', () => {
  const PANELS = {
    settings: { open: 'dez.model/settings/open', isOpen: 'dez.model/settings/isOpen' },
    history: { open: 'dez.model/settings/historyOpen', isOpen: 'dez.model/settings/isHistoryOpen' },
    help: { open: 'dez.model/settings/helpOpen', isOpen: 'dez.model/settings/isHelpOpen' },
  } as const
  type Panel = keyof typeof PANELS
  const panels = Object.keys(PANELS) as Panel[]

  function openPanels (): Panel[] {
    return panels.filter((panel) => sbp(PANELS[panel].isOpen) as boolean)
  }

  // At most one panel covers the thread: the one opened last.
  it.each(panels)('opening %s closes the panel that was open', (panel) => {
    for (const other of panels.filter((name) => name !== panel)) {
      sbp(PANELS[other].open)
      expect(openPanels()).toEqual([other])
      sbp(PANELS[panel].open)
      expect(openPanels()).toEqual([panel])
    }
  })
})

describe('dez.model/settings/changeEditorFontSize', () => {
  function fontSize (): number {
    return (sbp('dez.model/settings/snapshot') as SettingsSnapshot).editorFontSize
  }

  function change (delta: number, times = 1): void {
    for (let i = 0; i < times; i++) sbp('dez.model/settings/changeEditorFontSize', delta)
  }

  it('steps by one px and stops at both limits', () => {
    expect(fontSize()).toBe(15)
    change(1)
    expect(fontSize()).toBe(16)
    change(1, 40)
    expect(fontSize()).toBe(32)
    change(-1)
    expect(fontSize()).toBe(31)
    change(-1, 40)
    expect(fontSize()).toBe(10)
    change(1)
    expect(fontSize()).toBe(11)
  })
})

describe('dez.model/settings reply-end alerts', () => {
  function alertSettings (): Pick<SettingsSnapshot, 'doneSound' | 'doneSoundVolume' | 'doneNotification'> {
    const { doneSound, doneSoundVolume, doneNotification } = sbp('dez.model/settings/snapshot') as SettingsSnapshot
    return { doneSound, doneSoundVolume, doneNotification }
  }

  // The app state that one change saved after the 1 s save delay, or
  // undefined when the change saved nothing.
  async function savedAfter (change: () => void): Promise<AppStatePayload | undefined> {
    const saveCount = savedAppStates.length
    change()
    await vi.advanceTimersByTimeAsync(1000)
    return savedAppStates.length > saveCount ? savedAppStates.at(-1) : undefined
  }

  afterEach(() => {
    sbp('dez.model/settings/stopPersistence')
    vi.useRealTimers()
  })

  it('rounds the volume and keeps it in 0-100', () => {
    sbp('dez.model/settings/setDoneSoundVolume', 72.6)
    expect(alertSettings().doneSoundVolume).toBe(73)
    sbp('dez.model/settings/setDoneSoundVolume', -10)
    expect(alertSettings().doneSoundVolume).toBe(0)
    sbp('dez.model/settings/setDoneSoundVolume', 140)
    expect(alertSettings().doneSoundVolume).toBe(100)
  })

  // Each setting changes alone, so a setting that is missing from the save
  // watch list or from the save payload fails here.
  it('loads the saved alert settings, and saves a change of each one', async () => {
    diskAppState = { doneSound: false, doneSoundVolume: 20, doneNotification: false }
    await sbp('dez.model/settings/init')
    expect(alertSettings()).toEqual({ doneSound: false, doneSoundVolume: 20, doneNotification: false })

    vi.useFakeTimers()
    sbp('dez.model/settings/startPersistence')

    expect(await savedAfter(() => sbp('dez.model/settings/setDoneSound', true)))
      .toMatchObject({ doneSound: true, doneSoundVolume: 20, doneNotification: false })
    expect(await savedAfter(() => sbp('dez.model/settings/setDoneSoundVolume', 80)))
      .toMatchObject({ doneSound: true, doneSoundVolume: 80, doneNotification: false })
    expect(await savedAfter(() => sbp('dez.model/settings/setDoneNotification', true)))
      .toMatchObject({ doneSound: true, doneSoundVolume: 80, doneNotification: true })
  })
})

describe('dez.model/settings/setModelOutputFilter', () => {
  const filter = () => (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelOutputFilter

  afterEach(() => {
    sbp('dez.model/settings/stopPersistence')
    vi.useRealTimers()
  })

  it('keeps the known types, once each, in table order', () => {
    sbp('dez.model/settings/setModelOutputFilter', ['video', 'speech', 'text', 'video'])
    expect(filter()).toStrictEqual(['text', 'video'])
    sbp('dez.model/settings/setModelOutputFilter', [])
    expect(filter()).toStrictEqual([])
  })

  it('loads the saved filter, and saves a change', async () => {
    diskAppState = { modelOutputFilter: ['image'] }
    await sbp('dez.model/settings/init')
    expect(filter()).toStrictEqual(['image'])

    vi.useFakeTimers()
    sbp('dez.model/settings/startPersistence')
    sbp('dez.model/settings/setModelOutputFilter', ['audio', 'image'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(savedAppStates.at(-1)?.modelOutputFilter).toStrictEqual(['image', 'audio'])
  })
})

describe('dez.model/settings/setSystemPrompt', () => {
  const systemPrompt = () => (sbp('dez.model/settings/snapshot') as SettingsSnapshot).systemPrompt

  afterEach(() => {
    sbp('dez.model/settings/stopPersistence')
    vi.useRealTimers()
  })

  it('stores the exact built-in text as null, and keeps every other text as it is', () => {
    sbp('dez.model/settings/setSystemPrompt', `${BUILT_IN_SYSTEM_PROMPT}\n`)
    expect(systemPrompt()).toBe(`${BUILT_IN_SYSTEM_PROMPT}\n`)
    sbp('dez.model/settings/setSystemPrompt', BUILT_IN_SYSTEM_PROMPT)
    expect(systemPrompt()).toBeNull()
    sbp('dez.model/settings/setSystemPrompt', '')
    expect(systemPrompt()).toBe('')
    sbp('dez.model/settings/setSystemPrompt', null)
    expect(systemPrompt()).toBeNull()
    expect(sbp('dez.model/heldTexts')).not.toContain(BUILT_IN_SYSTEM_PROMPT)
  })

  it('loads the saved template, and saves a change and a restore', async () => {
    diskAppState = { systemPrompt: 'Be {{model_id}}.' }
    await sbp('dez.model/settings/init')
    expect(systemPrompt()).toBe('Be {{model_id}}.')

    vi.useFakeTimers()
    sbp('dez.model/settings/startPersistence')
    sbp('dez.model/settings/setSystemPrompt', 'Be brief.')
    await vi.advanceTimersByTimeAsync(1000)
    expect(savedAppStates.at(-1)?.systemPrompt).toBe('Be brief.')
    sbp('dez.model/settings/setSystemPrompt', null)
    await vi.advanceTimersByTimeAsync(1000)
    expect(savedAppStates.at(-1)?.systemPrompt).toBeNull()
  })
})

describe('dez.model/settings model parameters', () => {
  const film: ModelRef = { providerId: 'venice', modelId: 'film' }
  const song: ModelRef = { providerId: 'venice', modelId: 'song' }
  const values = () => (sbp('dez.model/settings/snapshot') as SettingsSnapshot).modelParameters
  const set = (model: ModelRef, name: string, value: string | number | null) => sbp('dez.model/settings/setModelParameter', model, name, value)

  afterEach(() => {
    sbp('dez.model/settings/stopPersistence')
    vi.useRealTimers()
  })

  it('keeps the values of each model apart, and replaces a value that is set again', () => {
    set(film, 'duration', '4s')
    set(film, 'resolution', '480p')
    set(song, 'duration_seconds', 30)
    set(film, 'duration', '8s')

    expect(values()).toStrictEqual({ 'venice/film': { duration: '8s', resolution: '480p' }, 'venice/song': { duration_seconds: 30 } })
  })

  it('removes a value that is set to null, and the model with its last value', () => {
    set(film, 'duration', '4s')
    set(film, 'resolution', '480p')

    set(film, 'duration', null)
    expect(values()).toStrictEqual({ 'venice/film': { resolution: '480p' } })

    set(film, 'resolution', null)
    set(song, 'duration_seconds', null)
    expect(values()).toStrictEqual({})
  })

  it('gives a snapshot that a reader cannot change the settings through', () => {
    set(film, 'duration', '4s')

    values()['venice/film'].duration = '60s'

    expect(values()).toStrictEqual({ 'venice/film': { duration: '4s' } })
  })

  it('resets the given toggles of the provider and the values of the one model', () => {
    sbp('dez.model/settings/setProviderSetting', 'venice', 'webSearch', false)
    sbp('dez.model/settings/setProviderSetting', 'venice', 'thinking', false)
    sbp('dez.model/settings/setProviderSetting', 'openrouter', 'thinking', false)
    set(film, 'duration', '4s')
    set(song, 'duration_seconds', 30)
    const stored = () => {
      const { providerSettings, modelParameters } = sbp('dez.model/settings/snapshot') as SettingsSnapshot
      return { providerSettings, modelParameters }
    }

    // A toggle that the popup does not show for the model keeps its value.
    sbp('dez.model/settings/resetProviderSettings', 'venice', ['thinking', 'never-stored'], 'film')
    expect(stored()).toStrictEqual({
      providerSettings: { venice: { webSearch: false }, openrouter: { thinking: false } },
      modelParameters: { 'venice/song': { duration_seconds: 30 } },
    })

    // A provider with no value left has no entry.
    sbp('dez.model/settings/resetProviderSettings', 'venice', ['webSearch'])
    expect(stored()).toStrictEqual({
      providerSettings: { openrouter: { thinking: false } },
      modelParameters: { 'venice/song': { duration_seconds: 30 } },
    })
  })

  it('loads the saved values, and saves a change', async () => {
    diskAppState = { modelParameters: { 'venice/film': { duration: '4s' } } }
    await sbp('dez.model/settings/init')
    expect(values()).toStrictEqual({ 'venice/film': { duration: '4s' } })

    vi.useFakeTimers()
    sbp('dez.model/settings/startPersistence')
    set(song, 'duration_seconds', 30)
    await vi.advanceTimersByTimeAsync(1000)
    expect(savedAppStates.at(-1)?.modelParameters).toStrictEqual({ 'venice/film': { duration: '4s' }, 'venice/song': { duration_seconds: 30 } })
  })
})

describe('dez.model/settings shortcuts', () => {
  const overrides = () => (sbp('dez.model/settings/snapshot') as SettingsSnapshot).shortcutOverrides
  const keyOf = (id: ShortcutId) => (sbp('dez.model/settings/shortcuts') as Shortcut[]).find((shortcut) => shortcut.id === id)?.keys
  const set = (id: ShortcutId, key: string | null) => sbp('dez.model/settings/setShortcut', id, key) as string | null

  it('stores only the keys that differ from the default, normalized', () => {
    expect(set('closeTab', 'alt-K')).toBeNull()
    expect(overrides()).toEqual({ closeTab: 'Shift-Alt-k' })
    expect(keyOf('closeTab')).toEqual(['Shift-Alt-k'])
    expect(set('increaseFontSize', 'Alt-i')).toBeNull()
    expect(keyOf('increaseFontSize')).toEqual(['Alt-i'])
    expect(set('increaseFontSize', 'Mod-=')).toBeNull()
    expect(keyOf('increaseFontSize')).toHaveLength(2)
    expect(set('closeTab', null)).toBeNull()
    expect(overrides()).toEqual({})
  })

  it('refuses a key that is not allowed, and keeps the old one', () => {
    expect(set('newTab', 'Alt-k')).toBeNull()
    expect(set('closeTab', 'Alt-k')).toBe('Used by New tab')
    expect(set('closeTab', 'Mod-c')).toBe('Reserved for Copy')
    expect(set('closeTab', 'Hyper-w')).toBe('Not a valid key')
    expect(overrides()).toEqual({ newTab: 'Alt-k' })
  })

  it('refuses a per-row reset while another action has the default key, but Reset All always works', () => {
    expect(set('closeTab', 'Alt-k')).toBeNull()
    expect(set('newTab', 'Mod-w')).toBeNull()
    expect(set('closeTab', null)).toBe('Used by New tab')
    sbp('dez.model/settings/resetShortcuts')
    expect(overrides()).toEqual({})
    expect(set('closeTab', 'Mod-t')).toBe('Used by New tab')
  })
})

describe('dez.model/modelCache errors', () => {
  it('records the last failure, clears it on success, and drops it with the provider', () => {
    const errors = () => sbp('dez.model/modelCache/errors') as Record<string, string>
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: false, models: [], error: 'HTTP 500' })
    sbp('dez.model/modelCache/applyProviderResult', 'other', { ok: false, models: [], error: 'HTTP 401' })
    expect(errors()).toEqual({ local: 'HTTP 500', other: 'HTTP 401' })

    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, models: [] })
    expect(errors()).toEqual({ other: 'HTTP 401' })

    sbp('dez.model/modelCache/removeProvider', 'other')
    expect(errors()).toEqual({})
    expect(Object.keys((sbp('dez.model/modelCache/snapshot') as ModelCache).providers)).toEqual(['local'])
  })
})

describe('dez.model/modelCache raw model entries', () => {
  const rawModel = (modelId: string) => sbp('dez.model/modelCache/rawModel', 'local', modelId) as unknown
  const entry = () => ({ id: 'm', pricing: { prompt: '0.1' } })

  it('keeps the entries of the last successful check in memory only, and drops them with the provider', () => {
    sbp('dez.model/modelCache/applyProviderResult', 'local', {
      ok: true,
      models: [{ id: 'm', name: 'M', provider: 'local' }],
      entries: new Map([['m', entry()]]),
    })
    expect(rawModel('m')).toStrictEqual(entry())
    expect(rawModel('other')).toBeUndefined()
    // Neither model_cache.json nor any snapshot reader gets them.
    expect((sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local?.models)
      .toStrictEqual([{ id: 'm', name: 'M', provider: 'local' }])

    // A copy: a reader cannot change the stored entry.
    const copy = rawModel('m') as { pricing: { prompt: string } }
    copy.pricing.prompt = 'changed'
    expect(rawModel('m')).toStrictEqual(entry())

    // A failed check keeps the last-known entries, as it keeps the models.
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: false, models: [], error: 'HTTP 500' })
    expect(rawModel('m')).toStrictEqual(entry())

    sbp('dez.model/modelCache/removeProvider', 'local')
    expect(rawModel('m')).toBeUndefined()
  })

  it('keeps the entries of the media list apart, and drops them when a check gives none', () => {
    const mediaEntry = { id: 'm', supported_durations: [1, 5] }
    const media = (modelId: string) => sbp('dez.model/modelCache/rawModel', 'local', modelId, 'media') as unknown
    const result = { ok: true, models: [{ id: 'm', name: 'M', provider: 'local' }], entries: new Map([['m', entry()]]) }

    sbp('dez.model/modelCache/applyProviderResult', 'local', { ...result, mediaEntries: new Map([['m', mediaEntry]]) })
    expect([rawModel('m'), media('m'), media('other')]).toStrictEqual([entry(), mediaEntry, undefined])

    // A failed check keeps them; a check whose media list failed does not.
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: false, models: [], error: 'HTTP 500' })
    expect(media('m')).toStrictEqual(mediaEntry)
    sbp('dez.model/modelCache/applyProviderResult', 'local', result)
    expect([rawModel('m'), media('m')]).toStrictEqual([entry(), undefined])

    sbp('dez.model/modelCache/applyProviderResult', 'local', { ...result, mediaEntries: new Map([['m', mediaEntry]]) })
    sbp('dez.model/modelCache/removeProvider', 'local')
    expect(media('m')).toBeUndefined()
  })
})

describe('dez.model/modelCache clip data', () => {
  // model_cache.json is the cache of what the media list told about each
  // model: a video model with no lengths gets no request.
  it('keeps the clip data of the last check only for a check whose media list did not load', () => {
    const lengths = [{ name: 'duration', label: 'Length (seconds)', options: [4, 8], default: 4 }]
    const film = { id: 'film', name: 'Film', provider: 'local', request: 'video' }
    const cachedModels = () => (sbp('dez.model/modelCache/snapshot') as ModelCache).providers.local?.models
    const apply = (result: Record<string, unknown>) => sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, ...result })

    // The cache does not have the provider yet: there is nothing to keep.
    apply({ models: [film], mediaListFailed: true })
    expect(cachedModels()).toStrictEqual([film])

    apply({ models: [{ ...film, parameters: lengths }], mediaEntries: new Map([['film', { id: 'film', price: '2' }]]) })
    apply({ models: [film], mediaListFailed: true })
    expect(cachedModels()).toStrictEqual([{ ...film, parameters: lengths }])
    // The raw entry has prices, which `model_info` must not show as new.
    expect(sbp('dez.model/modelCache/rawModel', 'local', 'film', 'media')).toBeUndefined()

    // A list that loaded and tells no lengths is the newer fact.
    apply({ models: [film] })
    expect(cachedModels()).toStrictEqual([film])
  })
})

describe('dez.model/modelCache learned image limits', () => {
  const film = { id: 'film', name: 'Film', provider: 'local', request: 'imageToVideo' as const, images: { maxImages: 2 } }
  const entry = { id: 'film', model_spec: { name: 'Film', constraints: { durations: ['5s'] } } }
  const learned = () => (sbp('dez.model/modelCache/model', 'local', 'film') as ModelInfo | null)?.learnedImageLimit
  const learn = () => sbp('dez.model/modelCache/learnImageLimit', 'local', 'film', 1)
  const check = (entries?: ReadonlyMap<string, unknown>, models: ModelInfo[] = [film]) =>
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: true, models, ...(entries && { entries }) })

  afterEach(() => {
    sbp('dez.model/modelCache/stopPersistence')
    vi.useRealTimers()
  })

  // With no raw entry, the next check could not tell whether the model
  // changed (after a start, until the provider's next good check).
  it('learns a limit only while the model\'s raw entry is in memory', () => {
    check()
    learn()
    expect(learned()).toBeUndefined()

    check(new Map([['film', entry]]))
    learn()
    expect(learned()?.maxImages).toBe(1)
  })

  it('keeps a limit over checks with the same entry and over a failed check, and forgets it when the entry changes', () => {
    check(new Map([['film', entry]]))
    learn()
    const limit = learned()

    check(new Map([['film', structuredClone(entry)]]))
    sbp('dez.model/modelCache/applyProviderResult', 'local', { ok: false, models: [], error: 'HTTP 500' })
    expect(learned()).toStrictEqual(limit)

    check(new Map([['film', { ...entry, offline: true }]]))
    expect(learned()).toBeUndefined()
  })

  it('forgets the limit of a model that left the list', () => {
    const entries = new Map([['film', entry]])
    check(entries)
    learn()

    check(new Map(), [])
    check(entries)
    expect(learned()).toBeUndefined()
  })

  it('saves a learned limit in model_cache.json', async () => {
    await sbp('dez.model/modelCache/init')
    vi.useFakeTimers()
    sbp('dez.model/modelCache/startPersistence')
    check(new Map([['film', entry]]))
    learn()
    await vi.advanceTimersByTimeAsync(1000)

    expect(savedModelCaches.at(-1)?.providers.local?.models).toStrictEqual([{ ...film, learnedImageLimit: learned() }])
  })
})

describe('dez.model/modelCache quote cache', () => {
  const start = 1_800_000_000_000
  const quote = (providerId: string, values: PriceQuote['values'], usd: number): PriceQuote =>
    ({ providerId, modelId: 'wan', kind: 'video', values, usd, at: Date.now() })
  const quotes = () => (sbp('dez.model/modelCache/snapshot') as ModelCache).quotes

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
  })

  afterEach(() => {
    sbp('dez.model/modelCache/stopPersistence')
    vi.useRealTimers()
  })

  it('keeps one quote of a request, the newest, and drops the quotes that are no longer fresh', () => {
    const old = quote('venice', { duration: '8s' }, 1)
    sbp('dez.model/modelCache/keepQuote', old)
    vi.setSystemTime(start + PRICE_LIFETIME_MS - 1)
    const other = quote('venice', { duration: '5s' }, 2)
    sbp('dez.model/modelCache/keepQuote', other)
    sbp('dez.model/modelCache/keepQuote', quote('venice', { duration: '5s' }, 3))
    expect(quotes()).toStrictEqual([old, { ...other, usd: 3 }])

    vi.setSystemTime(start + PRICE_LIFETIME_MS)
    expect(quotes()).toStrictEqual([{ ...other, usd: 3 }])
    const newest = quote('venice', { duration: '8s' }, 4)
    sbp('dez.model/modelCache/keepQuote', newest)
    expect(quotes()).toStrictEqual([{ ...other, usd: 3 }, newest])
  })

  it('saves only the fresh quotes in model_cache.json', async () => {
    await sbp('dez.model/modelCache/init')
    sbp('dez.model/modelCache/startPersistence')
    sbp('dez.model/modelCache/keepQuote', quote('venice', {}, 1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(savedModelCaches.at(-1)?.quotes).toStrictEqual([{ ...quote('venice', {}, 1), at: start }])

    vi.setSystemTime(start + PRICE_LIFETIME_MS)
    sbp('dez.model/modelCache/applyProviderResult', 'venice', { ok: true, models: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(Object.hasOwn(savedModelCaches.at(-1) ?? {}, 'quotes')).toBe(false)
  })

  it('drops the quotes of a provider that the user removed', () => {
    sbp('dez.model/modelCache/keepQuote', quote('venice', {}, 1))
    sbp('dez.model/modelCache/keepQuote', quote('local', {}, 2))

    sbp('dez.model/modelCache/removeProvider', 'venice')

    expect(quotes()).toStrictEqual([quote('local', {}, 2)])
  })
})

describe('dez.model/streamMessagesForTab tools', () => {
  const model: ModelRef = { providerId: 'local', modelId: 'm' }
  const sendTools = () => (sbp('dez.model/streamMessagesForTab', activeId(), model) as RequestMessages).sendTools
  const cacheModel = (toolCalling?: boolean, request?: ModelRequest) => sbp('dez.model/modelCache/applyProviderResult', 'local', {
    ok: true,
    models: [{ id: 'm', name: 'M', provider: 'local', ...(toolCalling === undefined ? {} : { toolCalling }), ...(request && { request }) }],
  })

  it('sends the tools unless the cache knows the model cannot call them', () => {
    // Not in the cache yet.
    expect(sendTools()).toBe(true)
    cacheModel()
    expect(sendTools()).toBe(true)
    cacheModel(true)
    expect(sendTools()).toBe(true)
    cacheModel(false)
    expect(sendTools()).toBe(false)
  })

  // The Tools toggle does not apply to a media model (modelToggles.ts).
  it('sends the tools only to a model that takes chat requests', () => {
    cacheModel(true, 'chat')
    expect(sendTools()).toBe(true)
    for (const request of ['image', 'tts', 'video', 'none'] as const) {
      cacheModel(true, request)
      expect(sendTools(), request).toBe(false)
    }
  })

  it('sends no tools while the provider\'s Tools toggle is off', () => {
    cacheModel(true)
    sbp('dez.model/settings/setProviderSetting', 'other', 'tools', false)
    sbp('dez.model/settings/setProviderSetting', 'local', 'thinking', false)
    expect(sendTools()).toBe(true)

    sbp('dez.model/settings/setProviderSetting', 'local', 'tools', false)
    expect(sendTools()).toBe(false)

    sbp('dez.model/settings/resetProviderSettings', 'local', ['tools'])
    expect(sendTools()).toBe(true)
  })
})
