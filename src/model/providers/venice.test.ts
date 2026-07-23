import { describe, expect, it } from 'vitest'
import { buildVeniceParameters, veniceProvider } from './venice'

// Defaults must match the legacy hardcoded VENICE_CHAT_PARAMETERS behavior so
// users who never open the settings popup see no change in requests.
const LEGACY_DEFAULT_PARAMETERS = {
  include_venice_system_prompt: false,
  enable_web_search: 'on',
  enable_x_search: true,
  enable_web_scraping: true,
}

describe('venice provider settings', () => {
  it('builds defaults matching the legacy hardcoded chat parameters', () => {
    expect(buildVeniceParameters()).toEqual(LEGACY_DEFAULT_PARAMETERS)
    expect(buildVeniceParameters({})).toEqual(LEGACY_DEFAULT_PARAMETERS)
  })

  it('maps boolean overrides to the API shape, including the web-search string enum', () => {
    expect(buildVeniceParameters({
      webSearch: false,
      xSearch: false,
      webScraping: false,
      veniceSystemPrompt: true,
    })).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
  })

  it('merges sparse overrides with descriptor defaults', () => {
    expect(buildVeniceParameters({ webSearch: false })).toEqual({
      include_venice_system_prompt: false,
      enable_web_search: 'off',
      enable_x_search: true,
      enable_web_scraping: true,
    })
  })

  it('exposes a settings descriptor whose keys the builder understands', () => {
    const keys = veniceProvider.settings?.map((setting) => setting.key)
    expect(keys).toEqual(['webSearch', 'xSearch', 'webScraping', 'veniceSystemPrompt'])
    // Flipping every setting away from its default must change every field.
    const flipped = Object.fromEntries(
      (veniceProvider.settings ?? []).map((setting) => [setting.key, !setting.default]),
    )
    expect(buildVeniceParameters(flipped)).toEqual({
      include_venice_system_prompt: true,
      enable_web_search: 'off',
      enable_x_search: false,
      enable_web_scraping: false,
    })
  })

  it('gates the X search row on Grok models via visibleForModel', () => {
    const defs = veniceProvider.settings ?? []
    const xSearch = defs.find((setting) => setting.key === 'xSearch')
    const predicate = xSearch?.visibleForModel
    expect(predicate).toBeTypeOf('function')
    // Grok ids all carry the grok- prefix.
    expect(predicate?.('grok-4-20')).toBe(true)
    expect(predicate?.('grok-4-20-multi-agent')).toBe(true)
    expect(predicate?.('grok-build-0-1')).toBe(true)
    // Non-Grok Venice model ids hide the row.
    expect(predicate?.('llama-3.3-70b')).toBe(false)
    expect(predicate?.('venice-uncensored-1-2')).toBe(false)
    expect(predicate?.('kimi-k3')).toBe(false)
    // The other Venice defs stay always visible (no predicate).
    for (const setting of defs.filter((def) => def.key !== 'xSearch')) {
      expect(setting.visibleForModel).toBeUndefined()
    }
  })
})
