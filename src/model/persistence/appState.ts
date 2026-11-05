import * as z from 'zod'
import { configIssueText, customProviderConfigSchema, providerModelConfigSchema, type ProviderConfig } from '../providers/config'
import type { AppStatePayload } from './types'
import type { DefaultModel, Theme } from '../state/settings'

const themeSchema = z.enum(['light', 'dark', 'system'])
const defaultModelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})
const tabSchema = z.object({
  id: z.string(),
  title: z.string(),
  conversationId: z.string(),
  activeModel: z.object({
    providerId: z.string(),
    modelId: z.string(),
    modelName: z.string(),
  }).nullable().catch(null),
  createdAt: z.number().catch(() => Date.now()),
})

type TabData = z.infer<typeof tabSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTheme(value: unknown): value is Theme {
  return themeSchema.safeParse(value).success
}

function defaultModel(value: unknown): DefaultModel | null {
  const result = defaultModelSchema.safeParse(value)
  return result.success ? result.data : null
}

function tabData(value: unknown): TabData | null {
  const result = tabSchema.safeParse(value)
  return result.success ? result.data : null
}

// Sparse provider-settings overrides: provider id -> setting key -> boolean.
// Tolerant per key: a malformed value drops only that key, a malformed
// provider record drops only that provider, and a malformed top level falls
// back to {} so startup never breaks on bad data.
function providerSettings(value: unknown): Record<string, Record<string, boolean>> {
  if (!isRecord(value)) return {}
  const output: Record<string, Record<string, boolean>> = {}
  for (const [providerId, record] of Object.entries(value)) {
    if (!isRecord(record)) continue
    output[providerId] = {}
    for (const [key, flag] of Object.entries(record)) {
      if (typeof flag === 'boolean') output[providerId][key] = flag
    }
  }
  return output
}

// Drops the invalid items of a hand-edited `models` list one at a time, so
// one bad model does not drop the whole provider.
function withValidModels(entry: unknown, entryIndex: number): unknown {
  if (!isRecord(entry) || !Array.isArray(entry.models)) return entry
  const models = entry.models.filter((model, modelIndex) => {
    const result = providerModelConfigSchema.safeParse(model)
    if (!result.success) {
      console.error(`Dropped model ${modelIndex} of custom provider ${entryIndex} in app_state.json: ${configIssueText(result.error)}`)
    }
    return result.success
  })
  return { ...entry, models }
}

// Custom providers are parsed one entry at a time: an invalid entry, a
// built-in id, or a repeated id (the first one wins) drops only that entry,
// and never the built-ins. A hand-added `apiKey` is not part of the config
// (the schema strips it); it is returned in `apiKeys` so that startup can
// move it to provider_keys.json. Logs name the entry index and the Zod
// issues only, never the entry, because the entry can hold a key.
function customProviders(value: unknown): { configs: ProviderConfig[]; apiKeys: Record<string, string> } {
  const configs: ProviderConfig[] = []
  const apiKeys: Record<string, string> = {}
  if (value === undefined) return { configs, apiKeys }
  if (!Array.isArray(value)) {
    console.error('Dropped customProviders in app_state.json: it is not a list')
    return { configs, apiKeys }
  }
  value.forEach((entry, index) => {
    const result = customProviderConfigSchema.safeParse(withValidModels(entry, index))
    if (!result.success) {
      console.error(`Dropped custom provider ${index} in app_state.json: ${configIssueText(result.error)}`)
      return
    }
    const config = result.data
    if (configs.some((existing) => existing.id === config.id)) {
      console.error(`Dropped custom provider ${index} in app_state.json: id "${config.id}" is used by an earlier entry`)
      return
    }
    configs.push(config)
    const apiKey = isRecord(entry) && typeof entry.apiKey === 'string' ? entry.apiKey.trim() : ''
    if (apiKey) apiKeys[config.id] = apiKey
  })
  return { configs, apiKeys }
}

export function defaultAppState(): AppStatePayload {
  return {
    tabs: [],
    activeTabId: null,
    theme: 'system',
    customProviders: [],
    defaultNewTabModel: null,
    lastUsedModel: null,
    favorites: [],
    providerSettings: {},
    checkForUpdates: true,
    lastUpdateCheckAt: null,
  }
}

export function parseAppStateJson(content: string): AppStatePayload {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) return defaultAppState()
    const fallback = defaultAppState()
    const providers = customProviders(parsed.customProviders)
    return {
      tabs: Array.isArray(parsed.tabs)
        ? parsed.tabs.map(tabData).filter((item): item is TabData => item !== null)
        : fallback.tabs,
      activeTabId: typeof parsed.activeTabId === 'string' || parsed.activeTabId === null
        ? parsed.activeTabId
        : fallback.activeTabId,
      theme: isTheme(parsed.theme) ? parsed.theme : fallback.theme,
      customProviders: providers.configs,
      customProviderApiKeys: providers.apiKeys,
      defaultNewTabModel: parsed.defaultNewTabModel === null
        ? null
        : defaultModel(parsed.defaultNewTabModel),
      lastUsedModel: parsed.lastUsedModel === null ? null : defaultModel(parsed.lastUsedModel),
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.map(defaultModel).filter((item): item is DefaultModel => item !== null)
        : fallback.favorites,
      providerSettings: providerSettings(parsed.providerSettings),
      checkForUpdates: typeof parsed.checkForUpdates === 'boolean'
        ? parsed.checkForUpdates
        : fallback.checkForUpdates,
      lastUpdateCheckAt: typeof parsed.lastUpdateCheckAt === 'number' || parsed.lastUpdateCheckAt === null
        ? parsed.lastUpdateCheckAt
        : fallback.lastUpdateCheckAt,
    }
  } catch {
    return defaultAppState()
  }
}

// `customProviderApiKeys` is parse-only: plain-text keys must never be
// written back to app_state.json, so it is dropped here (JSON.stringify
// omits undefined values).
export function serializeAppStateJson(state: AppStatePayload): string {
  return JSON.stringify({ ...state, customProviderApiKeys: undefined }, null, 2)
}
