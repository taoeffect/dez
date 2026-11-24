import type { ConversationCost } from '../../model/chat/conversationCost'
import { isMoneyLimitUsd, moneyLeft, type MoneyLimit } from '../../model/chat/moneyLimit'
import { usdText } from '../../model/providers/modelPrices'

/** The texts of the money limit part of the bottom bar (`UsageLabel.vue`):
 *  `text` after its icon (empty with no limit), and its tooltip. The
 *  refusal texts of the money rule (`moneyProblem`) tell the user to
 *  "click the money limit in the bottom bar": this part. */
export interface MoneyLimitLabelTexts {
  text: string
  tooltip: string
}

/** The money limit part for the tab with `limit` and `cost`. What is left
 *  is "about": the view sees only the counted cost, not the quotes of the
 *  paid requests that still run, which the money rule also holds. */
export function moneyLimitLabelTexts(limit: MoneyLimit | undefined, cost: ConversationCost | undefined): MoneyLimitLabelTexts {
  if (!limit) {
    return { text: '', tooltip: 'Money limit: none.\nClick to set the most that the requests of this tab can cost.' }
  }
  const left = moneyLeft(limit, { counted: cost?.usd ?? 0, held: 0 })
  return {
    text: `limit ${usdText(limit.usd)}`,
    tooltip: [
      `Money limit of this tab: ${usdText(limit.usd)}, about ${usdText(left)} left.`,
      limit.unknownPrices
        ? 'Requests with no known price can go. The limit counts the cost of one only when its provider tells it.'
        : 'Dez sends no request whose price it does not know.',
      'Click to change the limit.',
    ].join('\n'),
  }
}

/** The limit that the field of the popup tells: a number of USD (a `$`
 *  before it is fine), null for an empty field (no limit), or undefined
 *  for a text that is no amount, which sets nothing. */
export function draftLimitUsd(text: string): number | null | undefined {
  const amount = text.trim().replace(/^\$\s*/, '')
  if (amount === '') return null
  const usd = Number(amount)
  return isMoneyLimitUsd(usd) ? usd : undefined
}

/** The cost line of the popup: the counted cost of the conversation, and
 *  whether Dez knows no price for some of its requests. */
export function moneySpentText(cost: ConversationCost | undefined): string {
  if (!cost || cost.requests === 0) return 'This conversation cost nothing so far.'
  const unpriced = cost.unpriced > 0
    ? ` Dez knows no price for ${cost.unpriced} of its requests, so it cost more.`
    : ''
  return `This conversation cost about ${usdText(cost.usd)} so far.${unpriced}`
}
