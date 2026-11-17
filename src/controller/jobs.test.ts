import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { JOB_LIMIT_TEXT, MAX_OPEN_JOBS } from '../model/tools/jobs'
import { ToolError } from '../model/tools/types'
import { discardMadeAssets, TabJobs, writeJobAssets, type EndedJob, type MadeAsset } from './jobs'
import { APP_DIR, CACHE_DIR, heldWork, LONG, native, resetNative, running, settled } from './testing'

const IMAGE = `${APP_DIR}/assets/generated/images/made.png`
const SAVED_CLIP = `${APP_DIR}/assets/generated/audio/made.wav`
const TEMP_CLIP = `${CACHE_DIR}/media/made.mp4`
const URL_CLIP = 'https://clips.test/made.mp4'

const image: MadeAsset = { kind: 'image', path: IMAGE }
const clip = (src: string | null, url: string | null = null, jobId?: string): MadeAsset => ({
  kind: 'clip',
  clip: src?.endsWith('.wav') ? { kind: 'audio', type: 'audio/wav', src, url, expires: null } : { kind: 'video', type: 'video/mp4', src, url, expires: null },
  ...(jobId !== undefined && { jobId }),
})

// The stub stores: the files that were deleted, and an error that the
// delete of an image throws (set by a test). The native side is the stub
// of testing.ts.
let deletedImages: string[] = []
let deletedClips: string[] = []
let imageDeleteError: Error | undefined

sbp('sbp/selectors/register', {
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    if (imageDeleteError) throw imageDeleteError
    deletedImages.push(path)
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
  },
})

let jobs: TabJobs
let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.useFakeTimers()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  jobs = new TabJobs()
  resetNative()
  deletedImages = []
  deletedClips = []
  imageDeleteError = undefined
})

afterEach(() => {
  consoleError.mockRestore()
  vi.useRealTimers()
})

describe('TabJobs', () => {
  it('runs its jobs at the same time, and a wait gives the results in the order of their ends', async () => {
    const first = heldWork()
    const second = heldWork()
    const { id: firstId, number: firstNumber } = jobs.start('model_invoke', first.work, { ...LONG, label: 'A red fox' })
    const { id: secondId, number: secondNumber } = jobs.start('video', second.work, LONG)

    expect(firstId).toMatch(/^j-[a-z0-9]{4}$/)
    expect(secondId).not.toBe(firstId)
    expect([firstNumber, secondNumber]).toStrictEqual([1, 2])
    expect(jobs.running).toBe(2)

    second.finish({ text: 'Second.' })
    first.finish({ text: 'The provider refused it.', isError: true, assets: [image] })
    await settled()

    expect(await jobs.wait(running())).toStrictEqual<EndedJob[]>([
      { id: secondId, tool: 'video', status: 'finished', text: 'Second.', assets: [], hidesAssets: false, call: { number: 2, label: '' } },
      { id: firstId, tool: 'model_invoke', status: 'failed', text: 'The provider refused it.', assets: [image], hidesAssets: false, call: { number: 1, label: 'A red fox' } },
    ])
    expect(jobs.running).toBe(0)
  })

  it('waits for the next end of a job, and gives each result only once', async () => {
    const first = heldWork()
    const second = heldWork()
    const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
    const { id: secondId } = jobs.start('model_invoke', second.work, LONG)

    const wait = jobs.wait(running())
    first.finish({ text: 'First.' })
    expect((await wait).map((job) => job.id)).toStrictEqual([firstId])
    expect(jobs.running).toBe(1)
    expect(jobs.hasOpen).toBe(true)

    const next = jobs.wait(running())
    second.finish({ text: 'Second.' })
    expect((await next).map((job) => job.id)).toStrictEqual([secondId])

    // No job runs, and every result was given.
    expect(jobs.hasOpen).toBe(false)
    expect(await jobs.wait(running())).toStrictEqual([])
  })

  it('gives no result at once when the reply has no job', async () => {
    expect(await jobs.wait(running())).toStrictEqual([])
    expect(await jobs.settle(running())).toStrictEqual([])
    expect(jobs.hasOpen).toBe(false)
  })

  it('waits for every job with `all`, and gives all the results that are left in one call', async () => {
    const works = [heldWork(), heldWork(), heldWork()]
    const ids = works.map((held) => jobs.start('model_invoke', held.work, LONG).id)
    works[1].finish({ text: 'Second.' })
    await settled()
    expect((await jobs.wait(running())).map((job) => job.id)).toStrictEqual([ids[1]])

    let ended: EndedJob[] | undefined
    void jobs.wait(running(), { all: true }).then((results) => { ended = results })
    works[2].finish({ text: 'Third.' })
    await settled()
    // One job still runs, so the wait goes on with a result that is ready.
    expect(ended).toBeUndefined()

    works[0].finish({ text: 'First.' })
    await settled()
    expect(ended?.map((job) => [job.id, job.text])).toStrictEqual([[ids[2], 'Third.'], [ids[0], 'First.']])
    expect(jobs.hasOpen).toBe(false)
    expect(await jobs.wait(running(), { all: true })).toStrictEqual([])
  })

  // An image that the next step needs, while music still runs.
  it('waits only for the jobs `ids`, gives only their results, and keeps the other results for a later wait', async () => {
    const works = [heldWork(), heldWork(), heldWork()]
    const ids = works.map((held) => jobs.start('model_invoke', held.work, LONG).id)
    works[2].finish({ text: 'Third.' })
    await settled()

    let ended: EndedJob[] | undefined
    void jobs.wait(running(), { ids: [ids[0], ids[1]] }).then((results) => { ended = results })
    works[1].finish({ text: 'Second.' })
    await settled()
    // A result of another job is ready, and a named job still runs.
    expect(ended).toBeUndefined()

    works[0].finish({ text: 'First.' })
    await settled()
    expect(ended?.map((job) => job.id)).toStrictEqual([ids[1], ids[0]])
    expect(jobs.ready).toBe(1)

    // The named jobs gave their results, so the next named wait gives none
    // at once; the other result stays for a wait with no names.
    expect(await jobs.wait(running(), { ids: [ids[0]] })).toStrictEqual([])
    expect((await jobs.wait(running())).map((job) => job.id)).toStrictEqual([ids[2]])
    expect(jobs.hasOpen).toBe(false)
  })

  it('ends a wait whose signal aborts, and the job goes on', async () => {
    const held = heldWork()
    const { id } = jobs.start('model_invoke', held.work, LONG)
    const stop = new AbortController()
    const wait = jobs.wait(stop.signal)
    const reason = new Error('stop')

    stop.abort(reason)
    await expect(wait).rejects.toBe(reason)
    await expect(jobs.wait(stop.signal)).rejects.toBe(reason)
    expect(jobs.running).toBe(1)
    expect(held.signal().aborted).toBe(false)

    // The result is still there for the next reader.
    held.finish({ text: 'Done.' })
    expect((await jobs.wait(running())).map((job) => job.id)).toStrictEqual([id])
  })

  it('ends a job that takes more than its time limit as timed out, with its last state, and aborts its work', async () => {
    const held = heldWork()
    const { id } = jobs.start('model_invoke', held.work, { timeoutMs: 90_000 })
    held.report('Queued at the provider as job q-7.')

    await vi.advanceTimersByTimeAsync(89_999)
    expect(jobs.running).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(held.signal().aborted).toBe(true)
    expect(await jobs.wait(running())).toStrictEqual<EndedJob[]>([{
      id,
      tool: 'model_invoke',
      status: 'timed out',
      text: 'The job did not end within its time limit of 90 seconds, so Dez stopped it. It has no result. This is not a fault of the call. The last state of the job: Queued at the provider as job q-7.',
      assets: [],
      hidesAssets: false,
      call: { number: 1, label: '' },
    }])
    expect(jobs.list()).toStrictEqual([{
      id, tool: 'model_invoke', status: 'timed out', delivered: true, elapsedMs: 90_000, state: 'Queued at the provider as job q-7.', call: { number: 1, label: '' }, inputs: [],
    }])
  })

  it('throws away what a work gives after its job timed out, with its files', async () => {
    const held = heldWork()
    jobs.start('model_invoke', held.work, { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await jobs.wait(running())

    held.finish({ text: 'Late.', assets: [image, clip(SAVED_CLIP), clip(TEMP_CLIP, URL_CLIP), clip(URL_CLIP, URL_CLIP)] })
    await settled()

    expect(await jobs.wait(running())).toStrictEqual([])
    expect(deletedImages).toStrictEqual([IMAGE])
    expect(deletedClips).toStrictEqual([SAVED_CLIP])
    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/made.mp4', folder: false }])
    expect(jobs.list()[0].status).toBe('timed out')
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not time out a job that ended', async () => {
    const held = heldWork()
    jobs.start('model_invoke', held.work, { timeoutMs: 1000 })
    held.finish({ text: 'Done.' })
    await vi.advanceTimersByTimeAsync(5000)

    expect((await jobs.wait(running())).map((job) => job.status)).toStrictEqual(['finished'])
  })

  it('fails a job whose work throws: the text of a ToolError, else a text with no detail of the error, and logs it', async () => {
    const refused = jobs.start('model_invoke', async () => { throw new ToolError('The model takes no image.', 'HTTP 400') }, LONG).id
    // Before its first await, as a work that is no async function can.
    const broken = jobs.start('video', () => { throw new Error('Failed to read /home/u/.config/dez/assets/x.png') }, LONG).id
    await settled()

    const ended = new Map((await jobs.wait(running())).map((job) => [job.id, job]))
    expect(ended.get(refused)).toMatchObject({ status: 'failed', text: 'The model takes no image.\n\nDetails: HTTP 400' })
    expect(ended.get(broken)).toMatchObject({
      status: 'failed',
      text: 'Dez hit an error that it did not expect while it ran video. This is not a fault of the call. '
        + 'Tell the user that the tool failed (Help › Developer Console shows the error), and do not call it again with the same arguments.',
    })
    expect(consoleError).toHaveBeenCalledTimes(2)
  })

  it('lists its jobs in the order of their starts, with the state, the time, the call, the inputs, and whether a wait gave the result', async () => {
    const first = heldWork()
    const second = heldWork()
    const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
    await vi.advanceTimersByTimeAsync(4000)
    const { id: secondId } = jobs.start('video', second.work, { ...LONG, label: 'join_clips @c @d', inputs: ['c', 'd'] })
    second.report('Sent the request.')
    second.report('Queued.')
    await vi.advanceTimersByTimeAsync(3000)
    second.finish()
    await vi.advanceTimersByTimeAsync(2000)

    expect(jobs.list()).toStrictEqual([
      { id: firstId, tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 9000, state: '', call: { number: 1, label: '' }, inputs: [] },
      { id: secondId, tool: 'video', status: 'finished', delivered: false, elapsedMs: 3000, state: 'Queued.', call: { number: 2, label: 'join_clips @c @d' }, inputs: ['c', 'd'] },
    ])

    await jobs.wait(running())
    // A state that a work reports after its job ended does not count.
    second.report('Late.')
    expect(jobs.list()[1]).toMatchObject({ delivered: true, state: 'Queued.' })
  })

  // The conversation total adds the price of each job once, at the end of
  // the job.
  it('lists the last price that the work of a job reported, keeps the price of a job that ended, and gives it to onCost at the end', async () => {
    const counted: (number | null)[] = []
    jobs = new TabJobs((usd) => counted.push(usd))
    const paid = heldWork()
    const unpriced = heldWork()
    const stopped = heldWork()
    jobs.start('model_invoke', paid.work, LONG)
    jobs.start('model_invoke', unpriced.work, LONG)
    jobs.start('model_invoke', stopped.work, LONG)
    jobs.start('video', heldWork().work, LONG)

    paid.reportCost(0.4)
    paid.reportCost(0.35)
    unpriced.reportCost(null)
    stopped.reportCost(1.2)
    expect(counted).toStrictEqual([])
    paid.finish()
    await settled()
    expect(counted).toStrictEqual([0.35])
    jobs.stopAll()
    // A price that a work reports after its job ended does not count.
    paid.reportCost(9)
    stopped.reportCost(0)

    // A job whose work reported no price has no `cost`.
    expect(jobs.list().map((job) => job.cost)).toStrictEqual([0.35, null, 1.2, undefined])
    expect(Object.hasOwn(jobs.list()[3], 'cost')).toBe(false)
    expect(counted).toStrictEqual([0.35, null, 1.2])
  })

  // A reply has no limit of tool rounds, so the limit counts only the open
  // jobs: a model that reads its results can start any count of jobs.
  it(`starts no job while ${MAX_OPEN_JOBS} jobs run or have a result that no wait took, and starts jobs again after a wait`, async () => {
    const done = async () => ({ text: '', isError: false, assets: [] })
    jobs.start('model_invoke', heldWork().work, LONG)
    for (let count = 1; count < MAX_OPEN_JOBS; count++) jobs.start('model_invoke', done, LONG)
    await settled()
    expect([jobs.running, jobs.ready]).toStrictEqual([1, MAX_OPEN_JOBS - 1])

    let started = false
    const next = async () => { started = true; return await done() }
    expect(() => jobs.start('model_invoke', next, LONG)).toThrow(new ToolError(JOB_LIMIT_TEXT))
    expect(started).toBe(false)
    expect(jobs.list()).toHaveLength(MAX_OPEN_JOBS)

    // The wait takes the results that are ready; the job that still runs
    // counts on.
    await jobs.wait(running())
    expect(jobs.start('model_invoke', next, LONG).number).toBe(MAX_OPEN_JOBS + 1)
    expect(started).toBe(true)
  })

  // Delete Unused Files keeps these files: no text names them before a
  // reader writes them into the reply.
  it('gives the sources of the files that a running job kept, and of the results that ended, also after a reader took them', async () => {
    const keptImage = `${APP_DIR}/assets/generated/images/kept.png`
    const first = heldWork()
    const second = heldWork()
    const third = heldWork()
    jobs.start('model_invoke', first.work, LONG)
    jobs.start('model_invoke', second.work, LONG)
    jobs.start('model_invoke', third.work, LONG)
    first.finish({ assets: [image, clip(URL_CLIP, URL_CLIP)] })
    await settled()
    await jobs.wait(running())
    second.finish({ assets: [clip(TEMP_CLIP), clip(SAVED_CLIP)] })
    // The answer of the third job goes on after an image.
    third.keepAsset({ kind: 'image', path: keptImage })
    await settled()

    expect(jobs.madeAssetSources()).toStrictEqual([IMAGE, URL_CLIP, TEMP_CLIP, SAVED_CLIP, keptImage])
  })

  describe('settle', () => {
    it('waits until no job runs, then gives the results that no wait took', async () => {
      const first = heldWork()
      const second = heldWork()
      const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
      const { id: secondId } = jobs.start('model_invoke', second.work, LONG)
      first.finish({ text: 'First.' })
      await jobs.wait(running())

      let settledJobs: EndedJob[] | null | undefined
      void jobs.settle(running()).then((ended) => { settledJobs = ended })
      await settled()
      expect(settledJobs).toBeUndefined()

      second.finish({ assets: [image] })
      await settled()
      expect(settledJobs).toStrictEqual<EndedJob[]>([{ id: secondId, tool: 'model_invoke', status: 'finished', text: '', assets: [image], hidesAssets: false, call: { number: 2, label: '' } }])
      expect(jobs.list().map((job) => [job.id, job.delivered])).toStrictEqual([[firstId, true], [secondId, true]])
    })

    it('tells its reader that a job hides its assets', async () => {
      const held = heldWork()
      const { id } = jobs.start('model_invoke', held.work, { ...LONG, hidesAssets: true })
      held.finish({ assets: [image] })

      expect(await jobs.settle(running())).toStrictEqual<EndedJob[]>([{ id, tool: 'model_invoke', status: 'finished', text: '', assets: [image], hidesAssets: true, call: { number: 1, label: '' } }])
    })

    // A stop during the end wait of a reply hands the jobs on: the next
    // reply must still get every result.
    it('gives null when the lease aborts, takes no result, and leaves the jobs and the results for the next reader', async () => {
      const first = heldWork()
      const second = heldWork()
      const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
      const { id: secondId } = jobs.start('model_invoke', second.work, LONG)
      const lease = jobs.take('r1')
      first.finish({ text: 'First.', assets: [image] })
      await settled()
      const settle = jobs.settle(lease)

      jobs.release()

      expect(await settle).toBeNull()
      expect(second.signal().aborted).toBe(false)
      expect(deletedImages).toStrictEqual([])
      second.finish({ text: 'Second.' })
      expect((await jobs.wait(jobs.take('r2'), { all: true })).map((job) => [job.id, job.text])).toStrictEqual([[firstId, 'First.'], [secondId, 'Second.']])
    })
  })

  describe('take and release', () => {
    it('gives one lease at a time: a new take or a release aborts the lease before it', () => {
      const first = jobs.take('r1')
      const second = jobs.take('r2')
      expect([first.aborted, second.aborted]).toStrictEqual([true, false])

      jobs.release()
      expect(second.aborted).toBe(true)
    })

    it('keeps the section of each reply that took the jobs once, in the order of the takes', () => {
      jobs.take('r1')
      jobs.release()
      jobs.take('r2')
      jobs.take('r1')

      expect(jobs.replySections).toStrictEqual(['r1', 'r2'])
    })

    it('keeps the jobs, their numbers, and their results through a release and a take', async () => {
      jobs.take('r1')
      const held = heldWork()
      const { id } = jobs.start('model_invoke', held.work, LONG)
      jobs.release()
      held.finish({ text: 'Done.' })
      await settled()
      jobs.take('r2')

      expect(jobs.start('model_invoke', heldWork().work, LONG).number).toBe(2)
      expect((await jobs.wait(running(), { ids: [id] })).map((job) => job.text)).toStrictEqual(['Done.'])
    })

    // A runner of a reply that a stop cut can call `start` after the stop.
    it('starts no job for a call whose signal aborted, and starts jobs for later calls', () => {
      const stopped = new AbortController()
      stopped.abort()

      let started = false
      expect(() => jobs.start('model_invoke', async () => { started = true; return { text: '', isError: false, assets: [] } }, { ...LONG, signal: stopped.signal })).toThrow(ToolError)
      expect(started).toBe(false)
      expect(jobs.list()).toStrictEqual([])
      expect(jobs.start('model_invoke', heldWork().work, { ...LONG, signal: running() }).number).toBe(1)
    })
  })

  describe('cancel', () => {
    it('ends a job that runs at once as cancelled: aborts its work, counts its last price once, and gives no result', async () => {
      const counted: (number | null)[] = []
      jobs = new TabJobs((usd) => counted.push(usd))
      const held = heldWork()
      const other = heldWork()
      const { id } = jobs.start('model_invoke', held.work, LONG)
      jobs.start('model_invoke', other.work, LONG)
      held.reportCost(0.2)

      expect(jobs.cancel([id])).toStrictEqual([id])

      expect(held.signal().aborted).toBe(true)
      expect(other.signal().aborted).toBe(false)
      expect(counted).toStrictEqual([0.2])
      expect(jobs.list().map((job) => job.status)).toStrictEqual(['cancelled', 'running'])
      expect([jobs.running, jobs.ready]).toStrictEqual([1, 0])
      // A wait that names the job returns at once, with no result.
      expect(await jobs.wait(running(), { ids: [id] })).toStrictEqual([])
      // A second cancel changes nothing.
      expect(jobs.cancel([id])).toStrictEqual([])
      expect(counted).toStrictEqual([0.2])
    })

    it('throws away a late result of its work with its files, and logs no abort error', async () => {
      const held = heldWork()
      const { id } = jobs.start('model_invoke', held.work, LONG)
      const aborted = jobs.start('model_invoke', (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }), LONG).id

      jobs.cancel([id, aborted])
      held.finish({ text: 'Late.', assets: [image, clip(TEMP_CLIP)] })
      await settled()

      expect(await jobs.wait(running())).toStrictEqual([])
      expect(deletedImages).toStrictEqual([IMAGE])
      expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/made.mp4', folder: false }])
      expect(jobs.list().map((job) => job.status)).toStrictEqual(['cancelled', 'cancelled'])
      expect(jobs.madeAssetSources()).toStrictEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    })

    it('leaves a job that ended with its status and its unread result, and gives only the ids that it cancelled', async () => {
      const ended = heldWork()
      const endedId = jobs.start('model_invoke', ended.work, LONG).id
      const runningId = jobs.start('model_invoke', heldWork().work, LONG).id
      ended.finish({ text: 'Done.', assets: [image] })
      await settled()

      expect(jobs.cancel([endedId, runningId])).toStrictEqual([runningId])

      expect((await jobs.wait(running())).map((job) => [job.id, job.status, job.text])).toStrictEqual([[endedId, 'finished', 'Done.']])
      expect(deletedImages).toStrictEqual([])
    })

    // Unlike `stopAll`, a cancel lets the reply start the jobs that it
    // needs in place of the cancelled ones.
    it(`makes room for a new job while ${MAX_OPEN_JOBS} jobs are open, and jobs start after it`, () => {
      const ids = Array.from({ length: MAX_OPEN_JOBS }, () => jobs.start('model_invoke', heldWork().work, LONG).id)
      expect(() => jobs.start('model_invoke', heldWork().work, LONG)).toThrow(new ToolError(JOB_LIMIT_TEXT))

      jobs.cancel([ids[3]])

      expect(jobs.start('model_invoke', heldWork().work, LONG).number).toBe(MAX_OPEN_JOBS + 1)
    })
  })

  describe('stopAll', () => {
    it('ends every job that runs with no result, aborts its work, and ends the waits', async () => {
      const held = heldWork()
      const { id } = jobs.start('model_invoke', held.work, { timeoutMs: 1000 })
      const settle = jobs.settle(running())
      await vi.advanceTimersByTimeAsync(400)

      jobs.stopAll()

      expect(held.signal().aborted).toBe(true)
      expect(await settle).toStrictEqual([])
      expect(await jobs.wait(running())).toStrictEqual([])
      expect(jobs.hasOpen).toBe(false)

      // Neither the time limit nor the work changes a job that stopped; the
      // work's files go.
      held.finish({ assets: [image] })
      await vi.advanceTimersByTimeAsync(5000)
      expect(jobs.list()).toStrictEqual([{ id, tool: 'model_invoke', status: 'stopped', delivered: false, elapsedMs: 400, state: '', call: { number: 1, label: '' }, inputs: [] }])
      expect(deletedImages).toStrictEqual([IMAGE])
      expect(consoleError).not.toHaveBeenCalled()
    })

    it('does not log the abort error of a work that it stopped', async () => {
      jobs.start('model_invoke', (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }), LONG)

      jobs.stopAll()
      await settled()

      expect(jobs.list()[0].status).toBe('stopped')
      expect(consoleError).not.toHaveBeenCalled()
    })

    it('deletes the files of the results that no reader took', async () => {
      const held = heldWork()
      jobs.start('model_invoke', held.work, LONG)
      held.finish({ assets: [image, clip(TEMP_CLIP)] })
      await settled()

      jobs.stopAll()
      await settled()

      expect(deletedImages).toStrictEqual([IMAGE])
      expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/made.mp4', folder: false }])
      expect(await jobs.wait(running())).toStrictEqual([])
    })

    it('starts no job after it', () => {
      jobs.stopAll()

      let started = false
      expect(() => jobs.start('model_invoke', async () => { started = true; return { text: '', isError: false, assets: [] } }, LONG)).toThrow(ToolError)
      expect(started).toBe(false)
      expect(jobs.list()).toStrictEqual([])
    })
  })
})

describe('writeJobAssets', () => {
  // The provider made the last clip as its job `q-1`.
  const job: EndedJob = {
    id: 'j-aaaa', tool: 'model_invoke', status: 'finished', text: '', assets: [image, clip(SAVED_CLIP), clip(URL_CLIP, URL_CLIP, 'q-1')], hidesAssets: false, call: { number: 1, label: '' },
  }

  it('writes each asset under the name of the job\'s tool and the job\'s id, a clip with the job id of its provider, and gives the new ids', async () => {
    const writes: unknown[] = []
    const ids = ['c', 'd', 'e']
    const written = await writeJobAssets(job, {
      writeImage: (path, options) => { writes.push([path, options]); return ids.shift() ?? null },
      writeClip: (made, options) => { writes.push([made.src, options]); return ids.shift() ?? null },
    })

    expect(written).toStrictEqual([{ kind: 'image', id: 'c' }, { kind: 'audio', id: 'd' }, { kind: 'video', id: 'e' }])
    const options = { tool: 'model_invoke', madeBy: 'j-aaaa' }
    expect(writes).toStrictEqual([[IMAGE, options], [SAVED_CLIP, options], [URL_CLIP, { ...options, jobId: 'q-1' }]])
    expect(deletedImages).toStrictEqual([])
    expect(deletedClips).toStrictEqual([])
  })

  it('marks each asset of a job that hides its assets with the id of the job', async () => {
    const writes: unknown[] = []
    await writeJobAssets({ ...job, hidesAssets: true }, {
      writeImage: (_path, options) => { writes.push(options); return 'c' },
      writeClip: (_made, options) => { writes.push(options); return 'd' },
    })

    expect(writes).toStrictEqual([
      { tool: 'model_invoke', madeBy: 'j-aaaa', hidden: 'j-aaaa' },
      { tool: 'model_invoke', madeBy: 'j-aaaa', hidden: 'j-aaaa' },
      { tool: 'model_invoke', madeBy: 'j-aaaa', hidden: 'j-aaaa', jobId: 'q-1' },
    ])
  })

  it('deletes the file of an asset that the reply takes no more, and gives it no id', async () => {
    const written = await writeJobAssets(job, { writeImage: () => null, writeClip: () => null })

    expect(written).toStrictEqual([{ kind: 'image', id: null }, { kind: 'audio', id: null }, { kind: 'video', id: null }])
    expect(deletedImages).toStrictEqual([IMAGE])
    expect(deletedClips).toStrictEqual([SAVED_CLIP])
    // A clip at a provider URL has no file.
    expect(native.deletedFiles).toStrictEqual([])
  })
})

describe('discardMadeAssets', () => {
  it('goes on after a delete that fails, and logs it', async () => {
    imageDeleteError = new Error('No such file')

    await discardMadeAssets([image, clip(SAVED_CLIP)])

    expect(deletedClips).toStrictEqual([SAVED_CLIP])
    expect(consoleError).toHaveBeenCalledTimes(1)
  })
})
