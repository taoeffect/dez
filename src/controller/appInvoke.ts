import sbp from '@sbp/sbp'
import type { Section } from '../model/chat/types'
import { aliasRunTexts, type AppAlias } from '../model/tools/appAliases'
import { APP_READ_ASSET, APP_STOPPED_TEXT, AppCallError, notAnInputText, type AppCall, type AppFrameEnd, type AppFrameRun, type SavedAssetAnswer } from '../model/tools/appBridge'
import {
  aliasInvokeCall,
  APP_OUTPUT_FOLDER,
  APP_OUTPUT_LISTED_ENTRIES,
  APP_PAGE_LOADS_STATE,
  APP_RUNS_STATE,
  appFrameResult,
  appOutputNotStoredText,
  appRunDescription,
  appRunOutcome,
  appRunResult,
  checkedOutput,
  checkInvokeTarget,
  frameInputs,
  listedOutputs,
  NO_APP_OUTPUTS,
  SaveCount,
  type AppInput,
  type AppOutputs,
  type AppRunCaller,
  type CheckedInvokeCall,
  type InvokeCall,
} from '../model/tools/appInvoke'
import { APPS_ROOT, BUILT_IN_APPS_FOLDER, LIBS_ROOT } from '../model/tools/appsTool'
import { APP_DECODES_STATE, asksForDecode, runDecode, type DecodedClip } from '../model/tools/inputDecode'
import { endedRun, JsEvalOutput, textForModel } from '../model/tools/jsEval'
import { PROGRAM_READS_INPUTS, programNotStartedText, type KeptFile } from '../model/tools/programRuns'
import { ToolError, type ToolArguments } from '../model/tools/types'
import { assetBlob, storeCheckedFile, storeSave, type StoredSave } from './appBridge'
import { factsOf, readableManifestBytes } from './appsTool'
import { decodeClips } from './inputDecode'
import { discardMadeAssets, type JobOutcome, type MadeAsset } from './jobs'
import { moduleRun, writeRunFiles } from './jsEval'
import type { BundledToolInput, FileTree } from './nativeTypes'
import { clipInputFile, conversationWorkForms, folderPathForms, imageInputAsIs, inWorkFolder, runProgram } from './programRuns'

// The run of an `apps invoke` call (model/tools/appInvoke.ts), as a job of
// the reply, and the run of a call of an alias subcommand of `audio` or
// `video` (appAliases.ts), which the call waits for. This module registers
// no selector: the `invoke` runner (tools.ts) checks the call
// (`checkedAppRun`) and starts the work of the kind of the app:
// `runAppJob` for a script app, the code of the app in Deno, the program
// that Dez ships; `runAppFrameJob` for a UI app, the page of the app in a
// frame that the user does not see. An alias runs a built-in script app
// with `runAliasCall`.
//
// A script app:
//
// A run has its own new run folder, as a `js_eval` run has (jsEval.ts),
// with the same module of Dez and its own description of the run. The run
// folder also holds a copy of each input of the call and the output
// folder. Rust lets the code open that folder, the folder of its app, and
// the work folder of the conversation of the call, and nothing else
// (src-tauri/src/bundled_tools.rs). The code gets no input of the program
// and calls no Dez tool.
//
// Dez trusts nothing that the code leaves. It reads each file of the
// output folder, checks the type by the bytes that it read, and writes
// those same bytes into the Dez folder: the file that Dez stores is the
// one that it checked, whatever the code left at its place (a move would
// take what is there). Every text of a run goes to the model through
// `textForModel`, with the folders of the run.
//
// A UI app: the view owns the frame (`dez.ui/runAppFrame`), and this
// module does the calls of the page (the frame bridge,
// model/tools/appBridge.ts): a read gives only an input of the call, and
// a save is a file of the job, by the checks of appBridge.ts.

/** The run that `call` asks for (`invokeCall`, `aliasInvokeCall`), after
 *  the checks of the files of the app, with the kind of the app and the
 *  decode of the run. Throws a `ToolError`, whose text tells the model how
 *  to fix the call, for an app that cannot run (`checkInvokeTarget`), and
 *  for a decode that the app cannot have (`runDecode`).
 *
 *  Each fact is one exact read of its path, and not from a listing of the
 *  app: the code of an app can make more files than a listing holds. */
export async function checkedAppRun(call: InvokeCall): Promise<CheckedInvokeCall> {
  const [app, manifest, main, index] = await Promise.all([call.app, call.manifest, call.main, call.index].map(factsOf))
  const manifestBytes = await readableManifestBytes(call.manifest, manifest)
  const kind = checkInvokeTarget(call, { app, manifest, manifestBytes, main, index })
  return { ...call, kind, decode: runDecode(call, kind, manifestBytes) }
}

// Gets the inputs of a call of the tool `toolName` ready. It gives the
// files that the run must copy into its run folder; a downloaded clip is
// in the folder after this. An image goes as its own file, of any type:
// the code reads what it can. With `decodesClips`, it gives no clip: the
// decode copies each clip into the folder (`decodeClips`). Throws a
// `ToolError` for an input that Dez cannot read, and the stop of
// `signal`.
async function inputCopies(inputs: readonly AppInput[], decodesClips: boolean, folder: string, signal: AbortSignal, toolName: string): Promise<BundledToolInput[]> {
  const copies: BundledToolInput[] = []
  for (const input of inputs) {
    signal.throwIfAborted()
    if (input.kind !== 'image' && decodesClips) continue
    const copy = input.kind === 'image' ? await imageInputAsIs(input) : await clipInputFile(input, folder, signal, toolName)
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
// Unreferenced Files (`JobWork`).
//
// A list or a write that fails keeps no file: the stored ones are deleted,
// and a `ToolError` tells the model, which called the tool `toolName`. A
// stop of `signal` deletes them too, and rejects with the stop.
async function keptOutputs(folder: string, signal: AbortSignal, keepAsset: (asset: MadeAsset) => void, toolName: string): Promise<{ outputs: AppOutputs, assets: MadeAsset[] }> {
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
      // `checkedOutput` keeps no file whose read failed.
      const { asset } = await storeCheckedFile(appDir, bytes as Uint8Array, checked.kept)
      assets.push(asset)
      keepAsset(asset)
      kept.push(checked.kept)
    }
    return { outputs: { kept, notKept, problem: null }, assets }
  } catch (error) {
    await discardMadeAssets(assets)
    if (signal.aborted) throw error
    console.error('Failed to store the output files of a run of an app:', error)
    throw new ToolError(appOutputNotStoredText(toolName), '', { cause: error })
  }
}

/** The work of one run of the code of the script app of `call`, which
 *  `caller` started (`AppRunCaller`), in a new run folder that holds
 *  copies of the call's inputs, the decoded files of its clips when the
 *  run decodes them (`call.decode`, `decodeClips`), and the output folder.
 *  The code can also read and change the work folder of the conversation
 *  `conversationId` (`dez.workFolder`). The files of the output folder
 *  that Dez keeps are the assets of the run; the text tells what the code
 *  returned or threw, what Dez did with the files, and the console output.
 *  A run that failed keeps no file. It is the work of the job of an `apps
 *  invoke` call (`JobWork`), and of a call of an alias (`runAliasCall`).
 *
 *  A stop of `signal` (Dez stopped the job or the call, or its time limit
 *  passed) stops the program and rejects, which the caller drops. The run
 *  folder goes at every end; the files that the code wrote into the
 *  folder of its app and into the work folder stay. */
export function runAppJob(
  call: CheckedInvokeCall,
  { toolName, texts }: AppRunCaller,
  conversationId: string,
  signal: AbortSignal,
  report: (state: string) => void,
  keepAsset: (asset: MadeAsset) => void,
): Promise<JobOutcome> {
  return inWorkFolder(async (folder) => {
    report(PROGRAM_READS_INPUTS)
    // The first write of the run: it makes the run folder too, for the
    // user only, so the folder is there when Dez asks for its real path.
    try {
      await sbp('dez.native/createFolder', `${folder}/${APP_OUTPUT_FOLDER}`, 'cache')
    } catch (error) {
      console.error('Failed to make the output folder of a run of an app:', error)
      throw new ToolError(programNotStartedText('deno', toolName), '', { cause: error })
    }
    const runFolder = await folderPathForms(folder, 'cache', toolName)
    // A built-in app is in the files that Dez ships, and Rust finds its
    // folder there by its name (`builtInApp`); its texts show the folder of
    // the built-in apps as /apps too.
    const builtIn = call.app.root === 'resource'
    const apps = builtIn
      ? await folderPathForms(BUILT_IN_APPS_FOLDER, 'resource', toolName)
      : await folderPathForms(APPS_ROOT.file, 'app', toolName)
    const libs = await folderPathForms(LIBS_ROOT.file, LIBS_ROOT.root, toolName)
    const work = await conversationWorkForms(conversationId, toolName)
    const forModel = (text: string): string => textForModel(text, { run: runFolder.forms, apps: apps.forms, libs: libs.forms, work: work.forms })

    const [appName] = call.app.names
    const decodesClips = asksForDecode(call.decode)
    const inputs = await inputCopies(call.inputs, decodesClips, folder, signal, toolName)
    let decoded = new Map<string, DecodedClip>()
    if (decodesClips) {
      report(APP_DECODES_STATE)
      const clips = call.inputs.filter((input) => input.kind !== 'image')
      decoded = await decodeClips(clips, call.decode, folder, { toolName, texts, timeoutMs: call.timeoutMs }, signal)
    }
    // The description holds the paths that Dez joined, not the real ones:
    // Deno checks a path of the code against the folders of its flags as
    // text, and Rust writes the flags from the same joined paths.
    const description = appRunDescription(call, { run: runFolder.joined, app: `${apps.joined}/${appName}`, work: work.joined }, decoded)
    await writeRunFiles(folder, description, [], signal, toolName)

    report(APP_RUNS_STATE)
    const output = new JsEvalOutput()
    // No `stdin`, and a `call` line of the code gets no answer: the code of
    // an app calls no Dez tool.
    const appFolder = builtIn ? { builtInApp: appName } : { appFolder: appName }
    const run = { ...moduleRun(folder, call.timeoutMs), inputs, ...appFolder, conversationFolder: conversationId }
    const end = await runProgram('deno', toolName, run, signal, ({ stream, text }) => {
      output.add(stream, text)
    })
    // The caller has the same limit and its own clock, which started
    // before the input files were ready, so it ends the run first in most
    // cases; this is the text for the other case.
    if (end.kind === 'timedOut') return { text: texts.timedOut(call.timeoutMs, APP_RUNS_STATE), isError: true, assets: [] }

    const { line, log } = endedRun(end, output)
    const outcome = appRunOutcome(end, line, log.trim() !== '')
    if (outcome.isError) return { ...appRunResult(outcome, log, forModel, NO_APP_OUTPUTS), assets: [] }
    const { outputs, assets } = await keptOutputs(folder, signal, keepAsset, toolName)
    return { ...appRunResult(outcome, log, forModel, outputs), assets }
  })
}

/** The run of a call of the alias subcommand `alias` (appAliases.ts) with
 *  its checked arguments `args`, from the tab with `sections`, in the
 *  conversation `conversationId`: one run of the built-in app of the
 *  alias (`runAppJob`), which the call waits for, for at most the time
 *  limit of the call from its start. Gives the result of the call: what
 *  the app returned or threw, or why the run failed. Throws a `ToolError`
 *  for a call that Dez refuses (`aliasInvokeCall`) or a run that did not
 *  start, and the stop of `signal` (the user stopped the reply), which
 *  stops the run. */
export async function runAliasCall(alias: AppAlias, args: ToolArguments, sections: readonly Section[], conversationId: string, signal: AbortSignal): Promise<{ content: string, isError: boolean }> {
  const call = await checkedAppRun(aliasInvokeCall(alias, args, sections))
  const caller: AppRunCaller = { toolName: alias.tool, texts: aliasRunTexts(alias) }
  signal.throwIfAborted()
  // The clock of the call, as `TabJobs` has one for each job: the time
  // limit of each program of the run holds for that program alone.
  const clock = new AbortController()
  const timer = setTimeout(() => clock.abort(new Error(`${alias.app} did not end within its time limit.`)), call.timeoutMs)
  const stop = () => clock.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  try {
    const { text, isError, assets } = await runAppJob(call, caller, conversationId, clock.signal, () => {}, () => {})
    // The built-in apps of the aliases write their results into the work
    // folder of the conversation, and no file into their output folder: a
    // file there is a fault of Dez, and no text of the reply names it.
    if (assets.length > 0) {
      console.error(`${alias.app} left files in its output folder; Dez deletes them:`, assets)
      await discardMadeAssets(assets)
    }
    return { content: text, isError }
  } catch (error) {
    if (clock.signal.aborted && !signal.aborted) return { content: caller.texts.timedOut(call.timeoutMs, APP_RUNS_STATE), isError: true }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

/** The work of the job of an `apps invoke` call for a UI app (`JobWork`):
 *  one run of the handler of the page of the app of `call`, in a new frame
 *  that the user does not see (`dez.ui/runAppFrame`). The files that the
 *  page saved are the assets of the job, in the order of the saves; the
 *  text tells what the handler returned or threw, what Dez keeps, and the
 *  console output of the page. A run that failed keeps no file.
 *
 *  The page reads only the inputs of the call. Its saves are stored one
 *  at a time, in the order of its calls, so that the count and the order
 *  of the files do not depend on which write ends first. `keepAsset` gets
 *  each file when it is stored (`JobWork`).
 *
 *  A stop of `signal` (Dez stopped the job, or its time limit passed)
 *  closes the frame and rejects, which `TabJobs` drops with the assets of
 *  the job: so this deletes the stored files itself. A save that ends
 *  after the frame closed keeps no file. */
export async function runAppFrameJob(call: CheckedInvokeCall, signal: AbortSignal, report: (state: string) => void, keepAsset: (asset: MadeAsset) => void): Promise<JobOutcome> {
  report(APP_PAGE_LOADS_STATE)
  const saves = new SaveCount()
  const stored: StoredSave[] = []
  let closed = false
  // The end of the last save of the page; it never rejects.
  let lastSave: Promise<void> = Promise.resolve()

  const save = async (blob: Blob): Promise<SavedAssetAnswer> => {
    if (closed) throw new AppCallError(APP_STOPPED_TEXT)
    const file = await storeSave(blob, saves)
    if (closed) {
      await discardMadeAssets([file.asset])
      throw new AppCallError(APP_STOPPED_TEXT)
    }
    stored.push(file)
    keepAsset(file.asset)
    // An asset of a job has no id until a reader takes the result.
    return { id: null, kind: file.type.kind, type: file.type.type }
  }

  const run: AppFrameRun = {
    name: call.app.names[0],
    parameters: call.parameters,
    inputs: frameInputs(call.inputs),
    signal,
    onRuns: () => report(APP_RUNS_STATE),
    async onCall(pageCall: AppCall): Promise<unknown> {
      if (pageCall.selector === APP_READ_ASSET) {
        const input = call.inputs.find(({ id }) => id === pageCall.id)
        if (!input) throw new AppCallError(notAnInputText(pageCall.id, call.inputs))
        return await assetBlob(input, signal)
      }
      const answer = lastSave.then(() => save(pageCall.blob))
      lastSave = answer.then(() => undefined, () => undefined)
      return await answer
    },
  }

  let end: AppFrameEnd
  try {
    end = await sbp('dez.ui/runAppFrame', run) as AppFrameEnd
  } catch (error) {
    closed = true
    await discardMadeAssets(stored.map(({ asset }) => asset))
    throw error
  }
  // From here on, a save that still runs deletes its own file.
  closed = true
  if (end.kind !== 'returned') {
    await discardMadeAssets(stored.map(({ asset }) => asset))
    return { ...appFrameResult(end, []), assets: [] }
  }
  return { ...appFrameResult(end, stored.map(({ type }) => type.kind)), assets: stored.map(({ asset }) => asset) }
}
