import { describe, expect, it } from 'vitest'
import { draftLimitUsd } from './moneyLimitLabel'

describe('the field of the money limit popup', () => {
  // An empty field removes the limit; a text that is no amount must not,
  // or a typo would remove the limit of the user.
  it('reads an amount, an empty field as no limit, and any other text as nothing', () => {
    expect(['5', ' 2.50 ', '$3', '$ 0.5', '.25', '0'].map(draftLimitUsd)).toStrictEqual([5, 2.5, 3, 0.5, 0.25, 0])
    expect(['', '   ', '$'].map(draftLimitUsd)).toStrictEqual([null, null, null])
    expect(['-1', 'abc', '5$', '1,50', 'Infinity', '1e400'].map(draftLimitUsd)).toStrictEqual(Array(6).fill(undefined))
  })
})
