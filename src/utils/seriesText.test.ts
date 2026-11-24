import { describe, expect, it } from 'vitest'
import { seriesText } from './seriesText'

describe('seriesText', () => {
  it('puts no comma into a list of one or two items', () => {
    expect(seriesText(['csv'], 'or')).toBe('csv')
    expect(seriesText(['csv', 'tsv'], 'or')).toBe('csv or tsv')
    expect(seriesText(['image', 'clips'], 'and')).toBe('image and clips')
  })

  it('puts a comma before the conjunction of a list of three or more items', () => {
    expect(seriesText(['image', 'clip', 'data file'], 'and')).toBe('image, clip, and data file')
    expect(seriesText(['csv', 'tsv', 'json', 'txt'], 'or')).toBe('csv, tsv, json, or txt')
  })
})
