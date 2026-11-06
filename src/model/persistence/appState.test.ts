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
      editorFontSize: 18,
      defaultNewTabModel: { providerId: 'openrouter', modelId: 'model' },
      lastUsedModel: { providerId: 'zai', modelId: 'chat' },
      favorites: [{ providerId: 'venice', modelId: 'llm' }, null],
      providerSettings: { venice: { webSearch: false, veniceSystemPrompt: true } },
      checkForUpdates: false,
      lastUpdateCheckAt: 12,
      doneSound: false,
      doneSoundVolume: 35,
      doneNotification: false,
      shortcuts: { closeTab: 'alt-k', bogus: 'Alt-j', newTab: 'Escape' },
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
    expect(state.editorFontSize).toBe(18)
    expect(state.defaultNewTabModel).toEqual({ providerId: 'openrouter', modelId: 'model' })
    expect(state.lastUsedModel).toEqual({ providerId: 'zai', modelId: 'chat' })
    expect(state.favorites).toEqual([{ providerId: 'venice', modelId: 'llm' }])
    expect(state.providerSettings).toEqual({ venice: { webSearch: false, veniceSystemPrompt: true } })
    expect(state.checkForUpdates).toBe(false)
    expect(state.lastUpdateCheckAt).toBe(12)
    expect(state.doneSound).toBe(false)
    expect(state.doneSoundVolume).toBe(35)
    expect(state.doneNotification).toBe(false)
    expect(state.shortcuts).toEqual({ closeTab: 'Alt-k' })
    expect(parseAppStateJson('{ "shortcuts": "Alt-k" }').shortcuts).toEqual({})
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

  it('rounds and clamps a hand-edited editorFontSize, and ignores a bad type', () => {
    const parseFontSize = (value: unknown) => parseAppStateJson(JSON.stringify({ editorFontSize: value })).editorFontSize
    expect(parseAppStateJson('{}').editorFontSize).toBe(15)
    expect(parseFontSize(17.6)).toBe(18)
    expect(parseFontSize(4)).toBe(10)
    expect(parseFontSize(99)).toBe(32)
    expect(parseAppStateJson('{ "editorFontSize": 1e400 }').editorFontSize).toBe(32)
    expect(parseFontSize('20')).toBe(15)
    expect(parseFontSize(null)).toBe(15)
  })

  it('turns the reply-end alerts on at half volume when app_state.json has no alert settings', () => {
    const state = parseAppStateJson('{}')
    expect(state.doneSound).toBe(true)
    expect(state.doneSoundVolume).toBe(50)
    expect(state.doneNotification).toBe(true)
  })

  it('rounds and clamps a hand-edited doneSoundVolume, and ignores bad alert types', () => {
    const parse = (fields: Record<string, unknown>) => parseAppStateJson(JSON.stringify(fields))
    const parseVolume = (value: unknown) => parse({ doneSoundVolume: value }).doneSoundVolume
    expect(parseVolume(0)).toBe(0)
    expect(parseVolume(100)).toBe(100)
    expect(parseVolume(33.5)).toBe(34)
    expect(parseVolume(-3)).toBe(0)
    expect(parseVolume(250)).toBe(100)
    expect(parseAppStateJson('{ "doneSoundVolume": 1e400 }').doneSoundVolume).toBe(100)
    expect(parseVolume('20')).toBe(50)
    expect(parseVolume(null)).toBe(50)
    expect(parse({ doneSound: 'false' }).doneSound).toBe(true)
    expect(parse({ doneNotification: 0 }).doneNotification).toBe(true)
  })

  it('keeps a whole window geometry and drops a bad one as a whole', () => {
    const geometry = { width: 1000, height: 700, x: -1280, y: 40, maximized: true }
    const parseWindow = (value: unknown) => parseAppStateJson(JSON.stringify({ window: value })).window
    expect(parseAppStateJson(serializeAppStateJson({ window: geometry })).window).toEqual(geometry)
    expect(parseAppStateJson('{}').window).toBeUndefined()
    expect(parseWindow({ ...geometry, maximized: 'yes' })).toBeUndefined()
    expect(parseWindow({ ...geometry, width: 0 })).toBeUndefined()
    expect(parseWindow({ ...geometry, x: '10' })).toBeUndefined()
    expect(parseWindow('1000x700')).toBeUndefined()
  })

  it('keeps a window geometry with no position, and drops half a position', () => {
    const sizeOnly = { width: 1000, height: 700, maximized: false }
    const parseWindow = (value: unknown) => parseAppStateJson(JSON.stringify({ window: value })).window
    expect(parseWindow(sizeOnly)).toStrictEqual(sizeOnly)
    expect(parseWindow({ ...sizeOnly, x: 10 })).toBeUndefined()
    expect(parseWindow({ ...sizeOnly, y: 10 })).toBeUndefined()
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
