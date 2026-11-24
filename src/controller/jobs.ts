import sbp from '@sbp/sbp'
import { tempMediaFile } from '../model/chat/mediaFiles'
import { isSavedMediaPath, type MediaTagData } from '../model/chat/mediaTags'
import type { ModelRef } from '../model/chat/types'
import type { GeneratedClip } from '../model/providers/types'
import { hasJobResult, JOB_LIMIT_TEXT, jobTimedOutText, MAX_OPEN_JOBS, newJobId, type JobCall, type JobInfo, type JobResultStatus, type JobStatus, type WrittenJobAsset } from '../model/tools/jobs'
import { unexpectedToolErrorText } from '../model/tools/registry'
import { ToolError } from '../model/tools/types'
import type { ToolRunContext } from './tools'

// The jobs of a tab: the slow work of the tool calls of its replies, which
// runs in the background while a reply goes on (the rules and the texts for
// the model are in model/tools/jobs.ts). A runner starts a job with
// `context.jobs.start` and returns `jobStartedText` at once; the `jobs_wait`
// runner, or the end of the reply, takes the results. This module registers
// no selector: the reply that runs owns the `TabJobs` of its tab
// (`ReplyRuntime.jobs`), and the tab holds it between two replies
// (controller/stream.ts). A runner gets it in its `ToolRunContext`.

/** An image or a clip that the work of a reply made (a job, a tool call,
 *  a media round) before a text of the reply names it: a stored image
 *  file, or a clip as its tag holds it (a saved file, a temp copy, or a
 *  provider URL). `jobId` is the provider's id of the job that made the
 *  clip, when the provider made it as one: the clip's tag keeps it.
 *
 *  An asset that a tool call of the code of a script run made
 *  (controller/toolBridge.ts) has its own marks, as the job of the run
 *  has other ones (`writeJobAssets`): `tool`, the tool that made it;
 *  `model`, the model that made it; `madeBy`, the id of the job that made
 *  it for its call; `hidden`, the id of the job whose call made it as a
 *  part of its work; and `handle`, the name that the code knows it by
 *  (`&1`). */
export type MadeAsset = (
  | { kind: 'image', path: string }
  | { kind: 'clip', clip: Omit<MediaTagData, 'id' | 'other'>, jobId?: string }
) & { tool?: string, model?: ModelRef, madeBy?: string, hidden?: string, handle?: string }

/** A clip that a provider made (a clip of a media request, or the audio
 *  of a chat answer) as a made asset. */
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
 *  (Dez stopped it, a model cancelled it, or its time limit passed): the
 *  work must then end its requests. `report` keeps a state text for
 *  `jobs_list` and `job_inspect`, such as the phase of the work and a
 *  provider's job id; it goes to the chat provider too, and the result of
 *  a job that timed out ends with it. A report with `queued` tells that
 *  the work waits for its turn at a provider (mediaTurns.ts): the job is
 *  `queued` in `jobs_list` (`JobInfo.queued`), and its time limit stops
 *  until the next report, which has no `queued`. `reportCost` keeps the
 *  price in USD of the paid request of the work (`JobInfo.cost`; null: no
 *  price is known), for the spend line of `jobs_list`: a work that sends a
 *  paid request calls it when the request goes, and again when its price
 *  is final. A work that sends none never calls it.
 *
 *  The work makes its files, but writes nothing into the reply: a job can
 *  end while the model writes text, and the asset of a tool goes after the
 *  blocks of a group. The reader of the result writes them
 *  (`writeJobAssets`). A work that keeps a file while it goes on (an image
 *  of an answer whose stream goes on) tells it at once with `keepAsset`:
 *  until its result names the file, only that list keeps it from Delete
 *  Unreferenced Files (`madeAssetSources`). The result still holds the
 *  asset. A work whose files come right before its end needs no call: the
 *  cleanup keeps a file younger than `UNUSED_FILE_MIN_AGE_MS`. A work that
 *  throws fails its job, as a runner that throws fails its call: a
 *  `ToolError` gives its text as the result.
 *
 *  `jobs` are the jobs of the work's own tool calls (the code of a script
 *  run): a job that it starts is a job of this job (`TabJobs.scoped`). */
export type JobWork = (
  signal: AbortSignal,
  report: JobReport,
  reportCost: (usd: number | null) => void,
  keepAsset: (asset: MadeAsset) => void,
  jobs: ToolJobs,
) => Promise<JobOutcome>

/** The `report` of a `JobWork`. */
export type JobReport = (state: string, options?: { queued?: boolean }) => void

/** The options of a job start (`ToolJobs.start`). */
export interface JobOptions {
  timeoutMs: number
  hidesAssets?: boolean
  model?: ModelRef
  label?: string
  inputs?: readonly string[]
  signal?: AbortSignal
}

/** The jobs that the caller of a tool sees (`ToolRunContext.jobs`): a
 *  call of the model sees the jobs of its tab (`TabJobs`), and a call of
 *  the code of a script run sees only the jobs that the calls of that run
 *  started (`TabJobs.scoped`). Each member is as in `TabJobs`, for the
 *  jobs of that view. */
export interface ToolJobs {
  start(tool: string, work: JobWork, options: JobOptions): { id: string, number: number }
  readonly running: number
  readonly ready: number
  wait(signal: AbortSignal, options?: { all?: boolean, ids?: readonly string[] }): Promise<EndedJob[]>
  list(): JobInfo[]
  cancel(ids: readonly string[]): string[]
}

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
  /** The model that the work called (`model_invoke`), which made the
   *  assets: they go into the reply with its model mark
   *  (`writeJobAssets`). Absent for a job whose work calls no model. */
  model?: ModelRef
  /** Which call started the job, for the reader of the result. */
  call: JobCall
}

interface Job extends Omit<EndedJob, 'status' | 'assets'> {
  status: JobStatus
  // While the job runs, the files that its work kept so far (`keepAsset`);
  // from its end, the assets of its result.
  assets: MadeAsset[]
  // The last text that the work reported.
  state: string
  // The last price that the work reported (`JobInfo.cost`).
  cost?: number | null
  startedAt: number
  endedAt: number | null
  // A reader took the result.
  delivered: boolean
  // Its own controller, not the signal of the tool round that started the
  // job: the job outlives that round.
  abort: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  // The time limit of the job (`JobOptions.timeoutMs`), and what is left
  // of it when its timer started. The timer runs only while the job is not
  // queued: the limit is the time that the job runs.
  timeoutMs: number
  limitLeftMs: number
  timerStartedAt: number
  // The work waits for its turn at a provider (`JobWork`).
  queued: boolean
  // The ids of the assets that its call names as inputs (`JobInfo.inputs`).
  inputs: readonly string[]
  // The id of the job of the run of an app whose code started this job
  // with a tool call (`scoped`); null for a job of the model.
  scope: string | null
}

// The source of a made asset: the path of a stored image, or the `src` of
// a clip (a saved file, a temp copy, or a provider URL); null for a clip
// with no source.
function madeAssetSource(asset: MadeAsset): string | null {
  return asset.kind === 'image' ? asset.path : asset.clip.src
}

/** Deletes the files of made assets that no text of a reply will name:
 *  the results of a job that nobody read before its reply stopped, what a
 *  work still gave after its job ended, and the output of a tool call or a
 *  media round whose reply took it no more. A clip at a provider URL has
 *  no file. A failure is only logged: Settings › General › Delete
 *  Unreferenced Files finds a file that stays. */
export async function discardMadeAssets(assets: readonly MadeAsset[]): Promise<void> {
  for (const asset of assets) {
    const path = madeAssetSource(asset)
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

/** Puts made assets into the reply with `writers`, each with the options
 *  that `options` gives it, and tells the new id of each. All the writes
 *  are in one tick. An asset that the reply takes no more (its writer
 *  gives null) has no id, and its file is deleted. */
export async function writeMadeAssets(
  assets: readonly MadeAsset[],
  writers: Pick<ToolRunContext, 'writeImage' | 'writeClip'>,
  options: (asset: MadeAsset) => { tool?: string, model?: ModelRef, madeBy?: string, hidden?: string } = () => ({}),
): Promise<WrittenJobAsset[]> {
  const written: WrittenJobAsset[] = []
  const lost: MadeAsset[] = []
  for (const asset of assets) {
    const id = asset.kind === 'image'
      ? writers.writeImage(asset.path, options(asset))
      : writers.writeClip(asset.clip, { ...options(asset), ...(asset.jobId !== undefined && { jobId: asset.jobId }) })
    if (id === null) lost.push(asset)
    written.push({ kind: asset.kind === 'image' ? 'image' : asset.clip.kind, id, ...(asset.handle !== undefined && { handle: asset.handle }) })
  }
  await discardMadeAssets(lost)
  return written
}

/** Puts the assets of an ended job into the reply (`writeMadeAssets`),
 *  under the name of the job's tool, with the job's id (`madeBy`), and
 *  with the model that made them when the job has one. The assets of a
 *  job that hides them get the job's id as their hidden marker too.
 *
 *  An asset with marks of its own (`MadeAsset`: a tool call of the code of
 *  the job made it) keeps its tool and its model, is hidden when its call
 *  made it as a part of its work, and its line names its handle. */
export function writeJobAssets(job: EndedJob, writers: Pick<ToolRunContext, 'writeImage' | 'writeClip'>): Promise<WrittenJobAsset[]> {
  return writeMadeAssets(job.assets, writers, (asset) => {
    const model = asset.model ?? job.model
    return { tool: asset.tool ?? job.tool, madeBy: job.id, ...(model && { model }), ...((job.hidesAssets || asset.hidden !== undefined) && { hidden: job.id }) }
  })
}

// Which jobs a caller sees (`ToolJobs`): true for a job of the view.
type JobView = (job: Job) => boolean

// Every job of the tab, for the work of the reply itself (its end, a
// compaction, the cleanup of the files).
const ALL_JOBS: JobView = () => true

/** The jobs of a tab. A stop of the user or a new submit cuts the reply
 *  that runs, but not its jobs: the reply hands them on (`release`), and
 *  the next chat reply of the tab takes them (`take`), with their ids,
 *  their numbers, the results that wait, and the cost callback. So the
 *  model of the next reply can wait for them, or cancel the ones that it
 *  no longer needs (`cancel`). A reply that ends on its own waits for its
 *  jobs, then ends them (`stopAll`); a close of the tab ends them too.
 *  Only one reply reads the jobs at a time: the one that holds the lease
 *  of `take`.
 *
 *  A job that a tool call of the code of a script run started is a job
 *  of the job of that run (`scoped`). While the run goes on, only its code
 *  sees the job, so the model takes no result that the code waits for,
 *  and the code takes no result of the model. When the run ends, the
 *  model sees the jobs that are still open, as jobs of its own. The
 *  members of this class with no other note are for the model: they see
 *  only the jobs of the model (`modelView`). */
export class TabJobs implements ToolJobs {
  // In the order of the starts.
  private readonly jobs = new Map<string, Job>()
  // The jobs that ended with a result that no reader took, in the order of
  // their ends.
  private readonly unread: Job[] = []
  // Each wait for the next end of a job.
  private readonly waits = new Set<() => void>()
  private stopped = false
  // The ids of the agent sections of the replies that took the jobs, in
  // the order of the takes.
  private readonly sections: string[] = []
  // The lease of the reply that took the jobs last (`take`).
  private lease: AbortController | null = null
  // The jobs of the model: the ones that no tool call of the code of a run
  // started, and those of a run that ended.
  private readonly modelView: JobView = (job) => job.scope === null || this.jobs.get(job.scope)?.status !== 'running'

  /** `onCost` gets the price of each job that sent a paid request
   *  (`JobInfo.cost`) once, at the end of the job: the last price that its
   *  work reported before that end. */
  constructor(private readonly onCost: (usd: number | null) => void = () => {}) {}

  /** The ids of the agent sections of the replies that took these jobs:
   *  the replies that the user cut (a stop, a new submit, a delete of
   *  their running blocks), and the reply that holds them now. A
   *  compaction counts their work as the work of the reply that runs
   *  (`CompactionInput.replySections`). */
  get replySections(): readonly string[] {
    return this.sections
  }

  /** The reply of the section `sectionId` takes the jobs, and from now on
   *  is the one reader of their results. The lease that this returns
   *  aborts when the reply hands the jobs on (`release`), or when another
   *  reply takes them. */
  take(sectionId: string): AbortSignal {
    this.release()
    if (!this.sections.includes(sectionId)) this.sections.push(sectionId)
    this.lease = new AbortController()
    return this.lease.signal
  }

  /** The reply that holds the jobs hands them on: its lease aborts, and
   *  the jobs go on, for the next reply that takes them. */
  release(): void {
    this.lease?.abort()
    this.lease = null
  }

  /** How many jobs run now. */
  get running(): number {
    return this.runningIn(this.modelView)
  }

  /** A job runs, or a result waits for a reader: of every job. */
  get hasOpen(): boolean {
    return this.unread.length > 0 || this.runningIn(ALL_JOBS) > 0
  }

  /** How many results of ended jobs wait for a reader. */
  get ready(): number {
    return this.unread.filter(this.modelView).length
  }

  /** The quotes of the paid requests of the jobs that run, of every job,
   *  in USD: money that the tab spends already, which its cost counts only
   *  at the end of each job (the money limit, moneyLimit.ts). A request
   *  with no known price holds nothing. */
  get heldCost(): number {
    let usd = 0
    for (const job of this.jobs.values()) if (job.status === 'running' && typeof job.cost === 'number') usd += job.cost
    return usd
  }

  private runningIn(view: JobView): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.status === 'running' && view(job)) count++
    return count
  }

  /** Starts `work` as a job of `tool` and returns the job's id and its
   *  number (`JobCall.number`) at once. The job ends as `timed out` when
   *  the work runs more than `timeoutMs`: the time that it is queued
   *  (`JobWork`) does not count. `hidesAssets` and `model`: see
   *  `EndedJob`. `label` is the label of the call (`jobCallLabel`), and
   *  `inputs` the ids of the assets that the call names as inputs
   *  (`JobInfo.inputs`). Throws a `ToolError` for one open job too many
   *  (`MAX_OPEN_JOBS`, of every job: the jobs that ended and whose results
   *  a reader took do not count, so a long reply can start any count of
   *  jobs), after `stopAll`, and when `signal` (the signal of the call)
   *  aborted: a call that a stop or a new submit cut starts no job. */
  start(tool: string, work: JobWork, options: JobOptions): { id: string, number: number } {
    return this.startIn(null, tool, work, options)
  }

  // `start` for a job of the scope `scope` (`Job.scope`).
  private startIn(scope: string | null, tool: string, work: JobWork, { timeoutMs, hidesAssets = false, model, label = '', inputs = [], signal }: JobOptions): { id: string, number: number } {
    if (this.stopped || signal?.aborted) throw new ToolError('The reply stopped, so Dez started no job. This is not a fault of the call.')
    if (this.runningIn(ALL_JOBS) + this.unread.length >= MAX_OPEN_JOBS) throw new ToolError(JOB_LIMIT_TEXT)
    const job: Job = {
      id: newJobId((id) => this.jobs.has(id)),
      tool,
      hidesAssets,
      ...(model && { model }),
      call: { number: this.jobs.size + 1, label },
      status: 'running',
      text: '',
      assets: [],
      state: '',
      startedAt: Date.now(),
      endedAt: null,
      delivered: false,
      abort: new AbortController(),
      timer: undefined,
      timeoutMs,
      limitLeftMs: timeoutMs,
      timerStartedAt: 0,
      queued: false,
      inputs,
      scope,
    }
    this.jobs.set(job.id, job)
    this.runLimit(job)

    // In an async function, so that a work that throws before its first
    // await fails its job as a work that rejects does. The `await` listens
    // to the work's promise in this tick: a plain `return` of it would
    // listen one tick later, and two works that end in the tick of their
    // starts would then end in the order of the starts. A report after the
    // end of the job changes nothing: a stopped, cancelled, or timed-out
    // job keeps the price of its request when it ended.
    const outcome = (async () => await work(job.abort.signal, (state, options) => {
      if (job.status !== 'running') return
      job.state = state
      this.setQueued(job, options?.queued === true)
    }, (usd) => {
      if (job.status === 'running') job.cost = usd
    }, (asset) => {
      // A file that a work keeps after the end of its job comes in its
      // late result, which is thrown away with its files below.
      if (job.status === 'running') job.assets.push(asset)
    }, this.scoped(job.id)))()
    outcome.then((result) => {
      // The job timed out, stopped, or was cancelled before its work ended:
      // nobody reads this result.
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

  // Starts the timer of what is left of the time limit of `job`.
  private runLimit(job: Job): void {
    job.timerStartedAt = Date.now()
    job.timer = setTimeout(() => this.end(job, 'timed out', jobTimedOutText(job.timeoutMs, job.state)), job.limitLeftMs)
  }

  // The work of `job` waits for its turn at a provider, or its turn came.
  // The time limit stops while it waits: a model that starts more media
  // jobs than the provider takes at once must not lose the later ones to
  // the wait.
  private setQueued(job: Job, queued: boolean): void {
    if (job.queued === queued) return
    job.queued = queued
    if (queued) {
      clearTimeout(job.timer)
      job.limitLeftMs -= Date.now() - job.timerStartedAt
    } else {
      this.runLimit(job)
    }
  }

  // The jobs of the job `scope`, which the work of that job gets
  // (`JobWork`): the tool calls of the code of a run of an app start and
  // see only these.
  private scoped(scope: string): ToolJobs {
    const view: JobView = (job) => job.scope === scope
    const running = () => this.runningIn(view)
    const ready = () => this.unread.filter(view).length
    return {
      start: (tool, work, options) => this.startIn(scope, tool, work, options),
      get running() {
        return running()
      },
      get ready() {
        return ready()
      },
      wait: (signal, options) => this.waitIn(view, signal, options),
      list: () => this.listIn(view),
      cancel: (ids) => this.cancelIn(view, ids),
    }
  }

  // Ends a running job, and wakes every wait. A job that its work did not
  // end (a time limit, a stop, a cancel) aborts the work's signal, which
  // ends the requests of the work, and stops the jobs that the tool calls
  // of its code started and that still run: no code waits for them any
  // more. A job with no result (`hasJobResult`) leaves nothing for a
  // reader.
  private end(job: Job, status: Exclude<JobStatus, 'running'>, text = '', assets: MadeAsset[] = []): void {
    job.status = status
    job.text = text
    job.assets = assets
    job.endedAt = Date.now()
    clearTimeout(job.timer)
    job.queued = false
    if (status === 'timed out' || !hasJobResult(status)) {
      job.abort.abort()
      for (const inner of this.jobs.values()) {
        if (inner.scope === job.id && inner.status === 'running') this.end(inner, 'stopped')
      }
    }
    if (hasJobResult(status)) this.unread.push(job)
    if (job.cost !== undefined) this.onCost(job.cost)
    for (const wake of [...this.waits]) wake()
  }

  // The results of the view `view` that no reader took, which count as
  // read from now on: of the jobs `ids`, or of every job of the view. The
  // other results stay unread.
  private takeUnread(view: JobView, ids?: readonly string[]): EndedJob[] {
    const wanted = ids && new Set(ids)
    const taken: Job[] = []
    const kept: Job[] = []
    for (const job of this.unread) (view(job) && (!wanted || wanted.has(job.id)) ? taken : kept).push(job)
    this.unread.splice(0, this.unread.length, ...kept)
    return taken.map((job) => {
      job.delivered = true
      return { id: job.id, tool: job.tool, status: job.status as JobResultStatus, text: job.text, assets: job.assets, hidesAssets: job.hidesAssets, ...(job.model && { model: job.model }), call: job.call }
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
   *  runs, so it gives every result that is left in one call. With `ids`,
   *  it waits until none of those jobs runs, and gives only their results
   *  (an id of no job counts as ended, and a cancelled job gives none).
   *  Rejects with the reason of `signal` when it aborts; the jobs go on,
   *  and the results stay for the next reader. */
  wait(signal: AbortSignal, options?: { all?: boolean, ids?: readonly string[] }): Promise<EndedJob[]> {
    return this.waitIn(this.modelView, signal, options)
  }

  // `wait` for the jobs of the view `view`: a job of another view counts
  // as a job of no id.
  private async waitIn(view: JobView, signal: AbortSignal, { all = false, ids }: { all?: boolean, ids?: readonly string[] } = {}): Promise<EndedJob[]> {
    const done = ids
      ? () => ids.every((id) => {
          const job = this.jobs.get(id)
          return job?.status !== 'running' || !view(job)
        })
      : () => this.runningIn(view) === 0 || (!all && this.unread.some(view))
    for (;;) {
      signal.throwIfAborted()
      if (done()) return this.takeUnread(view, ids)
      await this.nextEnd(signal)
    }
  }

  /** For the end of a reply whose model did not wait for its jobs: waits
   *  until no job runs, then gives the results that no reader took, as
   *  `wait` does, of every job. `lease` is the lease of the reply
   *  (`take`): when it aborts (the user cut the reply, and it handed the
   *  jobs on), the wait ends and gives null, and the results stay for the
   *  next reader. A `stopAll` ends the wait, with no result. */
  async settle(lease: AbortSignal): Promise<EndedJob[] | null> {
    while (this.runningIn(ALL_JOBS) > 0 && !lease.aborted) await this.nextEnd(lease).catch(() => {})
    return lease.aborted ? null : this.takeUnread(ALL_JOBS)
  }

  /** The jobs of the model, in the order of the starts. */
  list(): JobInfo[] {
    return this.listIn(this.modelView)
  }

  /** Every job of the tab, in the order of the starts: also the jobs that
   *  the code of a run that goes on started. A compaction keeps their
   *  inputs. */
  allJobs(): JobInfo[] {
    return this.listIn(ALL_JOBS)
  }

  private listIn(view: JobView): JobInfo[] {
    const now = Date.now()
    return [...this.jobs.values()].filter(view).map((job) => ({
      id: job.id,
      tool: job.tool,
      status: job.status,
      delivered: job.delivered,
      elapsedMs: (job.endedAt ?? now) - job.startedAt,
      state: job.state,
      call: job.call,
      inputs: job.inputs,
      ...(job.cost !== undefined && { cost: job.cost }),
      ...(job.queued && { queued: true as const }),
    }))
  }

  /** The sources (`madeAssetSources`) of the files that the work of a job
   *  that runs kept so far, and of the assets of every job that ended with
   *  a result: the ones that no reader took yet, and the ones that a reader
   *  took but may not have written into the reply yet. No text names their
   *  files until the write, so Delete Unreferenced Files keeps them by this
   *  list (`dez.stream/unnamedMadeFiles`). */
  madeAssetSources(): string[] {
    return [...this.jobs.values()].flatMap((job) => job.assets.flatMap((asset) => madeAssetSource(asset) ?? []))
  }

  /** For `job_cancel`: ends at once each job of `ids` that runs, as
   *  `cancelled`, and gives the ids of those jobs. As a stopped job, it
   *  aborts its work (so its requests end), counts its last price
   *  (`onCost`: a provider can bill a request that it took), and gives no
   *  result; a late result of its work is thrown away with its files. A
   *  job that ended before keeps its status and its result. Unlike
   *  `stopAll`, new jobs can start after it. */
  cancel(ids: readonly string[]): string[] {
    return this.cancelIn(this.modelView, ids)
  }

  // `cancel` of the jobs of the view `view`.
  private cancelIn(view: JobView, ids: readonly string[]): string[] {
    const cancelled: string[] = []
    for (const id of ids) {
      const job = this.jobs.get(id)
      if (job?.status !== 'running' || !view(job)) continue
      this.end(job, 'cancelled')
      cancelled.push(id)
    }
    return cancelled
  }

  /** Ends every job at once: at the end of a reply that ended on its own,
   *  and at a close of the tab. The results that no reader took are thrown
   *  away with their files, as the output of a media request that the user
   *  stopped, and no job starts after this. */
  stopAll(): void {
    this.stopped = true
    for (const job of this.jobs.values()) {
      if (job.status === 'running') this.end(job, 'stopped')
    }
    for (const job of this.unread.splice(0)) void discardMadeAssets(job.assets)
  }
}
