import sbp from '@sbp/sbp'
import { IMAGE_FOLDERS } from '../model/chat/images'
import { MEDIA_FOLDERS } from '../model/chat/mediaTags'
import { newStoredFilePath } from '../model/chat/storedFilePaths'
import type { Section } from '../model/chat/types'
import {
  APP_OUTPUT_FOLDER,
  APP_OUTPUT_LISTED_ENTRIES,
  APP_RUNS_STATE,
  appOutputNotStoredText,
  appRunDescription,
  appRunOutcome,
  appRunResult,
  checkedOutput,
  checkInvokeTarget,
  invokeCall,
  listedOutputs,
  NO_APP_OUTPUTS,
  type AppInput,
  type AppOutputs,
  type InvokeCall,
} from '../model/tools/appInvoke'
import { APPS_ROOT, APPS_TOOL, isReadableManifest } from '../model/tools/appsTool'
import { jobTimedOutText } from '../model/tools/jobs'
import { endedRun, JsEvalOutput, textForModel } from '../model/tools/jsEval'
import { PROGRAM_READS_INPUTS, programNotStartedText, type KeptFile } from '../model/tools/programRuns'
import { ToolError, type SubcommandArguments } from '../model/tools/types'
import { factsOf, readBytes } from './appsTool'
import { discardMadeAssets, type JobOutcome, type MadeAsset } from './jobs'
import { moduleRun, writeRunFiles } from './jsEval'
import type { BundledToolInput, FileTree } from './nativeTypes'
import { clipInputFile, folderPathForms, imageFileInput, inWorkFolder, runProgram } from './programRuns'

// The run of an `apps invoke` call for a script app
// (model/tools/appInvoke.ts): the code of an app in Deno, the program that
// Dez ships, as a job of the reply. This module registers no selector: the
// `invoke` runner (tools.ts) checks the call (`checkedInvokeCall`) and
// starts the work (`runAppJob`).
//
// A run has its own new work folder, as a `js_eval` run has (jsEval.ts),
// with the same module of Dez and its own description of the run. The work
// folder also holds a copy of each input of the call and the output
// folder. Rust lets the code open that folder and the folder of its app,
// and nothing else (src-tauri/src/bundled_tools.rs). The code gets no
// input of the program and calls no Dez tool.
//
// Dez trusts nothing that the code leaves. It reads each file of the
// output folder, checks the type by the bytes that it read, and writes
// those same bytes into the Dez folder: the file that Dez stores is the
// one that it checked, whatever the code left at its place (a move would
// take what is there). Every text of a run goes to the model through
// `textForModel`, with the folders of the run.

/** The run that an `apps invoke` call asks for, from its checked arguments
 *  `args` and the sections of its tab, after the checks of the files of
 *  the app. Throws a `ToolError`, whose text tells the model how to fix
 *  the call, for a bad call (`invokeCall`) and for an app that cannot run
 *  (`checkInvokeTarget`).
 *
 *  Each fact is one exact read of its path, and not from a listing of the
 *  app: the code of an app can make more files than a listing holds. */
export async function checkedInvokeCall(args: SubcommandArguments, sections: readonly Section[]): Promise<InvokeCall> {
  const call = invokeCall(args, sections)
  const [app, manifest, main] = await Promise.all([call.app, call.manifest, call.main].map(factsOf))
  // The native side reads a file of any size, so the size check is first.
  const manifestBytes = isReadableManifest(manifest) ? await readBytes(call.manifest) : null
  checkInvokeTarget(call, { app, manifest, manifestBytes, main })
  return call
}

// Gets the inputs of a call ready. It gives the files that the run must
// copy into its work folder; a downloaded clip is in the folder after
// this. An image goes as its own file, of any type: the code reads what it
// can. Throws a `ToolError` for an input that Dez cannot read, and the
// stop of `signal`.
async function inputCopies(inputs: readonly AppInput[], folder: string, signal: AbortSignal): Promise<BundledToolInput[]> {
  const copies: BundledToolInput[] = []
  for (const input of inputs) {
    signal.throwIfAborted()
    const copy = input.kind === 'image' ? await imageFileInput(input) : await clipInputFile(input, folder, signal, APPS_TOOL.name)
    if (copy) copies.push(copy)
  }
  signal.throwIfAborted()
  return copies
}

// The bytes of the file `name` of the output folder of a run; null for a
// file that Dez cannot read (the native side reads only a regular file).
async function outputBytes(folder: string, name: string): Promise<Uint8Array | null> {
  try {
    return await sbp('dez.native/loadAppFileBytes', `${folder}/${APP_OUTPUT_FOLDER}/${name}`, 'cache') as Uint8Array
  } catch (error) {
    console.error(`Failed to read the output file ${name} of a run of an app:`, error)
    return null
  }
}

// What Dez keeps of the output folder of a run that ended with no error:
// the files that pass their checks, each stored in a generated folder of
// the Dez folder under a new name, as the assets of the job in the order
// of `outputs.kept`. One file is read, checked, and written before the
// next, so that the webview holds the bytes of one file at a time.
//
// `keepAsset` gets each file when it is stored: the files of a run can be
// large, so the last write can come long after the first, and until the
// result of the job names a file only that list keeps it from Delete
// Unused Files (`JobWork`).
//
// A list or a write that fails keeps no file: the stored ones are deleted,
// and a `ToolError` tells the model. A stop of `signal` deletes them too,
// and rejects with the stop.
async function keptOutputs(folder: string, signal: AbortSignal, keepAsset: (asset: MadeAsset) => void): Promise<{ outputs: AppOutputs, assets: MadeAsset[] }> {
  const assets: MadeAsset[] = []
  try {
    const tree = await sbp('dez.native/listFileTree', `${folder}/${APP_OUTPUT_FOLDER}`, APP_OUTPUT_LISTED_ENTRIES, 'cache') as FileTree
    const listed = listedOutputs(tree)
    if (listed.problem !== null) return { outputs: { kept: [], notKept: [], problem: listed.problem }, assets }

    const appDir = await sbp('dez.native/getAppDir') as string
    const kept: KeptFile[] = []
    const notKept = [...listed.notKept]
    for (const name of listed.files) {
      signal.throwIfAborted()
      const bytes = await outputBytes(folder, name)
      const checked = checkedOutput(name, bytes)
      if ('notKept' in checked) {
        notKept.push(checked.notKept)
        continue
      }
      const { kind, type, extension } = checked.kept
      const target = `${kind === 'image' ? IMAGE_FOLDERS.generated : MEDIA_FOLDERS.generated[kind]}/${crypto.randomUUID()}.${extension}`
      const path = newStoredFilePath(appDir, target, kind)
      // `checkedOutput` keeps no file whose read failed.
      await sbp('dez.native/saveAppFile', target, bytes as Uint8Array)
      const asset: MadeAsset = kind === 'image' ? { kind, path } : { kind: 'clip', clip: { kind, type, src: path, url: null, expires: null } }
      assets.push(asset)
      keepAsset(asset)
      kept.push(checked.kept)
    }
    return { outputs: { kept, notKept, problem: null }, assets }
  } catch (error) {
    await discardMadeAssets(assets)
    if (signal.aborted) throw error
    console.error('Failed to store the output files of a run of an app:', error)
    throw new ToolError(appOutputNotStoredText(), '', { cause: error })
  }
}

/** The work of the job of an `apps invoke` call (`JobWork`): one run of
 *  the code of the app of `call`, in a new work folder that holds copies
 *  of the call's inputs and the output folder. The files of the output
 *  folder that Dez keeps are the assets of the job; the text tells what
 *  the code returned or threw, what Dez did with the files, and the
 *  console output. A run that failed keeps no file.
 *
 *  A stop of `signal` (Dez stopped the job, or its time limit passed)
 *  stops the program and rejects, which `TabJobs` drops. The work folder
 *  goes at every end; the files that the code wrote into the folder of its
 *  app stay. */
export function runAppJob(call: InvokeCall, signal: AbortSignal, report: (state: string) => void, keepAsset: (asset: MadeAsset) => void): Promise<JobOutcome> {
  return inWorkFolder(async (folder) => {
    report(PROGRAM_READS_INPUTS)
    // The first write of the run: it makes the work folder too, for the
    // user only, so the folder is there when Dez asks for its real path.
    try {
      await sbp('dez.native/createFolder', `${folder}/${APP_OUTPUT_FOLDER}`, 'cache')
    } catch (error) {
      console.error('Failed to make the output folder of a run of an app:', error)
      throw new ToolError(programNotStartedText('deno', APPS_TOOL.name), '', { cause: error })
    }
    const work = await folderPathForms(folder, 'cache', APPS_TOOL.name)
    const apps = await folderPathForms(APPS_ROOT.file, 'app', APPS_TOOL.name)
    const forModel = (text: string): string => textForModel(text, work.forms, apps.forms)

    const [appName] = call.app.names
    const inputs = await inputCopies(call.inputs, folder, signal)
    // The description holds the paths that Dez joined, not the real ones:
    // Deno checks a path of the code against the folders of its flags as
    // text, and Rust writes the flags from the same joined paths.
    const description = appRunDescription(call, { work: work.joined, app: `${apps.joined}/${appName}` })
    await writeRunFiles(folder, description, [], signal, APPS_TOOL.name)

    report(APP_RUNS_STATE)
    const output = new JsEvalOutput()
    // No `stdin`, and a `call` line of the code gets no answer: the code of
    // an app calls no Dez tool.
    const end = await runProgram('deno', APPS_TOOL.name, { ...moduleRun(folder, call.timeoutMs), inputs, appFolder: appName }, signal, ({ stream, text }) => {
      output.add(stream, text)
    })
    // The job has the same limit and its own clock (`TabJobs`), which
    // started before the input files were ready, so it ends the job first
    // in most cases; this is the text for the other case.
    if (end.kind === 'timedOut') return { text: jobTimedOutText(call.timeoutMs, APP_RUNS_STATE), isError: true, assets: [] }

    const { line, log } = endedRun(end, output)
    const outcome = appRunOutcome(end, line, log.trim() !== '')
    if (outcome.isError) return { ...appRunResult(outcome, log, forModel, NO_APP_OUTPUTS), assets: [] }
    const { outputs, assets } = await keptOutputs(folder, signal, keepAsset)
    return { ...appRunResult(outcome, log, forModel, outputs), assets }
  })
}
