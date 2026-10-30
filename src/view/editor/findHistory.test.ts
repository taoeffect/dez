import { describe, expect, it } from 'vitest'
import { FIND_HISTORY_LIMIT, FindHistory } from './findHistory'

function historyOf(...searches: string[]): FindHistory {
  const history = new FindHistory()
  for (const search of searches) history.commit(search)
  return history
}

/** Every entry, newest first, as seen by pressing ArrowUp from an empty
 *  field until nothing older is left. */
function browseAll(history: FindHistory): string[] {
  const seen: string[] = []
  for (let entry = history.older(''); entry !== null; entry = history.older('')) seen.push(entry)
  history.resetBrowse()
  return seen
}

describe('FindHistory', () => {
  it('walks older to the oldest entry, then newer back to the draft', () => {
    const history = historyOf('a', 'b', 'c')
    expect(history.older('draft')).toBe('c')
    expect(history.older('c')).toBe('b')
    expect(history.older('b')).toBe('a')
    expect(history.older('a')).toBeNull()
    expect(history.newer()).toBe('b')
    expect(history.newer()).toBe('c')
    expect(history.newer()).toBe('draft')
    expect(history.newer()).toBeNull()
  })

  it('returns null when there is nothing to browse', () => {
    const history = new FindHistory()
    expect(history.older('x')).toBeNull()
    expect(history.newer()).toBeNull()
  })

  it('moves a re-committed search to the newest position without duplicates', () => {
    const history = historyOf('a', 'b', 'c', 'a')
    expect(browseAll(history)).toEqual(['a', 'c', 'b'])
  })

  it('does not keep empty searches', () => {
    const history = historyOf('a', '', 'b', '')
    expect(browseAll(history)).toEqual(['b', 'a'])
  })

  it(`keeps only the newest ${FIND_HISTORY_LIMIT} searches`, () => {
    const searches = Array.from({ length: FIND_HISTORY_LIMIT + 2 }, (_, i) => `q${i}`)
    const seen = browseAll(historyOf(...searches))
    expect(seen).toHaveLength(FIND_HISTORY_LIMIT)
    expect(seen[0]).toBe(`q${FIND_HISTORY_LIMIT + 1}`)
    expect(seen.at(-1)).toBe('q2')
  })

  it('skips the newest entry when the field already shows it', () => {
    const history = historyOf('a', 'b')
    expect(history.older('b')).toBe('a')
    expect(history.newer()).toBe('b')
    expect(history.newer()).toBeNull()
    expect(historyOf('only').older('only')).toBeNull()
  })

  it('takes a new draft after the browse position is reset', () => {
    const history = historyOf('a', 'b')
    expect(history.older('first')).toBe('b')
    history.resetBrowse()
    expect(history.newer()).toBeNull()
    expect(history.older('second')).toBe('b')
    expect(history.newer()).toBe('second')
  })

  it('ends browsing on commit', () => {
    const history = historyOf('a', 'b', 'c')
    history.older('')
    history.older('c')
    history.commit('b')
    expect(history.newer()).toBeNull()
    expect(history.older('')).toBe('b')
    expect(history.older('b')).toBe('c')
  })
})
