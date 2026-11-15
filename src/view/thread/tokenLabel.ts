import type { Compactions } from '../../model/chat/compaction'
import { compactionDueSize, type ContextSize } from '../../model/chat/contextSize'

/** The text and the tooltip of the token label of the bottom bar. */
export interface TokenLabelTexts {
  /** The size of the conversation, or, after a compaction, of its buffer
   *  (the conversation since its last compaction). */
  text: string
  tooltip: string
  /** Only after a compaction: the size of the whole conversation, in
   *  parentheses, which the label shows after `text`, with its own
   *  tooltip. */
  total?: { text: string, tooltip: string }
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
 *  tooltip gives the whole number, what it counts, how much of
 *  `contextWindow` it fills (the window of the active model, in tokens;
 *  undefined when Dez knows none: no model, or a model of no chat request),
 *  and at which size Dez compacts it (`compactionDueSize`).
 *
 *  After a compaction (`compactions`), that count is the size of the
 *  buffer, and `total` is the size of the whole conversation: the sizes
 *  that the conversation had at its compactions, plus the buffer. It is not
 *  the sum of the tokens of all requests, which is much more: each request
 *  sends its conversation again. Help › General (`HelpView.vue`) tells the
 *  user the mark and the two numbers. */
export function tokenLabelTexts(size: ContextSize, contextWindow: number | undefined, compactions?: Compactions): TokenLabelTexts {
  const about = size.estimated ? 'about ' : ''
  const subject = compactions ? 'buffer' : 'conversation'
  const sent = 'what your next message sends to the model'
  const lines = [
    `Size of this ${subject}: ${about}${WHOLE_NUMBER.format(size.tokens)} tokens`,
    compactions
      ? `The buffer is the conversation since its last compaction: the notes of that compaction, and all after them. It is ${sent}, with the system prompt and the tools that go with it.`
      : `It is ${sent}: the conversation, with the system prompt and the tools that go with it.`,
    size.estimated
      ? 'Dez estimates it (~): no provider counted the conversation as it is now.'
      : 'The provider counted it in the newest reply.',
  ]
  if (contextWindow !== undefined) {
    const dueSize = WHOLE_NUMBER.format(compactionDueSize(contextWindow, compactions))
    lines.push(
      `Context window of the model: ${WHOLE_NUMBER.format(contextWindow)} tokens. The ${subject} fills ${windowShareText(size.tokens, contextWindow)} of it.`,
      compactions
        ? `Dez compacts the conversation again when the buffer gets to ${dueSize} tokens.`
        : `Dez compacts the conversation when it gets to ${dueSize} tokens: notes of the model then take the place of the earlier messages.`,
    )
  }
  const texts: TokenLabelTexts = { text: `${size.estimated ? '~' : ''}${labelTokenText(size.tokens)}`, tooltip: lines.join('\n') }
  if (!compactions) return texts
  // No `~` in the parentheses: the mark of the buffer covers the sum too,
  // and the tooltip says "about".
  const totalTokens = compactions.tokens + size.tokens
  const compactionsText = compactions.count === 1 ? 'its compaction' : `each of its ${compactions.count} compactions`
  return {
    ...texts,
    total: {
      text: `(${labelTokenText(totalTokens)})`,
      tooltip: [
        `Size of the whole conversation: ${about}${WHOLE_NUMBER.format(totalTokens)} tokens`,
        `It is this buffer, plus the size that the conversation had at ${compactionsText}.`,
        'The requests sent more tokens than that in sum, as each request sends its conversation again. The cost tells what they cost.',
      ].join('\n'),
    },
  }
}
