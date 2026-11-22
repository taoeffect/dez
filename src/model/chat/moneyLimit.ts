import { ExplainedError } from '../../utils/errorText'
import { usdText, type ModelPrice } from '../providers/modelPrices'

/** The money limit of one tab, which the user sets in the popup of the
 *  coin after the cost in the bottom bar (view/thread/UsageLabel.vue).
 *  Saved in the tab entry of `app_state.json` and in the conversation
 *  header. No tool can change it. */
export interface MoneyLimit {
  /** The most that the requests of the conversation may cost, in USD; 0 or
   *  more. */
  usd: number
  /** Whether a request with no known price may go under the limit. */
  unknownPrices: boolean
}

/** What the requests of a tab cost so far, for the money rule: `counted`,
 *  the sum of the known prices of the conversation cost
 *  (`ConversationCost.usd`); `held`, the quotes of the paid requests that
 *  still run, which the cost counts only at their end. */
export interface MoneySpent {
  counted: number
  held: number
}

/** The money limit of a tab now (undefined with none), and what the tab
 *  spent. */
export interface TabMoney {
  limit: MoneyLimit | undefined
  spent: MoneySpent
}

/** The price of a request, as the money rule reads it. */
export type RequestPrice =
  /** A chat request: the provider bills its tokens, so Dez knows its price
   *  only after it. `known`: whether the model has a token price. */
  | { kind: 'tokens', known: boolean }
  /** A request with a price before it goes (a media request): its quote in
   *  USD, or null when Dez knows no price. */
  | { kind: 'quote', usd: number | null }

/** Who reads the refusal: the user (a toast), or a model (a tool
 *  result). */
export type MoneyReader = 'user' | 'model'

/** A refusal of the money limit of a tab (`moneyProblem`), for the user:
 *  it ends a reply, and its toast has a title of its own. */
export class MoneyLimitError extends ExplainedError {
  constructor(explanation: string) {
    super(explanation)
    this.name = 'MoneyLimitError'
  }
}

// A sum of float prices (0.1 + 0.2) can be a hair over the exact sum, so a
// request that fits the limit to the cent must not look like one over it.
const ROUNDING_USD = 1e-9

/** Whether `value` is a limit that Dez takes: a finite number of USD, 0 or
 *  more. */
export function isMoneyLimitUsd(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/** For object spreads: `{ moneyLimit }` (a copy), or `{}` without one,
 *  because a copy of a tab must never write `moneyLimit: undefined`. */
export function moneyLimitField(limit: MoneyLimit | undefined): { moneyLimit?: MoneyLimit } {
  return limit ? { moneyLimit: { ...limit } } : {}
}

/** The USD that is left under `limit`, never under 0. */
export function moneyLeft(limit: MoneyLimit, spent: MoneySpent): number {
  return Math.max(0, limit.usd - spent.counted - spent.held)
}

// "$0.42 so far", with the quotes of the requests that run when there are.
function spentText(spent: MoneySpent): string {
  const held = spent.held > 0 ? ` (with ${usdText(spent.held)} of quotes of paid requests that still run)` : ''
  return `${usdText(spent.counted + spent.held)} so far${held}`
}

// What the fix is, for the reader of a refusal. A model must not get
// around the limit, so it stops and asks the user.
function refusalEnd(reader: MoneyReader, unknown: boolean): string {
  if (reader === 'model') {
    return 'This is no fault of the call. The money limit is the user\'s, and no tool can change it. '
      + 'Stop, tell the user what you need and why, and ask whether to raise the limit'
      + `${unknown ? ' or to allow requests with no known price' : ''}.`
  }
  return unknown
    ? 'To send it, click the money limit in the bottom bar and check "Allow unknown prices", or remove the limit there.'
    : 'To go on, click the money limit in the bottom bar, and raise the limit or remove it.'
}

/** Why the money limit of a tab refuses a request with `price`, as a text
 *  for `reader`; null when the request may go. With no limit, Dez refuses
 *  nothing. The rules:
 *  - a request with no known price goes only when the tab allows unknown
 *    prices;
 *  - a chat request goes only while the money spent is under the limit;
 *  - a request with a quote goes only when the money spent plus its quote
 *    is not over the limit. */
export function moneyProblem(limit: MoneyLimit | undefined, spent: MoneySpent, price: RequestPrice, reader: MoneyReader): string | null {
  if (!limit) return null
  const total = spent.counted + spent.held
  const unknown = price.kind === 'tokens' ? !price.known : price.usd === null
  const head = `The requests of this tab cost ${spentText(spent)}, and its money limit is ${usdText(limit.usd)}.`
  if (unknown && !limit.unknownPrices) {
    return `Dez sent no request: Dez knows no price of it, and this tab has a money limit, which lets only requests with a known price go. ${head} ${refusalEnd(reader, true)}`
  }
  if (total >= limit.usd - ROUNDING_USD) {
    return `Dez sent no request: the money limit of this tab is reached. ${head} ${refusalEnd(reader, false)}`
  }
  if (price.kind === 'quote' && price.usd !== null && total + price.usd > limit.usd + ROUNDING_USD) {
    const left = moneyLeft(limit, spent)
    const cheaper = reader === 'model' ? ` A request that costs no more than ${usdText(left)} can still go.` : ''
    return `Dez sent no request: it costs ${usdText(price.usd)}, which is more than the ${usdText(left)} that is left under the money limit of this tab. ${head}${cheaper} ${refusalEnd(reader, false)}`
  }
  return null
}

/** The price of a chat request to a model with the list price `price`
 *  (`ModelInfo.price`): known with a token price, which gives the count of
 *  its cost (`chatRequestCost`). A price that the provider tells only in
 *  its answer is not known before the request. */
export function chatRequestPrice(price: ModelPrice | undefined): RequestPrice {
  return { kind: 'tokens', known: price?.unit === 'token' }
}

/** The line of the money limit for a model (`conversation_info`,
 *  `jobs_list`): the limit, what is left of it, and whether requests with
 *  no known price may go. */
export function moneyLimitText(limit: MoneyLimit | undefined, spent: MoneySpent): string {
  if (!limit) return 'Money limit: none. The user set no limit of the cost of this conversation.'
  const unknown = limit.unknownPrices
    ? 'Requests with no known price may go, and Dez does not count them.'
    : 'Dez refuses a request with no known price.'
  return `Money limit: ${usdText(limit.usd)}, which the user set; ${usdText(moneyLeft(limit, spent))} is left `
    + `(the cost so far, with the quotes of the paid requests that still run, is ${usdText(spent.counted + spent.held)}). `
    + `Dez refuses a request that would go over it. ${unknown} No tool can change the limit: ask the user.`
}
