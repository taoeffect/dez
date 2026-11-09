import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveModel, ContentNode, ModelRef, Section, SectionThinking, Tab, ThinkingReplay } from '../chat/types'
import type { AppStatePayload, ConversationData, ModelCache } from '../persistence/types'
import type { ProviderConfig } from '../providers/config'
import type { SettingsSnapshot } from './index'
import type { RequestMessages } from '../streams/types'
import type { Shortcut, ShortcutId } from '../shortcuts'
// Side-effect import: registers the dez.model/* selectors under test.
import './index'
import { appendThinkingToTabSection, appendTokenToTabSection, finalizeStreamSectionForTab, setThinkingReplayForTabSection } from './index'

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

// The ids of the conversations that the stub save below wrote, in order,
// and a promise that holds back each save that starts while it is set, as
// a slow disk would. Reset in beforeEach.
let savedConversationIds: string[] = []
let holdSaves: Promise<void> | null = null

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
  async 'dez.persistence/saveConversation' (data: ConversationData): Promise<void> {
    const hold = holdSaves
    if (hold) await hold
    savedConversationIds.push(data.id)
  },
  async 'dez.persistence/deleteConversation' (): Promise<void> {},
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

async function openConversation (id: string): Promise<Tab | null> {
  return await sbp('dez.model/tabs/openConversation', id) as Tab | null
}

beforeEach(() => {
  setActivePinia(createPinia())
  loadCalls = []
  diskConversations.clear()
  diskAppState = {}
  savedAppStates = []
  savedConversationIds = []
  holdSaves = null
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

  function activeTab (): Tab {
    return tabs().find((tab) => tab.id === activeId()) as Tab
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

describe('dez.model/persistence/flush', () => {
  // Dez quits right after the flush, and a reply that ends or stops saves
  // its tab without waiting (dez.stream/stop), so the flush waits for that
  // save; its own save of the active tab then comes last. History lists
  // conversations by the time of their last save, so a save of a tab with
  // no change would move it to the top.
  it('waits for a tab save that runs, then saves the active tab and no other', async () => {
    tabWithText('untouched')
    const replied = tabWithText('replied')
    const active = tabWithText('draft')
    let finishSave!: () => void
    holdSaves = new Promise((resolve) => {
      finishSave = resolve
    })
    void sbp('dez.model/tabs/save', replied.id)
    holdSaves = null

    // A flush that did not wait would write the active tab at once, before
    // the held save ends.
    const flush = sbp('dez.model/persistence/flush') as Promise<void>
    finishSave()
    await flush
    expect(savedConversationIds).toEqual([replied.conversationId, active.conversationId])
  })
})

describe('tab titles', () => {
  function titleFor (text: string): string {
    sbp('dez.model/tabs/replaceSections', activeId(), [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: '  ' }] },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text }] },
    ])
    return (tabs().find((tab) => tab.id === activeId()) as Tab).title
  }

  it('shows each image reference as [image], never its path', () => {
    const image = (name: string) => `/home/user/.config/dez/assets/images/${name}.png`

    expect(titleFor(`![${image('a')}]()`)).toBe('[image]')
    expect(titleFor(`Compare ![${image('a')}]() and ![${image('b')}]()`)).toBe('Compare [image] and [image]')
    expect(titleFor(`![${image('a')}]() ![${image('b')}]() Which one is brighter?`)).toBe('[image] [image] Which one is b…')
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
    finalizeStreamSectionForTab({ tabId: activeId(), sectionId: first.id, status: 'finished', model: { ...alpha, modelName: 'Alpha' }, startedAt: 1000, updatedAt: 1500, finishedAt: 1500, tokenCount: 12 })
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
    sbp('dez.model/settings/setDefaultNewTabModel', { providerId: 'local', modelId: 'm1' })
    sbp('dez.model/setActiveModel', 'local', 'm1', 'Model 1')

    expect(sbp('dez.model/customProviders/remove', 'local')).toBe(true)

    const snapshot = settings()
    expect(snapshot.customProviders.map((config) => config.id)).toEqual(['other'])
    expect(snapshot.favorites).toEqual([{ providerId: 'openrouter', modelId: 'm2' }])
    expect(snapshot.providerSettings).toEqual({ venice: { webSearch: false } })
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

describe('dez.model/streamMessagesForTab tools', () => {
  const model: ModelRef = { providerId: 'local', modelId: 'm' }
  const sendTools = () => (sbp('dez.model/streamMessagesForTab', activeId(), model) as RequestMessages).sendTools
  const cacheModel = (toolCalling?: boolean) => sbp('dez.model/modelCache/applyProviderResult', 'local', {
    ok: true,
    models: [{ id: 'm', name: 'M', provider: 'local', ...(toolCalling === undefined ? {} : { toolCalling }) }],
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

  it('sends no tools while the provider\'s Tools toggle is off', () => {
    cacheModel(true)
    sbp('dez.model/settings/setProviderSetting', 'other', 'tools', false)
    sbp('dez.model/settings/setProviderSetting', 'local', 'thinking', false)
    expect(sendTools()).toBe(true)

    sbp('dez.model/settings/setProviderSetting', 'local', 'tools', false)
    expect(sendTools()).toBe(false)

    sbp('dez.model/settings/resetProviderSettings', 'local')
    expect(sendTools()).toBe(true)
  })
})
