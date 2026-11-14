import { describe, expect, it } from 'vitest'
import { costLabelTexts, labelUsdText } from './costLabel'

describe('cost label', () => {
  it('shows cents, and 2 significant digits for a sum under a cent', () => {
    expect([0, 0.42, 0.426, 12.3, 1234.5].map(labelUsdText)).toEqual(['$0.00', '$0.42', '$0.43', '$12.30', '$1234.50'])
    expect([0.0031, 0.00314, 0.001, 0.0099, 3e-7].map(labelUsdText)).toEqual(['$0.0031', '$0.0031', '$0.0010', '$0.0099', '$0.00000030'])
  })

  // A sum that rounds up to a cent shows as a cent, not with a third digit.
  it('rounds once, so a sum at the cent edge shows in cents', () => {
    expect([0.00996, 0.009999, 0.01].map(labelUsdText)).toEqual(['$0.01', '$0.01', '$0.01'])
  })

  it('marks a sum without the price of a request, and an edited conversation', () => {
    const text = (unpriced: number, edited: boolean) => costLabelTexts({ usd: 0.5, requests: 3, unpriced }, edited).text
    expect([text(0, false), text(1, false), text(0, true), text(3, true)]).toEqual(['$0.50', '$0.50+', '$0.50 (?)', '$0.50+ (?)'])
  })
})
