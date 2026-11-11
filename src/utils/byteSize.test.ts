import { describe, expect, it } from 'vitest'
import { byteSizeText } from './byteSize'

const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3

describe('byteSizeText', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [KB, '1 KB'],
    [1536, '2 KB'],
    [48.3 * MB, '48.3 MB'],
    [1.25 * GB, '1.3 GB'],
    [2048 * GB, '2048.0 GB'],
  ])('gives %d bytes in the largest unit that fits', (bytes, text) => {
    expect(byteSizeText(bytes)).toBe(text)
  })

  // A number that rounds up to 1024 of a unit reads as 1 of the next unit.
  it.each([
    [MB - 1, '1.0 MB'],
    [GB - 1, '1.0 GB'],
  ])('gives %d bytes in the next unit', (bytes, text) => {
    expect(byteSizeText(bytes)).toBe(text)
  })
})
