import * as z from 'zod'
import { isProviderId } from '../providers/types'
import type { ProviderId } from '../providers/types'
import type { CachedProvider, ModelCache } from './types'

export const MODEL_CACHE_VERSION = 1

const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().refine(isProviderId, 'unknown provider'),
})

// Individually drop invalid models (e.g. unknown provider) instead of failing
// the whole provider entry, so one bad model doesn't discard the rest.
const modelsSchema = z.array(modelInfoSchema.nullable().catch(() => null))
  .catch(() => [])
  .transform((models) => models.filter((model): model is z.infer<typeof modelInfoSchema> => model !== null))

const cachedProviderSchema = z.object({
  models: modelsSchema,
  working: z.boolean().catch(true),
  updatedAt: z.number().catch(0),
  lastCheckedAt: z.number().catch(0),
})

export function emptyModelCache(): ModelCache {
  return { providers: {}, version: MODEL_CACHE_VERSION }
}

// Parse a persisted model cache, tolerating malformed/missing JSON by returning
// an empty cache. Unknown provider keys (or entries that fail validation) are
// dropped so a stale/forward-version file can't break startup.
export function parseModelCacheJson(content: string): ModelCache {
  try {
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return emptyModelCache()
    }
    const rawProviders = (parsed as Record<string, unknown>).providers
    const providers: Partial<Record<ProviderId, CachedProvider>> = {}
    if (typeof rawProviders === 'object' && rawProviders !== null && !Array.isArray(rawProviders)) {
      for (const [key, value] of Object.entries(rawProviders)) {
        if (!isProviderId(key)) continue
        const result = cachedProviderSchema.safeParse(value)
        if (result.success) providers[key] = result.data
      }
    }
    return { providers, version: MODEL_CACHE_VERSION }
  } catch {
    return emptyModelCache()
  }
}

export function serializeModelCacheJson(cache: ModelCache): string {
  return JSON.stringify(cache, null, 2)
}
