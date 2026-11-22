import { describe, expect, it } from 'vitest'
import { moneyLeft, moneyLimitText, moneyProblem, type MoneyLimit, type MoneySpent } from './moneyLimit'

const LIMIT: MoneyLimit = { usd: 5, unknownPrices: false }
const NOTHING: MoneySpent = { counted: 0, held: 0 }
const PRICED_CHAT = { kind: 'tokens', known: true } as const
const UNPRICED_CHAT = { kind: 'tokens', known: false } as const

describe('moneyProblem', () => {
  it('refuses nothing in a tab with no limit', () => {
    const spent = { counted: 1000, held: 1000 }

    expect(moneyProblem(undefined, spent, UNPRICED_CHAT, 'user')).toBeNull()
    expect(moneyProblem(undefined, spent, { kind: 'quote', usd: 99 }, 'model')).toBeNull()
    expect(moneyProblem(undefined, spent, { kind: 'quote', usd: null }, 'model')).toBeNull()
  })

  it('lets a chat request go while the money spent is under the limit, and refuses it at the limit', () => {
    expect(moneyProblem(LIMIT, { counted: 4.99, held: 0 }, PRICED_CHAT, 'user')).toBeNull()
    expect(moneyProblem(LIMIT, { counted: 5, held: 0 }, PRICED_CHAT, 'user')).toContain('limit of this tab is reached')
    expect(moneyProblem(LIMIT, { counted: 7, held: 0 }, PRICED_CHAT, 'user')).toContain('limit of this tab is reached')
  })

  // A job's request goes before its cost is counted: its quote is money
  // that the tab spends already.
  it('counts the quotes of the requests that still run as money spent', () => {
    const problem = moneyProblem(LIMIT, { counted: 3, held: 2 }, PRICED_CHAT, 'user')

    expect(problem).toContain('limit of this tab is reached')
    expect(problem).toContain('$2.00 of quotes of paid requests that still run')
    expect(moneyProblem(LIMIT, { counted: 3, held: 1.5 }, { kind: 'quote', usd: 0.6 }, 'model')).toContain('more than the $0.50 that is left')
  })

  it('lets a quoted request go when the money spent plus its quote is the limit, and refuses one above it', () => {
    expect(moneyProblem(LIMIT, { counted: 4.6, held: 0 }, { kind: 'quote', usd: 0.4 }, 'user')).toBeNull()
    // 0.1 + 0.2 is a hair over 0.3 in float math.
    expect(moneyProblem({ usd: 0.3, unknownPrices: false }, { counted: 0.1, held: 0 }, { kind: 'quote', usd: 0.2 }, 'user')).toBeNull()
    expect(moneyProblem(LIMIT, { counted: 4.6, held: 0 }, { kind: 'quote', usd: 0.41 }, 'user')).toContain('it costs $0.41')
    expect(moneyProblem(LIMIT, NOTHING, { kind: 'quote', usd: 5.01 }, 'user')).toContain('it costs $5.01')
  })

  it('lets a free quoted request go below the limit, but no request at it', () => {
    expect(moneyProblem(LIMIT, { counted: 4.99, held: 0 }, { kind: 'quote', usd: 0 }, 'user')).toBeNull()
    expect(moneyProblem(LIMIT, { counted: 5, held: 0 }, { kind: 'quote', usd: 0 }, 'user')).toContain('limit of this tab is reached')
  })

  it('refuses a request with no known price, unless the tab allows unknown prices', () => {
    expect(moneyProblem(LIMIT, NOTHING, UNPRICED_CHAT, 'user')).toContain('knows no price')
    expect(moneyProblem(LIMIT, NOTHING, { kind: 'quote', usd: null }, 'user')).toContain('knows no price')

    const allowing: MoneyLimit = { usd: 5, unknownPrices: true }
    expect(moneyProblem(allowing, NOTHING, UNPRICED_CHAT, 'user')).toBeNull()
    expect(moneyProblem(allowing, NOTHING, { kind: 'quote', usd: null }, 'user')).toBeNull()
    // An allowed unknown price still goes only under the limit.
    expect(moneyProblem(allowing, { counted: 5, held: 0 }, { kind: 'quote', usd: null }, 'user')).toContain('limit of this tab is reached')
  })

  it('tells the user where to change the limit, and tells a model to stop and ask the user', () => {
    const spent = { counted: 5, held: 0 }

    expect(moneyProblem(LIMIT, spent, PRICED_CHAT, 'user')).toContain('click the money limit in the bottom bar')
    const forModel = moneyProblem(LIMIT, spent, PRICED_CHAT, 'model')
    expect(forModel).toContain('no tool can change it')
    expect(forModel).toContain('ask whether to raise the limit')
    expect(forModel).not.toContain('bottom bar')
    expect(moneyProblem(LIMIT, NOTHING, UNPRICED_CHAT, 'model')).toContain('or to allow requests with no known price')
  })
})

describe('moneyLeft', () => {
  it('is the limit less the money spent, and never under 0', () => {
    expect(moneyLeft(LIMIT, { counted: 1.5, held: 0.5 })).toBe(3)
    expect(moneyLeft(LIMIT, { counted: 6, held: 1 })).toBe(0)
  })
})

describe('moneyLimitText', () => {
  it('tells the limit, what is left with the held quotes, and the rule of unknown prices', () => {
    const text = moneyLimitText({ usd: 5, unknownPrices: true }, { counted: 1.25, held: 0.75 })

    expect(text).toContain('Money limit: $5.00')
    expect(text).toContain('$3.00 is left')
    expect(text).toContain('Requests with no known price may go')
    expect(moneyLimitText(LIMIT, NOTHING)).toContain('Dez refuses a request with no known price')
    expect(moneyLimitText(undefined, NOTHING)).toContain('Money limit: none')
  })
})
