import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../chat/types'
import type { ConversationData, ModelCache } from '../persistence/types'
import type { ProviderConfig } from '../providers/config'
import type { SettingsSnapshot } from './index'
// Side-effect import: registers the dez.model/* selectors under test.
import './index'

// Conversation ids that the stub disk load below was asked for. Reset in
// beforeEach.
let loadCalls: string[] = []

// Stub the persistence selectors that the tab selectors call.
// src/model/persistence/index.ts is never imported by this test, so these are
// the only dez.persistence/* registrations in the test process.
sbp('sbp/selectors/register', {
  async 'dez.persistence/loadConversation' (id: string): Promise<ConversationData> {
    loadCalls.push(id)
    return {
      id,
      title: `Title ${id}`,
      sections: [{ role: 'user', nodes: [{ kind: 'text', text: `disk text ${id}` }] }],
      activeModel: null,
      created_at: 1000,
    }
  },
  async 'dez.persistence/saveAppState' (): Promise<void> {},
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

beforeEach(() => {
  setActivePinia(createPinia())
  loadCalls = []
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
