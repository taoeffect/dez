import { bearerJsonRequest } from './openaiCompatible'
import { modelData, stringField } from './modelParsing'
import { providerModel, type ModelInfo, type ProviderSettingDef, type ProviderSpec } from './types'

const VENICE_API_BASE = 'https://api.venice.ai/api/v1'

// User-facing toggles for the provider-settings popup. Defaults mirror the
// previously hardcoded chat parameters (web search/X search/web scraping on,
// Venice system prompt off) so behavior is unchanged until a user flips one.
const VENICE_SETTINGS: ProviderSettingDef[] = [
  { key: 'webSearch', label: 'Web search', type: 'boolean', default: true },
  // X search only applies to Grok models; every Grok model id Venice serves
  // carries the `grok-` prefix (e.g. grok-4-20, grok-build-0-1).
  {
    key: 'xSearch',
    label: 'X search',
    type: 'boolean',
    default: true,
    visibleForModel: (modelId) => modelId.startsWith('grok-'),
  },
  { key: 'webScraping', label: 'Web scraping', type: 'boolean', default: true },
  { key: 'veniceSystemPrompt', label: 'Venice system prompt', type: 'boolean', default: false },
]

export interface VeniceParameters {
  include_venice_system_prompt: boolean
  // The Venice API takes a string enum here ('auto' | 'on' | 'off'), unlike
  // the sibling flags which are booleans.
  enable_web_search: 'on' | 'off'
  enable_x_search: boolean
  enable_web_scraping: boolean
}

// Builds the `venice_parameters` request body from stored per-provider
// overrides (sparse: missing keys fall back to the descriptor defaults).
export function buildVeniceParameters(overrides?: Record<string, boolean>): VeniceParameters {
  const value = (key: string): boolean => {
    const stored = overrides?.[key]
    if (typeof stored === 'boolean') return stored
    return VENICE_SETTINGS.find((setting) => setting.key === key)?.default ?? false
  }
  return {
    include_venice_system_prompt: value('veniceSystemPrompt'),
    enable_web_search: value('webSearch') ? 'on' : 'off',
    enable_x_search: value('xSearch'),
    enable_web_scraping: value('webScraping'),
  }
}

export const veniceProvider: ProviderSpec = {
  id: 'venice',
  name: 'Venice',
  modelsUrl: `${VENICE_API_BASE}/models`,
  chatUrl: `${VENICE_API_BASE}/chat/completions`,
  settings: VENICE_SETTINGS,
  buildModelListRequest(secret) {
    return secret ? bearerJsonRequest(secret) : null
  },
  parseModels(data: unknown): ModelInfo[] {
    return modelData(data)
      .map((model) => {
        const id = stringField(model, 'id') ?? ''
        const name = stringField(model, 'name') ?? id
        return id ? providerModel('venice', id, name) : null
      })
      .filter((model): model is ModelInfo => model !== null)
  },
}
