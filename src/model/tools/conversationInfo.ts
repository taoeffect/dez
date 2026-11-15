import type { Compactions } from '../chat/compaction'
import { conversationCostText } from '../chat/compactionNotes'
import { compactionThreshold, type ContextSize } from '../chat/contextSize'
import { costSince, type ConversationCost } from '../chat/conversationCost'
import { usdText } from '../providers/modelPrices'
import type { PictureBudget } from '../streams/pictureBudget'
import { countText, pictureBudgetLeftText } from './assetView'
import type { JobInfo } from './jobs'
import type { ToolDefinition } from './types'

// `conversation_info`: the numbers of the conversation of a reply, for the
// model of the reply. The user sees them in the bottom bar
// (view/thread/UsageLabel.vue); a model gets them only with this tool, so
// that it can keep to a budget of cost or of tokens that the user gave it,
// and can tell how near the next compaction is.
//
// The description is static, and the system prompt names no number of a
// conversation: both are in the provider's prompt cache. So the numbers
// come only in the result of a call.
export const CONVERSATION_INFO_TOOL: ToolDefinition = {
  name: 'conversation_info',
  description: 'Tell the size and the cost of this conversation: its context size in tokens, the context window of your model, '
    + 'the size at which Dez compacts the conversation (your notes then take the place of the earlier messages), how many compactions it had, '
    + 'what its requests cost so far (an estimate, with the count of the requests that have no known price), '
    + 'and the picture budget that this reply has left. '
    + 'Call it when the user gave you a budget of cost or of tokens: before a step that costs much, and again after it. '
    + 'It sends no request, and it does not wait.',
  parameters: [],
}

/** What a `conversation_info` call tells. */
export interface ConversationInfoFacts {
  /** The context size of the conversation, for the model of the reply. */
  contextSize: ContextSize
  /** The context window of the model of the reply, in tokens. */
  contextWindow: number
  /** The numbers of the compactions of the conversation; undefined before
   *  its first one. */
  compactions: Compactions | undefined
  /** What the requests of the conversation cost; undefined before its
   *  first counted request. */
  cost: ConversationCost | undefined
  /** The jobs of the reply. */
  jobs: readonly JobInfo[]
  /** The picture budget that the reply has left; null for a model that
   *  gets no pictures. */
  pictureBudget: PictureBudget | null
}

// A count of things, as in `1 compaction`, `3 compactions`.
function countOf(count: number, name: string): string {
  return `${countText(count)} ${name}${count === 1 ? '' : 's'}`
}

// The line of the jobs that run with a paid request: the cost of a
// conversation gets the price of a job only at the end of the job
// (`ReplyJobs`, controller/jobs.ts), so the sums of a call leave these
// requests out. A model that keeps to a budget must count them too. Null
// when no such job runs.
function openJobsText(jobs: readonly JobInfo[]): string | null {
  const open = jobs.filter((job) => job.status === 'running' && job.cost !== undefined)
  if (open.length === 0) return null
  const prices = open.flatMap(({ cost }) => (typeof cost === 'number' ? [cost] : []))
  const unpriced = open.length - prices.length
  const start = `Not in the cost yet: the paid ${open.length === 1 ? 'request' : 'requests'} of ${countOf(open.length, 'job')} of this reply that still ${open.length === 1 ? 'runs' : 'run'}. `
    + 'Dez counts the request of a job when the job ends.'
  if (prices.length === 0) return `${start} Dez knows no price of ${open.length === 1 ? 'it' : 'them'}.`
  const total = usdText(prices.reduce((sum, price) => sum + price, 0))
  const rest = unpriced === 0 ? '' : `, and ${countOf(unpriced, 'job')} with no known price`
  return `${start} An estimate (the provider's price, else its quote): ${total} for ${countOf(prices.length, 'job')}${rest}.`
}

/** The result text of a `conversation_info` call: the context size and the
 *  context window, when Dez compacts the conversation, its compactions
 *  (with the size of the whole conversation), its cost (after a
 *  compaction, first the cost since the newest one), the paid requests of
 *  the jobs that the cost does not hold yet, and the picture budget. */
export function conversationInfoText({ contextSize, contextWindow, compactions, cost, jobs, pictureBudget }: ConversationInfoFacts): string {
  const about = contextSize.estimated ? 'about ' : ''
  const lines = [
    `Context size: ${about}${countText(contextSize.tokens)} tokens (${contextSize.estimated ? 'an estimate of Dez' : 'the count of the provider'}). `
      + `It is what your next request sends: the conversation${compactions ? ' since its newest compaction' : ''}, with the system prompt and the tools.`,
    `Context window of your model: ${countText(contextWindow)} tokens.`,
    `Compaction: Dez compacts the conversation when its context size gets to ${countText(compactionThreshold(contextWindow))} tokens, `
      + 'or sooner when its images and pictures are near a limit of your model. Dez then asks you for notes, which take the place of the earlier messages.',
  ]
  if (compactions) {
    lines.push(
      `Compactions so far: ${countText(compactions.count)}. The whole conversation is ${about}${countText(compactions.tokens + contextSize.tokens)} tokens: `
        + `the context size now, plus the context size at ${compactions.count === 1 ? 'its compaction' : 'each of its compactions'}. `
        + 'The requests sent more tokens than that in sum, as each request sends its context again.',
      conversationCostText(costSince(cost, compactions.cost), 'since its newest compaction'),
    )
  } else {
    lines.push('Compactions so far: none.')
  }
  lines.push(
    conversationCostText(cost, 'so far'),
    'The cost holds each request that Dez counted: the requests of the replies, the compaction requests, and the requests of the jobs that ended.',
  )
  const openJobs = openJobsText(jobs)
  if (openJobs) lines.push(openJobs)
  lines.push(pictureBudget ? pictureBudgetLeftText(pictureBudget) : 'Picture budget: none. Your model gets no pictures.')
  return lines.join('\n')
}
