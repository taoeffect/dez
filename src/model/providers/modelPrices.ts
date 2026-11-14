import type { ProviderConfig } from './config'
import { isRecord, valueAtPath } from './modelParsing'

// The units of a price with one number (`usd`), in the order of
// `PRICE_UNITS`.
export const SINGLE_PRICE_UNITS = ['character', 'second', 'image', 'clip'] as const

// Every price unit, in the order that a sort by price uses: two prices of
// different units cannot be compared, so the rows of one unit stay
// together.
export const PRICE_UNITS = ['token', ...SINGLE_PRICE_UNITS] as const

export type PriceUnit = typeof PRICE_UNITS[number]

// The price of one request unit of a model, in USD, from the provider's
// model list (`ModelInfo.price`):
// - `token`: per 1M input tokens, per 1M output tokens, and per 1M input
//   tokens that the provider's prompt cache gives, when it tells that.
// - `character`: per 1M characters of the request's text (speech).
// - `second`: per second of audio that the model makes or reads.
// - `image`: per image that the model makes.
// - `clip`: per clip that the model makes, for the default values of its
//   parameters.
// `note` tells the parameter values or the tier of the price, or that some
// requests have another price. Never empty.
export type ModelPrice =
  | { unit: 'token', input: number, output: number, cachedInput?: number, note?: string }
  | { unit: typeof SINGLE_PRICE_UNITS[number], usd: number, note?: string }

// A price of a list: a number, or a text of a number (OpenRouter gives its
// prices as texts). A value under 0 is no price: OpenRouter gives `-1` to a
// router model, whose price is that of the model that it picks.
export function priceNumber(value: unknown): number | undefined {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

// A price after a sum or a product, with no float noise (`0.0115` and not
// `0.011500000000000002`). Twelve significant digits keep the smallest
// rates of the lists (a dollar per token is 1e-7 and less).
export function roundedPrice(usd: number): number {
  return Number(usd.toPrecision(12))
}

// A price of one number in `unit`, rounded; none with no number.
export function unitPrice(unit: typeof SINGLE_PRICE_UNITS[number], usd: number | undefined, note?: string): ModelPrice | undefined {
  return usd === undefined ? undefined : { unit, usd: roundedPrice(usd), ...(note && { note }) }
}

// The token price of a chat model's list entry, at the config's paths
// (`modelTokenPrices` in config.ts). Both the input and the output price
// are needed; with one missing or under 0 the price is unknown. A list
// that has other rates for some requests (a long prompt, a time of day)
// gives its base rate, and the note says so.
export function modelTokenPrice(entry: Record<string, unknown>, config: ProviderConfig['modelTokenPrices']): ModelPrice | undefined {
  if (config === undefined) return undefined
  const input = priceNumber(valueAtPath(entry, config.input))
  const output = priceNumber(valueAtPath(entry, config.output))
  if (input === undefined || output === undefined) return undefined
  const perMillion = (usd: number): number => roundedPrice(usd * 1_000_000 / config.perTokens)
  const cachedInput = config.cachedInput === undefined ? undefined : priceNumber(valueAtPath(entry, config.cachedInput))
  const imageOutput = config.imageOutput === undefined ? undefined : priceNumber(valueAtPath(entry, config.imageOutput))
  const notes = [
    ...(config.otherRates !== undefined && hasData(valueAtPath(entry, config.otherRates)) ? ['base rate; some requests have other rates'] : []),
    ...(imageOutput ? [`images: $${perMillion(imageOutput)} per 1M output tokens`] : []),
  ]
  return {
    unit: 'token',
    input: perMillion(input),
    output: perMillion(output),
    ...(cachedInput !== undefined && { cachedInput: perMillion(cachedInput) }),
    ...(notes.length > 0 && { note: notes.join('; ') }),
  }
}

// A list or an object with at least one item: a list gives `null` or `[]`
// for "no other rates".
function hasData(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return isRecord(value) && Object.keys(value).length > 0
}
