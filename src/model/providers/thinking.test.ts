import { describe, expect, it } from 'vitest'
import { isThinkingEnabled } from './thinking'

describe('isThinkingEnabled', () => {
  it('is on unless the user turned the stored toggle off', () => {
    expect(isThinkingEnabled(undefined)).toBe(true)
    expect(isThinkingEnabled({})).toBe(true)
    expect(isThinkingEnabled({ webSearch: false })).toBe(true)
    expect(isThinkingEnabled({ thinking: true })).toBe(true)
    expect(isThinkingEnabled({ thinking: false })).toBe(false)
  })
})
