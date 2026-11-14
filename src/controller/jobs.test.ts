import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { JOB_LIMIT_TEXT, MAX_JOBS_PER_REPLY } from '../model/tools/jobs'
import { ToolError } from '../model/tools/types'
import { discardMadeAssets, ReplyJobs, writeJobAssets, type EndedJob, type MadeAsset } from './jobs'
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

let jobs: ReplyJobs
let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.useFakeTimers()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  jobs = new ReplyJobs()
  resetNative()
  deletedImages = []
  deletedClips = []
  imageDeleteError = undefined
})

afterEach(() => {
  consoleError.mockRestore()
  vi.useRealTimers()
})

describe('ReplyJobs', () => {
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
    expect(await jobs.settle()).toStrictEqual([])
    expect(jobs.hasOpen).toBe(false)
  })

  it('waits for every job with `all`, and gives all the results that are left in one call', async () => {
    const works = [heldWork(), heldWork(), heldWork()]
    const ids = works.map((held) => jobs.start('model_invoke', held.work, LONG).id)
    works[1].finish({ text: 'Second.' })
    await settled()
    expect((await jobs.wait(running())).map((job) => job.id)).toStrictEqual([ids[1]])

    let ended: EndedJob[] | undefined
    void jobs.wait(running(), true).then((results) => { ended = results })
    works[2].finish({ text: 'Third.' })
    await settled()
    // One job still runs, so the wait goes on with a result that is ready.
    expect(ended).toBeUndefined()

    works[0].finish({ text: 'First.' })
    await settled()
    expect(ended?.map((job) => [job.id, job.text])).toStrictEqual([[ids[2], 'Third.'], [ids[0], 'First.']])
    expect(jobs.hasOpen).toBe(false)
    expect(await jobs.wait(running(), true)).toStrictEqual([])
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
      id, tool: 'model_invoke', status: 'timed out', delivered: true, elapsedMs: 90_000, state: 'Queued at the provider as job q-7.', call: { number: 1, label: '' },
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

  it('lists its jobs in the order of their starts, with the state, the time, the call, and whether a wait gave the result', async () => {
    const first = heldWork()
    const second = heldWork()
    const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
    await vi.advanceTimersByTimeAsync(4000)
    const { id: secondId } = jobs.start('video', second.work, { ...LONG, label: 'join_clips @c @d' })
    second.report('Sent the request.')
    second.report('Queued.')
    await vi.advanceTimersByTimeAsync(3000)
    second.finish()
    await vi.advanceTimersByTimeAsync(2000)

    expect(jobs.list()).toStrictEqual([
      { id: firstId, tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 9000, state: '', call: { number: 1, label: '' } },
      { id: secondId, tool: 'video', status: 'finished', delivered: false, elapsedMs: 3000, state: 'Queued.', call: { number: 2, label: 'join_clips @c @d' } },
    ])

    await jobs.wait(running())
    // A state that a work reports after its job ended does not count.
    second.report('Late.')
    expect(jobs.list()[1]).toMatchObject({ delivered: true, state: 'Queued.' })
  })

  it(`starts no job after ${MAX_JOBS_PER_REPLY} jobs of the reply, also when they ended`, async () => {
    for (let count = 0; count < MAX_JOBS_PER_REPLY; count++) jobs.start('model_invoke', async () => ({ text: '', isError: false, assets: [] }), LONG)
    await settled()
    await jobs.wait(running())

    let started = false
    expect(() => jobs.start('model_invoke', async () => { started = true; return { text: '', isError: false, assets: [] } }, LONG)).toThrow(new ToolError(JOB_LIMIT_TEXT))
    expect(started).toBe(false)
    expect(new Set(jobs.list().map((job) => job.id)).size).toBe(MAX_JOBS_PER_REPLY)
  })

  describe('settle', () => {
    it('waits until no job runs, then gives the results that no wait took', async () => {
      const first = heldWork()
      const second = heldWork()
      const { id: firstId } = jobs.start('model_invoke', first.work, LONG)
      const { id: secondId } = jobs.start('model_invoke', second.work, LONG)
      first.finish({ text: 'First.' })
      await jobs.wait(running())

      let settledJobs: EndedJob[] | undefined
      void jobs.settle().then((ended) => { settledJobs = ended })
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

      expect(await jobs.settle()).toStrictEqual<EndedJob[]>([{ id, tool: 'model_invoke', status: 'finished', text: '', assets: [image], hidesAssets: true, call: { number: 1, label: '' } }])
    })
  })

  describe('stopAll', () => {
    it('ends every job that runs with no result, aborts its work, and ends the waits', async () => {
      const held = heldWork()
      const { id } = jobs.start('model_invoke', held.work, { timeoutMs: 1000 })
      const settle = jobs.settle()
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
      expect(jobs.list()).toStrictEqual([{ id, tool: 'model_invoke', status: 'stopped', delivered: false, elapsedMs: 400, state: '', call: { number: 1, label: '' } }])
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

  it('writes each asset under the name of the job\'s tool, a clip with the job id of its provider, and gives the new ids', async () => {
    const writes: unknown[] = []
    const ids = ['c', 'd', 'e']
    const written = await writeJobAssets(job, {
      writeImage: (path, options) => { writes.push([path, options]); return ids.shift() ?? null },
      writeClip: (made, options) => { writes.push([made.src, options]); return ids.shift() ?? null },
    })

    expect(written).toStrictEqual([{ kind: 'image', id: 'c' }, { kind: 'audio', id: 'd' }, { kind: 'video', id: 'e' }])
    expect(writes).toStrictEqual([[IMAGE, { tool: 'model_invoke' }], [SAVED_CLIP, { tool: 'model_invoke' }], [URL_CLIP, { tool: 'model_invoke', jobId: 'q-1' }]])
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
      { tool: 'model_invoke', hidden: 'j-aaaa' },
      { tool: 'model_invoke', hidden: 'j-aaaa' },
      { tool: 'model_invoke', hidden: 'j-aaaa', jobId: 'q-1' },
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
