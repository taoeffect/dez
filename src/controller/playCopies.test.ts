import '@sbp/okturtles.eventqueue'
import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PlayCopyRules from '../model/chat/playCopies'
import { PLAY_COPIES_MAX_BYTES, PLAY_COPY_MAX_BYTES, type PlayCopyTarget } from '../model/chat/playCopies'
import type { BundledToolEnd } from './nativeTypes'
import { movePlayCopy } from './playCopies'
import { APP_DIR, CACHE_DIR, ENDED, failureOf, native, resetNative, running, STOP, writes } from './testing'

// A cap of the memo that a test reaches with small copies. The copies of
// the other tests have 3 bytes each, far under it.
vi.mock('../model/chat/playCopies', async (importOriginal) => ({
  ...await importOriginal<typeof PlayCopyRules>(),
  PLAY_COPIES_MAX_BYTES: 1000,
}))

// The memo of the module lives for the whole file, so each test takes
// clips of its own.
const NAME = '0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60'
const savedClip = (name: string) => ({ src: `${APP_DIR}/assets/generated/video/${name}.mov`, size: 100, target: 'mp4' as PlayCopyTarget })

function playCopy(clip: { src: string, size: number, target: PlayCopyTarget }, signal = running()): Promise<Blob | null> {
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
})

afterEach(() => {
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
    const [one, two] = [new AbortController(), new AbortController()]
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
    native.fileBytes = () => new Uint8Array(PLAY_COPIES_MAX_BYTES / 2 + 1)
    const oldest = savedClip('trimmed')
    await playCopy(oldest)
    await playCopy(savedClip('kept'))
    const runs = native.runs.length

    expect(await playCopy(failed)).toBeNull()
    expect(native.runs).toHaveLength(runs)
    expect(await playCopy(oldest)).toBeInstanceOf(Blob)
    expect(native.runs).toHaveLength(runs + 1)
  })
})
