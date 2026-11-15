import type { ContextSize } from '../../model/chat/contextSize'

/** The text and the tooltip of the token label of the bottom bar. */
export interface TokenLabelTexts {
  text: string
  tooltip: string
}

const TOKEN_UNITS = [
  { size: 1_000_000, suffix: 'M' },
  { size: 1_000, suffix: 'k' },
] as const

/** A token count in at most 3 digits: `842`, `1.2k`, `81.2k`, `130k`,
 *  `1.2M`. A count under 100 of its unit keeps one decimal (also `1.0k`),
 *  so the width of the label does not change with each new value of a
 *  count that grows. */
export function labelTokenText(tokens: number): string {
  const count = Math.max(0, Math.round(tokens))
  // A count that rounds to 1000 of a unit shows in the next one: 999,500
  // is `1.0M`, not `1000k`.
  const unit = TOKEN_UNITS.find(({ size }) => count >= size * 0.9995)
  if (!unit) return String(count)
  // The count is rounded once, to tenths of the unit, and that number
  // picks the form: 99,950 shows as `100k`, not as `100.0k`.
  const tenths = Math.round(count * 10 / unit.size)
  return `${tenths < 1000 ? (tenths / 10).toFixed(1) : Math.round(count / unit.size)}${unit.suffix}`
}

// How much of `contextWindow` a conversation of `tokens` fills.
function windowShareText(tokens: number, contextWindow: number): string {
  const percent = 100 * tokens / contextWindow
  return percent > 0 && percent < 1 ? 'less than 1%' : `${Math.round(percent)}%`
}

// Whole numbers with thousands separators (`81,234`), the same on every
// computer.
const WHOLE_NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** The label of the context size of a conversation: the count, with `~`
 *  before it when it is an estimate of Dez and not a provider's count. The
 *  tooltip gives the whole number, what it counts, and how much of
 *  `contextWindow` it fills (the window of the active model, in tokens;
 *  undefined when Dez knows none: no model, or a model of no chat request).
 *  Help › General (`HelpView.vue`) tells the user the mark. */
export function tokenLabelTexts(size: ContextSize, contextWindow: number | undefined): TokenLabelTexts {
  const lines = [
    `Size of this conversation: ${size.estimated ? 'about ' : ''}${WHOLE_NUMBER.format(size.tokens)} tokens`,
    'It is what your next message sends to the model: the conversation, with the system prompt and the tools that go with it.',
    size.estimated
      ? 'Dez estimates it (~): no provider counted the conversation as it is now.'
      : 'The provider counted it in the newest reply.',
  ]
  if (contextWindow !== undefined) {
    lines.push(`Context window of the model: ${WHOLE_NUMBER.format(contextWindow)} tokens. The conversation fills ${windowShareText(size.tokens, contextWindow)} of it.`)
  }
  return { text: `${size.estimated ? '~' : ''}${labelTokenText(size.tokens)}`, tooltip: lines.join('\n') }
}
