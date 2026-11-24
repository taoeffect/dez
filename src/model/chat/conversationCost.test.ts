import { describe, expect, it } from 'vitest'
import type { Compactions } from './compaction'
import { costSince, withRequestCost, withRestoredCost, type ConversationCost } from './conversationCost'

describe('costSince', () => {
  it('gives the requests that came after the earlier moment, with their sum and their unpriced count', () => {
    const earlier: ConversationCost = { usd: 7.38, requests: 131, unpriced: 2 }
    const now = withRequestCost(withRequestCost(earlier, 0.42), null)

    expect(costSince(now, earlier)).toStrictEqual({ usd: expect.closeTo(0.42, 10), requests: 2, unpriced: 1 })
  })

  // 0.1 + 0.2 - 0.3 is not 0 in float math: a sum of no request must be.
  it('gives a sum of exactly 0 with no request since that moment', () => {
    const earlier: ConversationCost = { usd: 0.1 + 0.2, requests: 2, unpriced: 0 }

    expect(costSince({ usd: 0.3, requests: 2, unpriced: 0 }, earlier)).toStrictEqual({ usd: 0, requests: 0, unpriced: 0 })
    expect(costSince(undefined, { usd: 0, requests: 0, unpriced: 0 })).toStrictEqual({ usd: 0, requests: 0, unpriced: 0 })
  })

  // The header of a conversation file can hold any numbers.
  it('never gives a part under 0, or more unpriced requests than requests', () => {
    expect(costSince({ usd: 1, requests: 3, unpriced: 3 }, { usd: 2, requests: 2, unpriced: 0 })).toStrictEqual({ usd: 0, requests: 1, unpriced: 1 })
    expect(costSince({ usd: 1, requests: 3, unpriced: 0 }, { usd: 0.5, requests: 5, unpriced: 1 })).toStrictEqual({ usd: 0, requests: 0, unpriced: 0 })
  })
})

describe('withRestoredCost', () => {
  const compactions = (count: number, usd: number): Compactions => ({ count, tokens: 1000 * count, cost: { usd, requests: count, unpriced: 0 }, left: 50 })

  it('adds the removed cost and the cost that the tab counted since the delete, field by field', () => {
    const removed = { cost: { usd: 1.25, requests: 4, unpriced: 1 } }
    const now = { cost: { usd: 0.5, requests: 2, unpriced: 1 } }

    expect(withRestoredCost(now, removed)).toStrictEqual({ cost: { usd: 1.75, requests: 6, unpriced: 2 } })
  })

  it('gives the cost of the one side that has a cost, and no cost key when neither has one', () => {
    const cost: ConversationCost = { usd: 0.3, requests: 1, unpriced: 0 }

    expect(withRestoredCost({}, { cost })).toStrictEqual({ cost })
    expect(withRestoredCost({ cost }, {})).toStrictEqual({ cost })
    expect(withRestoredCost({}, {})).toStrictEqual({})
  })

  it('sets the edited mark when either side has it', () => {
    expect(withRestoredCost({}, { agentTextEdited: true })).toStrictEqual({ agentTextEdited: true })
    expect(withRestoredCost({ agentTextEdited: true }, {})).toStrictEqual({ agentTextEdited: true })
  })

  it('takes the removed compactions when the tab has none now, and the newer ones when both exist', () => {
    const removed = compactions(2, 0.8)
    const newer = compactions(1, 0.1)

    expect(withRestoredCost({}, { compactions: removed })).toStrictEqual({ compactions: removed })
    expect(withRestoredCost({ compactions: newer }, { compactions: removed })).toStrictEqual({ compactions: newer })
  })
})
