import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from './base64'

describe('bytesToBase64', () => {
  it('matches Node base64 for every byte value, padding, and sizes around the chunk length', () => {
    for (const length of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 3 * 0x8000 + 2]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 151 + 7) % 256)

      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})
