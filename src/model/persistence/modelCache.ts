import * as z from 'zod'
import { MODEL_OUTPUT_IDS } from '../modelOutputs'
import { CLIP_USES, type ClipKindRules, type InputClipRules } from '../providers/clipInputs'
import type { InputImageRules } from '../providers/clipImages'
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

// InputImageRules (src/model/providers/clipImages.ts). A bad size rule is
// dropped alone (`imageSizeRules`), and the model stays: its images then
// go as they are, and the provider checks them. A fewest count above the
// most count is no rule, so it is dropped too. So is a prompt name with no
// `{n}` (the images then keep their ids in the prompt), and a bad
// `whenParameter` (the model's own rules then apply).
const ownImageRulesShape = { maxImages: z.number().int().positive(), minImages: z.unknown(), size: z.unknown(), references: z.unknown() }

function ownImageRules({ maxImages, minImages, size, references }: { maxImages: number, minImages?: unknown, size?: unknown, references?: unknown }): Omit<InputImageRules, 'whenParameter'> {
  const sizeRules = isRecord(size) ? imageSizeRules(size) : undefined
  const fewest = typeof minImages === 'number' && Number.isInteger(minImages) && minImages > 0 && minImages <= maxImages ? minImages : undefined
  const promptName = isRecord(references) && typeof references.promptName === 'string' && references.promptName.includes('{n}') ? references.promptName : undefined
  return {
    maxImages,
    ...(fewest !== undefined && { minImages: fewest }),
    ...(sizeRules && { size: sizeRules }),
    ...(isRecord(references) && { references: promptName === undefined ? {} : { promptName } }),
  }
}

const whenParameterSchema = z.object({ name: z.string().min(1), value: optionValueSchema, rules: z.object(ownImageRulesShape).transform(ownImageRules) })

const inputImageRulesSchema = z.object({ ...ownImageRulesShape, whenParameter: z.unknown() })
  .transform(({ whenParameter, ...own }): InputImageRules => {
    const other = whenParameterSchema.safeParse(whenParameter)
    return { ...ownImageRules(own), ...(other.success && { whenParameter: other.data }) }
  })

// A number of a clip rule: a count is a whole number, and each number is
// above 0.
function clipRuleNumber(value: unknown, whole: boolean): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && (!whole || Number.isInteger(value)) ? value : undefined
}

// ClipKindRules (src/model/providers/clipInputs.ts). A bad rule is dropped
// alone, and the kind stays with its use: the provider then checks what
// Dez does not. A least length above the most length is no rule, so it is
// dropped too, and so is a prompt name with no `{n}` (the clips then keep
// their ids in the prompt). A kind with no known use is dropped.
const clipKindRulesSchema = z.object({
  use: z.enum(CLIP_USES),
  maxClips: z.unknown(),
  minSeconds: z.unknown(),
  maxSeconds: z.unknown(),
  maxTotalSeconds: z.unknown(),
  maxBytes: z.unknown(),
  types: z.unknown(),
  promptName: z.unknown(),
  urlOnly: z.unknown(),
}).transform((rules): ClipKindRules => {
  const maxClips = clipRuleNumber(rules.maxClips, true)
  const maxSeconds = clipRuleNumber(rules.maxSeconds, false)
  const minSeconds = clipRuleNumber(rules.minSeconds, false)
  const maxTotalSeconds = clipRuleNumber(rules.maxTotalSeconds, false)
  const maxBytes = clipRuleNumber(rules.maxBytes, true)
  const types = Array.isArray(rules.types) && rules.types.length > 0 && rules.types.every((type) => typeof type === 'string' && type !== '') ? rules.types as string[] : undefined
  const promptName = typeof rules.promptName === 'string' && rules.promptName.includes('{n}') ? rules.promptName : undefined
  return {
    use: rules.use,
    ...(maxClips !== undefined && { maxClips }),
    ...(minSeconds !== undefined && (maxSeconds === undefined || minSeconds <= maxSeconds) && { minSeconds }),
    ...(maxSeconds !== undefined && { maxSeconds }),
    ...(maxTotalSeconds !== undefined && { maxTotalSeconds }),
    ...(maxBytes !== undefined && { maxBytes }),
    ...(types && { types }),
    ...(promptName !== undefined && { promptName }),
    ...(rules.urlOnly === true && { urlOnly: true }),
  }
})

// InputClipRules. A bad kind is dropped alone, and the other stays; the
// rule of the audio clips goes with them. With no kind left, the model has
// no clip rules (as from `MediaFormat.clipRules`): it takes no clip.
const inputClipRulesSchema = z.object({ audio: z.unknown(), video: z.unknown(), audioNeedsVisual: z.unknown() })
  .transform(({ audio, video, audioNeedsVisual }): InputClipRules | undefined => {
    const audioRules = clipKindRulesSchema.safeParse(audio)
    const videoRules = clipKindRulesSchema.safeParse(video)
    if (!audioRules.success && !videoRules.success) return undefined
    return {
      ...(audioRules.success && { audio: audioRules.data }),
      ...(videoRules.success && { video: videoRules.data }),
      ...(audioRules.success && audioNeedsVisual === true && { audioNeedsVisual: true }),
    }
  })

// The transform drops the `clips` key of a model whose clip rules have no
// kind left, which Zod would keep with an undefined value.
const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().refine(isValidProviderId, 'invalid provider id'),
  // Optional with no version bump: a cache written before a field existed
  // reads it as "unknown" until the next model check.
  readableName: z.string().min(1).optional(),
  imageInput: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  thinking: z.boolean().optional(),
  unsupportedSettings: z.array(z.string()).min(1).optional(),
  outputs: z.array(z.enum(MODEL_OUTPUT_IDS)).optional(),
  request: z.enum(MODEL_REQUESTS).optional(),
  parameters: z.array(modelParameterSchema).min(1).optional(),
  text: clipTextRulesSchema.optional(),
  images: inputImageRulesSchema.optional(),
  clips: inputClipRulesSchema.optional(),
  unstoredOutput: z.string().min(1).optional(),
}).transform(({ clips, ...model }) => ({ ...model, ...(clips && { clips }) }))

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
