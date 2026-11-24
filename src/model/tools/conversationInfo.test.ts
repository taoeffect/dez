import { describe, expect, it } from 'vitest'
import { pictureBudgetLeftText } from './assetView'
import { conversationInfoText, type ConversationInfoFacts } from './conversationInfo'
import type { JobInfo } from './jobs'
import { jobInfo } from './testing'

const BUDGET = { left: { pictures: 12, tokens: 57_408, bytes: 3 * 1024 ** 2 }, roundPictures: 12 }

const text = (facts: Partial<ConversationInfoFacts> = {}) => conversationInfoText({
  contextSize: { tokens: 81_234, estimated: true },
  contextWindow: 200_000,
  compactions: undefined,
  cost: { usd: 0.42, requests: 5, unpriced: 1 },
  jobs: [],
  pictureBudget: BUDGET,
  money: { limit: undefined, spent: { counted: 0.42, held: 0 } },
  ...facts,
})

// A job of a reply; `cost` is absent for a job that sent no paid request.
const job = (number: number, status: JobInfo['status'], cost?: number | null): JobInfo =>
  jobInfo({ id: `j-${number}`, status, call: { number, label: '' }, ...(cost !== undefined && { cost }) })

describe('conversationInfoText', () => {
  it('tells the context size, the window, and the size at which Dez compacts the conversation', () => {
    const lines = text().split('\n')

    expect(lines[0]).toContain('about 81,234 tokens (an estimate of Dez)')
    expect(lines[1]).toContain('200,000 tokens')
    // 65% of the window, and never more than 250,000 tokens.
    expect(lines[2]).toContain('gets to 130,000 tokens')
    expect(text({ contextWindow: 1_000_000 })).toContain('gets to 250,000 tokens')
    expect(text({ contextSize: { tokens: 81_234, estimated: false } }).split('\n')[0]).toContain('Context size: 81,234 tokens (the count of the provider)')
  })

  // A threshold of 130,000; a quarter of it is 32,500.
  it('tells a later compaction size when the newest compaction left the conversation near the threshold', () => {
    const cost = { usd: 7.38, requests: 131, unpriced: 0 }
    const dueLine = (left: number) => text({ compactions: { count: 1, tokens: 300_000, cost, left } }).split('\n')[2]

    expect(dueLine(120_000)).toContain('gets to 152,500 tokens')
    expect(dueLine(20_000)).toContain('gets to 130,000 tokens')
  })

  it('gives one cost before the first compaction, with the requests of no known price', () => {
    const lines = text().split('\n')

    expect(lines).toContain('Compactions so far: none.')
    expect(lines.filter((line) => line.startsWith('Cost of the conversation'))).toEqual([
      'Cost of the conversation so far (an estimate): $0.42 for 5 requests. 1 of them has no known price, and the sum leaves it out.',
    ])
    expect(text({ cost: undefined })).toContain('Cost of the conversation so far: none.')
  })

  it('gives the size of the whole conversation and the cost since the newest compaction after a compaction', () => {
    const lines = text({
      compactions: { count: 3, tokens: 1_150_000, cost: { usd: 7.38, requests: 131, unpriced: 2 } },
      cost: { usd: 7.8, requests: 136, unpriced: 3 },
    }).split('\n')

    expect(lines[0]).toContain('the conversation since its newest compaction')
    expect(lines[3]).toContain('Compactions so far: 3. The whole conversation is about 1,231,234 tokens')
    expect(lines.filter((line) => line.startsWith('Cost of the conversation'))).toEqual([
      'Cost of the conversation since its newest compaction (an estimate): $0.42 for 5 requests. 1 of them has no known price, and the sum leaves it out.',
      'Cost of the conversation so far (an estimate): $7.80 for 136 requests. 3 of them have no known price, and the sum leaves them out.',
    ])
  })

  it('tells that no request went since a compaction that just ended', () => {
    const cost = { usd: 7.38, requests: 131, unpriced: 0 }

    expect(text({ compactions: { count: 1, tokens: 150_000, cost }, cost })).toContain('Cost of the conversation since its newest compaction: none.')
  })

  // The cost of a conversation gets the price of a job at the end of the job.
  it('tells the paid requests of the jobs that still run, which the cost does not hold yet', () => {
    const line = (jobs: JobInfo[]) => text({ jobs }).split('\n').find((candidate) => candidate.startsWith('Not in the cost yet')) ?? null

    // A job that ended is in the cost, and a job with no paid request
    // costs nothing.
    expect(line([job(1, 'finished', 0.5), job(2, 'running')])).toBeNull()
    expect(line([job(1, 'running', 0.25), job(2, 'running', 0.05), job(3, 'running', null), job(4, 'failed', 9)]))
      .toContain('3 jobs of this reply that still run')
    expect(line([job(1, 'running', 0.25), job(2, 'running', 0.05), job(3, 'running', null)]))
      .toContain('$0.30 for 2 jobs, and 1 job with no known price.')
    expect(line([job(1, 'running', null)])).toContain('Dez knows no price of it.')
  })

  it('ends with the picture budget that is left, or tells that the model gets no pictures', () => {
    expect(text().split('\n').at(-1)).toBe(pictureBudgetLeftText(BUDGET))
    expect(text({ pictureBudget: null }).split('\n').at(-1)).toContain('gets no pictures')
  })
})
