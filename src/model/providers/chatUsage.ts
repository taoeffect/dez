import { isProviderRefusal } from './errors'
import { roundedPrice, type ModelPrice } from './modelPrices'

/** What a provider tells, at the end of a chat stream, about the tokens
 *  and the price of the request. `inputTokens` counts every input token,
 *  in both wire formats: the ones that the provider's prompt cache gave
 *  (`cachedInputTokens`), the ones that the request put into the cache
 *  (`cacheWriteTokens`), and the rest (`inputTokenParts`). So
 *  `inputTokens + outputTokens` is the size of the conversation after the
 *  request. `providerCost` is the provider's own price of the request, in
 *  USD. A field is absent when the provider does not tell it. */
export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  providerCost?: number
}

/** The input tokens of a request, in the three parts that have a rate of
 *  their own. They always add up to `ChatUsage.inputTokens`. */
export interface InputTokenParts {
  /** The tokens that the prompt cache did not give and did not take. */
  uncached: number
  /** The tokens that the prompt cache gave. */
  cacheRead: number
  /** The tokens that the request put into the prompt cache. */
  cacheWrite: number
}

/** The parts of the input tokens of `usage`; undefined with no input
 *  count. A part that the provider does not tell is 0. A part that is
 *  larger than what is left of the input count is cut to it (the reads
 *  first), so that a bad count of a provider never gives a part under 0. */
export function inputTokenParts(usage: ChatUsage | undefined): InputTokenParts | undefined {
  if (usage?.inputTokens === undefined) return undefined
  const cacheRead = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cacheRead)
  return { uncached: usage.inputTokens - cacheRead - cacheWrite, cacheRead, cacheWrite }
}

/** A count or a price that a provider gives as a number (in a usage
 *  report, or a price table): a number that is 0 or more. */
export function usageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** `usage` with the known fields of `report` in place of its own: a later
 *  report of a stream tells the newer counts. Undefined while no field is
 *  known. */
export function withUsageReport(usage: ChatUsage | undefined, report: ChatUsage): ChatUsage | undefined {
  const known = Object.fromEntries(Object.entries(report).filter(([, value]) => value !== undefined)) as ChatUsage
  const merged = { ...usage, ...known }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** The price of one chat request in USD: the provider's own when it told
 *  one, else the token counts at the model's list price (also an old one:
 *  the best estimate there is), else undefined (unknown). The tokens that
 *  the prompt cache gave cost the list's cached rate, and the tokens that
 *  went into the cache cost its cache write rate (some providers ask more
 *  for them than for other input). Each costs the input rate when the
 *  list has no rate for it: a rate that Dez does not know must never
 *  count as 0. A cache write never costs less than the input rate: some
 *  lists give a write rate under it (the Gemini models of OpenRouter and
 *  Venice; live lists, 2026-11-14), and a token that goes into the cache
 *  is still an input token, so such a rate is at most what the write
 *  costs on top. */
export function chatRequestCost(usage: ChatUsage | undefined, price: ModelPrice | undefined): number | undefined {
  if (usage?.providerCost !== undefined) return usage.providerCost
  const input = inputTokenParts(usage)
  if (price?.unit !== 'token' || input === undefined || usage?.outputTokens === undefined) return undefined
  const microUsd = input.uncached * price.input
    + input.cacheRead * (price.cachedInput ?? price.input)
    + input.cacheWrite * Math.max(price.cacheWrite ?? price.input, price.input)
    + usage.outputTokens * price.output
  return roundedPrice(microUsd / 1_000_000)
}

/** The price of a chat request that went (`onSent`) and whose
 *  `dez.provider/streamChat` then rejected with `error`: 0 when the
 *  provider refused it (`isProviderRefusal`: a refused request costs
 *  nothing), else unknown (null): a stop, a connection or a stream that
 *  broke while the provider can have made a part of the answer, or a
 *  failed download of an image of the answer, which the provider made. */
export function failedChatRequestCost(error: unknown): 0 | null {
  return isProviderRefusal(error) ? 0 : null
}
