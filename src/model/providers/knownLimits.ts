import * as z from 'zod'
import { configIssueText, isValidProviderId, MEDIA_API_FORMAT_IDS, type MediaApiFormatId } from './config'
import knownLimitsFile from './knownLimits.json'
import { MODEL_REQUESTS, type ModelRequest } from './types'

// The known limits of models (knownLimits.json): rules that Dez knows from
// other places than the provider's model data, such as a rule of the
// provider's docs that Dez does not check, a refusal that Dez saw, or a limit
// of Dez itself. `model_info` gives the ones of a model as `dez.limits`, so a
// model can plan a request; Dez refuses no request by them.
//
// An entry's `match` tells the models that the limit is for; each part that
// it names must match. It names a media format (`mediaApi.format`, so a
// custom provider of the Venice format gets the Venice rows) or a provider
// id. `checked` is the day that someone last checked the rule at its source.

const matchSchema = z.strictObject({
  mediaFormat: z.enum(MEDIA_API_FORMAT_IDS).optional(),
  providerId: z.string().refine(isValidProviderId).optional(),
  // The model's request kind is one of these.
  request: z.array(z.enum(MODEL_REQUESTS)).min(1).optional(),
  // The model's id is one of these, or starts with one of these.
  modelIds: z.array(z.string().min(1)).min(1).optional(),
  modelIdPrefixes: z.array(z.string().min(1)).min(1).optional(),
  // The model's id holds this text.
  modelIdIncludes: z.string().min(1).optional(),
}).refine((match) => match.mediaFormat !== undefined || match.providerId !== undefined, 'A match must name a media format or a provider id.')

const knownLimitEntrySchema = z.strictObject({
  // Unique in the file, and stable.
  id: z.string().min(1),
  match: matchSchema,
  // One or two plain sentences for the model that reads model_info: the
  // rule, and whose rule it is.
  text: z.string().trim().min(1),
  source: z.string().trim().min(1),
  checked: z.iso.date(),
  // The numbers of the rule, by name, for a model that compares them.
  limit: z.record(z.string(), z.number()).optional(),
})

/** The form of knownLimits.json. The tests check the file with it. */
export const knownLimitsFileSchema = z.strictObject({ limits: z.array(knownLimitEntrySchema) })

export type KnownLimitEntry = z.infer<typeof knownLimitEntrySchema>

/** A known limit of a model, as `model_info` gives it in `dez.limits`. */
export interface KnownLimit {
  text: string
  source: string
  limit?: Record<string, number>
}

/** The model that a known limit can be for. */
export interface KnownLimitTarget {
  providerId: string
  /** The format of the provider's media API; none for a provider with no
   *  media API. */
  mediaFormat?: MediaApiFormatId
  modelId: string
  /** The model's request kind; none when Dez has no cached model. */
  request?: ModelRequest
}

/** The entries of a known limits file. An entry that breaks the form is left
 *  out and logged, so that a bad entry never stops the app from starting. */
export function parseKnownLimits(file: unknown): KnownLimitEntry[] {
  const list = z.object({ limits: z.array(z.unknown()) }).safeParse(file)
  if (!list.success) {
    console.error(`Dez left out every known model limit: the file has no list of limits. ${configIssueText(list.error)}`)
    return []
  }
  return list.data.limits.flatMap((value, index) => {
    const entry = knownLimitEntrySchema.safeParse(value)
    if (entry.success) return [entry.data]
    console.error(`Dez left out the known model limit at index ${index}: ${configIssueText(entry.error)}`)
    return []
  })
}

const KNOWN_LIMITS = parseKnownLimits(knownLimitsFile)

/** Whether a known limit with the match `match` is for the model `target`. */
export function matchesKnownLimit(match: KnownLimitEntry['match'], target: KnownLimitTarget): boolean {
  const { modelId } = target
  return (match.mediaFormat === undefined || match.mediaFormat === target.mediaFormat)
    && (match.providerId === undefined || match.providerId === target.providerId)
    && (match.request === undefined || (target.request !== undefined && match.request.includes(target.request)))
    && (match.modelIds === undefined || match.modelIds.includes(modelId))
    && (match.modelIdPrefixes === undefined || match.modelIdPrefixes.some((prefix) => modelId.startsWith(prefix)))
    && (match.modelIdIncludes === undefined || modelId.includes(match.modelIdIncludes))
}

/** The known limits of the model `target` among `entries` (by default the
 *  ones of knownLimits.json), in their order. */
export function knownLimitsOf(target: KnownLimitTarget, entries: readonly KnownLimitEntry[] = KNOWN_LIMITS): KnownLimit[] {
  return entries
    .filter((entry) => matchesKnownLimit(entry.match, target))
    .map(({ text, source, limit }) => ({ text, source, ...(limit && { limit }) }))
}
