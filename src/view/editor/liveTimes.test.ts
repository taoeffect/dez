import { describe, expect, it } from 'vitest'
import type { LiveTimes } from '../../model/streams/types'
import { callPhase, callTime, nextTickDelay, replyTime, timeText, timeWords } from './liveTimes'

const START = 1_000_000

// A reply into `s2` that started at `START`: `c1` ran 2.5 s, `c2` ran
// 0.4 s, `c3` runs since 3.2 s into the reply.
const TIMES: LiveTimes = {
  sectionId: 's2',
  startedAt: START,
  calls: {
    c1: { startedAt: START + 200, endedAt: START + 2700 },
    c2: { startedAt: START + 2700, endedAt: START + 3100 },
    c3: { startedAt: START + 3200, endedAt: null },
  },
}

describe('replyTime', () => {
  it('counts the reply of its section from the first second on', () => {
    expect(replyTime(TIMES, 's2', START + 999)).toBeNull()
    expect(replyTime(TIMES, 's2', START + 1000)).toStrictEqual({ ms: 1000, live: true })
    expect(replyTime(TIMES, 's2', START + 61_500)).toStrictEqual({ ms: 61_500, live: true })
  })

  it('gives no time to another section, or when no reply runs', () => {
    expect(replyTime(TIMES, 's1', START + 5000)).toBeNull()
    expect(replyTime(null, 's2', START + 5000)).toBeNull()
  })
})

describe('callTime', () => {
  const now = START + 4500

  it('gives an ended call of a second or more its fixed time, and a shorter one none', () => {
    expect(callTime(TIMES, 's2', 'c1', now)).toStrictEqual({ ms: 2500, live: false })
    expect(callTime(TIMES, 's2', 'c2', now)).toBeNull()
  })

  it('counts a call that runs from its first second on', () => {
    expect(callTime(TIMES, 's2', 'c3', START + 4199)).toBeNull()
    expect(callTime(TIMES, 's2', 'c3', START + 4200)).toStrictEqual({ ms: 1000, live: true })
  })

  // Call ids are unique only in one section, and come from the provider.
  it('gives no time to a call that did not start, to a call of another section, or to an id of the prototype', () => {
    expect(callTime(TIMES, 's2', 'c4', now)).toBeNull()
    expect(callTime(TIMES, 's1', 'c1', now)).toBeNull()
    expect(callTime(TIMES, null, 'c1', now)).toBeNull()
    expect(callTime(null, 's2', 'c1', now)).toBeNull()
    expect(callTime(TIMES, 's2', 'constructor', now)).toBeNull()
    expect(callTime(TIMES, 's2', '__proto__', now)).toBeNull()
  })
})

describe('callPhase', () => {
  it('marks an ended call, and a call that waits while another runs, and not the call that runs', () => {
    expect(['c1', 'c2', 'c3', 'c4'].map((id) => callPhase(TIMES, 's2', id))).toStrictEqual(['ended', 'ended', null, 'waiting'])
  })

  // Between two calls, and before the first call of a group starts, no
  // call runs: a call that did not start keeps the look of a busy call.
  it('marks no call that did not start while no call runs', () => {
    const between: LiveTimes = { ...TIMES, calls: { c1: TIMES.calls.c1 } }
    expect(callPhase(between, 's2', 'c2')).toBeNull()
    expect(callPhase({ ...TIMES, calls: {} }, 's2', 'c1')).toBeNull()
  })

  it('marks no call of another section, or when no reply runs, or with an id of the prototype', () => {
    expect(callPhase(TIMES, 's1', 'c1')).toBeNull()
    expect(callPhase(TIMES, null, 'c1')).toBeNull()
    expect(callPhase(null, 's2', 'c1')).toBeNull()
    expect(callPhase({ ...TIMES, calls: { c1: TIMES.calls.c1 } }, 's2', 'constructor')).toBeNull()
  })
})

describe('time text', () => {
  it('rounds a live time down to whole seconds, and shows a fixed time as the pill shows a reply time', () => {
    expect([timeText({ ms: 4999, live: true }), timeText({ ms: 4999, live: false })]).toStrictEqual(['4s', '5.0s'])
    expect([timeWords({ ms: 4999, live: true }), timeWords({ ms: 4213, live: false })]).toStrictEqual(['4 seconds', '4.2 seconds'])
  })
})

describe('nextTickDelay', () => {
  it('wakes at the next whole second of the reply or of a call that runs', () => {
    // 3.8 s into the reply (next second in 200 ms) and 0.6 s into `c3`
    // (next second in 400 ms).
    expect(nextTickDelay(TIMES, START + 3800)).toBe(200)
    // 4.1 s into the reply (900 ms) and 0.9 s into `c3` (100 ms).
    expect(nextTickDelay(TIMES, START + 4100)).toBe(100)
  })

  it('wakes at least every 250 ms, for a call that starts with no change of the doc', () => {
    expect(nextTickDelay({ ...TIMES, calls: {} }, START + 4500)).toBe(250)
  })

  it('never sleeps 0 ms on a whole second, nor long on a clock that went back', () => {
    expect(nextTickDelay({ ...TIMES, calls: {} }, START + 5000)).toBe(250)
    expect(nextTickDelay({ ...TIMES, calls: {} }, START + 4999)).toBe(1)
    expect(nextTickDelay({ ...TIMES, calls: {} }, START - 300)).toBe(250)
  })
})
