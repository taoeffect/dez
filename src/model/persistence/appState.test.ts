import { describe, expect, it } from 'vitest'
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
      showPillSeparators: false,
      theme: 'dark',
      defaultModels: { openrouter: 'model' },
      defaultNewTabModel: { providerId: 'openrouter', modelId: 'model' },
      lastUsedModel: { providerId: 'zai', modelId: 'chat' },
      favorites: [{ providerId: 'venice', modelId: 'llm' }, null],
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
    expect(state.showPillSeparators).toBe(false)
    expect(state.theme).toBe('dark')
    expect(state.defaultModels).toEqual({ openrouter: 'model' })
    expect(state.defaultNewTabModel).toEqual({ providerId: 'openrouter', modelId: 'model' })
    expect(state.lastUsedModel).toEqual({ providerId: 'zai', modelId: 'chat' })
    expect(state.favorites).toEqual([{ providerId: 'venice', modelId: 'llm' }])
    expect(state.checkForUpdates).toBe(false)
    expect(state.lastUpdateCheckAt).toBe(12)
    expect(serializeAppStateJson(state)).toBe(JSON.stringify(state, null, 2))
  })
})
