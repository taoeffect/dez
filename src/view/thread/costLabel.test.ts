import { describe, expect, it } from 'vitest'
import type { ConversationCost } from '../../model/chat/conversationCost'
import { costLabelTexts, labelUsdText, type CostLabelTexts } from './costLabel'

describe('cost label', () => {
  it('shows cents, and 2 significant digits for a sum under a cent', () => {
    expect([0, 0.42, 0.426, 12.3, 1234.5].map(labelUsdText)).toEqual(['$0.00', '$0.42', '$0.43', '$12.30', '$1234.50'])
    expect([0.0031, 0.00314, 0.001, 0.0099, 3e-7].map(labelUsdText)).toEqual(['$0.0031', '$0.0031', '$0.0010', '$0.0099', '$0.00000030'])
  })

  // A sum that rounds up to a cent shows as a cent, not with a third digit.
  it('rounds once, so a sum at the cent edge shows in cents', () => {
    expect([0.00996, 0.009999, 0.01].map(labelUsdText)).toEqual(['$0.01', '$0.01', '$0.01'])
  })

  // The label shows the sum, the total, and then the mark.
  const shown = ({ text, total, mark }: CostLabelTexts) => [text, ...(total ? [total.text] : [])].join(' ') + mark

  it('marks a sum without the price of a request, and an edited conversation', () => {
    const text = (unpriced: number, edited: boolean) => shown(costLabelTexts({ usd: 0.5, requests: 3, unpriced }, edited))
    expect([text(0, false), text(1, false), text(0, true), text(3, true)]).toEqual(['$0.50', '$0.50+', '$0.50 (?)', '$0.50+ (?)'])
  })

  it('shows no total before the first compaction', () => {
    expect(costLabelTexts({ usd: 0.5, requests: 3, unpriced: 0 }, false)).not.toHaveProperty('total')
  })

  describe('after a compaction', () => {
    const atCompaction: ConversationCost = { usd: 7.38, requests: 131, unpriced: 0 }
    const compactions = (cost = atCompaction, count = 3) => ({ count, tokens: 1_150_000, cost })

    it('shows the cost of the requests since the compaction, and in parentheses the cost of the whole conversation', () => {
      const texts = costLabelTexts({ usd: 7.8, requests: 136, unpriced: 0 }, false, compactions())

      expect(shown(texts)).toBe('$0.42 ($7.80)')
      expect(texts.tooltip.split('\n')).toEqual(['Cost of this buffer (the conversation since its last compaction): about $0.42', '5 requests'])
      expect(texts.total?.tooltip.split('\n')).toEqual([
        'Cost of the whole conversation: about $7.80',
        '136 requests',
        'It is the cost of this buffer, of its 3 compactions, and of all before them.',
      ])
    })

    // The request of the compaction is in the cost at the compaction.
    it('shows a buffer of no request as $0.00, with no rest of the float math', () => {
      const texts = costLabelTexts({ usd: 0.3, requests: 2, unpriced: 0 }, false, compactions({ usd: 0.1 + 0.2, requests: 2, unpriced: 0 }, 1))

      expect(shown(texts)).toBe('$0.00 ($0.30)')
      expect(texts.tooltip).toContain('nothing yet')
      expect(texts.total?.tooltip).toContain('of its compaction, and of all before it.')
    })

    it('marks each sum by its own requests with no known price, and puts the mark of an edited reply last', () => {
      const text = (unpriced: number, unpricedAtCompaction: number, edited = false) =>
        shown(costLabelTexts({ usd: 7.8, requests: 136, unpriced }, edited, compactions({ ...atCompaction, unpriced: unpricedAtCompaction })))

      // A request with no price before the compaction is only in the total.
      expect([text(2, 2), text(3, 2), text(3, 2, true), text(0, 0, true)])
        .toEqual(['$0.42 ($7.80+)', '$0.42+ ($7.80+)', '$0.42+ ($7.80+) (?)', '$0.42 ($7.80) (?)'])
    })

    it('tells in the tooltip of the total how many requests have no known price', () => {
      const texts = costLabelTexts({ usd: 7.8, requests: 136, unpriced: 3 }, true, compactions({ ...atCompaction, unpriced: 2 }))

      expect(texts.tooltip.split('\n')).toEqual([
        'Cost of this buffer (the conversation since its last compaction): at least $0.42',
        '5 requests, 1 with no known price (not in the sum)',
        'You changed or deleted a reply. Its cost is still in the sum of the whole conversation.',
      ])
      expect(texts.total?.tooltip).toContain('Cost of the whole conversation: at least $7.80\n136 requests, 3 with no known price (not in the sum)')
    })
  })
})
