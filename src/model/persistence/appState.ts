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
import { MEDIA_TAG_KINDS } from '../chat/mediaTags'
import { isMoneyLimitUsd } from '../chat/moneyLimit'
import type { AppStatePayload, ConversationJobs, StoredJob, StoredMediaReply } from './types'
import type { DefaultModel, Theme, WindowGeometry } from '../state/settings'
import { EDITOR_FONT_SIZE_DEFAULT, clampEditorFontSize } from '../editorFontSize'
import { DONE_SOUND_VOLUME_DEFAULT } from '../doneSoundVolume'
import { defaultClipVolumes, type ClipVolumes } from '../clipVolume'
import { clampVolumePercent } from '../volumePercent'
import { MODEL_PICKER_SIZE_DEFAULT, clampModelPickerSize, type ModelPickerSize } from '../modelPickerSize'
import { currentShortcutPlatform, parseShortcutOverrides } from '../shortcuts'
import { normalizeOutputs } from '../modelOutputs'
import { isTextKind, MEDIA_KINDS, type ClipKind, type ImageKind, type MediaKind } from '../providers/types'
import { MAX_OPEN_JOBS } from '../tools/jobs'
import { cloneJsonObject, isJsonObject, type JsonObject } from '../../utils/json'

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
  // The marks of `Tab`, absent when not set. A bad value drops only the
  // mark, not the tab.
  incognito: z.literal(true).optional().catch(undefined),
  requestSent: z.literal(true).optional().catch(undefined),
  // `Tab.moneyLimit`; a limit with a bad sum is dropped as a whole, and a
  // bad flag of unknown prices is off, which refuses more.
  moneyLimit: z.object({
    usd: z.number().refine(isMoneyLimitUsd),
    unknownPrices: z.boolean().catch(false),
  }).optional().catch(undefined),
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

const modelPickerSizeSchema = z.object({
  width: z.number(),
  maxHeight: z.number(),
})

const modelRefSchema = z.object({ providerId: z.string(), modelId: z.string() })

// The media kinds of a provider job that Dez can ask for again: a text
// kind (a transcription) is one request, with no job.
function isResumableKind(value: unknown): value is ClipKind | ImageKind {
  return typeof value === 'string' && (MEDIA_KINDS as readonly string[]).includes(value) && !isTextKind(value as MediaKind)
}

// `StoredProviderJob`. The resume value is copied, so that a `__proto__`
// key of a hand edit stays a plain key.
const providerJobSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  kind: z.custom<ClipKind | ImageKind>(isResumableKind),
  jobId: z.string().min(1),
  resume: z.custom<JsonObject>(isJsonObject).transform(cloneJsonObject),
  quote: z.number().nonnegative().optional(),
  uploadCost: z.number().nonnegative().nullable().optional(),
})

// `StoredJob`. A bad provider job or cost drops only that field: the job
// then comes back as a job whose work is lost, and its number stays taken.
const storedJobSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  tool: z.string(),
  label: z.string(),
  inputs: z.array(z.string()),
  hidesAssets: z.boolean(),
  model: modelRefSchema.optional().catch(undefined),
  timeoutMs: z.number().positive(),
  cost: z.number().nonnegative().nullable().optional().catch(undefined),
  providerJob: providerJobSchema.optional().catch(undefined),
})

const mediaReplySchema = z.object({
  sectionIndex: z.number().int().nonnegative(),
  model: modelRefSchema.extend({ modelName: z.string() }),
  providerJob: providerJobSchema,
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

function windowGeometry(value: unknown): WindowGeometry | undefined {
  const result = windowGeometrySchema.safeParse(value)
  return result.success ? result.data : undefined
}

// Like editorFontSize: a hand-edited size is rounded and raised to the
// minimum, not dropped. A size that is not two finite numbers gets the
// default.
function modelPickerSize(value: unknown): ModelPickerSize {
  const result = modelPickerSizeSchema.safeParse(value)
  return result.success ? clampModelPickerSize(result.data) : { ...MODEL_PICKER_SIZE_DEFAULT }
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

// The jobs of one conversation, one at a time: a bad job, a job with the id
// or the number of an earlier one, and the jobs over `MAX_OPEN_JOBS` are
// dropped with a log line. The log names no field value: a value can hold
// a URL of the provider.
function storedJobs(value: unknown, conversationId: string): StoredJob[] {
  if (!Array.isArray(value)) return []
  const jobs: StoredJob[] = []
  value.forEach((item, index) => {
    const result = storedJobSchema.safeParse(item)
    if (!result.success) {
      console.error(`Dropped job ${index} of conversation ${conversationId} in app_state.json: ${configIssueText(result.error)}`)
      return
    }
    const job = result.data
    if (jobs.some(({ id, number }) => id === job.id || number === job.number)) {
      console.error(`Dropped job ${index} of conversation ${conversationId} in app_state.json: an earlier job has its id or number`)
      return
    }
    if (jobs.length === MAX_OPEN_JOBS) {
      console.error(`Dropped job ${index} of conversation ${conversationId} in app_state.json: more than ${MAX_OPEN_JOBS} open jobs`)
      return
    }
    jobs.push(job)
  })
  return jobs
}

function storedMediaReply(value: unknown, conversationId: string): StoredMediaReply | undefined {
  if (value === undefined) return undefined
  const result = mediaReplySchema.safeParse(value)
  if (result.success) return result.data
  console.error(`Dropped the media reply of conversation ${conversationId} in app_state.json: ${configIssueText(result.error)}`)
  return undefined
}

// The open jobs of each conversation (`AppStatePayload.openJobs`). Each
// conversation and each job on its own; a conversation with nothing left
// gets no key.
function openJobs(value: unknown): Record<string, ConversationJobs> {
  if (!isRecord(value)) return {}
  const entries: Array<[string, ConversationJobs]> = []
  for (const [conversationId, record] of Object.entries(value)) {
    if (!isRecord(record)) continue
    const jobs = storedJobs(record.jobs, conversationId)
    const mediaReply = storedMediaReply(record.mediaReply, conversationId)
    if (jobs.length > 0 || mediaReply) entries.push([conversationId, { ...(jobs.length > 0 && { jobs }), ...(mediaReply && { mediaReply }) }])
  }
  // `fromEntries`, so that a `__proto__` key is a plain key.
  return Object.fromEntries(entries)
}

// Each kind and each field on its own. Like doneSoundVolume, a hand-edited
// volume is rounded and kept in range, not dropped; any other bad value
// gets its default.
function clipVolumes(value: unknown): ClipVolumes {
  const volumes = defaultClipVolumes()
  if (!isRecord(value)) return volumes
  for (const kind of MEDIA_TAG_KINDS) {
    const entry = value[kind]
    if (!isRecord(entry)) continue
    if (typeof entry.volume === 'number') volumes[kind].volume = clampVolumePercent(entry.volume)
    if (typeof entry.muted === 'boolean') volumes[kind].muted = entry.muted
  }
  return volumes
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
    modelPickerSize: { ...MODEL_PICKER_SIZE_DEFAULT },
    providerSettings: {},
    modelParameters: {},
    checkForUpdates: true,
    lastUpdateCheckAt: null,
    doneSound: true,
    doneSoundVolume: DONE_SOUND_VOLUME_DEFAULT,
    doneNotification: true,
    clipVolumes: defaultClipVolumes(),
    shortcuts: {},
    systemPrompt: null,
    incognitoOption: false,
    openJobs: {},
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
      modelPickerSize: modelPickerSize(parsed.modelPickerSize),
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
        ? clampVolumePercent(parsed.doneSoundVolume)
        : fallback.doneSoundVolume,
      doneNotification: typeof parsed.doneNotification === 'boolean'
        ? parsed.doneNotification
        : fallback.doneNotification,
      clipVolumes: clipVolumes(parsed.clipVolumes),
      shortcuts: parseShortcutOverrides(parsed.shortcuts, currentShortcutPlatform),
      // Any text is kept as it is, also an empty one (no system prompt); a
      // template problem is shown in Settings and refuses a send.
      systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : fallback.systemPrompt,
      incognitoOption: typeof parsed.incognitoOption === 'boolean'
        ? parsed.incognitoOption
        : fallback.incognitoOption,
      openJobs: openJobs(parsed.openJobs),
    }
  } catch {
    return defaultAppState()
  }
}

// `customProviderApiKeys` is parse-only: plain-text keys must never be
// written back to app_state.json, so it is dropped here (JSON.stringify
// omits undefined values). An empty `openJobs` map is dropped too, so that
// a file with no open job has no trace of the feature.
export function serializeAppStateJson(state: AppStatePayload): string {
  const openJobs = state.openJobs && Object.keys(state.openJobs).length > 0 ? state.openJobs : undefined
  return JSON.stringify({ ...state, customProviderApiKeys: undefined, openJobs }, null, 2)
}
