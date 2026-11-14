/** What the requests of one conversation cost, as far as Dez knows: every
 *  chat round, media round, and `model_invoke` job of its replies. Saved
 *  in the conversation header (conversationFormat.ts). */
export interface ConversationCost {
  /** The sum of the known prices, in USD. */
  usd: number
  /** The counted requests, with and without a known price. */
  requests: number
  /** The counted requests with no known price; never more than
   *  `requests`. */
  unpriced: number
}

/** `cost` with one more request, whose price is `usd`, or unknown (null).
 *  A price that is not a finite number of 0 or more counts as unknown. */
export function withRequestCost(cost: ConversationCost | undefined, usd: number | null): ConversationCost {
  const known = usd !== null && Number.isFinite(usd) && usd >= 0
  return {
    usd: (cost?.usd ?? 0) + (known ? usd : 0),
    requests: (cost?.requests ?? 0) + 1,
    unpriced: (cost?.unpriced ?? 0) + (known ? 0 : 1),
  }
}

/** For object spreads: `{ cost }` (a copy), or `{}` without one, because a
 *  copy of a tab must never write `cost: undefined`. */
export function costField(cost: ConversationCost | undefined): { cost?: ConversationCost } {
  return cost ? { cost: { ...cost } } : {}
}

/** For object spreads: `{ agentTextEdited: true }`, or `{}` when the flag
 *  is not set, because a copy of a tab must never write
 *  `agentTextEdited: undefined`. */
export function agentTextEditedField(edited: boolean | undefined): { agentTextEdited?: true } {
  return edited ? { agentTextEdited: true } : {}
}
