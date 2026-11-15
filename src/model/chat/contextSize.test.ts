import { describe, expect, it } from 'vitest'
import { contextField, contextSize } from './contextSize'

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

describe('contextField', () => {
  it('gives a copy of the count, and no key with no count', () => {
    const counted = { tokens: 5, estimate: 7 }
    const { context } = contextField(counted)

    expect(context).toStrictEqual(counted)
    expect(context).not.toBe(counted)
    expect(contextField(undefined)).toStrictEqual({})
  })
})
