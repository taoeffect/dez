import { hasBridgedCalls, type BridgedCalls } from '../model/chat/bridgedCalls'
import { CODE_RUN_TEXTS, type AppRunCaller, type CodeRunCall } from '../model/tools/appInvoke'
import { jobCallLabel, jobResultText } from '../model/tools/jobs'
import { codeRunsAsJobText, codeTimedOutText, JS_EVAL_CALL_WAIT_MS, JS_EVAL_TOOL, RunClock, withRunTime } from '../model/tools/jsEval'
import { ToolError, type ToolRunResult } from '../model/tools/types'
import { runScriptJob } from './appInvoke'
import { writeMadeAssets } from './jobs'
import type { ToolRunContext } from './tools'

// The run of a `js_eval` call (model/tools/jsEval.ts): the code of a model
// in Deno, the program that Dez ships. This module registers no selector.
//
// The run is a script run, as the run of a script app is: one job of the
// reply that runs `runScriptJob` (controller/appInvoke.ts). So the code
// gets what the code of an app gets (its inputs, the output folder, the
// work folder, the fonts, skia-canvas), and its tool calls follow the
// rules of the calls of a job: their assets are assets of the job, with
// handles, and their jobs are jobs of the job.
//
// The call waits for the job a short time (`JS_EVAL_CALL_WAIT_MS`): most
// code ends within it, and the model needs the value for its next step. A
// run that ends within the wait gives its result to the call, and was
// never a job of the model. A run that goes on is from then on a job of
// the reply, as the job of an `apps invoke` call: `jobs_wait` gives its
// result, a cut of the reply hands it on, and `job_cancel` ends it.

const JS_EVAL_CALLER: AppRunCaller = { toolName: JS_EVAL_TOOL.name, texts: CODE_RUN_TEXTS }

// The result of a job of a `js_eval` run that ended with no result for its
// call: a stop of the tab ended it before its work.
const NO_RESULT_TEXT = 'Dez stopped the run of the code before its end, so it has no result. This is not a fault of the call.'

/** Runs the code of `call` as a job of the reply, and waits for its end
 *  for at most `JS_EVAL_CALL_WAIT_MS`. A run that ends within the wait
 *  gives its result: the value that the code returned or threw, what Dez
 *  kept of the output folder, what its tool calls left, its console
 *  output, and how long it ran (`withRunTime`), then a line for each image
 *  and clip of the run, which go into the reply. `context` is the context
 *  of the call, which the tool calls of the code run with
 *  (`ScriptRunBridge`).
 *
 *  A result of a run whose program ended also has the list of the tool
 *  calls of the code (`ToolRunResult.bridged`), also an error result. A
 *  run that its time limit stopped gives `codeTimedOutText` for the last
 *  state of its job, with its run time, also as the result of its job. A
 *  run that goes on after the wait gives `codeRunsAsJobText`, and the
 *  result of its job has no list of the tool calls. Throws the
 *  `ToolError` of a job that cannot start (`JOB_LIMIT_TEXT`), and the
 *  stop of `signal` during the wait, which also cancels the job: its code
 *  and its tool call stop. */
export async function runJsEval(call: CodeRunCall, signal: AbortSignal, context: ToolRunContext): Promise<ToolRunResult> {
  let calls: BridgedCalls | null = null
  const clock = new RunClock()
  const waited = await context.jobs.startWithWait(
    JS_EVAL_TOOL.name,
    (jobSignal, report, _reportCost, keepAsset, jobs) => runScriptJob(
      { kind: 'code', call, clock },
      JS_EVAL_CALLER,
      context.conversationId,
      jobSignal,
      report,
      keepAsset,
      { context, jobs, onCalls: (bridged) => { calls = bridged } },
    ),
    {
      timeoutMs: call.timeoutMs,
      label: jobCallLabel(call.code),
      inputs: call.inputs.map(({ id }) => id),
      signal,
      timedOutText: (timeoutMs, state) => withRunTime(codeTimedOutText(timeoutMs, state), clock),
    },
    JS_EVAL_CALL_WAIT_MS,
  )
  if ('started' in waited) return { content: codeRunsAsJobText(waited.started.id, waited.started.number), isError: false }
  const { ended } = waited
  if (ended === null) throw new ToolError(NO_RESULT_TEXT)
  if (ended.status === 'timed out') return { content: ended.text, isError: true }

  // The assets keep the marks of the tool calls that made them: the code
  // of the run made none itself, and no block names the job of the run.
  const written = await writeMadeAssets(ended.assets, context, (asset) => ({
    tool: asset.tool ?? JS_EVAL_TOOL.name,
    ...(asset.model && { model: asset.model }),
    ...(asset.madeBy !== undefined && { madeBy: asset.madeBy }),
    ...(asset.hidden !== undefined && { hidden: asset.hidden }),
  }))
  // `onCalls` set it in the work of the job, which the type check of this
  // function does not see.
  const bridged = calls as BridgedCalls | null
  return {
    content: jobResultText(ended.text, written),
    isError: ended.status === 'failed' || written.some(({ id }) => id === null),
    ...(bridged && hasBridgedCalls(bridged) && { bridged }),
  }
}
