import * as z from 'zod'
import type { AppStatePayload } from '../types'
import type { DefaultModel, Theme } from '../../stores/settingsStore'

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

function defaultModels(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const output: Record<string, string> = {}
  for (const [key, modelId] of Object.entries(value)) {
    if (typeof modelId === 'string') output[key] = modelId
  }
  return output
}

export function defaultAppState(): AppStatePayload {
  return {
    tabs: [],
    activeTabId: null,
    showPillSeparators: true,
    theme: 'system',
    defaultModels: {},
    defaultNewTabModel: null,
    lastUsedModel: null,
    favorites: [],
    checkForUpdates: true,
    lastUpdateCheckAt: null,
  }
}

export function parseAppStateJson(content: string): AppStatePayload {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) return defaultAppState()
    const fallback = defaultAppState()
    return {
      tabs: Array.isArray(parsed.tabs)
        ? parsed.tabs.map(tabData).filter((item): item is TabData => item !== null)
        : fallback.tabs,
      activeTabId: typeof parsed.activeTabId === 'string' || parsed.activeTabId === null
        ? parsed.activeTabId
        : fallback.activeTabId,
      showPillSeparators: typeof parsed.showPillSeparators === 'boolean'
        ? parsed.showPillSeparators
        : fallback.showPillSeparators,
      theme: isTheme(parsed.theme) ? parsed.theme : fallback.theme,
      defaultModels: defaultModels(parsed.defaultModels),
      defaultNewTabModel: parsed.defaultNewTabModel === null
        ? null
        : defaultModel(parsed.defaultNewTabModel),
      lastUsedModel: parsed.lastUsedModel === null ? null : defaultModel(parsed.lastUsedModel),
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.map(defaultModel).filter((item): item is DefaultModel => item !== null)
        : fallback.favorites,
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

export function serializeAppStateJson(state: AppStatePayload): string {
  return JSON.stringify(state, null, 2)
}
