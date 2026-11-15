import { describe, expect, it } from 'vitest'
import { compactionDueSize, compactionThreshold, contextField, contextSize } from './contextSize'

describe('contextSize', () => {
  it('gives the estimate, marked as one, while no request told its tokens', () => {
    expect(contextSize(undefined, 1200)).toStrictEqual({ tokens: 1200, estimated: true })
  })

  it('gives the count of the provider as it is while the estimate did not change', () => {
    expect(contextSize({ tokens: 5000, estimate: 7000 }, 7000)).toStrictEqual({ tokens: 5000, estimated: false })
  })

  it('adds what the estimate grew by since the count, and takes off what it lost', () => {
    expect(contextSize({ tokens: 5000, estimate: 7000 }, 7300)).toStrictEqual({ tokens: 5300, estimated: true })
    expect(contextSize({ tokens: 5000, estimate: 7000 }, 4000)).toStrictEqual({ tokens: 2000, estimated: true })
  })

  // The estimate of the text can be far over the provider's count.
  it('never goes under 0', () => {
    expect(contextSize({ tokens: 5000, estimate: 7000 }, 100)).toStrictEqual({ tokens: 0, estimated: true })
  })
})

describe('compactionThreshold', () => {
  it('is 65% of the context window, in whole tokens, and never over 250,000', () => {
    expect([200_000, 127_999, 400_000, 1_000_000].map(compactionThreshold)).toStrictEqual([130_000, 83_199, 250_000, 250_000])
  })
})

// A window of 200,000 tokens: a threshold of 130,000, and a quarter of it
// is 32,500.
describe('compactionDueSize', () => {
  const after = (left?: number) => compactionDueSize(200_000, { count: 1, tokens: 150_000, cost: { usd: 0, requests: 0, unpriced: 0 }, ...(left !== undefined && { left }) })

  it('is the threshold with no compaction, and after a compaction that left the conversation well under it', () => {
    expect([compactionDueSize(200_000, undefined), after(), after(0), after(97_500)]).toStrictEqual([130_000, 130_000, 130_000, 130_000])
  })

  // What a compaction leaves can be near the threshold by itself, and a
  // next compaction would take nothing out of it.
  it('waits for a quarter of the threshold over what a compaction left, when that is more', () => {
    expect([after(97_501), after(130_000), after(180_000)]).toStrictEqual([130_001, 162_500, 212_500])
  })
})

describe('contextField', () => {
  it('gives a copy of the count, and no key with no count', () => {
    const counted = { tokens: 5, estimate: 7 }
    const { context } = contextField(counted)

    expect(context).toStrictEqual(counted)
    expect(context).not.toBe(counted)
    expect(contextField(undefined)).toStrictEqual({})
  })
})
