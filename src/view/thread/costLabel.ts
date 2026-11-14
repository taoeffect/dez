import type { ConversationCost } from '../../model/chat/conversationCost'
import { usdText } from '../../model/providers/modelPrices'

/** The text and the tooltip of the cost label of the bottom bar. */
export interface CostLabelTexts {
  text: string
  tooltip: string
}

/** A sum in USD with 2 decimals (`$0.42`, `$12.30`), or with 2 significant
 *  digits when it rounds to less than a cent (`$0.0031`), so that a small
 *  sum never shows as `$0.00`. Never with an exponent. */
export function labelUsdText(usd: number): string {
  if (usd <= 0) return '$0.00'
  // The exponent of the sum rounded to 2 significant digits: 0.00996 gives
  // `1.0e-2`, so it shows as `$0.01`, not as `$0.010`.
  const exponent = Number(usd.toExponential(1).split('e')[1])
  return `$${usd.toFixed(exponent >= -2 ? 2 : Math.min(100, 1 - exponent))}`
}

/** The label of the cost of a conversation: the sum, with `+` when a request
 *  has no known price (the real cost is higher), and ` (?)` when the user
 *  changed the text of a reply (the cost can be for text that is gone).
 *  The tooltip gives the sum with more digits and the request counts. */
export function costLabelTexts(cost: ConversationCost, edited: boolean): CostLabelTexts {
  const unpriced = cost.unpriced > 0 ? '+' : ''
  const requests = `${cost.requests} ${cost.requests === 1 ? 'request' : 'requests'}`
  // "at least" when a request has no known price, as the real cost is higher.
  const sum = cost.unpriced >= cost.requests
    ? 'not known'
    : `${cost.unpriced > 0 ? 'at least' : 'about'} ${usdText(cost.usd)}`
  const lines = [
    `Cost of this conversation: ${sum}`,
    cost.unpriced > 0 ? `${requests}, ${cost.unpriced} with no known price (not in the sum)` : requests,
  ]
  if (edited) lines.push('You changed or deleted a reply. Its cost is still in the sum.')
  return { text: `${labelUsdText(cost.usd)}${unpriced}${edited ? ' (?)' : ''}`, tooltip: lines.join('\n') }
}
