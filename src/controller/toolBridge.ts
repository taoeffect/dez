import sbp from '@sbp/sbp'
import { clipModelMark, imageModelMark } from '../model/chat/assetModels'
import { cappedBridgedCalls, type BridgedCall, type BridgedCalls } from '../model/chat/bridgedCalls'
import { sectionPlainText, textNode } from '../model/chat/content'
import { IMAGE_TOOL_KEY, imageMarkdown } from '../model/chat/images'
import { newMediaIds } from '../model/chat/mediaIds'
import { MEDIA_JOB_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, mediaTagText } from '../model/chat/mediaTags'
import type { ModelRef, Section } from '../model/chat/types'
import { NO_CALL_PICTURE_BUDGET } from '../model/streams/pictureBudget'
import { isOpenJob } from '../model/tools/jobs'
import { jsEvalAnswerLine, type JsEvalCallLine, type RunFolderForms } from '../model/tools/jsEval'
import { assetHandle, bridgedToolCall, shownSelector, UNEXPECTED_BRIDGE_ERROR_TEXT, withHandles, type BridgeRules } from '../model/tools/toolBridge'
import type { ToolRunResult } from '../model/tools/types'
import type { JobOptions, MadeAsset, ToolJobs } from './jobs'
import type { ProgramInputWriter } from './programRuns'
import { discardShownPictures } from './shownPictures'
import type { ToolRunContext } from './tools'

// The page side of the tool bridge (model/tools/toolBridge.ts): it runs the
// Dez tools that the code of a script run calls with `dez.sbp` (the code
// of a `js_eval` call, or of a script app), and writes the answer of each
// call to the input of the program. This module registers no selector.
//
// The run is a job, which can end while the model writes text, so its
// calls write nothing into the reply: the assets that they make are assets
// of the job, and the code knows each by a handle (`&1`), which the result
// of the job maps to its id. The jobs that they start are jobs of the job
// (`TabJobs.scoped`). The block of a `js_eval` call keeps a list of the
// calls of its code for the user (`BridgedCalls`).

/** The answer to one call line: the result of its tool, or the error of a
 *  line that Dez refuses. */
interface CallAnswer {
  text: string
  isError: boolean
}

/** What the tool calls of the code of a script run left, at the end of the
 *  run. */
export interface ScriptRunBridgeEnd {
  /** The images and the clips that the calls made, in the order of their
   *  handles, each with its handle and its marks (`MadeAsset`). The job
   *  keeps them, or its work deletes them (`discardMadeAssets`). */
  made: HandledAsset[]
  /** The jobs that the calls started and that are still open: no call of
   *  the code took their results. Each with its number
   *  (`JobCall.number`). From the end of the run, they are jobs of the
   *  model (`TabJobs.scoped`). */
  jobs: { id: string, number: number }[]
  /** How many calls had no answer when the run ended. */
  unanswered: number
  /** The calls of the code, for the block of a `js_eval` call
   *  (`ToolBlockData.bridged`). */
  calls: BridgedCalls
}

/** A made asset with its handle. */
export type HandledAsset = MadeAsset & { handle: string }

// The id of the section with the assets that the calls of a run made, in
// the sections of a call (`ToolRunContext.sections`). No section of a tab
// has it: theirs come from `crypto.randomUUID()`.
const MADE_ASSETS_SECTION_ID = 'dez-script-run-assets'

// The text of the made asset `asset` with the id `id`, as a reply holds the
// asset of a tool (`toolAssetWriters`, stream.ts), so that a tool finds it
// in the sections of a call by its id.
function madeAssetMarkup(asset: MadeAsset, id: string): string {
  const tool = asset.tool ?? ''
  if (asset.kind === 'image') return imageMarkdown(asset.path, [{ key: 'id', value: id }, { key: IMAGE_TOOL_KEY, value: tool }, ...imageModelMark(asset.model)])
  return mediaTagText({
    ...asset.clip,
    id,
    other: [
      { name: MEDIA_TOOL_ATTRIBUTE, value: tool },
      ...clipModelMark(asset.model),
      ...(asset.jobId === undefined ? [] : [{ name: MEDIA_JOB_ATTRIBUTE, value: asset.jobId }]),
    ],
  })
}

/** The bridged tool calls of one script run (the code of a `js_eval` call,
 *  or of a script app), the work of its job: it runs the calls of the
 *  lines of the run one at a time, and writes the answer of each to the
 *  input of the program. `context` is the context of the call that
 *  started the job, `jobs` the jobs of the job (`JobWork`), `folders` the
 *  paths of the folders of the run on this computer (`textForModel`),
 *  `keepAsset` the one of the job (`JobWork`), `callSignal` the signal of
 *  the job, and `rules` the rules of the kind of run (`JS_EVAL_BRIDGE`,
 *  `APP_RUN_BRIDGE`), whose `runName` names the run in the log.
 *
 *  Each asset that a call makes gets a handle (`&1`, `&2`, …) and an id
 *  that stands for it while the run goes on: the next id of the
 *  conversation, after the ids of the tab and of the earlier assets of the
 *  run. A later call finds the asset by that id in its sections, and its
 *  arguments name it by the handle (`bridgedToolCall`), and each result
 *  text names it by the handle (`withHandles`). The asset gets its real id
 *  only when a reader of the result of the job writes it into a reply
 *  (`writeJobAssets`, `runJsEval`); the reply can have given the id that
 *  stood for it to another asset by then. */
export class ScriptRunBridge {
  // Aborts the call that runs: at a stop of the job, and at the end of the
  // run. A call that a stop cut must start no job (`startJob`, tools.ts),
  // and a call that waits (`jobs_wait`) must not outlive the code that
  // made it.
  private readonly stop = new AbortController()
  private readonly unlinkCallSignal: () => void
  // The end of the last call that the bridge took. The calls run one at a
  // time, in the order of their lines: a call takes the next handle, the
  // next id that stands for one, and the next job number, and code that
  // makes two calls at one time (`Promise.all`) must get the same handles,
  // ids, and job numbers in each run. A plain promise chain, not the event
  // queue (`okTurtles.eventQueue`): that one keeps an entry for each queue
  // name, and each run would need its own name.
  private tail: Promise<void> = Promise.resolve()
  private ended = false
  // How many call lines the bridge took.
  private callLines = 0
  private answers = 0
  private readonly made: HandledAsset[] = []
  // The ids that stand for the handles, in the order of the handles.
  private readonly handleIds: string[] = []
  // The handle of each id of `handleIds`.
  private readonly handleById = new Map<string, string>()
  // The text of each made asset, with its id (`madeAssetMarkup`).
  private readonly madeTexts: string[] = []
  // The jobs that a call sees (`ToolRunContext.jobs`).
  private readonly callJobs: ToolJobs
  // One entry for each call line up to the limit of a run, in the order of
  // the lines. An entry starts as a call that the end of the run cut, and
  // its call fills it.
  private readonly records: BridgedCall[] = []

  constructor(
    private readonly context: ToolRunContext,
    private readonly jobs: ToolJobs,
    private readonly folders: RunFolderForms,
    private readonly keepAsset: (asset: MadeAsset) => void,
    callSignal: AbortSignal,
    private readonly rules: BridgeRules,
  ) {
    const stop = () => this.stop.abort(callSignal.reason)
    if (callSignal.aborted) stop()
    else callSignal.addEventListener('abort', stop, { once: true })
    this.unlinkCallSignal = () => callSignal.removeEventListener('abort', stop)
    const handles = this.handleById
    // The jobs of the job, with one difference: a job keeps no id that
    // stands for a handle. Its label names the handle, and its inputs (for
    // a compaction, `JobInfo.inputs`) leave the asset out, as no text of
    // the conversation holds it yet.
    const callOptions = (options: JobOptions): JobOptions => ({
      ...options,
      ...(options.label !== undefined && { label: withHandles(options.label, handles) }),
      inputs: (options.inputs ?? []).filter((id) => !handles.has(id)),
    })
    this.callJobs = {
      start: (tool, work, options) => jobs.start(tool, work, callOptions(options)),
      startWithWait: (tool, work, options, waitMs) => jobs.startWithWait(tool, work, callOptions(options), waitMs),
      get running() {
        return jobs.running
      },
      get ready() {
        return jobs.ready
      },
      wait: (signal, options) => jobs.wait(signal, options),
      list: () => jobs.list(),
      cancel: (ids) => jobs.cancel(ids),
    }
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
   *  do not run. From here on a call writes no asset, and no answer goes
   *  to the program, which is gone. */
  async end(): Promise<ScriptRunBridgeEnd> {
    this.ended = true
    this.unlinkCallSignal()
    this.stop.abort(new Error('The run of the code ended.'))
    await this.tail
    return {
      made: this.made,
      // Only the open ones: for a job whose result a later call of the
      // code took (`jobs_wait`), or that one cancelled, the model has
      // nothing to do.
      jobs: this.jobs.list().filter(isOpenJob).map((job) => ({ id: job.id, number: job.call.number })),
      // Dez stopped the call that ran, and ran none of the calls after it.
      unanswered: this.callLines - this.answers,
      calls: cappedBridgedCalls(this.records, this.callLines - this.records.length),
    }
  }

  // Runs the call of the call line `number` of the run, and writes its
  // answer. It never rejects: a rejection would end the chain of the calls
  // (`tail`), and the code would wait for each later answer to its time
  // limit.
  private async answer(line: JsEvalCallLine, number: number, write: ProgramInputWriter): Promise<void> {
    let answer: CallAnswer | null
    try {
      answer = await this.run(line, number)
    } catch (error) {
      // A forged line can hold a value that the checks cannot walk (some
      // thousand arrays in each other).
      console.error(`A tool call of the code of ${this.rules.runName} failed:`, error)
      answer = { text: UNEXPECTED_BRIDGE_ERROR_TEXT, isError: true }
    }
    // An error after the end is a call that the end cut too: the end stops
    // the call that runs, and the error of a stopped call is no answer of
    // its tool.
    if (answer === null || (answer.isError && this.ended)) return
    this.answered(number, answer)
    if (this.ended) return
    try {
      await write(jsEvalAnswerLine(line.id, answer))
      this.answers++
    } catch (error) {
      // No failure of Dez when the program is gone: code that does not
      // wait for its call (no `await`) ends before the answer. The result
      // of the run tells the model of such a call (`unanswered`).
      if (!this.ended) console.error(`Failed to write the answer of a tool call to ${this.rules.runName}:`, error)
    }
  }

  // The answer to the call line `number`: the result of its tool, or the
  // error of a line that Dez refuses (`bridgedToolCall`), with the handles
  // in place of the ids that stand for them. Null for a line whose call did
  // not run, as the run ended before it. The entry of the line gets the
  // tool and the arguments of the call, also when the call does not run.
  private async run(line: JsEvalCallLine, number: number): Promise<CallAnswer | null> {
    // A line after the limit of a run has no entry: code can write lines
    // without end, and the list counts them (`BridgedCalls.more`).
    const record: BridgedCall | null = number > this.rules.maxCalls
      ? null
      : { name: shownSelector(line.selector, this.folders), arguments: {}, status: 'cut', result: '' }
    if (record) this.records.push(record)
    const check = bridgedToolCall(line, number, this.folders, this.rules, this.handleIds)
    if (check.ok && record) {
      record.name = check.call.name
      record.arguments = check.call.arguments
    }
    if (this.ended) return null
    if (!check.ok) return { text: check.error, isError: true }
    const result = await sbp('dez.controller/tools/run', check.call, this.stop.signal, this.callContext(check.call.name)) as ToolRunResult
    // A call has no picture budget, so no tool shows a picture; a copy that
    // comes anyway goes.
    if (result.pictures) void discardShownPictures(result.pictures)
    return { text: withHandles(result.content, this.handleById), isError: result.isError }
  }

  // The entry of the call line `number` keeps the answer of its call, as
  // the code got it, before the answer goes to the program; a call that
  // the end of the run cut keeps none. The entries are in the order of the
  // lines, from line 1.
  private answered(number: number, answer: CallAnswer): void {
    const record = this.records[number - 1]
    if (!record) return
    record.status = answer.isError ? 'error' : 'success'
    record.result = answer.text
  }

  // Keeps the asset `asset` that a call of the tool `tool` made (or of the
  // tool `options.tool`: `jobs_wait` writes what the job of another tool
  // made) as an asset of the job, with its next handle, and gives the id
  // that stands for the handle. `madeBy` and `hidden` of `options` are the
  // job that made the asset for its call, and the job whose call made it
  // as a part of its work: the asset keeps them for the writer of the
  // result of the job. Null after the end of the run: the result of the
  // job is written by then, so the runner of the call deletes the file.
  private keep(asset: MadeAsset, tool: string, options?: { tool?: string, model?: ModelRef, madeBy?: string, hidden?: string }): string | null {
    if (this.ended) return null
    const handle = assetHandle(this.made.length + 1)
    const marked: HandledAsset = {
      ...asset,
      tool: options?.tool ?? tool,
      ...(options?.model && { model: options.model }),
      ...(options?.madeBy !== undefined && { madeBy: options.madeBy }),
      ...(options?.hidden !== undefined && { hidden: options.hidden }),
      handle,
    }
    const [id] = newMediaIds([...this.context.sections().map(sectionPlainText), ...this.madeTexts], 1)
    this.made.push(marked)
    this.handleIds.push(id)
    this.handleById.set(id, handle)
    this.madeTexts.push(madeAssetMarkup(marked, id))
    this.keepAsset(marked)
    return id
  }

  // The sections of a call: those of the tab, then one with the assets
  // that the earlier calls of the run made.
  private sections(): Section[] {
    const made: Section = { id: MADE_ASSETS_SECTION_ID, role: 'agent', content: [textNode(this.madeTexts.join('\n\n'))] }
    return [...this.context.sections(), made]
  }

  // The context of a bridged call of the tool `tool`: the tab, the
  // conversation, and the model of the call that started the job, with
  // the sections of the run (`sections`), the jobs of the job, and the
  // writers of the job (`keep`). It shows no app and no picture: the job
  // has no reply to show them in, and the result of a job has no picture.
  private callContext(tool: string): ToolRunContext {
    const { context } = this
    return {
      tabId: context.tabId,
      conversationId: context.conversationId,
      model: context.model,
      sections: () => this.sections(),
      jobs: this.callJobs,
      writeImage: (path, options) => this.keep({ kind: 'image', path }, tool, options),
      writeClip: (clip, options) => this.keep({ kind: 'clip', clip, ...(options?.jobId !== undefined && { jobId: options.jobId }) }, tool, options),
      showApp: () => false,
      pictureBudget: async () => NO_CALL_PICTURE_BUDGET,
      money: context.money,
      checkMoney: context.checkMoney,
    }
  }
}
