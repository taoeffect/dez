import { describe, expect, it } from 'vitest'
import { costSince, withRequestCost, type ConversationCost } from './conversationCost'

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
