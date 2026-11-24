import { describe, expect, it } from 'vitest'
import { dataFileExtension, nextDataFileName } from './dataFiles'

describe('dataFileExtension', () => {
  it('takes the four data endings in any case, and nothing else', () => {
    expect(['a.csv', 'b.TSV', 'c.Json', 'notes.txt'].map(dataFileExtension)).toStrictEqual(['csv', 'tsv', 'json', 'txt'])
    expect(['report.pdf', 'csv', 'data.csv.gz', 'table.xlsx', 'a.jsonl'].map(dataFileExtension)).toStrictEqual([null, null, null, null, null])
  })
})

describe('nextDataFileName', () => {
  it('starts at 1 in an empty folder', () => {
    expect(nextDataFileName('csv', [], [])).toBe('data-1.csv')
  })

  it('goes past the highest number of the folder, of any ending and any case, so no file is replaced', () => {
    expect(nextDataFileName('json', ['data-1.csv', 'DATA-7.TXT', 'data-3.tsv', 'beats-a.json', 'data-x.csv', 'data-2'], [])).toBe('data-8.json')
  })

  // A file that a model deleted: the old path in the conversation must not
  // name the new file.
  it('goes past the highest number that a text of the conversation names', () => {
    expect(nextDataFileName('csv', ['data-1.csv'], ['Plot /work/data-1.csv', 'and /work/data-4.json too', 'data-9.csv is no path', '/apps/data-12.csv'])).toBe('data-5.csv')
  })
})
