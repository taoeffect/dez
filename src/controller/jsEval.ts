import sbp from '@sbp/sbp'
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
import { programNotStartedText } from '../model/tools/programRuns'
import { ToolError } from '../model/tools/types'
import { inWorkFolder, runProgram } from './programRuns'

// The run of a `js_eval` call (model/tools/jsEval.ts): the code of a model
// in Deno, the program that Dez ships. This module registers no selector.
//
// The run has its own new work folder, with two files that Dez writes:
// its own module, which Deno runs, and the code of the call. The page
// gives Rust only the name of the module: Rust writes the Deno command
// line, with no permission for the code (src-tauri/src/bundled_tools.rs).

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

/** Runs the code of `call` to its end, and gives the result text: the
 *  value that the code returned, then its console output. Throws a
 *  `ToolError` with the error result of any other end (`jsEvalResult`) and
 *  of a run that did not start, and the stop of `signal`, which also stops
 *  the code. */
export function runJsEval(call: JsEvalCall, signal: AbortSignal): Promise<string> {
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
    const run = { args: [JS_EVAL_RUNNER_FILE], folder, inputs: [], timeoutMs: call.timeoutMs, maxOutputBytes: JS_EVAL_OUTPUT_BYTES, ...(timeZone ? { timeZone } : {}) }
    const end = await runProgram('deno', JS_EVAL_TOOL.name, run, signal, ({ stream, text }) => {
      output.add(stream, text)
    })
    const { text, isError } = jsEvalResult(call, end, output, folders)
    if (isError) throw new ToolError(text)
    return text
  })
}
