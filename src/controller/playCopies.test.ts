import '@sbp/okturtles.eventqueue'
import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PlayCopyRules from '../model/chat/playCopies'
import { PLAY_COPY_KEEP_MS, PLAY_COPY_MAX_BYTES, PLAY_COPY_MEMO_MAX_BYTES, type PlayCopyTarget } from '../model/chat/playCopies'
import type { BundledToolEnd } from './nativeTypes'
import { movePlayCopy } from './playCopies'
import { APP_DIR, CACHE_DIR, ENDED, failureOf, native, resetNative, STOP, writes } from './testing'

// A cap of the memo that a test reaches with small copies. The copies of
// the other tests have 3 bytes each, far under it.
vi.mock('../model/chat/playCopies', async (importOriginal) => ({
  ...await importOriginal<typeof PlayCopyRules>(),
  PLAY_COPY_MEMO_MAX_BYTES: 1000,
}))

// The memo of the module lives for the whole file, so each test takes
// clips of its own. Its copies go at the end of each test: every player
// goes, and the time of the memo passes.
const NAME = '0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60'
const savedClip = (name: string) => ({ src: `${APP_DIR}/assets/generated/video/${name}.mov`, size: 100, target: 'mp4' as PlayCopyTarget })

// The players of a test. The `abort()` of one is the player going: its
// wait stops, or it no longer shows the copy.
const players: AbortController[] = []

function player(): AbortController {
  const made = new AbortController()
  players.push(made)
  return made
}

function playCopy(clip: { src: string, size: number, target: PlayCopyTarget }, signal = player().signal): Promise<Blob | null> {
  return sbp('dez.controller/media/playCopy', clip, { signal }) as Promise<Blob | null>
}

// A program whose runs end when the test ends them, in the order of the
// runs.
function heldRuns(): ((end: BundledToolEnd) => void)[] {
  const ends: ((end: BundledToolEnd) => void)[] = []
  native.program = () => new Promise((resolve) => { ends.push(resolve) })
  return ends
}

beforeEach(() => {
  resetNative()
  native.folderFiles = ['play_copy.mp4', 'play_copy.webm']
  native.fileBytes = () => new Uint8Array([1, 2, 3])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Only the timers of the memo: `vi.waitFor` keeps the real ones.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  for (const made of players.splice(0)) made.abort(STOP)
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('dez.controller/media/playCopy', () => {
  it('makes one copy for two players of one clip, gives it to a later player with no run, and makes a new one when the file changed', async () => {
    const clip = savedClip('one')

    const [first, second] = await Promise.all([playCopy(clip), playCopy(clip)])

    expect(native.runs).toHaveLength(1)
    const [{ run }] = native.runs
    expect(run.inputs).toStrictEqual([{ name: 'play_input.mov', source: clip.src }])
    // Rust reads the copy from the cache root, not the asset protocol.
    expect(native.readFiles).toStrictEqual([{ root: 'cache', path: `${run.folder}/play_copy.mp4` }])
    expect(first).toBe(second)
    expect(first).toBeInstanceOf(Blob)
    expect(first?.type).toBe('video/mp4')
    expect(first?.size).toBe(3)

    expect(await playCopy(clip)).toBe(first)
    expect(native.runs).toHaveLength(1)

    expect(await playCopy({ ...clip, size: 200 })).not.toBe(first)
    expect(native.runs).toHaveLength(2)
  })

  it('makes no second run for a clip whose copy failed, and logs the failure with no path', async () => {
    const clip = savedClip('broken')
    native.program = writes('stderr', `${clip.src}: Invalid data found when processing input\n`, { kind: 'exited', code: 183 })

    expect(await playCopy(clip)).toBeNull()
    expect(await playCopy(clip)).toBeNull()

    expect(native.runs).toHaveLength(1)
    expect(console.error).toHaveBeenCalledOnce()
    expect(String(vi.mocked(console.error).mock.calls[0])).not.toContain(APP_DIR)
  })

  it('gives no copy that is larger than its cap', async () => {
    native.folderFileSize = PLAY_COPY_MAX_BYTES + 1

    expect(await playCopy(savedClip('long'))).toBeNull()
    expect(native.readFiles).toStrictEqual([])
  })

  it('stops the run when the last player stops waiting, and runs again for a later player', async () => {
    const clip = savedClip('stopped')
    const ends = heldRuns()
    const [one, two] = [player(), player()]
    const first = failureOf(playCopy(clip, one.signal))
    const second = failureOf(playCopy(clip, two.signal))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))

    one.abort(STOP)
    expect(await first).toBe(STOP)
    expect(native.cancelledRuns).toStrictEqual([])

    two.abort(STOP)
    expect(await second).toBe(STOP)
    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])

    const third = playCopy(clip)
    ends[0]({ kind: 'cancelled' })
    await vi.waitFor(() => expect(native.runs).toHaveLength(2))
    ends[1](ENDED)

    expect(await third).toBeInstanceOf(Blob)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('runs again on the saved file when a Save moved the temp copy while the run read it', async () => {
    const temp = { src: `${CACHE_DIR}/media/${NAME}.mp4`, size: 100, target: 'webm' as PlayCopyTarget }
    const saved = `${APP_DIR}/assets/generated/video/${NAME}.mp4`
    const ends = heldRuns()
    const copy = playCopy(temp)
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))

    movePlayCopy(temp.src, saved)
    ends[0]({ kind: 'exited', code: 1 })
    await vi.waitFor(() => expect(native.runs).toHaveLength(2))
    expect(native.runs[1].run.inputs).toStrictEqual([{ name: 'play_input.mp4', source: saved }])
    ends[1](ENDED)

    const made = await copy
    expect(made?.type).toBe('video/webm')
    expect(console.error).not.toHaveBeenCalled()
    expect(await playCopy({ ...temp, src: saved })).toBe(made)
    expect(native.runs).toHaveLength(2)
  })

  it('drops the oldest copies over the cap of the memo, but keeps a copy that failed', async () => {
    const failed = savedClip('failed-then-trimmed')
    native.program = writes('stderr', 'Invalid data found when processing input\n', { kind: 'exited', code: 183 })
    expect(await playCopy(failed)).toBeNull()
    native.program = async () => ENDED
    // Two copies of more than half the cap each: the trim after the second
    // passes every older entry.
    native.fileBytes = () => new Uint8Array(PLAY_COPY_MEMO_MAX_BYTES / 2 + 1)
    const oldest = savedClip('trimmed')
    const oldestPlayer = player()
    await playCopy(oldest, oldestPlayer.signal)
    oldestPlayer.abort(STOP)
    await playCopy(savedClip('kept'))
    const runs = native.runs.length

    expect(await playCopy(failed)).toBeNull()
    expect(native.runs).toHaveLength(runs)
    expect(await playCopy(oldest)).toBeInstanceOf(Blob)
    expect(native.runs).toHaveLength(runs + 1)
  })

  it('keeps a copy for a while after its last player went, and drops it after that', async () => {
    const clip = savedClip('left')
    const shown = player()
    const made = await playCopy(clip, shown.signal)

    shown.abort(STOP)
    await vi.advanceTimersByTimeAsync(PLAY_COPY_KEEP_MS - 1)
    const returned = player()
    expect(await playCopy(clip, returned.signal)).toBe(made)
    expect(native.runs).toHaveLength(1)

    returned.abort(STOP)
    await vi.advanceTimersByTimeAsync(PLAY_COPY_KEEP_MS)
    expect(await playCopy(clip)).not.toBe(made)
    expect(native.runs).toHaveLength(2)
  })

  it('keeps a copy that another player still shows', async () => {
    const clip = savedClip('shown-twice')
    const [one, two] = [player(), player()]
    const [made] = await Promise.all([playCopy(clip, one.signal), playCopy(clip, two.signal)])

    one.abort(STOP)
    await vi.advanceTimersByTimeAsync(PLAY_COPY_KEEP_MS)

    expect(await playCopy(clip)).toBe(made)
    expect(native.runs).toHaveLength(1)
  })

  it('drops over the cap of the memo only the copies that no player shows, and drops one at once when its player goes', async () => {
    native.fileBytes = () => new Uint8Array(PLAY_COPY_MEMO_MAX_BYTES / 2 + 1)
    const first = savedClip('shown-over-cap')
    const second = savedClip('shown-over-cap-too')
    const firstPlayer = player()
    const firstCopy = await playCopy(first, firstPlayer.signal)
    const secondCopy = await playCopy(second)

    const again = player()
    expect(await playCopy(first, again.signal)).toBe(firstCopy)
    again.abort(STOP)
    expect(await playCopy(second)).toBe(secondCopy)
    expect(native.runs).toHaveLength(2)

    firstPlayer.abort(STOP)
    expect(await playCopy(first)).not.toBe(firstCopy)
    expect(native.runs).toHaveLength(3)
  })
})
