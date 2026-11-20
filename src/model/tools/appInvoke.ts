import { byteSizeText } from '../../utils/byteSize'
import { countOf } from '../../utils/countText'
import type { JsonObject } from '../../utils/json'
import { startOf } from '../../utils/textCut'
import { storedTypeOfBytes } from '../chat/fileSignatures'
import { imageExtension, imageMediaType } from '../chat/images'
import type { Section } from '../chat/types'
import { conversationAssets, type ConversationAssets } from '../streams/mediaRequest'
import { APP_KINDS, MANIFEST_FILE, MANIFEST_MAX_BYTES, parseAppManifest } from './appManifest'
import {
  APP_RUN_DEFAULT_SECONDS,
  APP_RUN_MAX_OUTPUT_BYTES,
  APP_RUN_MAX_OUTPUT_FILES,
  APPS_TOOL,
  appNamed,
  checkAppIsThere,
  isPathName,
  isReadableManifest,
  kindName,
  pathIn,
  type AppsPath,
  type AppsTree,
  type PathFacts,
} from './appsTool'
import { SCRIPT_MAIN_FILE } from './appTemplates'
import { assetIdWords } from './arguments'
import { ASSET_NAMES, jobCallLabel, jobTimeoutMs } from './jobs'
import { JS_EVAL_OUTPUT_BYTES, namesDenoFlag, runResultText, type JsEvalEndLine, type RunOutcome } from './jsEval'
import { clipInput, tellUserConsole, type ClipInput, type KeptFile, type ProgramEnd } from './programRuns'
import { assetText, unknownAssetsText } from './toolInputs'
import { ToolError, type SubcommandArguments } from './types'

// `apps invoke` for a script app: one run of the code of an app, as a job.
// Deno runs the module of Dez (jsEvalRunner.js), which calls the default
// export of the `main.ts` of the app with the parameters of the call. The
// code can open two folders: the folder of its app, where its state stays
// from one run to the next, and the work folder of the run, which holds a
// copy of each input and the output folder. It has no network and no tool
// bridge (`dez.sbp`). controller/appInvoke.ts does the run.
//
// This module has the pure parts: the checks of a call, the description of
// a run (`run.json`), the rules of the output folder, and every text that
// the calling model reads.
//
// Dez trusts nothing that a run leaves. A file of the output folder is kept
// only as a type that Dez stores, which its first bytes tell
// (`storedTypeOfBytes`), never its name. The limits of a run
// (`APP_RUN_MAX_OUTPUT_FILES`, `APP_RUN_MAX_OUTPUT_BYTES`) are next to the
// other limits of the apps (appsTool.ts), as the help of `invoke` states
// them.
//
// Every text here is a tool result: it goes to the chat provider. A text of
// a run (its value, its error, its console output) goes into a result only
// through `textForModel` (jsEval.ts) with the folders of the run, which
// `appRunResult` gets as `forModel`.

// What Dez did not do for a call that it refuses.
const NOT_DONE = 'Dez started no job.'

/** The name of the folder for the files that a run gives back, in the work
 *  folder of the run. Dez makes it before the run. */
export const APP_OUTPUT_FOLDER = 'output'

/** How many entries of the output folder Dez asks for after a run. The
 *  entries of the folder itself come first in a listing, so this is the
 *  most files and folders directly in it that Dez sees
 *  (`listedOutputs`). */
export const APP_OUTPUT_LISTED_ENTRIES = 200

/** The state of a job while the code of its app runs. */
export const APP_RUNS_STATE = 'The code of the app runs.'

/** An image of a call, as the code of the app gets it: a copy of the
 *  image's own file, of any type (an SVG too: the code reads its text). */
export interface AppImageInput {
  kind: 'image'
  id: string
  /** The name of its copy in the work folder. */
  name: string
  path: string
  /** Its media type, by the ending of its file name. */
  type: string
}

export type AppInput = AppImageInput | ClipInput

// The input that the id `id` names; null for an id of no image and no
// clip. The name of an image's copy is the id and the extension of the
// file's type, as for a clip (`clipInput`), so it tells nothing of the
// user's file name.
function inputOf(id: string, assets: ConversationAssets): AppInput | null {
  const path = assets.images.get(id)
  if (path !== undefined) {
    const type = imageMediaType(path)
    return { kind: 'image', id, name: `${id}.${type === null ? 'bin' : imageExtension(type)}`, path, type: type ?? 'application/octet-stream' }
  }
  const clip = assets.clips.get(id)
  return clip ? clipInput(clip) : null
}

/** The run of an app that an `invoke` call asks for. */
export interface InvokeCall {
  app: AppsPath
  /** The manifest file of the app, which tells its kind. */
  manifest: AppsPath
  /** The file whose default export the run calls. */
  main: AppsPath
  /** The first argument of that function, as the call gave it. */
  parameters: JsonObject
  /** The images and the clips of the call, each one once, in the order of
   *  the call. */
  inputs: AppInput[]
  timeoutMs: number
}

function parametersOf(args: SubcommandArguments): JsonObject {
  const value = args.parameters
  return typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** The run that an `apps invoke` call asks for, from its checked arguments
 *  and the sections of its tab. Throws a `ToolError`, whose text tells the
 *  model how to fix the call, for a text that is no name of an app, a bad
 *  time limit, and an input that names no image and no clip. It reads no
 *  file: `checkInvokeTarget` tells whether the app can run. */
export function invokeCall(args: SubcommandArguments, sections: readonly Section[]): InvokeCall {
  const app = appNamed((typeof args.name === 'string' ? args.name : '').trim())
  const timeoutMs = jobTimeoutMs(args, APP_RUN_DEFAULT_SECONDS)
  const ids = new Set(assetIdWords(args, 'inputs', 'an image or a clip', `Give the ids of the images and the clips, as in "@a @c". ${NOT_DONE}`))
  const assets = conversationAssets(sections)
  const inputs: AppInput[] = []
  const unknown: string[] = []
  for (const id of ids) {
    const input = inputOf(id, assets)
    if (input) inputs.push(input)
    else unknown.push(id)
  }
  if (unknown.length > 0) throw new ToolError(unknownAssetsText(unknown, assets, { argument: '`inputs`', notDone: NOT_DONE }))
  return { app, manifest: pathIn(app, MANIFEST_FILE), main: pathIn(app, SCRIPT_MAIN_FILE), parameters: parametersOf(args), inputs, timeoutMs }
}

/** What is at the paths of an app that a call runs. Each fact is exact
 *  (one read for each path), and not from a listing of the app: the code of
 *  an app can make more files than a listing holds. */
export interface InvokeTarget {
  app: PathFacts
  manifest: PathFacts
  /** The bytes of the manifest file; null when Dez does not read it
   *  (`isReadableManifest`). */
  manifestBytes: Uint8Array | null
  main: PathFacts
}

const MANIFEST_NEEDS = `a JSON object with "name", "description", and "kind", which is ${APP_KINDS.map((kind) => `"${kind}"`).join(' or ')}`
const MAIN_EXPORT = '`export default async function main(parameters, dez) { … }`'

/** Throws a `ToolError` unless the app of `call` is a script app that a
 *  run can start: its folder, a manifest that tells the kind `script`, and
 *  its main file. */
export function checkInvokeTarget({ app, manifest, main }: InvokeCall, target: InvokeTarget): void {
  checkAppIsThere(app, target.app)
  if (target.manifest.kind === 'missing') {
    throw new ToolError(`The app ${app.virtual} has no ${MANIFEST_FILE}, so Dez does not know its kind. Write ${manifest.virtual}: ${MANIFEST_NEEDS}. ${NOT_DONE}`)
  }
  if (!isReadableManifest(target.manifest) || target.manifestBytes === null) {
    throw new ToolError(`${manifest.virtual} is no plain file of at most ${byteSizeText(MANIFEST_MAX_BYTES)}, so Dez does not read it and does not know the kind of the app. `
      + `Write it again: ${MANIFEST_NEEDS}. ${NOT_DONE}`)
  }
  const parsed = parseAppManifest(new TextDecoder().decode(target.manifestBytes))
  if (!parsed) {
    throw new ToolError(`${manifest.virtual} is not valid, so Dez does not know the kind of the app. Write it again: ${MANIFEST_NEEDS}. ${NOT_DONE}`)
  }
  if (parsed.kind !== 'script') {
    throw new ToolError(`${app.virtual} is a UI app, and invoke runs only a script app: an app whose ${MANIFEST_FILE} has the kind "script", with its code in ${SCRIPT_MAIN_FILE}. ${NOT_DONE}`)
  }
  if (target.main.kind === 'missing') {
    throw new ToolError(`The app ${app.virtual} has no ${SCRIPT_MAIN_FILE}, the file whose code a run calls. `
      + `Write ${main.virtual}, with the function of the app as its default export, as in ${MAIN_EXPORT}. ${NOT_DONE}`)
  }
  if (target.main.kind !== 'file') {
    throw new ToolError(`${main.virtual} is ${kindName(target.main.kind)} and no file, so a run has no code to call. `
      + `Delete it with rm, and write the file with the function of the app as its default export, as in ${MAIN_EXPORT}. ${NOT_DONE}`)
  }
}

/** The file URL of the absolute path `path`, as the module of Dez imports
 *  it. A setter of a URL's path escapes most characters that a URL does not
 *  hold as they are (a space, `?`, `#`). It keeps a `%` (so `%41` in a
 *  folder name would name `A`), takes a `\` for a `/`, and drops a tab and
 *  a line end: these get their escapes first. */
export function fileUrl(path: string): string {
  const url = new URL('file:///')
  url.pathname = path.replace(/[%\\\n\r\t]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return url.href
}

/** The folders of a run on this computer, as absolute paths. Each is the
 *  path that Dez joined from its root folder, with no link resolved: Rust
 *  gives Deno the same texts as the folders that the code can open, and
 *  Deno checks a path against them as text (bundled_tools.rs). */
export interface AppRunFolders {
  /** The work folder of the run. */
  work: string
  /** The folder of the app. */
  app: string
}

/** The text of the description of a run of `call` (`RUN_DESCRIPTION_FILE`,
 *  jsEval.ts), which the module of Dez reads: the main file of the app as
 *  a file URL, the parameters, and what the `dez` object of the code holds
 *  (`appDez`, jsEvalRunner.js): each input with the path of its copy, the
 *  output folder, and the folder of the app. */
export function appRunDescription(call: Pick<InvokeCall, 'parameters' | 'inputs'>, folders: AppRunFolders): string {
  return JSON.stringify({
    kind: 'app',
    main: fileUrl(`${folders.app}/${SCRIPT_MAIN_FILE}`),
    parameters: call.parameters,
    inputs: call.inputs.map((input) => ({
      id: input.id,
      kind: input.kind,
      type: input.kind === 'image' ? input.type : input.clip.type,
      path: `${folders.work}/${input.name}`,
    })),
    outputFolder: `${folders.work}/${APP_OUTPUT_FOLDER}`,
    appFolder: folders.app,
  })
}

/** What the result of a call that started a job adds after
 *  `jobStartedText`: the inputs of the run, so that the model sees at once
 *  what the code gets. Each `@id` of this text is an input of the job. */
export function invokeInputsText(inputs: readonly AppInput[]): string {
  return inputs.length === 0 ? 'The run has no input.' : `The inputs of the run, in the order of dez.inputs: ${inputs.map(assetText).join(', ')}.`
}

/** The label of an `invoke` call (`JobCall.label`): the app, and the
 *  parameters of the run when the call gives some. `args` are the
 *  subcommand's own arguments. */
export function invokeLabel(args: SubcommandArguments): string {
  const parameters = parametersOf(args)
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  return jobCallLabel(`invoke ${name}${Object.keys(parameters).length === 0 ? '' : ` ${JSON.stringify(parameters)}`}`)
}

// What an error text of Deno that names a flag gets as advice: a model can
// set no flag, and the usual cause is a path that is in no folder of the
// run (a relative path, a path of the computer).
const SANDBOX_ADVICE = 'The code of an app can open only the folder of its app and the work folder of its run. '
  + 'It has no network and no environment variables, it starts no program, and it loads no package of npm, of JSR, or from a URL. '
  + 'No flag changes that, and you can set none. For a file, use only the paths that `dez` gives: '
  + '`dez.appFolder`, `dez.outputFolder`, and the `path` of each of `dez.inputs`. A relative path does not work.'

const KEPT_NONE = 'Dez kept no file of the run.'

// The outcome of a run whose code returned `value`. A string with no
// visible character does not go as it is: a blank result reads as a
// failure of the tool.
function returnedOutcome(value: string | undefined): RunOutcome {
  const told = (lead: string): RunOutcome => ({ isError: false, lead, given: null, advice: [] })
  if (value === undefined) return told('The app ended with no error and returned no value.')
  if (value === '') return told('The app returned an empty string.')
  if (value.trim() === '') return told(`The app returned a string of only white space (${countOf(value.length, 'character')}).`)
  return { isError: false, lead: null, given: { text: value, name: 'returned value' }, advice: [] }
}

/** The outcome of a run of an app that ended with `end` and gave the
 *  protocol line `line` (`endedRun`, jsEval.ts). `hasConsole` tells that
 *  the code wrote console output, which goes after it. A run that Dez
 *  stopped at its time limit is not here: the job has the text of its own
 *  time limit (`jobTimedOutText`). */
export function appRunOutcome(end: Exclude<ProgramEnd, { kind: 'timedOut' }>, line: JsEvalEndLine | null, hasConsole: boolean): RunOutcome {
  if (line?.type === 'result') return returnedOutcome(line.text)
  if (line?.type === 'error') {
    return {
      isError: true,
      lead: `The code of the app threw an error. ${KEPT_NONE} The error:`,
      given: { text: line.text, name: 'text of the error' },
      advice: namesDenoFlag(line.text) ? [SANDBOX_ADVICE] : [],
    }
  }
  const failed = (lead: string): RunOutcome => ({ isError: true, lead, given: null, advice: [] })
  if (end.kind === 'outputTooLarge') {
    return failed(`Dez stopped the app: it wrote more than ${byteSizeText(JS_EVAL_OUTPUT_BYTES)} of output. ${KEPT_NONE} `
      + 'Make the code write less to the console and return only what you need.')
  }
  const silent = hasConsole ? '' : ' The app wrote nothing to the console.'
  // A signal that Dez did not send ended the program. V8 ends it this way
  // at the limit of its memory.
  if (end.code === null) {
    return failed(`The system ended the app before it returned a value. ${KEPT_NONE} The usual cause: the code used more memory than a run can have. `
      + `Make the code use less memory (smaller arrays and strings, or the work in parts), and call again.${silent}`)
  }
  return failed(`The app ended before it returned a value (exit code ${end.code}). ${KEPT_NONE} `
    + 'The usual causes: an error in a timer or in a promise that the code did not await, '
    + `an \`await\` of a promise that never settles, or a call of \`Deno.exit\`.${hasConsole ? ' The console output tells which.' : silent}`)
}

/** What Dez found in the output folder of a run. */
export interface ListedOutputs {
  /** The names of the files that Dez reads to check their types, in the
   *  order of their names (`frame_2.png` before `frame_10.png`). */
  files: string[]
  /** Each entry that Dez does not keep, with the cause, as a part of a
   *  sentence: `notes/ (a folder: …)`. */
  notKept: string[]
  /** Why Dez keeps no file of the run at all, as the start of an error
   *  result; null when it keeps the files that pass their checks. */
  problem: string | null
}

// The most characters of a name that the apps tool does not take, in a
// result: the code of an app can make a name of any length.
const SHOWN_NAME_CHARS = 100

const WRITE_FEWER = `Dez keeps at most ${APP_RUN_MAX_OUTPUT_FILES} files of one run: make the app write only its results into \`dez.outputFolder\`, `
  + 'and run it once for each part of a larger result.'

/** The files of the output folder of a run that Dez reads, from the
 *  listing `tree` of the folder with `APP_OUTPUT_LISTED_ENTRIES`. Only a
 *  plain file directly in the folder counts, with a name that the file
 *  selectors take, that is not empty, and that is not over
 *  `APP_RUN_MAX_OUTPUT_BYTES`. A run with more such files than
 *  `APP_RUN_MAX_OUTPUT_FILES` keeps none, and neither does a run with more
 *  entries directly in the folder than the listing holds. */
export function listedOutputs(tree: AppsTree): ListedOutputs {
  if (tree.kind !== 'folder') return { files: [], notKept: ['the output folder (the app left no folder at its place)'], problem: null }
  const direct = tree.entries.filter((entry) => !entry.path.includes('/'))
  // The entries of the folder itself come first in a listing
  // (`entries_below`, persistence.rs). So a cut listing holds them all when
  // it holds an entry of a folder below.
  if (tree.more && direct.length === tree.entries.length) {
    return {
      files: [],
      notKept: [],
      problem: `The app ended with no error, but it put more than ${APP_OUTPUT_LISTED_ENTRIES} files and folders into its output folder, so Dez kept none. ${WRITE_FEWER}`,
    }
  }

  const files: string[] = []
  const notKept: string[] = []
  const sorted = [...direct].sort((one, other) => one.path.localeCompare(other.path, 'en', { numeric: true }))
  for (const { path: name, kind, size } of sorted) {
    if (!isPathName(name)) {
      notKept.push(`${JSON.stringify(startOf(name, SHOWN_NAME_CHARS))} (a name that Dez does not take: the name of an output file has only ASCII letters, digits, "-", "_", and ".")`)
    } else if (kind === 'folder') notKept.push(`${name}/ (a folder: Dez keeps only the files directly in the output folder)`)
    else if (kind !== 'file') notKept.push(`${name} (${kindName(kind)})`)
    else if (size === 0) notKept.push(`${name} (it is empty)`)
    else if (size > APP_RUN_MAX_OUTPUT_BYTES) notKept.push(`${name} (it is larger than ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)}, the most that Dez keeps of one file of a run)`)
    else files.push(name)
  }
  if (files.length > APP_RUN_MAX_OUTPUT_FILES) {
    return {
      files: [],
      notKept: [],
      problem: `The app ended with no error, but it put ${files.length} files into its output folder, so Dez kept none. ${WRITE_FEWER}`,
    }
  }
  return { files, notKept, problem: null }
}

/** One file of the output folder after its check: the file as Dez keeps
 *  it, or why Dez does not keep it (a part of a sentence, as
 *  `ListedOutputs.notKept`). */
export type CheckedOutput = { kept: KeptFile } | { notKept: string }

/** The check of the output file `name` with the bytes `bytes`; null for a
 *  file that Dez could not read. Its first bytes tell its type, and with
 *  it the kind of the asset and the ending of the stored file: the code of
 *  an app gives a file any name. */
export function checkedOutput(name: string, bytes: Uint8Array | null): CheckedOutput {
  if (bytes === null) return { notKept: `${name} (Dez could not read it)` }
  const type = storedTypeOfBytes(bytes)
  return type === null
    ? { notKept: `${name} (Dez stores no file of its type)` }
    : { kept: { name, kind: type.kind, type: type.type, extension: type.extension } }
}

/** The files of the output folder of a run, for its result. */
export interface AppOutputs {
  /** The files that Dez keeps, in the order of the assets of the job. */
  kept: readonly KeptFile[]
  notKept: readonly string[]
  /** `ListedOutputs.problem`. */
  problem: string | null
}

/** The outputs of a run that keeps no file and tells of none: a run that
 *  failed. */
export const NO_APP_OUTPUTS: AppOutputs = { kept: [], notKept: [], problem: null }

// The most entries that a result names as not kept.
const SHOWN_NOT_KEPT = 20

// What a result tells of the output folder, as its paragraphs.
function outputParagraphs({ kept, notKept }: AppOutputs): string[] {
  const sentences: string[] = []
  if (kept.length > 0) {
    const names = kept.map(({ name, kind }) => `${name} (${ASSET_NAMES[kind]})`).join(', ')
    sentences.push(kept.length === 1
      ? `Dez keeps 1 file of the output folder: ${names}. The line at the end gives its id.`
      : `Dez keeps ${kept.length} files of the output folder: ${names}. The lines at the end give their ids in this order.`)
  }
  if (notKept.length > 0) {
    const rest = notKept.length - SHOWN_NOT_KEPT
    sentences.push(`Dez did not keep ${notKept.slice(0, SHOWN_NOT_KEPT).join(', ')}${rest > 0 ? `, and ${rest} more of the output folder` : ''}.`)
  }
  return sentences.length === 0 ? [] : [sentences.join(' ')]
}

/** The result of a run of an app with the outcome `outcome`
 *  (`appRunOutcome`) and the console output `log`: what the code returned
 *  or threw, what Dez did with the files of the output folder, then the
 *  console output. A run whose outputs have a problem is an error result,
 *  which still gives the value. `forModel` takes the paths of this
 *  computer out of a text of the run (`textForModel`, jsEval.ts, with the
 *  folders of the run). */
export function appRunResult(outcome: RunOutcome, log: string, forModel: (text: string) => string, outputs: AppOutputs): { text: string, isError: boolean } {
  const told: RunOutcome = outputs.problem === null
    ? outcome
    : { ...outcome, isError: true, lead: `${outputs.problem} ${outcome.lead ?? 'The app returned:'}` }
  return { text: runResultText(told, log, forModel, () => outputParagraphs(outputs)), isError: told.isError }
}

/** The error result of a run whose files Dez could not get out of the
 *  output folder: the list of the folder failed, or the write of a kept
 *  file into the Dez folder. */
export function appOutputNotStoredText(): string {
  return `The app ended with no error, but Dez could not get the files of its output folder into the Dez folder, so it kept none. ${tellUserConsole(APPS_TOOL.name)}`
}
