import sbp from '@sbp/sbp'
import { hasBridgedCalls } from '../model/chat/bridgedCalls'
import {
  JS_EVAL_CODE_FILE,
  JS_EVAL_OUTPUT_BYTES,
  JS_EVAL_RUNNER,
  JS_EVAL_RUNNER_FILE,
  JS_EVAL_TOOL,
  JsEvalOutput,
  jsEvalCodeFile,
  jsEvalResult,
  type JsEvalCall,
} from '../model/tools/jsEval'
import { programNotStartedText, type ProgramEnd } from '../model/tools/programRuns'
import { ToolError, type ToolRunResult } from '../model/tools/types'
import { inWorkFolder, runProgram } from './programRuns'
import { discardShownPictures } from './shownPictures'
import { ToolBridge } from './toolBridge'
import type { ToolRunContext } from './tools'

// The run of a `js_eval` call (model/tools/jsEval.ts): the code of a model
// in Deno, the program that Dez ships. This module registers no selector.
//
// The run has its own new work folder, with two files that Dez writes:
// its own module, which Deno runs, and the code of the call. The page
// gives Rust only the name of the module: Rust writes the Deno command
// line, with no permission for the code (src-tauri/src/bundled_tools.rs).
//
// The code calls the other Dez tools over the input and the output of the
// program (toolBridge.ts).

// The paths of the work folder `folder` (a path in the cache root) on this
// computer, as a text of the run can name them: the real path, which Deno
// gives its code, and the path that Dez made. The folder must be there.
//
// Throws a `ToolError` when Dez cannot get the real path: without it, a
// text of the run could show the model a path of the user's computer.
async function workFolderPaths(folder: string): Promise<string[]> {
  try {
    const joined = `${await sbp('dez.native/getAppDir', 'cache') as string}/${folder}`
    return [...new Set([await sbp('dez.native/canonicalPath', joined) as string, joined])]
  } catch (error) {
    console.error('Failed to get the real path of the work folder of a Deno run:', error)
    throw new ToolError(programNotStartedText('deno', JS_EVAL_TOOL.name), '', { cause: error })
  }
}

/** Runs the code of `call` to its end, and gives the result: the value
 *  that the code returned, what its tool calls left, then its console
 *  output, and the pictures that its tool calls showed. `context` is the
 *  context of the call, which the tool calls of the code run with
 *  (`ToolBridge`).
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
    const files = [
      { name: JS_EVAL_RUNNER_FILE, text: JS_EVAL_RUNNER },
      { name: JS_EVAL_CODE_FILE, text: jsEvalCodeFile(call.code) },
    ]
    for (const { name, text } of files) {
      signal.throwIfAborted()
      try {
        await sbp('dez.native/saveAppFile', `${folder}/${name}`, text, 'cache')
      } catch (error) {
        console.error(`Failed to write the file ${name} of a Deno run:`, error)
        throw new ToolError(programNotStartedText('deno', JS_EVAL_TOOL.name), '', { cause: error })
      }
    }
    const folders = await workFolderPaths(folder)
    // The code gets the time zone of the user, so that its local time is
    // the user's: Rust gives a program no other fact of the computer.
    const { timeZone } = Intl.DateTimeFormat().resolvedOptions()
    const output = new JsEvalOutput()
    const bridge = new ToolBridge(context, folders, signal)
    // `stdin`: the answers of the tool calls go to the input of the program.
    const run = { args: [JS_EVAL_RUNNER_FILE], folder, inputs: [], timeoutMs: call.timeoutMs, maxOutputBytes: JS_EVAL_OUTPUT_BYTES, stdin: true, ...(timeZone ? { timeZone } : {}) }
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
