import sbp from '@sbp/sbp'
import { describe, expect, it } from 'vitest'
import type { AppCardFacts } from '../../model/tools/appShow'
import { appSizeLabel, knownAppFacts, readAppFacts, setAppDeleted } from './appFacts'

const READY: AppCardFacts = { state: 'ready', description: 'Keeps notes.', size: { bytes: 2048, more: false } }

// The reads that wait for their answer, in the order of their starts.
const reads: Array<(facts: AppCardFacts) => void> = []

sbp('sbp/selectors/register', {
  'dez.controller/apps/card' (): Promise<AppCardFacts> {
    return new Promise((resolve) => reads.push(resolve))
  },
})

describe('readAppFacts', () => {
  it('shares one read between the cards of an app, and reads again after it', async () => {
    const first = readAppFacts('notes')
    const second = readAppFacts('notes')
    expect(reads).toHaveLength(1)
    reads.shift()?.(READY)
    expect(await first).toBe(READY)
    expect(await second).toBe(READY)
    expect(knownAppFacts('notes')).toBe(READY)

    void readAppFacts('notes')
    expect(reads).toHaveLength(1)
    reads.shift()?.(READY)
  })

  // The read tells of files that Dez deleted after it started.
  it('keeps an app gone when a read from before its delete ends after it', async () => {
    const before = readAppFacts('timer')
    setAppDeleted('timer')
    reads.shift()?.(READY)

    expect(await before).toStrictEqual({ state: 'missing' })
    expect(knownAppFacts('timer')).toStrictEqual({ state: 'missing' })

    // A model can make the app again.
    const after = readAppFacts('timer')
    reads.shift()?.(READY)
    expect(await after).toBe(READY)
    expect(knownAppFacts('timer')).toBe(READY)
  })
})

describe('appSizeLabel', () => {
  it('gives the size of a folder, and no text for facts with no size', () => {
    expect(appSizeLabel(READY)).toBe('2 KB')
    expect(appSizeLabel({ state: 'broken', size: { bytes: 300, more: true } })).toBe('more than 300 B')
    expect(appSizeLabel({ state: 'broken', size: null })).toBe('')
    expect(appSizeLabel({ state: 'missing' })).toBe('')
    expect(appSizeLabel(undefined)).toBe('')
  })
})
