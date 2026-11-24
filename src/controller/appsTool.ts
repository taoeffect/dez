import sbp from '@sbp/sbp'
import {
  APPS_MAX_ENTRIES,
  APPS_ROOT,
  appsRootTree,
  BUILT_IN_APPS_FOLDER,
  capsHold,
  checkAppRoom,
  checkInitTarget,
  checkTextFile,
  editCall,
  editResult,
  fileText,
  findCall,
  findText,
  hasReadableManifest,
  initCall,
  initText,
  isAppFolder,
  isReadableManifest,
  itemFailureText,
  listAppsCall,
  listAppsText,
  LS_MAX_ENTRIES,
  lsCall,
  lsText,
  mkdirCall,
  mkdirStep,
  moveStep,
  mvCall,
  mvResult,
  nativeFailure,
  pathIn,
  readCall,
  readText,
  RM_LISTED_ENTRIES,
  rmCall,
  rmResult,
  rmStep,
  unitOf,
  wcCall,
  wcResult,
  wcRowOfBytes,
  wcRowOfFacts,
  writeCall,
  writePlan,
  writeText,
  type AppsPath,
  type ItemOutcome,
  type ListedApp,
  type PathFacts,
} from '../model/tools/appsTool'
import { isBuiltInApp, MANIFEST_FILE } from '../model/tools/appManifest'
import { grepCall, grepPlan, grepRequest, grepText, grepTimeoutError } from '../model/tools/appsGrep'
import { appNotShownText, checkShowTarget, showCall, showResultText, type ShowCall, type ShowTarget } from '../model/tools/appShow'
import { grepFiles, GREP_TIME_LIMIT_SECONDS, type GrepOutcome, type GrepRequest } from '../model/tools/grepMatch'
import { ToolError, type SubcommandArguments } from '../model/tools/types'
import { rawErrorText } from '../utils/errorText'
import type { AppFileEntry, FileTree } from './nativeTypes'

// The file work of the `apps` tool (model/tools/appsTool.ts): each function
// runs one subcommand through the native file selectors, on the three top
// folders of a path (`AppsPath`): `/apps` (the folder `apps/` of the app
// root, and the built-in apps in the files that Dez ships), `/libs` (the
// libraries that Dez ships, only to read), and `/work` (the work folder of
// the conversation). The model module checks the call, decides what to do
// from what is at the paths, and builds every text; the functions here
// only ask the native side and do what the model module decided. The run
// of an app (`invoke`) is in appInvoke.ts. `show` changes no file: it
// checks the files of the app, and the reply of its call writes the app
// into itself. `grep` matches the lines of the files in a Web Worker
// (grepWorker.ts), with a time limit.
//
// A check and the file operation after it are two native calls, so a
// program that changes the folder between them can make the operation
// fail. The native side then refuses on its own (it replaces no folder,
// and follows no link), and the call gets `nativeFailure`.

/** The result of a subcommand: its text, or a result that is an error
 *  with more than its text. */
type AppsResult = string | { content: string, isError: boolean }

// One native call. A failure is a `ToolError` that tells the model what
// Dez tried (`what`, as in `read /apps/a/main.js`); the raw text goes to
// the log, and to the model with no local path.
async function native<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    console.error(`apps tool: Dez could not ${what}:`, error)
    throw nativeFailure(what, rawErrorText(error))
  }
}

// What is at `path`, and at most `maxEntries` of the entries below it. The
// folder of all apps is two folders: the apps of the user and the built-in
// apps (`appsRootTree`).
async function treeOf(path: AppsPath, maxEntries: number): Promise<FileTree> {
  const listing = (file: string, root: AppsPath['root']) => native(`list ${path.virtual}`, () => sbp('dez.native/listFileTree', file, maxEntries, root) as Promise<FileTree>)
  if (path.top.place !== 'apps' || path.names.length > 0) return listing(path.file, path.root)
  const [own, builtIn] = await Promise.all([listing(path.file, path.root), listing(BUILT_IN_APPS_FOLDER, 'resource')])
  return appsRootTree(own, builtIn, maxEntries)
}

/** What is at the path `path` of the apps, with nothing of what is below
 *  it. Throws a `ToolError` when the native side fails. */
export function factsOf(path: AppsPath): Promise<FileTree> {
  return treeOf(path, 0)
}

/** The listing of the app at `app`, with as many entries as an app can
 *  have: for its size (`appSize`) and the room that it has left. Throws a
 *  `ToolError` when the native side fails. */
export function appTreeOf(app: AppsPath): Promise<FileTree> {
  return treeOf(app, APPS_MAX_ENTRIES)
}

// The listing of the unit of `path` (`unitOf`: its app, or the top
// folder), as a change at `path` reads it (`writePlan`, `mkdirStep`,
// `moveStep`).
function unitTreeOf(path: AppsPath): Promise<FileTree> {
  return appTreeOf(unitOf(path))
}

// The bytes of the file at the path `path` of the apps. The native side
// reads a file of any size: check its size first (`factsOf`). Throws a
// `ToolError` for a read that fails.
function readBytes(path: AppsPath): Promise<Uint8Array> {
  return native(`read ${path.virtual}`, () => sbp('dez.native/loadAppFileBytes', path.file, path.root) as Promise<Uint8Array>)
}

/** The bytes of the manifest file at `path`, whose facts are `facts`; null
 *  when Dez does not read it (`isReadableManifest`). The native side reads
 *  a file of any size, so the size check is first. Throws a `ToolError`
 *  for a read that fails. */
export async function readableManifestBytes(path: AppsPath, facts: PathFacts): Promise<Uint8Array | null> {
  return isReadableManifest(facts) ? await readBytes(path) : null
}

function save(path: AppsPath, content: string | Uint8Array): Promise<void> {
  return native(`write ${path.virtual}`, () => sbp('dez.native/saveAppFile', path.file, content, path.root) as Promise<void>)
}

// Makes a folder and the missing ones above it, for the user only. A save
// or a move would make them too, but for everyone to read.
function makeFolder(path: AppsPath): Promise<void> {
  return native(`make the folder ${path.virtual}`, () => sbp('dez.native/createFolder', path.file, path.root) as Promise<void>)
}

// Runs `work` for each item of a call, one after the other. An item whose
// work throws a `ToolError` failed by itself: the next ones still run. A
// stop of the reply (`signal`) ends the call before the next item: nobody
// reads the result then, and the user who stopped the reply wants no more
// work of it (deletes, moves, reads).
async function eachByItself<T>(items: readonly T[], signal: AbortSignal, work: (item: T) => Promise<string>): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = []
  for (const item of items) {
    signal.throwIfAborted()
    try {
      outcomes.push({ done: true, text: await work(item) })
    } catch (error) {
      if (!(error instanceof ToolError)) throw error
      outcomes.push({ done: false, text: itemFailureText(error) })
    }
  }
  return outcomes
}

/** `apps init`: makes the folder of a new app, for the user only, and
 *  writes the files of its template. A failed write takes the folder away
 *  again, so that the name is free for the next call. */
export async function initApp(args: SubcommandArguments): Promise<AppsResult> {
  const call = initCall(args)
  checkInitTarget(call, await factsOf(call.app))
  await makeFolder(call.app)
  try {
    for (const file of call.files) await save(file.path, file.content)
  } catch (error) {
    await (sbp('dez.native/deleteAppFile', call.app.file, call.app.root, { folder: true }) as Promise<void>)
      .catch((cleanupError: unknown) => console.error(`apps tool: Dez could not delete the half-made app ${call.app.virtual}:`, cleanupError))
    throw error
  }
  return initText(call)
}

/** `apps read`. The size check comes before the read: the native side
 *  reads a file of any size. */
export async function readAppFile(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const call = readCall(args, conversationId)
  checkTextFile(call.path, await factsOf(call.path))
  const bytes = await readBytes(call.path)
  return readText(call, fileText(call.path, bytes), bytes.length)
}

/** `apps write`. */
export async function writeAppFile(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const call = writeCall(args, conversationId)
  const [target, unit] = await Promise.all([factsOf(call.path), unitTreeOf(call.path)])
  const plan = writePlan(call, target, unit)
  if (plan.folder) await makeFolder(plan.folder)
  await save(call.path, call.bytes)
  return writeText(call, plan.replaced)
}

/** `apps edit`. It writes only when an edit changed the text, and it lists
 *  the app only when the file grows. */
export async function editAppFile(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const call = editCall(args, conversationId)
  checkTextFile(call.path, await factsOf(call.path))
  const before = await readBytes(call.path)
  const { content, isError, bytes } = editResult(call, fileText(call.path, before))
  if (bytes) {
    if (bytes.length > before.length && capsHold(call.path)) {
      checkAppRoom(unitOf(call.path), await unitTreeOf(call.path), { entries: 0, bytes: bytes.length - before.length })
    }
    await save(call.path, bytes)
  }
  return { content, isError }
}

/** `apps rm`. A delete of a whole app tells the editor
 *  (`dez.editor/appDeleted`), as the trash of its card does: the runs of
 *  the app end, and its cards tell that it is gone. */
export async function removeAppPaths(args: SubcommandArguments, signal: AbortSignal, conversationId: string): Promise<AppsResult> {
  const { paths } = rmCall(args, conversationId)
  return rmResult(await eachByItself(paths, signal, async (path) => {
    const step = rmStep(path, await treeOf(path, RM_LISTED_ENTRIES))
    await native(`delete ${path.virtual}`, () => sbp('dez.native/deleteAppFile', path.file, path.root, { folder: step.folder }) as Promise<void>)
    if (isAppFolder(path)) sbp('dez.editor/appDeleted', path.names[0])
    return step.text
  }))
}

/** `apps mv`. The moves run one after the other, so a later move of the
 *  call sees what an earlier one did. A move of a whole app tells the
 *  editor that the app of the old name is gone, as `rm` does. */
export async function moveAppPaths(args: SubcommandArguments, signal: AbortSignal, conversationId: string): Promise<AppsResult> {
  const { moves } = mvCall(args, conversationId)
  return mvResult(await eachByItself(moves, signal, async (move) => {
    const { from, to } = move
    const [source, target, unit] = await Promise.all([factsOf(from), factsOf(to), unitTreeOf(to)])
    const step = moveStep(move, { source, target, unit })
    if (step.folder) await makeFolder(step.folder)
    await native(`move ${from.virtual} to ${to.virtual}`, () => sbp('dez.native/moveAppFile', { root: from.root, path: from.file }, { root: to.root, path: to.file }) as Promise<void>)
    if (isAppFolder(from)) sbp('dez.editor/appDeleted', from.names[0])
    return step.text
  }))
}

/** `apps mkdir`. */
export async function makeAppFolder(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const { path } = mkdirCall(args, conversationId)
  const [target, unit] = await Promise.all([factsOf(path), unitTreeOf(path)])
  const step = mkdirStep(path, target, unit)
  if (step.make) await makeFolder(path)
  return step.text
}

/** `apps ls`. */
export async function listAppFolder(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const { path } = lsCall(args, conversationId)
  return lsText(path, await treeOf(path, LS_MAX_ENTRIES))
}

/** `apps find`: one listing of the folder, as `ls` asks for. */
export async function findAppFiles(args: SubcommandArguments, conversationId: string): Promise<AppsResult> {
  const call = findCall(args, conversationId)
  return findText(call, await treeOf(call.path, LS_MAX_ENTRIES))
}

// How many files `grep` reads at once.
const GREP_PARALLEL_READS = 8

// The bytes of the files at `paths`, in their order, `GREP_PARALLEL_READS`
// reads at a time. A stop of the reply ends the reads before the next one.
// A failed read ends them all: the call fails with it.
async function readEach(paths: readonly AppsPath[], signal: AbortSignal): Promise<Uint8Array[]> {
  const bytes: Uint8Array[] = []
  let next = 0
  let failed = false
  const reader = async () => {
    while (next < paths.length && !failed) {
      signal.throwIfAborted()
      const index = next
      next += 1
      try {
        bytes[index] = await readBytes(paths[index])
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(GREP_PARALLEL_READS, paths.length) }, reader))
  return bytes
}

// Runs `grepFiles` on `request` in a Web Worker (grepWorker.ts), so that a
// slow regular expression cannot stop the window, and gives its outcome:
// null when the matching runs for more than `GREP_TIME_LIMIT_SECONDS`.
// The end of the work, the time limit, a stop of the reply, and a request
// that the worker cannot take each end the worker. The bytes of the files
// move to the worker: the caller must not read them after the call.
function grepInWorker(request: GrepRequest, signal: AbortSignal): Promise<GrepOutcome | null> {
  signal.throwIfAborted()
  // Vite finds and bundles the worker only in this form: `new URL` with a
  // literal path, right in `new Worker`, with literal options. Keep it.
  // https://vite.dev/guide/features.html#web-workers
  const worker = new Worker(new URL('./grepWorker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const end = (settle: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      settle()
    }
    const onAbort = () => end(() => reject(signal.reason))
    const timer = setTimeout(() => end(() => resolve(null)), GREP_TIME_LIMIT_SECONDS * 1000)
    signal.addEventListener('abort', onAbort)
    worker.onmessage = (event: MessageEvent<GrepOutcome>) => end(() => resolve(event.data))
    worker.onerror = (event) => end(() => reject(new Error(`The search worker failed: ${event.message || 'it did not start'}`)))
    worker.onmessageerror = () => end(() => reject(new Error('The search worker gave an outcome that Dez cannot read')))
    // Two files never share a buffer (`dez.native/loadAppFileBytes` gives
    // each its own), but a transfer list must not name one twice.
    const buffers = new Set(request.files.map((file) => file.bytes.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))
    // `postMessage` throws when it cannot copy or move the request (a
    // `DataCloneError`, as for a detached buffer).
    try {
      worker.postMessage(request, [...buffers])
    } catch (error) {
      end(() => reject(error))
    }
  })
}

/** `apps grep`: one listing of the path, as `ls` asks for, the reads of the
 *  files that `grepPlan` picks, and the matching in a worker. A stop of
 *  the reply ends the reads and the matching. */
export async function grepAppFiles(args: SubcommandArguments, signal: AbortSignal, conversationId: string): Promise<AppsResult> {
  const call = grepCall(args, conversationId)
  const plan = grepPlan(call, await treeOf(call.path, LS_MAX_ENTRIES))
  if (plan.kind === 'text') return plan.text
  const request = grepRequest(call, plan.files, await readEach(plan.files.map((file) => file.path), signal))
  // With no file to search, the outcome is the empty one: no worker.
  if (request.files.length === 0) return grepText(call, plan, grepFiles(request))

  let outcome: GrepOutcome | null
  try {
    outcome = await grepInWorker(request, signal)
  } catch (error) {
    if (signal.aborted) throw error
    console.error('apps tool: Dez could not search the files:', error)
    throw nativeFailure('search the files', rawErrorText(error))
  }
  if (outcome === null) throw grepTimeoutError()
  return grepText(call, plan, outcome)
}

/** `apps wc`: what is at each path, then the bytes of each file of at most
 *  `APPS_MAX_FILE_BYTES` (`wcRowOfFacts`), one file at a time, so that the
 *  webview holds at most one such file. A stop of the reply ends the call
 *  before the next path. */
export async function wcAppFiles(args: SubcommandArguments, signal: AbortSignal, conversationId: string): Promise<AppsResult> {
  const { paths } = wcCall(args, conversationId)
  return wcResult(await eachByItself(paths, signal, async (path) => wcRowOfFacts(path, await factsOf(path)) ?? wcRowOfBytes(path, await readBytes(path))))
}

/** `apps list_apps`: one listing for each app, for its size, and one read
 *  of its manifest. The apps are the folders of `apps/` and the built-in
 *  apps, each place with only its own names (`appsRootTree`). */
export async function listApps(args: SubcommandArguments): Promise<AppsResult> {
  const call = listAppsCall(args)
  const [own, builtIn] = await Promise.all([
    native('list the apps', () => sbp('dez.native/listAppFiles', APPS_ROOT.file, APPS_ROOT.root, { folders: true }) as Promise<AppFileEntry[]>),
    native('list the apps', () => sbp('dez.native/listAppFiles', BUILT_IN_APPS_FOLDER, 'resource', { folders: true }) as Promise<AppFileEntry[]>),
  ])
  const names = [...builtIn.map(({ name }) => name).filter(isBuiltInApp), ...own.map(({ name }) => name).filter((name) => !isBuiltInApp(name))]
  const apps = await Promise.all(names.map(async (name): Promise<ListedApp> => {
    const app = pathIn(APPS_ROOT, name)
    const tree = await appTreeOf(app)
    const manifest = hasReadableManifest(tree) ? await readBytes(pathIn(app, MANIFEST_FILE)) : null
    return { name, tree, manifest }
  }))
  return listAppsText(call, apps)
}

/** What is at the paths of the app of `call`, each from one exact read of
 *  its path. Throws a `ToolError` when the native side fails. */
export async function showTargetOf(call: ShowCall): Promise<ShowTarget> {
  const [app, manifest, index] = await Promise.all([call.app, call.manifest, call.index].map(factsOf))
  return { app, manifest, manifestBytes: await readableManifestBytes(call.manifest, manifest), index }
}

/** `apps show`: checks that the app is a UI app with its page
 *  (`checkShowTarget`), and then has the reply of the call write the tag
 *  of the app into itself (`reply.showApp`, `ToolRunContext.showApp`).
 *  Throws a `ToolError` for an app that Dez cannot show, and for a reply
 *  that takes no text any more. */
export async function showApp(args: SubcommandArguments, reply: { showApp(name: string): boolean }): Promise<AppsResult> {
  const call = showCall(args)
  checkShowTarget(call, await showTargetOf(call))
  if (!reply.showApp(call.name)) throw new ToolError(appNotShownText())
  return showResultText(call.name)
}
