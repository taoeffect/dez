import type { Compactions } from '../../model/chat/compaction'
import { costSince, type ConversationCost } from '../../model/chat/conversationCost'
import { usdText } from '../../model/providers/modelPrices'

/** The texts of the cost label of the bottom bar. The label shows `text`,
 *  then `total`, then `mark`: `$0.42+ ($7.80+) (?)`. */
export interface CostLabelTexts {
  /** The sum of the conversation, or, after a compaction, of its buffer
   *  (the conversation since its last compaction). */
  text: string
  tooltip: string
  /** Only after a compaction: the sum of the whole conversation, in
   *  parentheses, with its own tooltip. */
  total?: { text: string, tooltip: string }
  /** ` (?)` for a conversation with an edited reply, else empty. */
  mark: string
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

// A sum of the label, with `+` when a request of it has no known price.
function sumText(cost: ConversationCost): string {
  return `${labelUsdText(cost.usd)}${cost.unpriced > 0 ? '+' : ''}`
}

// The two tooltip lines of a sum: the sum with more digits, and its request
// counts. "at least" when a request has no known price, as the real cost
// is higher. `subject` is what the sum counts.
function sumLines(subject: string, cost: ConversationCost): string[] {
  // A buffer has no request right after its compaction.
  if (cost.requests === 0) return [`Cost of ${subject}: nothing yet`, 'No request yet']
  const requests = `${cost.requests} ${cost.requests === 1 ? 'request' : 'requests'}`
  const sum = cost.unpriced >= cost.requests
    ? 'not known'
    : `${cost.unpriced > 0 ? 'at least' : 'about'} ${usdText(cost.usd)}`
  return [
    `Cost of ${subject}: ${sum}`,
    cost.unpriced > 0 ? `${requests}, ${cost.unpriced} with no known price (not in the sum)` : requests,
  ]
}

/** The label of the cost of a conversation: the sum, with `+` when a request
 *  has no known price (the real cost is higher), and the mark ` (?)` when
 *  the user changed the text of a reply (the cost can be for text that is
 *  gone). The tooltip gives the sum with more digits and the request counts.
 *
 *  After a compaction (`compactions`), that sum is the one of the buffer
 *  (the requests since the compaction), and `total` is the sum of the whole
 *  conversation, each with its own `+`. Help › General (`HelpView.vue`)
 *  tells the user these marks and the two sums. */
export function costLabelTexts(cost: ConversationCost, edited: boolean, compactions?: Compactions): CostLabelTexts {
  const mark = edited ? ' (?)' : ''
  if (!compactions) {
    const lines = sumLines('this conversation', cost)
    if (edited) lines.push('You changed or deleted a reply. Its cost is still in the sum.')
    return { text: sumText(cost), tooltip: lines.join('\n'), mark }
  }
  const buffer = costSince(cost, compactions.cost)
  const lines = sumLines('this buffer (the conversation since its last compaction)', buffer)
  if (edited) lines.push('You changed or deleted a reply. Its cost is still in the sum of the whole conversation.')
  const [compactionsText, before] = compactions.count === 1 ? ['its compaction', 'it'] : [`its ${compactions.count} compactions`, 'them']
  return {
    text: sumText(buffer),
    tooltip: lines.join('\n'),
    total: {
      text: `(${sumText(cost)})`,
      tooltip: [
        ...sumLines('the whole conversation', cost),
        `It is the cost of this buffer, of ${compactionsText}, and of all before ${before}.`,
      ].join('\n'),
    },
    mark,
  }
}
