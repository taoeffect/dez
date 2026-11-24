import { describe, expect, it } from 'vitest'
import { liveDuration, longDuration, longLiveDuration, shortDuration } from './durationText'

describe('final time forms', () => {
  it('shows tenths under 10 seconds', () => {
    expect([0, 49, 50, 420, 4213, 9949].map(shortDuration)).toEqual(['<0.1s', '<0.1s', '0.1s', '0.4s', '4.2s', '9.9s'])
    expect([0, 420, 4213, 9949].map(longDuration)).toEqual(['less than 0.1 seconds', '0.4 seconds', '4.2 seconds', '9.9 seconds'])
  })

  // A time that rounds up to the next unit shows in that unit's form.
  it('rounds once, so a time at a unit edge moves to the next form', () => {
    expect([9950, 42_300, 59_499, 59_500].map(shortDuration)).toEqual(['10s', '42s', '59s', '1m 00s'])
    expect([9950, 59_500].map(longDuration)).toEqual(['10 seconds', '1 minute'])
  })

  it('gives minutes and hours a two-digit smaller unit', () => {
    expect([65_000, 600_000, 3_599_499, 3_599_500, 3_725_000, 90_000_000].map(shortDuration))
      .toEqual(['1m 05s', '10m 00s', '59m 59s', '1h 00m', '1h 02m', '25h 00m'])
  })

  it('rounds a time over an hour to whole minutes', () => {
    expect([3_629_999, 3_630_000, 3_659_000, 7_170_000].map(shortDuration))
      .toEqual(['1h 00m', '1h 01m', '1h 01m', '2h 00m'])
  })

  // The tooltip names every nonzero unit, the seconds of a long reply too.
  it('spells out each nonzero unit in the long form', () => {
    expect([1000, 61_000, 120_000, 3_600_000, 3_725_000, 7_201_000].map(longDuration))
      .toEqual(['1.0 seconds', '1 minute 1 second', '2 minutes', '1 hour', '1 hour 2 minutes 5 seconds', '2 hours 1 second'])
  })
})

// A live time must never show more than the clock: "2s" only once 2 full
// seconds have passed, where `shortDuration` would round 1.5 s up to "2s".
describe('live time forms', () => {
  it('counts whole seconds and rounds down', () => {
    expect([0, 999, 1000, 1999, 2000, 42_700, 59_999].map(liveDuration))
      .toEqual(['0s', '0s', '1s', '1s', '2s', '42s', '59s'])
  })

  it('moves to the next unit only when the unit is whole', () => {
    expect([60_000, 65_900, 3_599_999, 3_600_000, 3_659_999, 3_660_000, 90_000_000].map(liveDuration))
      .toEqual(['1m 00s', '1m 05s', '59m 59s', '1h 00m', '1h 00m', '1h 01m', '25h 00m'])
  })

  it('spells out the whole units in the long form', () => {
    expect([0, 1000, 12_900, 61_000, 3_725_999].map(longLiveDuration))
      .toEqual(['0 seconds', '1 second', '12 seconds', '1 minute 1 second', '1 hour 2 minutes 5 seconds'])
  })
})
