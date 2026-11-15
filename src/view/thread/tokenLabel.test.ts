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

  // 65% of the window, and never more than 250,000 tokens.
  it('tells in the tooltip at which size Dez compacts a conversation of the model, and nothing for a model with no window', () => {
    const tooltip = (contextWindow?: number) => tokenLabelTexts({ tokens: 81_234, estimated: false }, contextWindow).tooltip

    expect(tooltip(200_000)).toContain('Dez compacts the conversation when it gets to 130,000 tokens')
    expect(tooltip(1_000_000)).toContain('when it gets to 250,000 tokens')
    expect(tooltip()).not.toContain('compacts')
  })

  it('shows no total before the first compaction', () => {
    expect(tokenLabelTexts({ tokens: 81_234, estimated: true }, 200_000)).not.toHaveProperty('total')
  })

  describe('after a compaction', () => {
    const cost = { usd: 7.38, requests: 131, unpriced: 0 }
    const texts = (estimated: boolean, count = 3) => tokenLabelTexts({ tokens: 81_234, estimated }, 200_000, { count, tokens: 1_150_000, cost })

    it('shows the size of the buffer, and in parentheses the sizes at the compactions plus the buffer', () => {
      expect([texts(true).text, texts(true).total?.text]).toEqual(['~81.2k', '(1.2M)'])
      expect([texts(false).text, texts(false).total?.text]).toEqual(['81.2k', '(1.2M)'])
    })

    it('tells in each tooltip which number it is, with the whole number', () => {
      const { tooltip, total } = texts(true)

      expect(tooltip.split('\n')[0]).toBe('Size of this buffer: about 81,234 tokens')
      expect(tooltip).toContain('since its last compaction')
      expect(tooltip).toContain('The buffer fills 41% of it.')
      expect(tooltip).toContain('Dez compacts the conversation again when the buffer gets to 130,000 tokens')
      expect(total?.tooltip.split('\n')[0]).toBe('Size of the whole conversation: about 1,231,234 tokens')
      expect(total?.tooltip).toContain('each of its 3 compactions')
      // A sum with a counted buffer is no estimate.
      expect(texts(false).total?.tooltip.split('\n')[0]).toBe('Size of the whole conversation: 1,231,234 tokens')
      expect(texts(false, 1).total?.tooltip).toContain('at its compaction.')
    })

    // A window of 200,000 tokens: a threshold of 130,000, a quarter of it
    // is 32,500.
    it('tells a later compaction size when the compaction left the buffer near the threshold', () => {
      const tooltip = (left: number) => tokenLabelTexts({ tokens: 125_000, estimated: false }, 200_000, { count: 1, tokens: 300_000, cost, left }).tooltip

      expect(tooltip(120_000)).toContain('Dez compacts the conversation again when the buffer gets to 152,500 tokens')
      expect(tooltip(20_000)).toContain('when the buffer gets to 130,000 tokens')
    })
  })
})
