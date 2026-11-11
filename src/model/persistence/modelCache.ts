import * as z from 'zod'
import { MODEL_OUTPUT_IDS } from '../modelOutputs'
import type { ClipImageRules } from '../providers/clipImages'
import { isValidProviderId } from '../providers/config'
import { imageSizeRules } from '../providers/imageSize'
import { isRecord } from '../providers/modelParsing'
import { MODEL_REQUESTS, type ProviderId } from '../providers/types'
import type { CachedProvider, ModelCache } from './types'

export const MODEL_CACHE_VERSION = 1

const optionValueSchema = z.union([z.string(), z.number()])

// A ModelParameter (src/model/providers/modelParameters.ts): a list of
// options, a range, or a switch. The switch has only the fields that all
// three have, so it is strict and comes last: an options or range entry
// with a bad field must not read as a switch.
const modelParameterSchema = z.union([
  z.object({ name: z.string(), label: z.string(), options: z.array(optionValueSchema).min(1), default: optionValueSchema.optional() }),
  z.object({ name: z.string(), label: z.string(), min: z.number(), max: z.number(), step: z.number().positive().optional(), default: z.number().optional() }),
  z.strictObject({ name: z.string(), label: z.string(), default: z.boolean().optional() }),
])

const textLengthSchema = z.number().int().nonnegative()

// ClipTextRules (src/model/providers/clipText.ts).
const clipTextRulesSchema = z.object({
  minPromptLength: textLengthSchema.optional(),
  maxPromptLength: textLengthSchema.optional(),
  lyrics: z.object({ required: z.boolean(), maxLength: textLengthSchema.optional() }).optional(),
})

// ClipImageRules (src/model/providers/clipImages.ts). A bad size rule is
// dropped alone (`imageSizeRules`), and the model stays: its images then
// go as they are, and the provider checks them.
const clipImageRulesSchema = z.object({ maxFrames: z.number().int().positive(), size: z.unknown() })
  .transform(({ maxFrames, size }): ClipImageRules => {
    const sizeRules = isRecord(size) ? imageSizeRules(size) : undefined
    return { maxFrames, ...(sizeRules && { size: sizeRules }) }
  })

const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().refine(isValidProviderId, 'invalid provider id'),
  // Optional with no version bump: a cache written before a field existed
  // reads it as "unknown" until the next model check.
  imageInput: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  thinking: z.boolean().optional(),
  unsupportedSettings: z.array(z.string()).min(1).optional(),
  outputs: z.array(z.enum(MODEL_OUTPUT_IDS)).optional(),
  request: z.enum(MODEL_REQUESTS).optional(),
  parameters: z.array(modelParameterSchema).min(1).optional(),
  text: clipTextRulesSchema.optional(),
  images: clipImageRulesSchema.optional(),
})

// Individually drop invalid models (e.g. a bad provider id) instead of failing
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
// an empty cache. Keys that are not valid provider ids (or entries that fail
// validation) are dropped so a stale/forward-version file can't break startup.
// An entry of a provider that no longer exists is kept but never shown: the
// picker lists only configured providers.
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
        if (!isValidProviderId(key)) continue
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
