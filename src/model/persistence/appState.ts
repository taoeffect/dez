import * as z from 'zod'
import {
  configIssueText,
  customProviderConfigSchema,
  providerModelConfigSchema,
  providerSettingDefSchema,
  type ProviderConfig,
} from '../providers/config'
import { isParameterValue, type ParameterValues } from '../providers/modelParameters'
import { parseModelRefKey } from '../chat/modelRef'
import type { AppStatePayload } from './types'
import type { DefaultModel, Theme, WindowGeometry } from '../state/settings'
import { EDITOR_FONT_SIZE_DEFAULT, clampEditorFontSize } from '../editorFontSize'
import { DONE_SOUND_VOLUME_DEFAULT, clampDoneSoundVolume } from '../doneSoundVolume'
import { currentShortcutPlatform, parseShortcutOverrides } from '../shortcuts'
import { normalizeOutputs } from '../modelOutputs'

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

// A `window` value that is not a whole geometry is dropped as a whole; the
// window then opens at its default size, centered. `x`/`y` are both there or
// both absent (no saved place, see `WindowGeometry`).
const windowGeometrySchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  x: z.number().optional(),
  y: z.number().optional(),
  maximized: z.boolean(),
}).refine((geometry) => (geometry.x === undefined) === (geometry.y === undefined))

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

function windowGeometry(value: unknown): WindowGeometry | undefined {
  const result = windowGeometrySchema.safeParse(value)
  return result.success ? result.data : undefined
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

// The parameter values that the user chose: full model id -> parameter
// name -> text, number, or switch state. Tolerant like `providerSettings`:
// a bad value drops only its key, a bad record only its model. A key that
// is no full model id (`modelRefKey`) is dropped too, so `__proto__` is
// never a key. A model with no value left gets no entry.
function modelParameters(value: unknown): Record<string, ParameterValues> {
  if (!isRecord(value)) return {}
  const output: Record<string, ParameterValues> = {}
  for (const [modelKey, record] of Object.entries(value)) {
    if (parseModelRefKey(modelKey) === null || !isRecord(record)) continue
    const values = Object.entries(record).filter((entry): entry is [string, ParameterValues[string]] => isParameterValue(entry[1]))
    if (values.length > 0) output[modelKey] = Object.fromEntries(values)
  }
  return output
}

// Drops the invalid items of a hand-edited list one at a time, so one bad
// item does not drop the whole provider.
function validItems(list: unknown[], schema: z.ZodType, itemName: string, entryIndex: number): unknown[] {
  return list.filter((item, itemIndex) => {
    const result = schema.safeParse(item)
    if (!result.success) {
      console.error(`Dropped ${itemName} ${itemIndex} of custom provider ${entryIndex} in app_state.json: ${configIssueText(result.error)}`)
    }
    return result.success
  })
}

// The `models` and `settings` lists of a custom provider, checked one item
// at a time. A setting whose key a later Dez reserves for its own toggle
// (`tools`) is such a bad item.
function withValidLists(entry: unknown, entryIndex: number): unknown {
  if (!isRecord(entry)) return entry
  const output = { ...entry }
  if (Array.isArray(entry.models)) output.models = validItems(entry.models, providerModelConfigSchema, 'model', entryIndex)
  if (Array.isArray(entry.settings)) output.settings = validItems(entry.settings, providerSettingDefSchema, 'setting', entryIndex)
  return output
}

// Custom providers are parsed one entry at a time: an invalid entry, a
// built-in id, or a repeated id (the first one wins) drops only that entry,
// and never the built-ins. A hand-added `apiKey` is not part of the config
// (the schema strips it); it is returned in `apiKeys` so that startup can
// move it to provider_keys.json. A key put in `headers` is part of the
// config, so it stays in app_state.json as written. Logs name the entry
// index and the Zod issues only, never the entry, because the entry can
// hold a key.
function customProviders(value: unknown): { configs: ProviderConfig[]; apiKeys: Record<string, string> } {
  const configs: ProviderConfig[] = []
  const apiKeys: Record<string, string> = {}
  if (value === undefined) return { configs, apiKeys }
  if (!Array.isArray(value)) {
    console.error('Dropped customProviders in app_state.json: it is not a list')
    return { configs, apiKeys }
  }
  value.forEach((entry, index) => {
    const result = customProviderConfigSchema.safeParse(withValidLists(entry, index))
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
    editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
    customProviders: [],
    defaultNewTabModel: null,
    lastUsedModel: null,
    favorites: [],
    modelOutputFilter: [],
    providerSettings: {},
    modelParameters: {},
    checkForUpdates: true,
    lastUpdateCheckAt: null,
    doneSound: true,
    doneSoundVolume: DONE_SOUND_VOLUME_DEFAULT,
    doneNotification: true,
    shortcuts: {},
    systemPrompt: null,
  }
}

// app_state.json holds an AppStatePayload (types.ts). A bad field gets its
// default, so a hand edit never stops startup.
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
      // A hand-edited size is rounded and kept in range, not dropped.
      editorFontSize: typeof parsed.editorFontSize === 'number'
        ? clampEditorFontSize(parsed.editorFontSize)
        : fallback.editorFontSize,
      window: windowGeometry(parsed.window),
      customProviders: providers.configs,
      customProviderApiKeys: providers.apiKeys,
      defaultNewTabModel: parsed.defaultNewTabModel === null
        ? null
        : defaultModel(parsed.defaultNewTabModel),
      lastUsedModel: parsed.lastUsedModel === null ? null : defaultModel(parsed.lastUsedModel),
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.map(defaultModel).filter((item): item is DefaultModel => item !== null)
        : fallback.favorites,
      // Unknown types are dropped, so a hand edit never hides every model.
      modelOutputFilter: Array.isArray(parsed.modelOutputFilter)
        ? normalizeOutputs(parsed.modelOutputFilter)
        : fallback.modelOutputFilter,
      providerSettings: providerSettings(parsed.providerSettings),
      modelParameters: modelParameters(parsed.modelParameters),
      checkForUpdates: typeof parsed.checkForUpdates === 'boolean'
        ? parsed.checkForUpdates
        : fallback.checkForUpdates,
      lastUpdateCheckAt: typeof parsed.lastUpdateCheckAt === 'number' || parsed.lastUpdateCheckAt === null
        ? parsed.lastUpdateCheckAt
        : fallback.lastUpdateCheckAt,
      doneSound: typeof parsed.doneSound === 'boolean' ? parsed.doneSound : fallback.doneSound,
      // Like editorFontSize: a hand-edited volume is rounded and kept in
      // range, not dropped.
      doneSoundVolume: typeof parsed.doneSoundVolume === 'number'
        ? clampDoneSoundVolume(parsed.doneSoundVolume)
        : fallback.doneSoundVolume,
      doneNotification: typeof parsed.doneNotification === 'boolean'
        ? parsed.doneNotification
        : fallback.doneNotification,
      shortcuts: parseShortcutOverrides(parsed.shortcuts, currentShortcutPlatform),
      // Any text is kept as it is, also an empty one (no system prompt); a
      // template problem is shown in Settings and refuses a send.
      systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : fallback.systemPrompt,
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
