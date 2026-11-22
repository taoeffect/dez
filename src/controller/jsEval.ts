import sbp from '@sbp/sbp'
import { hasBridgedCalls } from '../model/chat/bridgedCalls'
import {
  codeRunDescription,
  JS_EVAL_CODE_FILE,
  JS_EVAL_OUTPUT_BYTES,
  JS_EVAL_RUNNER,
  JS_EVAL_RUNNER_FILE,
  JS_EVAL_TOOL,
  JsEvalOutput,
  jsEvalCodeFile,
  jsEvalResult,
  RUN_DESCRIPTION_FILE,
  type JsEvalCall,
} from '../model/tools/jsEval'
import { programNotStartedText, type ProgramEnd } from '../model/tools/programRuns'
import { ToolError, type ToolRunResult } from '../model/tools/types'
import type { BundledToolRun } from './nativeTypes'
import { conversationWorkForms, folderPathForms, inWorkFolder, runProgram } from './programRuns'
import { discardShownPictures } from './shownPictures'
import { ToolBridge } from './toolBridge'
import type { ToolRunContext } from './tools'

// The run of a `js_eval` call (model/tools/jsEval.ts): the code of a model
// in Deno, the program that Dez ships. This module registers no selector.
//
// The run has its own new run folder (a work folder of the cache root,
// `inWorkFolder`), with three files that Dez writes: its own module,
// which Deno runs, the description of the run, which tells the module
// what to run, and the code of the call. The page gives Rust only the
// name of the module: Rust writes the Deno command line, with no
// permission for the code but the work folder of its conversation
// (`conversationWorkForms`; src-tauri/src/bundled_tools.rs).
//
// The code calls the other Dez tools over the input and the output of the
// program (toolBridge.ts).
//
// A run of an app (appInvoke.ts) runs the same module, with its own
// description: `writeRunFiles` and `moduleRun` serve both.

/** Writes the files of a run of Dez's module into the run folder
 *  `folder`: the module, the description of the run (the text
 *  `description`), and `more`. Throws a `ToolError` for a write that
 *  fails (the run of the tool `toolName` does not start), and the stop of
 *  `signal`. */
export async function writeRunFiles(
  folder: string,
  description: string,
  more: readonly { name: string, text: string }[],
  signal: AbortSignal,
  toolName: string,
): Promise<void> {
  const files = [{ name: JS_EVAL_RUNNER_FILE, text: JS_EVAL_RUNNER }, { name: RUN_DESCRIPTION_FILE, text: description }, ...more]
  for (const { name, text } of files) {
    signal.throwIfAborted()
    try {
      await sbp('dez.native/saveAppFile', `${folder}/${name}`, text, 'cache')
    } catch (error) {
      console.error(`Failed to write the file ${name} of a Deno run:`, error)
      throw new ToolError(programNotStartedText('deno', toolName), '', { cause: error })
    }
  }
}

/** The run of Dez's module in the run folder `folder`, with no input
 *  file. The code gets the time zone of the user, so that its local time
 *  is the user's: Rust gives a program no other fact of the computer. */
export function moduleRun(folder: string, timeoutMs: number): Omit<BundledToolRun, 'tool'> {
  const { timeZone } = Intl.DateTimeFormat().resolvedOptions()
  return { args: [JS_EVAL_RUNNER_FILE], folder, inputs: [], timeoutMs, maxOutputBytes: JS_EVAL_OUTPUT_BYTES, ...(timeZone ? { timeZone } : {}) }
}

/** Runs the code of `call` to its end, and gives the result: the value
 *  that the code returned, what its tool calls left, then its console
 *  output, and the pictures that its tool calls showed. `context` is the
 *  context of the call, which the tool calls of the code run with
 *  (`ToolBridge`). The code can read and change the work folder of the
 *  conversation of the call (`dez.workFolder`).
 *
 *  Any other end of the code gives its error result (`jsEvalResult`), and
 *  throws no `ToolError`: an error result also has the list of the tool
 *  calls of the code (`ToolRunResult.bridged`), which a `ToolError` cannot
 *  carry. It shows no picture: the call deletes the copies.
 *
 *  Throws a `ToolError` for a run that did not start, and the stop of
 *  `signal`, which also stops the code and its tool call. Such a call has
 *  no list, and deletes the copies too. */
export function runJsEval(call: JsEvalCall, signal: AbortSignal, context: ToolRunContext): Promise<ToolRunResult> {
  return inWorkFolder(async (folder) => {
    const work = await conversationWorkForms(context.conversationId, JS_EVAL_TOOL.name)
    await writeRunFiles(folder, codeRunDescription(work.joined), [{ name: JS_EVAL_CODE_FILE, text: jsEvalCodeFile(call.code) }], signal, JS_EVAL_TOOL.name)
    const folders = { run: (await folderPathForms(folder, 'cache', JS_EVAL_TOOL.name)).forms, work: work.forms }
    const output = new JsEvalOutput()
    const bridge = new ToolBridge(context, folders, signal)
    // `stdin`: the answers of the tool calls go to the input of the program.
    const run = { ...moduleRun(folder, call.timeoutMs), stdin: true, conversationFolder: context.conversationId }
    let end: ProgramEnd
    try {
      end = await runProgram('deno', JS_EVAL_TOOL.name, run, signal, ({ stream, text }, writeInput) => {
        for (const line of output.add(stream, text)) bridge.call(line, writeInput)
      })
    } catch (error) {
      await discardShownPictures((await bridge.end()).pictures)
      throw error
    }
    const { toolCalls, pictures, bridged } = await bridge.end()
    const { text, isError } = jsEvalResult(call, end, output, folders, toolCalls)
    const list = hasBridgedCalls(bridged) ? { bridged } : {}
    if (isError) {
      await discardShownPictures(pictures)
      return { content: text, isError: true, ...list }
    }
    return { content: text, isError: false, ...(pictures.length > 0 && { pictures }), ...list }
  })
}
