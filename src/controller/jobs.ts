import sbp from '@sbp/sbp'
import { tempMediaFile } from '../model/chat/mediaFiles'
import { isSavedMediaPath, type MediaTagData } from '../model/chat/mediaTags'
import type { GeneratedClip } from '../model/providers/types'
import { JOB_LIMIT_TEXT, jobTimedOutText, MAX_JOBS_PER_REPLY, newJobId, type JobCall, type JobInfo, type JobResultStatus, type JobStatus, type WrittenJobAsset } from '../model/tools/jobs'
import { unexpectedToolErrorText } from '../model/tools/registry'
import { ToolError } from '../model/tools/types'
import type { ToolRunContext } from './tools'

// The jobs of one reply: the slow work of its tool calls, which runs in the
// background while the reply goes on (the rules and the texts for the model
// are in model/tools/jobs.ts). A runner starts a job with
// `context.jobs.start` and returns `jobStartedText` at once; the `jobs_wait`
// runner, or the end of the reply, takes the results. This module registers
// no selector: a reply owns its `ReplyJobs` (`ReplyRuntime.jobs`,
// controller/stream.ts), and a runner gets it in its `ToolRunContext`.

/** An image or a clip that the work of a reply made (a job, a tool call,
 *  a media round) before a text of the reply names it: a stored image
 *  file, or a clip as its tag holds it (a saved file, a temp copy, or a
 *  provider URL). `jobId` is the provider's id of the job that made the
 *  clip, when the provider made it as one: the clip's tag keeps it. */
export type MadeAsset =
  | { kind: 'image', path: string }
  | { kind: 'clip', clip: Omit<MediaTagData, 'id' | 'other'>, jobId?: string }

/** A clip of a media request (`dez.provider/generateMedia`) as a made
 *  asset. */
export function generatedClipAsset(clip: GeneratedClip): MadeAsset {
  return {
    kind: 'clip',
    clip: { kind: clip.kind, type: clip.mediaType, src: clip.src, url: clip.url, expires: clip.expires },
    ...(clip.jobId !== null && { jobId: clip.jobId }),
  }
}

/** What the work of a job gave. */
export interface JobOutcome {
  /** The result for the model that reads it; blank for none. It goes to
   *  the chat provider, so it holds no local path. */
  text: string
  /** The work failed, and `text` tells why. */
  isError: boolean
  assets: MadeAsset[]
}

/** The work of a job. `signal` aborts when the job ends before its work
 *  (its reply ended, or its time limit passed): the work must then end its
 *  requests. `report` keeps a state text for `jobs_list` and `job_inspect`,
 *  such as the phase of the work and a provider's job id; it goes to the
 *  chat provider too, and the result of a job that timed out ends with it.
 *
 *  The work makes its files, but writes nothing into the reply: a job can
 *  end while the model writes text, and the asset of a tool goes after the
 *  blocks of a group. The reader of the result writes them
 *  (`writeJobAssets`). A work that throws fails its job, as a runner that
 *  throws fails its call: a `ToolError` gives its text as the result. */
export type JobWork = (signal: AbortSignal, report: (state: string) => void) => Promise<JobOutcome>

/** A job that ended with a result, as its reader gets it. */
export interface EndedJob {
  id: string
  /** The tool whose call started the job. */
  tool: string
  status: JobResultStatus
  text: string
  assets: MadeAsset[]
  /** The call made the assets as a part of its work: they go into the
   *  reply as hidden assets of this job (`writeJobAssets`). */
  hidesAssets: boolean
  /** Which call started the job, for the reader of the result. */
  call: JobCall
}

interface Job extends Omit<EndedJob, 'status'> {
  status: JobStatus
  // The last text that the work reported.
  state: string
  startedAt: number
  endedAt: number | null
  // A reader took the result.
  delivered: boolean
  // Its own controller, not the signal of the tool round that started the
  // job: the job outlives that round.
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
}

/** Deletes the files of made assets that no text of a reply will name:
 *  the results of a job that nobody read before its reply stopped, what a
 *  work still gave after its job ended, and the output of a tool call or a
 *  media round whose reply took it no more. A clip at a provider URL has
 *  no file. A failure is only logged: Settings › General › Unused files
 *  finds an image or a saved clip that stays, and the cleanup of the temp
 *  copies (controller/media.ts) a temp copy. */
export async function discardMadeAssets(assets: readonly MadeAsset[]): Promise<void> {
  for (const asset of assets) {
    const path = asset.kind === 'image' ? asset.path : asset.clip.src
    if (path === null) continue
    try {
      if (asset.kind === 'image') {
        await sbp('dez.controller/images/delete', path)
      } else if (isSavedMediaPath(path)) {
        await sbp('dez.controller/media/delete', path)
      } else {
        const file = tempMediaFile(path, await sbp('dez.native/getAppDir', 'cache') as string)
        if (file !== null) await sbp('dez.native/deleteAppFile', file, 'cache')
      }
    } catch (error) {
      console.error('Failed to delete a made file that no text names:', error)
    }
  }
}

/** Puts the assets of an ended job into the reply with `writers`, under the
 *  name of the job's tool, and tells the new id of each. All the writes are
 *  in one tick. An asset that the reply takes no more (its writer gives
 *  null) has no id, and its file is deleted. The assets of a job that
 *  hides them get the job's id as their hidden marker. */
export async function writeJobAssets(job: EndedJob, writers: Pick<ToolRunContext, 'writeImage' | 'writeClip'>): Promise<WrittenJobAsset[]> {
  const written: WrittenJobAsset[] = []
  const lost: MadeAsset[] = []
  const options = { tool: job.tool, ...(job.hidesAssets && { hidden: job.id }) }
  for (const asset of job.assets) {
    const id = asset.kind === 'image'
      ? writers.writeImage(asset.path, options)
      : writers.writeClip(asset.clip, { ...options, ...(asset.jobId !== undefined && { jobId: asset.jobId }) })
    if (id === null) lost.push(asset)
    written.push({ kind: asset.kind === 'image' ? 'image' : asset.clip.kind, id })
  }
  await discardMadeAssets(lost)
  return written
}

/** The jobs of one reply. */
export class ReplyJobs {
  // In the order of the starts.
  private readonly jobs = new Map<string, Job>()
  // The jobs that ended with a result that no reader took, in the order of
  // their ends.
  private readonly unread: Job[] = []
  // Each wait for the next end of a job.
  private readonly waits = new Set<() => void>()
  private stopped = false

  /** How many jobs run now. */
  get running(): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.status === 'running') count++
    return count
  }

  /** A job runs, or a result waits for a reader. */
  get hasOpen(): boolean {
    return this.unread.length > 0 || this.running > 0
  }

  /** Starts `work` as a job of `tool` and returns the job's id and its
   *  number (`JobCall.number`) at once. The job ends as `timed out` when
   *  the work takes more than `timeoutMs`. `hidesAssets`: see `EndedJob`.
   *  `label` is the label of the call (`jobCallLabel`). Throws a
   *  `ToolError` for a job over `MAX_JOBS_PER_REPLY`, and after `stopAll`. */
  start(tool: string, work: JobWork, { timeoutMs, hidesAssets = false, label = '' }: { timeoutMs: number, hidesAssets?: boolean, label?: string }): { id: string, number: number } {
    if (this.stopped) throw new ToolError('The reply stopped, so Dez started no job. This is not a fault of the call.')
    if (this.jobs.size >= MAX_JOBS_PER_REPLY) throw new ToolError(JOB_LIMIT_TEXT)
    const job: Job = {
      id: newJobId((id) => this.jobs.has(id)),
      tool,
      hidesAssets,
      call: { number: this.jobs.size + 1, label },
      status: 'running',
      text: '',
      assets: [],
      state: '',
      startedAt: Date.now(),
      endedAt: null,
      delivered: false,
      abort: new AbortController(),
      timer: setTimeout(() => this.end(job, 'timed out', jobTimedOutText(timeoutMs, job.state)), timeoutMs),
    }
    this.jobs.set(job.id, job)

    // In an async function, so that a work that throws before its first
    // await fails its job as a work that rejects does. The `await` listens
    // to the work's promise in this tick: a plain `return` of it would
    // listen one tick later, and two works that end in the tick of their
    // starts would then end in the order of the starts.
    const outcome = (async () => await work(job.abort.signal, (state) => {
      if (job.status === 'running') job.state = state
    }))()
    outcome.then((result) => {
      // The job timed out or stopped before its work ended: nobody reads
      // this result.
      if (job.status !== 'running') void discardMadeAssets(result.assets)
      else this.end(job, result.isError ? 'failed' : 'finished', result.text, result.assets)
    }, (error: unknown) => {
      // The abort of a job that ended is not a failure.
      if (job.status !== 'running') return
      console.error(`The ${tool} job ${job.id} failed:`, error)
      this.end(job, 'failed', error instanceof ToolError ? error.message : unexpectedToolErrorText(tool))
    })
    return { id: job.id, number: job.call.number }
  }

  // Ends a running job, and wakes every wait. A job that its work did not
  // end (a time limit, a stop) aborts the work's signal, which ends the
  // requests of the work.
  private end(job: Job, status: Exclude<JobStatus, 'running'>, text = '', assets: MadeAsset[] = []): void {
    job.status = status
    job.text = text
    job.assets = assets
    job.endedAt = Date.now()
    clearTimeout(job.timer)
    if (status === 'timed out' || status === 'stopped') job.abort.abort()
    if (status !== 'stopped') this.unread.push(job)
    for (const wake of [...this.waits]) wake()
  }

  // The results that no reader took, which count as read from now on.
  private takeUnread(): EndedJob[] {
    return this.unread.splice(0).map((job) => {
      job.delivered = true
      return { id: job.id, tool: job.tool, status: job.status as JobResultStatus, text: job.text, assets: job.assets, hidesAssets: job.hidesAssets, call: job.call }
    })
  }

  // Resolves at the next end of a job; rejects with the reason of `signal`
  // when it aborts first.
  private nextEnd(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        this.waits.delete(wake)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        this.waits.delete(wake)
        reject(signal?.reason)
      }
      this.waits.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** For `jobs_wait`: the jobs that ended and whose results no reader took
   *  yet, in the order of their ends. Each result comes once. With no such
   *  job, it waits for the next end of a job; with no job that runs
   *  either, it gives none at once. With `all`, it waits until no job
   *  runs, so it gives every result that is left in one call. Rejects with
   *  the reason of `signal` when it aborts; the jobs go on, and the
   *  results stay for the next reader. */
  async wait(signal: AbortSignal, all = false): Promise<EndedJob[]> {
    for (;;) {
      signal.throwIfAborted()
      if (this.running === 0 || (!all && this.unread.length > 0)) return this.takeUnread()
      await this.nextEnd(signal)
    }
  }

  /** For the end of a reply whose model did not wait for its jobs: waits
   *  until no job runs, then gives the results that no reader took, as
   *  `wait` does. A `stopAll` ends the wait, with no result. */
  async settle(): Promise<EndedJob[]> {
    while (this.running > 0) await this.nextEnd()
    return this.takeUnread()
  }

  /** Every job of the reply, in the order of the starts. */
  list(): JobInfo[] {
    const now = Date.now()
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      tool: job.tool,
      status: job.status,
      delivered: job.delivered,
      elapsedMs: (job.endedAt ?? now) - job.startedAt,
      state: job.state,
      call: job.call,
    }))
  }

  /** Ends every job at once, when its reply ends: a stop, a new submit, or
   *  the reply's own end. No job outlives its reply, as nothing could take
   *  its result. The results that no reader took are thrown away with
   *  their files, as the output of a media request that the user stopped,
   *  and no job starts after this. */
  stopAll(): void {
    this.stopped = true
    for (const job of this.jobs.values()) {
      if (job.status === 'running') this.end(job, 'stopped')
    }
    for (const job of this.unread.splice(0)) void discardMadeAssets(job.assets)
  }
}
