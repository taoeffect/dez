import sbp from '@sbp/sbp'
import { cappedBridgedCalls, type BridgedCall, type BridgedCalls } from '../model/chat/bridgedCalls'
import type { ShownPicture } from '../model/chat/shownPictures'
import { modelFamily } from '../model/providers/modelFamilies'
import { NO_CALL_PICTURE_BUDGET, pictureBudgetLeft, shownPictureCost, totalCost } from '../model/streams/pictureBudget'
import { isOpenJob, startedJobId, type JobAssetKind } from '../model/tools/jobs'
import { JS_EVAL_MAX_TOOL_CALLS, jsEvalAnswerLine, type JsEvalCallLine, type JsEvalToolCalls } from '../model/tools/jsEval'
import { bridgedToolCall, shownSelector, UNEXPECTED_BRIDGE_ERROR_TEXT } from '../model/tools/toolBridge'
import type { ToolRunResult } from '../model/tools/types'
import type { ProgramInputWriter } from './programRuns'
import { discardShownPictures } from './shownPictures'
import type { ToolRunContext } from './tools'

// The page side of the tool bridge of one `js_eval` run
// (model/tools/toolBridge.ts): it runs the Dez tools that the code of the
// run calls with `dez.sbp`, and writes the answer of each call to the
// input of the program. This module registers no selector.
//
// A bridged call is a call of the `js_eval` call that runs the code: it
// runs through `dez.controller/tools/run`, as a call of the model does,
// with the context of that call. So its asset goes into the reply, its job
// is a job of the reply, and its pictures count against the budget of the
// round. Only the result differs: the code gets it, not the model, so the
// result of the `js_eval` call tells the model what the calls left
// (`JsEvalToolCalls`), and the block of that call keeps a list of the
// calls for the user (`BridgedCalls`).

/** What the tool calls of the code of a run left, at the end of the run. */
export interface ToolBridgeEnd {
  /** For the result text of the run (`jsEvalResult`). */
  toolCalls: JsEvalToolCalls
  /** The saved copies of the pictures that the calls showed, in their
   *  order. The result of the `js_eval` call takes them, or its runner
   *  deletes them (`discardShownPictures`). */
  pictures: readonly ShownPicture[]
  /** The calls of the code, for the block of the `js_eval` call
   *  (`ToolBlockData.bridged`). */
  bridged: BridgedCalls
}

/** The bridged tool calls of one `js_eval` run. `context` is the context
 *  of the `js_eval` call, `workFolders` the paths of the work folder of
 *  the run on this computer (`textForModel`), and `callSignal` the signal
 *  of the `js_eval` call. */
export class ToolBridge {
  // Aborts the call that runs: at a stop of the `js_eval` call, and at the
  // end of the run. A call that a stop cut must start no job (`startJob`,
  // tools.ts), and a call that waits (`jobs_wait`) must not outlive the
  // code that made it.
  private readonly stop = new AbortController()
  private readonly unlinkCallSignal: () => void
  // The end of the last call that the bridge took. The calls run one at a
  // time, in the order of their lines: the tools read the conversation and
  // write into the reply (the next asset id, the picture budget), and code
  // that makes two calls at one time (`Promise.all`) must get the same
  // ids and the same budget in each run. A plain promise chain, not the
  // event queue (`okTurtles.eventQueue`): that one keeps an entry for each
  // queue name, and each run would need its own name.
  private tail: Promise<void> = Promise.resolve()
  private ended = false
  private callLines = 0
  private answers = 0
  private readonly assets: { kind: JobAssetKind, id: string }[] = []
  // The apps that the calls showed (`apps show`), in their order.
  private readonly shownApps: string[] = []
  // The ids of the jobs that the calls started.
  private readonly startedJobs = new Set<string>()
  private readonly pictures: ShownPicture[] = []
  // One entry for each call line up to the limit of a run, in the order of
  // the lines. An entry starts as a call that the end of the run cut, and
  // its call fills it.
  private readonly records: BridgedCall[] = []

  constructor(private readonly context: ToolRunContext, private readonly workFolders: readonly string[], callSignal: AbortSignal) {
    const stop = () => this.stop.abort(callSignal.reason)
    if (callSignal.aborted) stop()
    else callSignal.addEventListener('abort', stop, { once: true })
    this.unlinkCallSignal = () => callSignal.removeEventListener('abort', stop)
  }

  /** Takes the call line `line` of the run: runs its call after the calls
   *  of the earlier lines, and writes its answer with `write`, the writer
   *  of the input of the run. It never throws, as the output handler of a
   *  run calls it (`runProgram`). */
  call(line: JsEvalCallLine, write: ProgramInputWriter): void {
    const number = ++this.callLines
    this.tail = this.tail.then(() => this.answer(line, number, write))
  }

  /** Ends the bridge at the end of the run, and gives what its calls left.
   *  It stops the call that runs and waits for its end; the calls after it
   *  do not run. From here on a call writes no asset and shows no picture,
   *  and no answer goes to the program, which is gone. */
  async end(): Promise<ToolBridgeEnd> {
    this.ended = true
    this.unlinkCallSignal()
    this.stop.abort(new Error('The run of the code ended.'))
    await this.tail
    return {
      toolCalls: {
        assets: this.assets,
        shownApps: this.shownApps,
        // Only the open ones: for a job whose result a later call of the
        // code took (`jobs_wait`), or that one cancelled, the model has
        // nothing to do.
        jobs: this.context.jobs.list()
          .filter((job) => this.startedJobs.has(job.id) && isOpenJob(job))
          .map((job) => ({ id: job.id, number: job.call.number })),
        unanswered: this.callLines - this.answers,
        pictures: this.pictures.length,
      },
      pictures: this.pictures,
      bridged: cappedBridgedCalls(this.records, this.callLines - this.records.length),
    }
  }

  // Runs the call of the call line `number` of the run, writes its answer,
  // and keeps its entry of the list of the calls. It never rejects: a
  // rejection would end the chain of the calls (`tail`), and the code would
  // wait for each later answer to its time limit.
  private async answer(line: JsEvalCallLine, number: number, write: ProgramInputWriter): Promise<void> {
    // A line after the limit of a run has no entry: code can write lines
    // without end, and the list counts them (`BridgedCalls.more`).
    const record: BridgedCall | null = number > JS_EVAL_MAX_TOOL_CALLS
      ? null
      : { name: shownSelector(line.selector, this.workFolders), arguments: {}, status: 'cut', result: '' }
    if (record) this.records.push(record)
    let answer: { text: string, isError: boolean } | null
    try {
      answer = await this.run(line, number, record)
    } catch (error) {
      // A forged line can hold a value that the checks cannot walk (some
      // thousand arrays in each other).
      console.error('A tool call of the code of a js_eval run failed:', error)
      answer = { text: UNEXPECTED_BRIDGE_ERROR_TEXT, isError: true }
    }
    // The entry of a call that the end of the run cut stays as it started.
    // An error after the end is such a call too: the end stops the call
    // that runs, and the error of a stopped call is no answer of its tool.
    if (answer === null || (answer.isError && this.ended)) return
    if (record) {
      record.status = answer.isError ? 'error' : 'success'
      record.result = answer.text
    }
    if (this.ended) return
    try {
      await write(jsEvalAnswerLine(line.id, answer))
      this.answers++
    } catch (error) {
      // No failure of Dez when the program is gone: code that does not
      // wait for its call (no `await`) ends before the answer. The result
      // of the run tells the model of such a call (`unanswered`).
      if (!this.ended) console.error('Failed to write the answer of a tool call to a js_eval run:', error)
    }
  }

  // The answer to the call line `number` of the run: the result of its
  // tool, or the error of a line that Dez refuses (`bridgedToolCall`).
  // Null for a line whose call did not run, as the run ended before it.
  // `record`, the entry of the line, gets the tool and the arguments of
  // the call, also when the call does not run.
  private async run(line: JsEvalCallLine, number: number, record: BridgedCall | null): Promise<{ text: string, isError: boolean } | null> {
    const check = bridgedToolCall(line, number, this.workFolders)
    if (check.ok && record) {
      record.name = check.call.name
      record.arguments = check.call.arguments
    }
    if (this.ended) return null
    if (!check.ok) return { text: check.error, isError: true }
    const result = await sbp('dez.controller/tools/run', check.call, this.stop.signal, this.callContext(check.call.name)) as ToolRunResult
    if (result.isError) return { text: result.content, isError: true }
    // Also after the end of the run: the job runs, so the model must know
    // of it.
    const jobId = startedJobId(result.content)
    if (jobId !== null) this.startedJobs.add(jobId)
    if (this.ended) void discardShownPictures(result.pictures ?? [])
    else this.pictures.push(...result.pictures ?? [])
    return { text: result.content, isError: false }
  }

  // The context of a bridged call of the tool `tool`: the one of the
  // `js_eval` call, with four differences.
  // - An asset has the name of the tool that made it, not `js_eval` (a
  //   write that names its own tool keeps it: `jobs_wait` writes what the
  //   job of another tool made), and the bridge keeps its id for the
  //   result of the run. It keeps the name of an app that a call showed
  //   in the same way.
  // - After the end of the run, a call writes no asset, shows no app, and
  //   has no picture budget: the result of the run, which must name each
  //   asset and each app and take each picture, is written by then.
  // - The picture budget is less the pictures of the earlier calls of the
  //   run. The budget of the `js_eval` call counts only the pictures of
  //   the calls of the round that ended, and this one has not.
  // - The call is bridged: its result goes to the code, not to the model.
  private callContext(tool: string): ToolRunContext {
    const { context } = this
    const written = (kind: JobAssetKind, write: () => string | null): string | null => {
      const id = this.ended ? null : write()
      if (id !== null) this.assets.push({ kind, id })
      return id
    }
    return {
      tabId: context.tabId,
      model: context.model,
      jobs: context.jobs,
      writeImage: (path, options) => written('image', () => context.writeImage(path, { tool, ...options })),
      writeClip: (clip, options) => written(clip.kind, () => context.writeClip(clip, { tool, ...options })),
      showApp: (name) => {
        const shown = !this.ended && context.showApp(name)
        if (shown) this.shownApps.push(name)
        return shown
      },
      pictureBudget: async () => {
        if (this.ended) return NO_CALL_PICTURE_BUDGET
        const budget = await context.pictureBudget()
        const rule = modelFamily(context.model.modelId).imageTokens
        return {
          left: pictureBudgetLeft(budget.left, totalCost(this.pictures.map((picture) => shownPictureCost(rule, picture)))),
          roundPictures: Math.max(0, budget.roundPictures - this.pictures.length),
        }
      },
      roundResults: context.roundResults,
      isBridged: true,
    }
  }
}
