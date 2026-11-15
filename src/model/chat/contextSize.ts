import type { Compactions } from './compaction'

/** The context of a conversation as its newest chat request counted it: a
 *  chat round of a reply that told its tokens. A media round and the
 *  request of a `model_invoke` job do not count: they send no conversation.
 *  Saved in the conversation header (conversationFormat.ts). */
export interface CountedContext {
  /** The input and the output tokens of that request, as the provider
   *  counted them: the size of the conversation right after it. */
  tokens: number
  /** Dez's own estimate of the conversation at that moment
   *  (`estimatedRequestTokens`, streams/contextEstimate.ts). */
  estimate: number
}

/** About how many tokens the next chat request of a conversation holds. */
export interface ContextSize {
  tokens: number
  /** False only when `tokens` is a provider's count of the conversation as
   *  it is now. */
  estimated: boolean
}

/** The context size of a conversation whose newest counted request is
 *  `counted` (undefined: no request told its tokens), and that Dez
 *  estimates at `estimateNow` tokens as it is now.
 *
 *  The provider's count is the base, and Dez's estimate gives only what
 *  changed since: the estimate now, less the estimate at the count. So the
 *  text that came after the request (tool results, a new message, an edit
 *  of the user) counts at once, and an error of the estimate in the text
 *  that the request held cancels out. The result is never under 0. */
export function contextSize(counted: CountedContext | undefined, estimateNow: number): ContextSize {
  if (!counted) return { tokens: estimateNow, estimated: true }
  return {
    tokens: Math.max(0, counted.tokens + estimateNow - counted.estimate),
    estimated: estimateNow !== counted.estimate,
  }
}

/** The context size at which Dez makes a conversation smaller (a
 *  compaction), for a model with a context window of `contextWindow`
 *  tokens: well under the window, so that the answer and the next tool
 *  results still fit, and never over a size at which requests get slow and
 *  costly. The picture budget is a share of it
 *  (streams/pictureBudget.ts). */
export function compactionThreshold(contextWindow: number): number {
  return Math.min(250_000, Math.floor(0.65 * contextWindow))
}

// The share of the compaction threshold by which a conversation must grow
// after a compaction before its size makes the next one due. What a
// compaction leaves (the system prompt, the tools, the notes, and the
// first and the newest message of the user, word for word) can be near the
// threshold by itself, and the next compaction takes nothing out of that:
// with no such growth, each request of that conversation would compact it
// again.
const MIN_GROWTH_SHARE = 0.25

/** The context size at which a conversation needs a compaction, for a
 *  model with a context window of `contextWindow` tokens: the compaction
 *  threshold, or more when its newest compaction (`compactions`) left
 *  more than 3/4 of it: then a quarter of the threshold over what it left
 *  (`Compactions.left`). A conversation that grows past the window first
 *  gets the provider's error. */
export function compactionDueSize(contextWindow: number, compactions: Compactions | undefined): number {
  const threshold = compactionThreshold(contextWindow)
  return Math.max(threshold, (compactions?.left ?? 0) + Math.floor(MIN_GROWTH_SHARE * threshold))
}

/** For object spreads: `{ context }` (a copy), or `{}` without one, because
 *  a copy of a tab must never write `context: undefined`. */
export function contextField(context: CountedContext | undefined): { context?: CountedContext } {
  return context ? { context: { ...context } } : {}
}
