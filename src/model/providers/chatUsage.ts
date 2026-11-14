import { isProviderRefusal } from './errors'
import { roundedPrice, type ModelPrice } from './modelPrices'

/** What a provider tells, at the end of a chat stream, about the tokens
 *  and the price of the request. `inputTokens` counts every input token,
 *  the ones that the provider's prompt cache gave too (`cachedInputTokens`
 *  is that part). `providerCost` is the provider's own price of the
 *  request, in USD. A field is absent when the provider does not tell it. */
export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  providerCost?: number
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
 *  the prompt cache gave cost the list's cached rate, or the input rate
 *  when it has none. A list price has no rate for the tokens that go into
 *  the prompt cache, so they cost the input rate (some providers ask
 *  more). */
export function chatRequestCost(usage: ChatUsage | undefined, price: ModelPrice | undefined): number | undefined {
  if (usage?.providerCost !== undefined) return usage.providerCost
  if (price?.unit !== 'token' || usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const microUsd = (usage.inputTokens - cached) * price.input
    + cached * (price.cachedInput ?? price.input)
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
