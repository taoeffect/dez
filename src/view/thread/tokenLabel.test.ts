import { describe, expect, it } from 'vitest'
import { labelTokenText, tokenLabelTexts } from './tokenLabel'

describe('token label', () => {
  it('shows a count under 1000 as it is, and a larger one in k or M with 3 digits at most', () => {
    expect([0, 842, 999, 1000, 1234, 19_900, 81_234, 130_000].map(labelTokenText))
      .toEqual(['0', '842', '999', '1.0k', '1.2k', '19.9k', '81.2k', '130k'])
    expect([1_234_567, 12_345_678, 123_456_789].map(labelTokenText)).toEqual(['1.2M', '12.3M', '123M'])
  })

  // The rounded number picks the form and the unit, so no label shows
  // `100.0k` or `1000k`.
  it('rounds once, so a count at the edge of a form shows in the next form', () => {
    expect([99_949, 99_950, 999_499, 999_500].map(labelTokenText)).toEqual(['99.9k', '100k', '999k', '1.0M'])
  })

  it('marks an estimate with a tilde', () => {
    const text = (estimated: boolean) => tokenLabelTexts({ tokens: 81_234, estimated }, undefined).text
    expect([text(false), text(true)]).toEqual(['81.2k', '~81.2k'])
  })

  it('tells the whole count in the tooltip, and the share of the window of a model that has one', () => {
    const tooltip = (tokens: number, contextWindow?: number) => tokenLabelTexts({ tokens, estimated: false }, contextWindow).tooltip

    expect(tooltip(81_234)).toContain('81,234 tokens')
    expect(tooltip(81_234)).not.toContain('%')
    expect(tooltip(81_234, 200_000)).toContain('200,000 tokens')
    expect(tooltip(81_234, 200_000)).toContain('41%')
    // A small conversation fills some of the window, and a conversation
    // can be larger than the window of a model that the user switched to.
    expect(tooltip(9, 200_000)).toContain('less than 1%')
    expect(tooltip(250_000, 200_000)).toContain('125%')
  })
})
