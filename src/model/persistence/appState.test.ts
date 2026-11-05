import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { defaultAppState, parseAppStateJson, serializeAppStateJson } from './appState'

describe('app state persistence format', () => {
  it('falls back to default app state when JSON is malformed', () => {
    expect(parseAppStateJson('{')).toEqual(defaultAppState())
  })

  it('filters invalid tabs and preserves valid persisted settings', () => {
    const state = parseAppStateJson(JSON.stringify({
      tabs: [
        {
          id: 'tab',
          title: 'Existing Tab',
          conversationId: 'conversation',
          activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
          createdAt: 34,
        },
        { id: 'missing fields' },
        null,
      ],
      activeTabId: 'tab',
      theme: 'dark',
      defaultNewTabModel: { providerId: 'openrouter', modelId: 'model' },
      lastUsedModel: { providerId: 'zai', modelId: 'chat' },
      favorites: [{ providerId: 'venice', modelId: 'llm' }, null],
      providerSettings: { venice: { webSearch: false, veniceSystemPrompt: true } },
      checkForUpdates: false,
      lastUpdateCheckAt: 12,
    }))

    expect(state.tabs).toEqual([{
      id: 'tab',
      title: 'Existing Tab',
      conversationId: 'conversation',
      activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
      createdAt: 34,
    }])
    expect(parseAppStateJson('{ "tabs": [null], "activeTabId": null }').tabs).toEqual([])
    expect(state.activeTabId).toBe('tab')
    expect(state.theme).toBe('dark')
    expect(state.defaultNewTabModel).toEqual({ providerId: 'openrouter', modelId: 'model' })
    expect(state.lastUsedModel).toEqual({ providerId: 'zai', modelId: 'chat' })
    expect(state.favorites).toEqual([{ providerId: 'venice', modelId: 'llm' }])
    expect(state.providerSettings).toEqual({ venice: { webSearch: false, veniceSystemPrompt: true } })
    expect(state.checkForUpdates).toBe(false)
    expect(state.lastUpdateCheckAt).toBe(12)
    expect(parseAppStateJson(serializeAppStateJson(state))).toEqual(state)
  })

  it('tolerates missing or malformed providerSettings', () => {
    expect(parseAppStateJson('{}').providerSettings).toEqual({})
    expect(parseAppStateJson('{ "providerSettings": 42 }').providerSettings).toEqual({})
    // A malformed value drops only that key: valid sibling overrides survive
    // both within the same provider and in other providers, and a malformed
    // provider record drops only that provider.
    expect(parseAppStateJson(JSON.stringify({
      providerSettings: {
        venice: { webSearch: false, xSearch: 'broken' },
        openrouter: { someFlag: true },
        zai: 42,
      },
    })).providerSettings).toEqual({
      venice: { webSearch: false },
      openrouter: { someFlag: true },
    })
  })
})

describe('custom providers in app state', () => {
  const local = { id: 'local', name: 'Local', baseUrl: 'http://localhost:8080/v1' }
  let consoleError: MockInstance<typeof console.error>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('fills config defaults and round-trips', () => {
    const state = parseAppStateJson(JSON.stringify({ customProviders: [local] }))

    expect(state.customProviders).toEqual([
      { ...local, apiFormat: 'openai', models: [], fetchModels: true, auth: 'apiKey' },
    ])
    expect(parseAppStateJson(serializeAppStateJson(state))).toEqual(state)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('drops bad entries and bad models one at a time and keeps valid siblings', () => {
    const state = parseAppStateJson(JSON.stringify({
      customProviders: [
        { ...local, baseUrl: 'ftp://localhost/v1' },
        local,
        { ...local, name: 'Second local' },
        { id: 'openrouter', name: 'Fake OpenRouter', baseUrl: 'https://example.com/v1' },
        { id: 'copilot-clone', name: 'Clone', baseUrl: 'https://example.com', auth: 'githubCopilot' },
        'not an entry',
        {
          id: 'other',
          name: 'Other',
          baseUrl: 'https://other.example/v1',
          models: [{ id: 'good' }, { id: ' ' }, 42, { id: 'also-good', name: 'Also good' }],
        },
      ],
    }))

    expect(state.customProviders?.map((config) => [config.id, config.name])).toEqual([
      ['local', 'Local'],
      ['other', 'Other'],
    ])
    expect(state.customProviders?.[1].models).toEqual([{ id: 'good' }, { id: 'also-good', name: 'Also good' }])
    // Five dropped entries and two dropped models.
    expect(consoleError).toHaveBeenCalledTimes(7)
  })

  it('falls back to no custom providers when the field is not a list', () => {
    expect(parseAppStateJson('{ "customProviders": { "id": "local" } }').customProviders).toEqual([])
    expect(parseAppStateJson('{}').customProviders).toEqual([])
  })

  it('moves a hand-added apiKey out of the config and never writes it back', () => {
    const state = parseAppStateJson(JSON.stringify({
      customProviders: [
        { ...local, apiKey: ' sk-local-key ' },
        { id: 'blank', name: 'Blank key', baseUrl: 'http://localhost:1234/v1', apiKey: '  ' },
        { id: 'dropped', name: '', baseUrl: 'http://localhost:1/v1', apiKey: 'sk-dropped-key' },
      ],
    }))

    expect(state.customProviderApiKeys).toEqual({ local: 'sk-local-key' })
    expect(state.customProviders?.map((config) => config.id)).toEqual(['local', 'blank'])
    expect(state.customProviders?.[0]).not.toHaveProperty('apiKey')
    const json = serializeAppStateJson(state)
    expect(json).not.toContain('sk-local-key')
    expect(json).not.toContain('customProviderApiKeys')
  })

  it('never logs the content of a dropped entry', () => {
    parseAppStateJson(JSON.stringify({
      customProviders: [{ id: 'leak', name: 'Leak', baseUrl: 'sk-secret-url', apiKey: 'sk-secret-key' }],
    }))

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/sk-secret/)
  })
})
