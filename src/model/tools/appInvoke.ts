import { byteSizeText } from '../../utils/byteSize'
import { isJsonObject, type JsonObject } from '../../utils/json'
import { startOf } from '../../utils/textCut'
import { storedTypeOfBytes, type StoredFileType } from '../chat/fileSignatures'
import { imageExtension, imageMediaType } from '../chat/images'
import type { Section } from '../chat/types'
import { conversationAssets, type ConversationAssets } from '../streams/mediaRequest'
import { aliasCallText, aliasNotDoneText, ALIAS_TIMEOUT_MS, type AppAlias } from './appAliases'
import { APP_FRAME_ROOT_URL, APP_HANDLER_EXAMPLE, AppCallError, type AppFrameEnd, type AppFrameInput } from './appBridge'
import { MANIFEST_FILE, NATIVE_CANVAS_LIBRARY, NATIVE_FIELD_EXAMPLE, type AppKind, type AppManifest } from './appManifest'
import {
  APP_RUN_DEFAULT_SECONDS,
  APP_RUN_MAX_OUTPUT_BYTES,
  APP_RUN_MAX_OUTPUT_FILES,
  APPS_VIRTUAL_ROOT,
  STORED_TYPES,
  appNamed,
  checkAppIsThere,
  checkBuiltInKind,
  checkedManifest,
  isPathName,
  kindName,
  pathIn,
  type AppsPath,
  type AppsTree,
  type PathFacts,
} from './appsTool'
import { SCRIPT_MAIN_FILE, UI_CLIENT_SCRIPT_TAG, UI_INDEX_FILE } from './appTemplates'
import { assetIdWords } from './arguments'
import { FRAMES_FOLDER_ENDING, isFramesFolderName, sequenceText, type FrameSequence } from './frameSequences'
import { callDecode, DECODED_TOO_LARGE_TEXT, decodedInputFacts, decodeFailedText, type DecodedClip, type InputDecode } from './inputDecode'
import { ASSET_NAMES, jobCallLabel, jobTimedOutText, jobTimeoutMs, type JobAssetKind } from './jobs'
import { cutCallsParagraphs, endedOutcome, failedOutcome, namesDenoFlag, openJobLines, returnedOutcome, runResultText, skiaCanvasRefused, textForModel, type JsEvalEndLine, type RunOutcome } from './jsEval'
import { clipInput, tellUserConsole, type ClipInput, type KeptFile, type ProgramEnd } from './programRuns'
import { assetText, unknownAssetsText } from './toolInputs'
import { ToolError, type SubcommandArguments, type ToolArguments } from './types'
import { SHIPPED_FONTS } from './videoFonts'

// `apps invoke`: one run of the code of an app, as a job. The kind of the
// app (its manifest) picks what runs it.
//
// A script app: Deno runs the module of Dez (jsEvalRunner.js), which calls
// the default export of the `main.ts` of the app with the parameters of
// the call. The code can open three folders: the folder of its app, where
// its state stays from one run to the next, the run folder, which holds a
// copy of each input, the decoded files of the input clips when the run
// decodes them (inputDecode.ts), and the output folder, and the work
// folder of the conversation of the call (conversationWork.ts). It reads
// the libraries and the fonts that Dez ships (`dez.fonts`), and an app
// whose manifest has `"native": ["skia-canvas"]` can also load the native
// file of skia-canvas (`runNativeCanvas`). It has no network. It calls the
// Dez tools with `dez.sbp`, by the rules of `APP_RUN_BRIDGE`
// (toolBridge.ts): the images and the clips that its calls make are
// assets of the job, which the code knows by their handles (`&1`), and
// the result of the job maps each handle to its id. A run of an alias
// (appAliases.ts) gets no tool calls.
//
// A UI app: Dez loads the page of the app in a hidden frame, and calls the
// handler that the page registered (`APP_INVOKE_HANDLER`) with the
// parameters of the call. The page reads the inputs and saves its files
// over the frame bridge (appBridge.ts). It has no network, no file (also
// no work folder), and no storage.
//
// controller/appInvoke.ts does both runs.
//
// This module has the pure parts: the checks of a call, the description of
// a run (`run.json`), the rules of the output folder and of a save of a
// page, and every text that the calling model reads.
//
// Dez trusts nothing that a run leaves. A file of the output folder or of
// a save is kept only as a type that Dez stores, which its first bytes
// tell (`storedTypeOfBytes`), never its name. A folder `<name>.frames` of
// the output folder is a frame sequence, which Dez encodes with its ffmpeg
// into one clip after the run (frameSequences.ts). The limits of a run
// (`APP_RUN_MAX_OUTPUT_FILES`, `APP_RUN_MAX_OUTPUT_BYTES`,
// `APP_RUN_MAX_FRAMES`) are next to the other limits of the apps
// (appsTool.ts), as the help of `invoke` states them.
//
// Every text here is a tool result: it goes to the chat provider. A text of
// a run (its value, its error, its console output) goes into a result only
// through `textForModel` (jsEval.ts): with the folders of the run for a
// script app, which `appRunResult` gets as `forModel`, and after
// `frameTextForModel` for a UI app.

// What Dez did not do for a call that it refuses.
const NOT_DONE = 'Dez started no job.'

/** The name of the folder for the files that a run gives back, in the run
 *  folder. Dez makes it before the run. */
export const APP_OUTPUT_FOLDER = 'output'

/** How many entries of the output folder Dez asks for after a run. The
 *  entries of the folder itself come first in a listing, so this is the
 *  most files and folders directly in it that Dez sees
 *  (`listedOutputs`). */
export const APP_OUTPUT_LISTED_ENTRIES = 200

/** The state of a job while the code of its app runs. */
export const APP_RUNS_STATE = 'The code of the app runs.'

/** The state of a job of a UI app until its page is ready for the run. */
export const APP_PAGE_LOADS_STATE = 'The page of the app loads.'

/** An image of a call, as the code of the app gets it: a copy of the
 *  image's own file, of any type (an SVG too: the code reads its text). */
export interface AppImageInput {
  kind: 'image'
  id: string
  /** The name of its copy in the run folder. */
  name: string
  path: string
  /** Its media type, by the ending of its file name. */
  type: string
}

export type AppInput = AppImageInput | ClipInput

/** The input that the id `id` names; null for an id of no image and no
 *  clip. The name of an image's copy is the id and the extension of the
 *  file's type, as for a clip (`clipInput`), so it tells nothing of the
 *  user's file name. */
export function inputOf(id: string, assets: ConversationAssets): AppInput | null {
  const path = assets.images.get(id)
  if (path !== undefined) {
    const type = imageMediaType(path)
    return { kind: 'image', id, name: `${id}.${type === null ? 'bin' : imageExtension(type)}`, path, type: type ?? 'application/octet-stream' }
  }
  const clip = assets.clips.get(id)
  return clip ? clipInput(clip) : null
}

/** An input as the handler of a page gets it (`run.inputs`): no copy and
 *  no path, as the page reads the bytes over the frame bridge. */
export function frameInputs(inputs: readonly AppInput[]): AppFrameInput[] {
  return inputs.map((input) => ({ id: input.id, kind: input.kind, type: input.kind === 'image' ? input.type : input.clip.type }))
}

/** The run of an app that an `invoke` call asks for. */
export interface InvokeCall {
  app: AppsPath
  /** The manifest file of the app, which tells its kind. */
  manifest: AppsPath
  /** The file of a script app whose default export the run calls. */
  main: AppsPath
  /** The page of a UI app, which registers the handler that the run
   *  calls. */
  index: AppsPath
  /** The first argument of that function, as the call gave it. */
  parameters: JsonObject
  /** The images and the clips of the call, each one once, in the order of
   *  the call. */
  inputs: AppInput[]
  timeoutMs: number
  /** The call's own `decode` (`callDecode`); null for a call with
   *  none. */
  decode: InputDecode | null
}

/** A call whose app can run (`checkInvokeTarget`), with the kind of the
 *  app, which picks what runs it, the decode of the run (`runDecode`), and
 *  whether the run may load the native file of skia-canvas
 *  (`runNativeCanvas`). */
export interface CheckedInvokeCall extends Omit<InvokeCall, 'decode'> {
  kind: AppKind
  decode: InputDecode
  nativeCanvas: boolean
}

/** The error texts of a run of a script app that depend on the call that
 *  started it: an `apps invoke` call (`INVOKE_RUN_TEXTS`), or a call of an
 *  alias subcommand (`aliasRunTexts`, appAliases.ts). Each tells the model
 *  what it can change in its own call. */
export interface AppRunTexts {
  /** The error result of a run whose decode of the clip `input` failed:
   *  ffprobe or ffmpeg could not read it. */
  decodeFailed: (input: Pick<ClipInput, 'kind' | 'id'>) => string
  /** The error result of a run whose decoded files are larger than
   *  `APP_RUN_MAX_DECODED_BYTES` together. */
  decodedTooLarge: string
  /** The error result of a run that its time limit `timeoutMs` stopped in
   *  the state `state`. */
  timedOut: (timeoutMs: number, state: string) => string
}

/** The texts of a run of an `apps invoke` call: a job. */
export const INVOKE_RUN_TEXTS: AppRunTexts = {
  decodeFailed: decodeFailedText,
  decodedTooLarge: DECODED_TOO_LARGE_TEXT,
  timedOut: jobTimedOutText,
}

/** What started a run of a script app: the Dez tool of the call, which
 *  the texts name, and the error texts of the run. */
export interface AppRunCaller {
  toolName: string
  texts: AppRunTexts
}

function parametersOf(args: SubcommandArguments): JsonObject {
  return isJsonObject(args.parameters) ? args.parameters : {}
}

// The paths of the app `app` that a run reads: its folder, its manifest,
// the main file of a script app, and the page of a UI app.
function appRunPaths(app: AppsPath): Pick<InvokeCall, 'app' | 'manifest' | 'main' | 'index'> {
  return { app, manifest: pathIn(app, MANIFEST_FILE), main: pathIn(app, SCRIPT_MAIN_FILE), index: pathIn(app, UI_INDEX_FILE) }
}

// The inputs of the ids `ids`, in their order, from the assets of the
// conversation `assets`. Throws a `ToolError` for the ids that name no
// image and no clip, whose text names the argument `argument` and ends
// with `notDone`.
function knownInputs(ids: Iterable<string>, assets: ConversationAssets, argument: string, notDone: string): AppInput[] {
  const inputs: AppInput[] = []
  const unknown: string[] = []
  for (const id of ids) {
    const input = inputOf(id, assets)
    if (input) inputs.push(input)
    else unknown.push(id)
  }
  if (unknown.length > 0) throw new ToolError(unknownAssetsText(unknown, assets, { argument, notDone }))
  return inputs
}

/** The run that an `apps invoke` call asks for, from its checked arguments
 *  and the sections of its tab. Throws a `ToolError`, whose text tells the
 *  model how to fix the call, for a text that is no name of an app, a bad
 *  time limit, an input that names no image and no clip, and a `decode`
 *  that is not valid. It reads no file: `checkInvokeTarget` tells whether
 *  the app can run. */
export function invokeCall(args: SubcommandArguments, sections: readonly Section[]): InvokeCall {
  const app = appNamed((typeof args.name === 'string' ? args.name : '').trim())
  const timeoutMs = jobTimeoutMs(args, APP_RUN_DEFAULT_SECONDS)
  const ids = new Set(assetIdWords(args, 'inputs', 'an image or a clip', `Give the ids of the images and the clips, as in "@a @c". ${NOT_DONE}`))
  const inputs = knownInputs(ids, conversationAssets(sections), '`inputs`', NOT_DONE)
  return {
    ...appRunPaths(app),
    parameters: parametersOf(args),
    inputs,
    timeoutMs,
    decode: callDecode(args),
  }
}

/** The run that a call of the alias subcommand `alias` asks for
 *  (appAliases.ts), from its checked arguments `args` and the sections of
 *  its tab: the built-in app of the alias, with the clips of the input
 *  parameters in their order, every other argument as a parameter of the
 *  app, the time limit of an alias, and the decode of the manifest of the
 *  app. Throws a `ToolError`, whose text tells the model how to fix the
 *  call, for a word that is no id, an input parameter with no id or one
 *  with more than one id where it takes one, an id that names no clip of
 *  the kinds that its parameter takes, and the same clip in two input
 *  parameters. The app itself checks its parameters. */
export function aliasInvokeCall(alias: AppAlias, args: ToolArguments, sections: readonly Section[]): InvokeCall {
  const call = aliasCallText(alias)
  const notDone = aliasNotDoneText(alias)
  const assets = conversationAssets(sections)
  const inputs: AppInput[] = []
  // The input parameter of each id, for a clip in two of them.
  const parameterOf = new Map<string, string>()
  for (const { parameter, many, kinds, what } of alias.inputs) {
    const form = many ? `Give the ids of ${what.many}, as in "@b @d".` : `Give the id of ${what.one}, as in "@b".`
    const ids = [...new Set(assetIdWords(args, parameter, what.one, `${form} ${notDone}`))]
    if (ids.length === 0) throw new ToolError(`\`${parameter}\` names no clip. ${form} ${notDone}`)
    if (!many && ids.length > 1) throw new ToolError(`\`${parameter}\` names ${ids.length} clips, and it takes one. ${form} ${notDone}`)
    for (const input of knownInputs(ids, assets, `\`${parameter}\``, notDone)) {
      const { id } = input
      if (input.kind === 'image' || !kinds.includes(input.kind)) {
        const article = input.kind === 'video' ? 'a' : 'an'
        throw new ToolError(`@${id} is ${article} ${ASSET_NAMES[input.kind]}, and \`${parameter}\` of ${call} takes only ${what.many}. ${form} ${notDone}`)
      }
      const other = parameterOf.get(id)
      if (other !== undefined) throw new ToolError(`\`${other}\` and \`${parameter}\` name the same clip @${id}. Give each one a different clip. ${notDone}`)
      parameterOf.set(id, parameter)
      inputs.push(input)
    }
  }
  const inputParameters = new Set(alias.inputs.map((input) => input.parameter))
  return {
    ...appRunPaths(appNamed(alias.app)),
    parameters: Object.fromEntries(Object.entries(args).filter(([name]) => !inputParameters.has(name))),
    inputs,
    timeoutMs: ALIAS_TIMEOUT_MS,
    decode: null,
  }
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
  index: PathFacts
}

const MAIN_EXPORT = '`export default async function main(parameters, dez) { … }`'

/** The manifest of the app of `call`, which a run can start: its kind
 *  picks what runs it. Throws a `ToolError` unless the app has its
 *  folder, a manifest that tells its kind, and the file that a run of that
 *  kind needs: the main file of a script app, or the page of a UI app. */
export function checkInvokeTarget({ app, manifest, main, index }: InvokeCall, target: InvokeTarget): AppManifest {
  checkAppIsThere(app, target.app)
  const appManifest = checkedManifest(app, manifest, target.manifest, target.manifestBytes, NOT_DONE)
  checkBuiltInKind(app, appManifest.kind, NOT_DONE)
  if (appManifest.kind === 'ui') {
    if (target.index.kind === 'missing') {
      throw new ToolError(`The app ${app.virtual} has no ${UI_INDEX_FILE}, the page whose handler a run calls. `
        + `Write ${index.virtual}: it loads Dez's script with ${UI_CLIENT_SCRIPT_TAG}, and a script of the page registers the handler, as in ${APP_HANDLER_EXAMPLE}. ${NOT_DONE}`)
    }
    if (target.index.kind !== 'file') {
      throw new ToolError(`${index.virtual} is ${kindName(target.index.kind)} and no file, so a run has no page to load. `
        + `Delete it with rm, and write the page of the app as that file. ${NOT_DONE}`)
    }
    return appManifest
  }
  if (target.main.kind === 'missing') {
    throw new ToolError(`The app ${app.virtual} has no ${SCRIPT_MAIN_FILE}, the file whose code a run calls. `
      + `Write ${main.virtual}, with the function of the app as its default export, as in ${MAIN_EXPORT}. ${NOT_DONE}`)
  }
  if (target.main.kind !== 'file') {
    throw new ToolError(`${main.virtual} is ${kindName(target.main.kind)} and no file, so a run has no code to call. `
      + `Delete it with rm, and write the file with the function of the app as its default export, as in ${MAIN_EXPORT}. ${NOT_DONE}`)
  }
  return appManifest
}

// The problem of the value `value` of the field "native" of a manifest, as
// a part of a sentence; null for a value that is valid.
function nativeFieldProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'it must be a list of names of native libraries'
  const other = value.find((name) => name !== NATIVE_CANVAS_LIBRARY)
  if (other === undefined) return null
  const named = typeof other === 'string' ? `"${startOf(other, SHOWN_NAME_CHARS)}"` : 'a value that is no name'
  return `it names ${named}, and the one native library that a script app can load is "${NATIVE_CANVAS_LIBRARY}"`
}

/** Whether a run of the app of `call` may load the native file of
 *  skia-canvas: its manifest has the field `"native": ["skia-canvas"]`. An
 *  empty list asks for nothing. Throws a `ToolError` for a field that is
 *  not valid, and for the field in the manifest of a UI app. */
export function runNativeCanvas({ app, manifest }: Pick<InvokeCall, 'app' | 'manifest'>, { kind, native }: AppManifest): boolean {
  if (native === undefined) return false
  const problem = nativeFieldProblem(native)
  if (problem !== null) {
    throw new ToolError(`The field "native" of ${manifest.virtual} is not valid: ${problem}. `
      + `For a script app that draws with ${NATIVE_CANVAS_LIBRARY}, write the field as ${NATIVE_FIELD_EXAMPLE}; else delete it. ${NOT_DONE}`)
  }
  if ((native as unknown[]).length === 0) return false
  if (kind === 'ui') {
    throw new ToolError(`${manifest.virtual} has the field "native", which only a script app takes: the page of ${app.virtual} cannot load a native library. `
      + `Delete the field. ${NOT_DONE}`)
  }
  return true
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
  /** The run folder. */
  run: string
  /** The folder of the app. */
  app: string
  /** The work folder of the conversation of the call
   *  (conversationWork.ts). */
  work: string
  /** The folder of the fonts that Dez ships, which every run of an app
   *  reads. */
  fonts: string
}

/** The text of the description of a run of `call` (`RUN_DESCRIPTION_FILE`,
 *  jsEval.ts), which the module of Dez reads: the main file of the app as
 *  a file URL, the parameters, and what the `dez` object of the code holds
 *  (`appDez`, jsEvalRunner.js): each input with the path of its copy and
 *  the facts of its decoded files (`decoded`, by id; `decodedInputFacts`),
 *  the output folder, the folder of the app, the work folder of the
 *  conversation, and each font that Dez ships with the path of its file,
 *  for `useShippedFonts` of `dez-media/canvas`. */
export function appRunDescription(call: Pick<InvokeCall, 'parameters' | 'inputs'>, folders: AppRunFolders, decoded: ReadonlyMap<string, DecodedClip> = new Map()): string {
  return JSON.stringify({
    kind: 'app',
    main: fileUrl(`${folders.app}/${SCRIPT_MAIN_FILE}`),
    parameters: call.parameters,
    inputs: call.inputs.map((input) => {
      const clip = decoded.get(input.id)
      return {
        id: input.id,
        kind: input.kind,
        type: input.kind === 'image' ? input.type : input.clip.type,
        path: `${folders.run}/${input.name}`,
        ...(clip && decodedInputFacts(clip, folders.run)),
      }
    }),
    outputFolder: `${folders.run}/${APP_OUTPUT_FOLDER}`,
    appFolder: folders.app,
    workFolder: folders.work,
    fonts: SHIPPED_FONTS.map(({ file, family, weight, scripts }) => ({ file, family, weight, scripts, path: `${folders.fonts}/${file}` })),
  })
}

/** What the result of a call that started a job adds after
 *  `jobStartedText`: the inputs of the run, so that the model sees at once
 *  what the code gets, and where (by the kind of the app). Each `@id` of
 *  this text is an input of the job. */
export function invokeInputsText(inputs: readonly AppInput[], kind: AppKind): string {
  if (inputs.length === 0) return 'The run has no input.'
  return `The inputs of the run, in the order of ${kind === 'ui' ? 'run.inputs' : 'dez.inputs'}: ${inputs.map(assetText).join(', ')}.`
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
const SANDBOX_ADVICE = 'The code of an app can open only the folder of its app, its run folder, and the work folder of the conversation, '
  + 'and read the libraries and the fonts that Dez ships. '
  + 'It has no network and no environment variables, it starts no program, and it loads no package of npm, of JSR, or from a URL. '
  + 'No flag changes that, and you can set none. For a file, use only the paths that `dez` gives: '
  + '`dez.appFolder`, `dez.outputFolder`, `dez.workFolder`, the `path` of each of `dez.inputs`, and the `path` of each of `dez.fonts`. '
  + 'A relative path does not work.'

// The advice for an app that loads skia-canvas, and whose manifest does not
// ask for it (`skiaCanvasRefused`).
const NATIVE_CANVAS_ADVICE = `${NATIVE_CANVAS_LIBRARY} loads a native file, which only the run of an app whose ${MANIFEST_FILE} has ${NATIVE_FIELD_EXAMPLE} may load. `
  + `Add that field to the ${MANIFEST_FILE} of the app, and run the app again.`

const KEPT_NONE = 'Dez kept no file of the run.'

// The same for a script app: the assets that the tool calls of its code
// made stay (`AppRunCalls.made`).
const KEPT_NO_OUTPUT = 'Dez kept no file of the output folder.'

// The lead of a run whose code returned no value.
const NO_VALUE = 'The app ended with no error and returned no value.'

/** The outcome of a run of an app that ended with `end` and gave the
 *  protocol line `line` (`endedRun`, jsEval.ts). `hasConsole` tells that
 *  the code wrote console output, which goes after it, and `nativeCanvas`
 *  that the run could load skia-canvas (`runNativeCanvas`). A run that Dez
 *  stopped at its time limit is not here: its caller has the text of its
 *  own time limit (`AppRunTexts.timedOut`). */
export function appRunOutcome(end: Exclude<ProgramEnd, { kind: 'timedOut' }>, line: JsEvalEndLine | null, hasConsole: boolean, nativeCanvas: boolean): RunOutcome {
  if (line?.type === 'result') return returnedOutcome(line.text, 'app', NO_VALUE)
  if (line?.type === 'error') {
    return {
      isError: true,
      lead: `The code of the app threw an error. ${KEPT_NO_OUTPUT} The error:`,
      given: { text: line.text, name: 'text of the error' },
      advice: namesDenoFlag(line.text) ? [!nativeCanvas && skiaCanvasRefused(line.text) ? NATIVE_CANVAS_ADVICE : SANDBOX_ADVICE] : [],
    }
  }
  return endedOutcome(end, 'app', hasConsole, KEPT_NO_OUTPUT)
}

/** One entry of the output folder that Dez checks: a file, or the folder
 *  of a frame sequence (frameSequences.ts), which gives one clip. */
export interface ListedOutput {
  name: string
  frames: boolean
}

/** What Dez found in the output folder of a run. */
export interface ListedOutputs {
  /** The files that Dez reads to check their types, and the frame
   *  sequences that it encodes, in the order of their names
   *  (`frame_2.png` before `frame_10.png`). */
  outputs: ListedOutput[]
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

/** The files of the output folder of a run that Dez reads, and its frame
 *  sequences, from the listing `tree` of the folder with
 *  `APP_OUTPUT_LISTED_ENTRIES`. Only a plain file directly in the folder
 *  counts, with a name that the file selectors take, that is not empty,
 *  and that is not over `APP_RUN_MAX_OUTPUT_BYTES`; and a folder directly
 *  in it whose name ends with `.frames` (`isFramesFolderName`), which
 *  counts as one file. A run with more such entries than
 *  `APP_RUN_MAX_OUTPUT_FILES` keeps none, and neither does a run with more
 *  entries directly in the folder than the listing holds. */
export function listedOutputs(tree: AppsTree): ListedOutputs {
  if (tree.kind !== 'folder') return { outputs: [], notKept: ['the output folder (the app left no folder at its place)'], problem: null }
  const direct = tree.entries.filter((entry) => !entry.path.includes('/'))
  // The entries of the folder itself come first in a listing
  // (`entries_below`, persistence.rs). So a cut listing holds them all when
  // it holds an entry of a folder below.
  if (tree.more && direct.length === tree.entries.length) {
    return {
      outputs: [],
      notKept: [],
      problem: `The app ended with no error, but it put more than ${APP_OUTPUT_LISTED_ENTRIES} files and folders into its output folder, so Dez kept none. ${WRITE_FEWER}`,
    }
  }

  const outputs: ListedOutput[] = []
  const notKept: string[] = []
  const sorted = [...direct].sort((one, other) => one.path.localeCompare(other.path, 'en', { numeric: true }))
  for (const { path: name, kind, size } of sorted) {
    if (!isPathName(name)) {
      notKept.push(`${JSON.stringify(startOf(name, SHOWN_NAME_CHARS))} (a name that Dez does not take: the name of an output file has only ASCII letters, digits, "-", "_", and ".")`)
    } else if (kind === 'folder' && isFramesFolderName(name)) outputs.push({ name, frames: true })
    else if (kind === 'folder') {
      notKept.push(`${name}/ (a folder: Dez keeps only the files directly in the output folder, and a frame sequence in a folder whose name ends with ${FRAMES_FOLDER_ENDING})`)
    } else if (kind !== 'file') notKept.push(`${name} (${kindName(kind)})`)
    else if (size === 0) notKept.push(`${name} (it is empty)`)
    else if (size > APP_RUN_MAX_OUTPUT_BYTES) notKept.push(`${name} (it is larger than ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)}, the most that Dez keeps of one file of a run)`)
    else outputs.push({ name, frames: false })
  }
  if (outputs.length > APP_RUN_MAX_OUTPUT_FILES) {
    return {
      outputs: [],
      notKept: [],
      problem: `The app ended with no error, but it put ${outputs.length} files into its output folder, so Dez kept none. ${WRITE_FEWER}`,
    }
  }
  return { outputs, notKept, problem: null }
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

/** A file of the output folder that Dez keeps. For the clip of a frame
 *  sequence, `name` is the name of its folder, and `frames` has its
 *  facts. */
export type KeptOutput = KeptFile & { frames?: FrameSequence }

/** The files of the output folder of a run, for its result. */
export interface AppOutputs {
  /** The files that Dez keeps, in the order of the assets of the job. */
  kept: readonly KeptOutput[]
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
    const names = kept.map(({ name, kind, frames }) => (frames ? `${name}/ (${ASSET_NAMES[kind]}: ${sequenceText(frames)})` : `${name} (${ASSET_NAMES[kind]})`)).join(', ')
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

/** What the tool calls of the code of a run of a script app (`dez.sbp`)
 *  left (controller/toolBridge.ts), for the result of the run. */
export interface AppRunCalls {
  /** The images and the clips that the calls made, which the job keeps
   *  also when the run fails, each by its handle, in the order of the
   *  handles. Their lines come after the ones of the output folder. */
  made: readonly { kind: JobAssetKind, handle: string }[]
  /** The jobs that the calls started and that are still open, each with
   *  its number (`JobCall.number`). */
  jobs: readonly { id: string, number: number }[]
  /** How many calls had no answer when the run ended. */
  unanswered: number
}

/** The calls of a run whose code made none. */
export const NO_APP_RUN_CALLS: AppRunCalls = { made: [], jobs: [], unanswered: 0 }

// What a result tells of the tool calls `calls` of the code, as its
// paragraphs, for a result whose given text is `given`.
function callParagraphs({ made, jobs, unanswered }: AppRunCalls, given: string): string[] {
  const names = made.map(({ kind, handle }) => `${handle} (${ASSET_NAMES[kind]})`).join(', ')
  const jobLines = openJobLines(jobs, given)
  return [
    ...(made.length === 0 ? [] : [made.length === 1
      ? `Dez keeps the asset that a tool call of the code made: ${names}. Its line at the end gives its id, with its handle.`
      : `Dez keeps the ${made.length} assets that the tool calls of the code made: ${names}. Their lines at the end give their ids, each with its handle.`]),
    ...(jobLines.length === 0 ? [] : [`From the tool calls of the code:\n${jobLines.join('\n')}`]),
    ...cutCallsParagraphs(unanswered),
  ]
}

/** The result of a run of an app with the outcome `outcome`
 *  (`appRunOutcome`) and the console output `log`: what the code returned
 *  or threw, what Dez did with the files of the output folder, what the
 *  tool calls of the code left (`calls`), then the console output. A run
 *  whose outputs have a problem is an error result, which still gives the
 *  value. `forModel` takes the paths of this computer out of a text of the
 *  run (`textForModel`, jsEval.ts, with the folders of the run). */
export function appRunResult(outcome: RunOutcome, log: string, forModel: (text: string) => string, outputs: AppOutputs, calls: AppRunCalls): { text: string, isError: boolean } {
  const told: RunOutcome = outputs.problem === null
    ? outcome
    : { ...outcome, isError: true, lead: `${outputs.problem} ${outcome.lead ?? 'The app returned:'}` }
  return { text: runResultText(told, log, forModel, (given) => [...outputParagraphs(outputs), ...callParagraphs(calls, given)]), isError: told.isError }
}

/** The error result of a run whose files Dez could not get out of the
 *  output folder: the list of the folder failed, or the write of a kept
 *  file into the Dez folder. `toolName` is the tool of the call. */
export function appOutputNotStoredText(toolName: string): string {
  return `The app ended with no error, but Dez could not get the files of its output folder into the Dez folder, so it kept none. ${tellUserConsole(toolName)}`
}

/** A text of the page of a run (its value, its error, its console output)
 *  as a result holds it. The URL of a file of an app reads as the `apps`
 *  tool names the file (`/apps/<app>/main.js`): the stack of an error
 *  names a file by its URL in the scheme of the app frames. A page knows
 *  no path of this computer, but the parameters of a call can hold one,
 *  so the text goes through `textForModel` too. */
export function frameTextForModel(text: string): string {
  return textForModel(text.replaceAll(APP_FRAME_ROOT_URL, `${APPS_VIRTUAL_ROOT}/`), { run: [] })
}

// The outcome of a run of the handler of a page that ended with `end`.
function frameOutcome(end: AppFrameEnd): RunOutcome {
  switch (end.kind) {
    case 'returned':
      return returnedOutcome(end.value, 'app', NO_VALUE)
    case 'threw':
      return { isError: true, lead: `The code of the app threw an error. ${KEPT_NONE} The error:`, given: { text: end.error, name: 'text of the error' }, advice: [] }
    case 'unregistered':
      return failedOutcome(`The page of the app has no handler for a run. ${KEPT_NONE} `
        + `A script of the page must register the handler while the page loads, before its first \`await\`, as in ${APP_HANDLER_EXAMPLE}.`)
    case 'noClient':
      return failedOutcome(`The page of the app loaded, but it did not answer Dez. ${KEPT_NONE} `
        + `The usual cause: ${UI_INDEX_FILE} does not load Dez's script. Put ${UI_CLIENT_SCRIPT_TAG} before the other scripts of the page.`)
    case 'navigated':
      return failedOutcome(`Dez stopped the app: its page loaded again, or went to another page. ${KEPT_NONE} `
        + 'An app is one page: its code must not reload the page, set `location`, or send a form.')
  }
}

// What a result tells of the files that a page saved (their kinds, in the
// order of the saves, which is the order of the assets of the job), as its
// paragraphs.
function savedParagraphs(kinds: readonly JobAssetKind[]): string[] {
  if (kinds.length === 0) return []
  const names = kinds.map((kind) => ASSET_NAMES[kind]).join(', ')
  return [kinds.length === 1
    ? `Dez keeps the 1 file that the app saved (${names}). The line at the end gives its id.`
    : `Dez keeps the ${kinds.length} files that the app saved, in the order of the saves: ${names}. The lines at the end give their ids in this order.`]
}

/** The result of a run of the handler of a page that ended with `end`:
 *  what the handler returned or threw, the files that the page saved
 *  (`saved`: their kinds, in the order of the saves), then the console
 *  output of the page. Only a run whose handler returned keeps its files:
 *  for any other end, give no saved file. */
export function appFrameResult(end: AppFrameEnd, saved: readonly JobAssetKind[]): { text: string, isError: boolean } {
  const outcome = frameOutcome(end)
  const log = 'log' in end ? end.log : ''
  return { text: runResultText(outcome, log, frameTextForModel, () => savedParagraphs(saved)), isError: outcome.isError }
}

/** Throws an `AppCallError` for a save of a page with `size` bytes that
 *  Dez does not take: no bytes, or more than one file of a run can have.
 *  This check reads no byte, so a save that it refuses does not count
 *  (`SaveCount`). */
export function checkSaveSize(size: number): void {
  if (size === 0) throw new AppCallError('Dez saved nothing: the save has no bytes.')
  if (size > APP_RUN_MAX_OUTPUT_BYTES) {
    throw new AppCallError(`Dez saved nothing: the file has ${byteSizeText(size)}, and an app can save at most ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)} in one file.`)
  }
}

/** The saves of one run of a page that got past the size check, counted.
 *  A save of a type that Dez refuses counts too: Dez read its bytes. */
export class SaveCount {
  private taken = 0

  /** Counts one save. Throws an `AppCallError` for a save over
   *  `APP_RUN_MAX_OUTPUT_FILES`. */
  take(): void {
    if (this.taken >= APP_RUN_MAX_OUTPUT_FILES) {
      throw new AppCallError(`Dez saved nothing: an app can save at most ${APP_RUN_MAX_OUTPUT_FILES} files in one run, and this run has used them.`)
    }
    this.taken += 1
  }
}

/** The type of a save of a page with the bytes `bytes`, which their first
 *  bytes tell, never a name or the type of the Blob. Throws an
 *  `AppCallError` for bytes of a type that Dez does not store. */
export function savedFileType(bytes: Uint8Array): StoredFileType {
  const type = storedTypeOfBytes(bytes)
  if (type === null) {
    throw new AppCallError('Dez saved nothing: the bytes are no file of a type that Dez stores. '
      + `Dez reads the type from the first bytes, and it stores only these types ${STORED_TYPES}.`)
  }
  return type
}
