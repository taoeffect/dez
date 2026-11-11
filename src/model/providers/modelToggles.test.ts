import { describe, expect, it } from 'vitest'
import type { ProviderSettingDef } from './config'
import { modelToggles, toggleRows, toggleValue, toolsApply, type ModelToggles, type ToggleModel } from './modelToggles'
import { MODEL_REQUESTS } from './types'

const setting = (key: string, more: Partial<ProviderSettingDef> = {}): ProviderSettingDef =>
  ({ key, label: key, type: 'boolean', default: true, bodyPath: key, ...more })

const search = setting('search')
const xSearch = setting('xSearch', { modelIdPrefix: 'grok-' })
const config = { thinking: {}, settings: [search, xSearch] }

describe('modelToggles', () => {
  it('gives a model with no known fact every toggle of the provider, the config toggles in config order', () => {
    expect(modelToggles(config, { id: 'grok-4' })).toStrictEqual({ thinking: true, tools: true, settings: [search, xSearch] })
    expect(modelToggles(config, { id: 'grok-4', request: 'chat', toolCalling: true, thinking: true }))
      .toStrictEqual({ thinking: true, tools: true, settings: [search, xSearch] })
  })

  it('gives no Thinking toggle for a provider without thinking, whatever the model', () => {
    for (const model of [{ id: 'm' }, { id: 'm', thinking: true }]) {
      expect(modelToggles({}, model)).toStrictEqual({ thinking: false, tools: true, settings: [] })
    }
  })

  it('leaves out only the toggle that the model is known not to use', () => {
    const cases: Array<[ToggleModel, ModelToggles]> = [
      [{ id: 'grok-4', thinking: false }, { thinking: false, tools: true, settings: [search, xSearch] }],
      [{ id: 'grok-4', toolCalling: false }, { thinking: true, tools: false, settings: [search, xSearch] }],
      [{ id: 'grok-4', unsupportedSettings: ['search'] }, { thinking: true, tools: true, settings: [xSearch] }],
      [{ id: 'grok-4', unsupportedSettings: ['xSearch', 'not-a-setting'] }, { thinking: true, tools: true, settings: [search] }],
    ]

    for (const [model, toggles] of cases) {
      expect(modelToggles(config, model), JSON.stringify(model)).toStrictEqual(toggles)
    }
  })

  it('gives a prefix-gated toggle only to a model id with the prefix, also when the list says the model takes it', () => {
    expect(modelToggles(config, { id: 'llama-3' }).settings).toStrictEqual([search])
    expect(modelToggles(config, { id: 'my-grok-4' }).settings).toStrictEqual([search])
    expect(modelToggles(config, { id: 'grok-' }).settings).toStrictEqual([search, xSearch])
  })

  it('gives no toggle to a model that takes no chat request', () => {
    const kinds = MODEL_REQUESTS.filter((request) => request !== 'chat')

    expect(kinds.length).toBeGreaterThan(0)
    for (const request of kinds) {
      expect(modelToggles(config, { id: 'grok-4', request, toolCalling: true, thinking: true }), request)
        .toStrictEqual({ thinking: false, tools: false, settings: [] })
    }
  })
})

describe('toolsApply', () => {
  it('is true for a chat model unless it is known not to call tools', () => {
    expect([{}, { request: 'chat' as const }, { toolCalling: true }].map(toolsApply)).toStrictEqual([true, true, true])
    expect(toolsApply({ toolCalling: false })).toBe(false)
  })

  it('is false for every other request kind, also for a model that calls tools', () => {
    for (const request of MODEL_REQUESTS.filter((kind) => kind !== 'chat')) {
      expect(toolsApply({ request, toolCalling: true }), request).toBe(false)
    }
  })
})

describe('toggleRows', () => {
  it('gives Thinking, then Tools, then the config toggles that apply, each with its default', () => {
    const off = setting('off', { label: 'Off', default: false })

    expect(toggleRows({ thinking: true, tools: true, settings: [search, off] })).toStrictEqual([
      { key: 'thinking', label: 'Thinking', default: true },
      { key: 'tools', label: 'Tools', default: true },
      { key: 'search', label: 'search', default: true },
      { key: 'off', label: 'Off', default: false },
    ])
    expect(toggleRows({ thinking: false, tools: false, settings: [] })).toStrictEqual([])
  })
})

describe('toggleValue', () => {
  it('gives the stored value of a flipped toggle, else the default', () => {
    const row = { key: 'search', default: true }
    const stored: (Record<string, boolean> | undefined)[] = [undefined, {}, { other: false }, { search: false }]

    expect(stored.map((values) => toggleValue(row, values))).toStrictEqual([true, true, true, false])
  })
})
