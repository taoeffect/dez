import type { ModelOutput } from '../modelOutputs'
import type { ProviderConfig } from './config'
import type { ParameterValues } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'
import type { MediaKind } from './types'

// The units of a price with one number (`usd`), in the order of
// `PRICE_UNITS`.
export const SINGLE_PRICE_UNITS = ['character', 'second', 'image', 'clip'] as const

// Every price unit, in the order that a sort by price uses: two prices of
// different units cannot be compared, so the rows of one unit stay
// together.
export const PRICE_UNITS = ['token', ...SINGLE_PRICE_UNITS] as const

// The price of one request unit of a model, in USD, from the provider's
// model list (`ModelInfo.price`):
// - `token`: per 1M input tokens, per 1M output tokens, and, when the list
//   tells them, per 1M input tokens that the provider's prompt cache gives
//   (`cachedInput`) and per 1M input tokens that a request puts into that
//   cache (`cacheWrite`).
// - `character`: per 1M characters of the request's text (speech).
// - `second`: per second of audio that the model makes or reads.
// - `image`: per image that the model makes.
// - `clip`: per clip that the model makes or reads (one request), for the
//   default values of its parameters.
// `note` tells the parameter values or the tier of the price, or that some
// requests have another price. Never empty.
export type ModelPrice =
  | { unit: 'token', input: number, output: number, cachedInput?: number, cacheWrite?: number, note?: string }
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

/** The price in USD of a request whose price is by the characters of its
 *  text (`price` of the unit `character`, per 1M characters), for `text`;
 *  undefined for a price of another unit. A character is a code point, as
 *  a person counts it. */
export function textLengthCost(price: ModelPrice | undefined, text: string): number | undefined {
  return price?.unit === 'character' ? roundedPrice(Array.from(text).length * price.usd / 1_000_000) : undefined
}

/** How long a price stays good without a new check: a quote of the
 *  provider, or the list prices of the provider's model check. Short, so
 *  that a sale of the provider shows soon. */
export const PRICE_LIFETIME_MS = 3_600_000

/** True for a price of the time `at` that is good at `now`. A time after
 *  `now` (the clock of the computer went back) is not good: a new check
 *  costs nothing. */
export function isFreshPrice(at: number, now: number): boolean {
  return now >= at && now - at < PRICE_LIFETIME_MS
}

/** The provider's price of one media request (`dez.provider/mediaQuote`):
 *  a model, its request kind, and the parameter values of the request,
 *  with the price in USD, the note of the quote, and the time of the quote.
 *  Kept in model_cache.json while it is fresh (`isFreshPrice`). */
export interface PriceQuote {
  providerId: string
  modelId: string
  kind: MediaKind
  values: ParameterValues
  usd: number
  note?: string
  at: number
}

/** What a quote is the price of. */
export type QuoteRequest = Pick<PriceQuote, 'providerId' | 'modelId' | 'kind' | 'values'>

// The values of a request as one text that does not depend on the order of
// the names.
function valuesKey(values: ParameterValues): string {
  return JSON.stringify(Object.keys(values).sort().map((name) => [name, values[name]]))
}

function isQuoteOf(quote: PriceQuote, request: QuoteRequest): boolean {
  return quote.providerId === request.providerId && quote.modelId === request.modelId
    && quote.kind === request.kind && valuesKey(quote.values) === valuesKey(request.values)
}

/** The quotes that are fresh at `now`. */
export function freshQuotes(quotes: readonly PriceQuote[], now: number): PriceQuote[] {
  return quotes.filter((quote) => isFreshPrice(quote.at, now))
}

/** The fresh quotes with `quote` in place of an older quote of the same
 *  request. */
export function withQuote(quotes: readonly PriceQuote[], quote: PriceQuote, now: number): PriceQuote[] {
  return [...freshQuotes(quotes, now).filter((kept) => !isQuoteOf(kept, quote)), quote]
}

/** The newest fresh quote of `request`, if any. */
export function freshQuote(quotes: readonly PriceQuote[], request: QuoteRequest, now: number): PriceQuote | undefined {
  return freshQuotes(quotes, now).filter((quote) => isQuoteOf(quote, request))
    .reduce<PriceQuote | undefined>((newest, quote) => (newest && newest.at >= quote.at ? newest : quote), undefined)
}

/** A price in USD as a short text: `$0` for 0, else at least 2 decimals,
 *  and about 4 significant digits for a small price (`$0.0115`, `$0.10`,
 *  `$3.50`), never with an exponent. */
export function usdText(usd: number): string {
  if (usd === 0) return '$0'
  const decimals = Math.min(100, Math.max(2, Math.ceil(-Math.log10(usd)) + 3))
  // The zeros at the end go, but never the first 2 decimals.
  return `$${usd.toFixed(decimals).replace(/(\.\d\d\d*?)0+$/, '$1')}`
}

const UNIT_TEXTS = { character: 'per 1M chars', second: 'per second', image: 'per image', clip: 'per clip' } as const

/** A price as a short text, for a column of a list: `$0.10/$0.50 per 1M
 *  tokens` (input/output), `$0.01 per image`, with its note in
 *  parentheses. */
export function priceText(price: ModelPrice): string {
  const text = price.unit === 'token'
    ? `${usdText(price.input)}/${usdText(price.output)} per 1M tokens`
    : `${usdText(price.usd)} ${UNIT_TEXTS[price.unit]}`
  return price.note === undefined ? text : `${text} (${price.note})`
}

// The token price of a chat model's list entry, at the config's paths
// (`modelTokenPrices` in config.ts). Both the input and the output price
// are needed; with one missing or under 0 the price is unknown. A list
// that has other rates for some requests (a long prompt, a time of day)
// gives its base rate, and the note says so. `outputs`: what the model
// makes (`effectiveOutputs`). A model whose tokens are free but that makes
// images or audio with no price of its own for them has an unknown price,
// not 0: OpenRouter's music models (Lyria) list "0" for their tokens and
// tell their price per clip only in their description.
export function modelTokenPrice(entry: Record<string, unknown>, config: ProviderConfig['modelTokenPrices'], outputs: readonly ModelOutput[]): ModelPrice | undefined {
  if (config === undefined) return undefined
  const input = priceNumber(valueAtPath(entry, config.input))
  const output = priceNumber(valueAtPath(entry, config.output))
  if (input === undefined || output === undefined) return undefined
  // A router or a panel of models has no one price: unknown, never its
  // cheapest rate (`variableRate`, `variableRateBy` in config.ts).
  if (config.variableRate !== undefined && priceNumber(valueAtPath(entry, config.variableRate)) !== undefined) return undefined
  if (config.variableRateBy !== undefined) {
    const kind = valueAtPath(entry, config.variableRateBy.path)
    if (typeof kind === 'string' && config.variableRateBy.values.includes(kind)) return undefined
  }
  const perMillion = (usd: number): number => roundedPrice(usd * 1_000_000 / config.perTokens)
  const pathPrice = (path: string | undefined) => path === undefined ? undefined : priceNumber(valueAtPath(entry, path))
  const cachedInput = pathPrice(config.cachedInput)
  const cacheWrite = pathPrice(config.cacheWrite)
  const mediaPrices = { image: pathPrice(config.imageOutput), audio: pathPrice(config.audioOutput) }
  const unpricedMedia = (['image', 'audio'] as const).some((media) => outputs.includes(media) && mediaPrices[media] === undefined)
  if (input === 0 && output === 0 && unpricedMedia) return undefined
  const notes = [
    ...(config.otherRates !== undefined && hasData(valueAtPath(entry, config.otherRates)) ? ['base rate, some requests have other rates'] : []),
    ...(mediaPrices.image ? [`images: ${usdText(perMillion(mediaPrices.image))} per 1M output tokens`] : []),
    ...(mediaPrices.audio ? [`audio: ${usdText(perMillion(mediaPrices.audio))} per 1M output tokens`] : []),
  ]
  return {
    unit: 'token',
    input: perMillion(input),
    output: perMillion(output),
    ...(cachedInput !== undefined && { cachedInput: perMillion(cachedInput) }),
    ...(cacheWrite !== undefined && { cacheWrite: perMillion(cacheWrite) }),
    ...(notes.length > 0 && { note: notes.join('; ') }),
  }
}

// The token price of a chat model from the config's price table
// (`tokenPrices` in config.ts): the first row whose expression finds the
// model id, read with no case, as modelFamilies.json is; none when no row
// finds it.
export function tokenTablePrice(modelId: string, rows: ProviderConfig['tokenPrices']): ModelPrice | undefined {
  const row = rows?.find(({ match }) => new RegExp(match, 'i').test(modelId))
  if (!row) return undefined
  const { input, output, cachedInput, cacheWrite, note } = row
  return {
    unit: 'token',
    input,
    output,
    ...(cachedInput !== undefined && { cachedInput }),
    ...(cacheWrite !== undefined && { cacheWrite }),
    ...(note && { note }),
  }
}

// A list or an object with at least one item: a list gives `null` or `[]`
// for "no other rates".
function hasData(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return isRecord(value) && Object.keys(value).length > 0
}
