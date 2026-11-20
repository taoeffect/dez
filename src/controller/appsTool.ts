import sbp from '@sbp/sbp'
import {
  appOf,
  APPS_MAX_ENTRIES,
  APPS_ROOT,
  checkAppRoom,
  checkInitTarget,
  checkTextFile,
  editCall,
  editResult,
  fileText,
  hasReadableManifest,
  isReadableManifest,
  initCall,
  initText,
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
  parentOf,
  pathIn,
  readCall,
  readText,
  RM_LISTED_ENTRIES,
  rmCall,
  rmResult,
  rmStep,
  writeCall,
  writePlan,
  writeText,
  type AppsPath,
  type ItemOutcome,
  type ListedApp,
} from '../model/tools/appsTool'
import { MANIFEST_FILE } from '../model/tools/appManifest'
import { appNotShownText, checkShowTarget, showCall, showResultText } from '../model/tools/appShow'
import { ToolError, type SubcommandArguments } from '../model/tools/types'
import { rawErrorText } from '../utils/errorText'
import type { AppFileEntry, FileTree } from './nativeTypes'

// The file work of the `apps` tool (model/tools/appsTool.ts): each function
// runs one subcommand on the folder `apps/` of the app root, through the
// native file selectors. The model module checks the call, decides what to
// do from what is at the paths, and builds every text; the functions here
// only ask the native side and do what the model module decided. The run
// of an app (`invoke`) is in appInvoke.ts. `show` changes no file: it
// checks the files of the app, and the reply of its call writes the app
// into itself.
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

// What is at `path`, and at most `maxEntries` of the entries below it.
function treeOf(path: AppsPath, maxEntries: number): Promise<FileTree> {
  return native(`list ${path.virtual}`, () => sbp('dez.native/listFileTree', path.file, maxEntries) as Promise<FileTree>)
}

/** What is at the path `path` of the apps, with nothing of what is below
 *  it. Throws a `ToolError` when the native side fails. */
export function factsOf(path: AppsPath): Promise<FileTree> {
  return treeOf(path, 0)
}

/** The bytes of the file at the path `path` of the apps. The native side
 *  reads a file of any size: check its size first (`factsOf`). Throws a
 *  `ToolError` for a read that fails. */
export function readBytes(path: AppsPath): Promise<Uint8Array> {
  return native(`read ${path.virtual}`, () => sbp('dez.native/loadAppFileBytes', path.file) as Promise<Uint8Array>)
}

function save(path: AppsPath, content: string | Uint8Array): Promise<void> {
  return native(`write ${path.virtual}`, () => sbp('dez.native/saveAppFile', path.file, content) as Promise<void>)
}

// Makes a folder and the missing ones above it, for the user only. A save
// or a move would make them too, but for everyone to read.
function makeFolder(path: AppsPath): Promise<void> {
  return native(`make the folder ${path.virtual}`, () => sbp('dez.native/createFolder', path.file) as Promise<void>)
}

// Runs `work` for each item of a call, one after the other. An item whose
// work throws a `ToolError` failed by itself: the next ones still run. A
// stop of the reply (`signal`) ends the call before the next item: nobody
// reads the result then, and the user who stopped the reply wants no more
// deletes and moves.
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
    await (sbp('dez.native/deleteAppFile', call.app.file, 'app', { folder: true }) as Promise<void>)
      .catch((cleanupError: unknown) => console.error(`apps tool: Dez could not delete the half-made app ${call.app.virtual}:`, cleanupError))
    throw error
  }
  return initText(call)
}

/** `apps read`. The size check comes before the read: the native side
 *  reads a file of any size. */
export async function readAppFile(args: SubcommandArguments): Promise<AppsResult> {
  const call = readCall(args)
  checkTextFile(call.path, await factsOf(call.path))
  const bytes = await readBytes(call.path)
  return readText(call, fileText(call.path, bytes), bytes.length)
}

/** `apps write`. */
export async function writeAppFile(args: SubcommandArguments): Promise<AppsResult> {
  const call = writeCall(args)
  const [target, app] = await Promise.all([factsOf(call.path), treeOf(appOf(call.path), APPS_MAX_ENTRIES)])
  const plan = writePlan(call, target, app)
  if (plan.folder) await makeFolder(plan.folder)
  await save(call.path, call.bytes)
  return writeText(call, plan.replaced)
}

/** `apps edit`. It writes only when an edit changed a line, and it lists
 *  the app only when the file grows. */
export async function editAppFile(args: SubcommandArguments): Promise<AppsResult> {
  const call = editCall(args)
  checkTextFile(call.path, await factsOf(call.path))
  const before = await readBytes(call.path)
  const { content, isError, bytes } = editResult(call, fileText(call.path, before))
  if (bytes) {
    const app = appOf(call.path)
    if (bytes.length > before.length) checkAppRoom(app, await treeOf(app, APPS_MAX_ENTRIES), { entries: 0, bytes: bytes.length - before.length })
    await save(call.path, bytes)
  }
  return { content, isError }
}

/** `apps rm`. */
export async function removeAppPaths(args: SubcommandArguments, signal: AbortSignal): Promise<AppsResult> {
  const { paths } = rmCall(args)
  return rmResult(await eachByItself(paths, signal, async (path) => {
    const step = rmStep(path, await treeOf(path, RM_LISTED_ENTRIES))
    await native(`delete ${path.virtual}`, () => sbp('dez.native/deleteAppFile', path.file, 'app', { folder: step.folder }) as Promise<void>)
    return step.text
  }))
}

/** `apps mv`. The moves run one after the other, so a later move of the
 *  call sees what an earlier one did. */
export async function moveAppPaths(args: SubcommandArguments, signal: AbortSignal): Promise<AppsResult> {
  const { moves } = mvCall(args)
  return mvResult(await eachByItself(moves, signal, async (move) => {
    const { from, to } = move
    const [source, target, app, parent] = await Promise.all([from, to, appOf(to), parentOf(to)].map(factsOf))
    const step = moveStep(move, { source, target, app, parent })
    if (step.folder) await makeFolder(step.folder)
    await native(`move ${from.virtual} to ${to.virtual}`, () => sbp('dez.native/moveAppFile', { root: 'app', path: from.file }, { root: 'app', path: to.file }) as Promise<void>)
    return step.text
  }))
}

/** `apps mkdir`. */
export async function makeAppFolder(args: SubcommandArguments): Promise<AppsResult> {
  const { path } = mkdirCall(args)
  const [target, app] = await Promise.all([factsOf(path), treeOf(appOf(path), APPS_MAX_ENTRIES)])
  const step = mkdirStep(path, target, app)
  if (step.make) await makeFolder(path)
  return step.text
}

/** `apps ls`. */
export async function listAppFolder(args: SubcommandArguments): Promise<AppsResult> {
  const { path } = lsCall(args)
  return lsText(path, await treeOf(path, LS_MAX_ENTRIES))
}

/** `apps list_apps`: one listing for each folder of `apps/`, for its size,
 *  and one read of its manifest. */
export async function listApps(args: SubcommandArguments): Promise<AppsResult> {
  const call = listAppsCall(args)
  const folders = await native('list the apps', () => sbp('dez.native/listAppFiles', APPS_ROOT.file, 'app', { folders: true }) as Promise<AppFileEntry[]>)
  const apps = await Promise.all(folders.map(async ({ name }): Promise<ListedApp> => {
    const app = pathIn(APPS_ROOT, name)
    const tree = await treeOf(app, APPS_MAX_ENTRIES)
    const manifest = hasReadableManifest(tree) ? await readBytes(pathIn(app, MANIFEST_FILE)) : null
    return { name, tree, manifest }
  }))
  return listAppsText(call, apps)
}

/** `apps show`: checks that the app is a UI app with its page
 *  (`checkShowTarget`), each fact from one exact read of its path, and
 *  then has the reply of the call write the tag of the app into itself
 *  (`reply.showApp`, `ToolRunContext.showApp`). Throws a `ToolError` for
 *  an app that Dez cannot show, and for a reply that takes no text any
 *  more. */
export async function showApp(args: SubcommandArguments, reply: { showApp(name: string): boolean }): Promise<AppsResult> {
  const call = showCall(args)
  const [app, manifest, index] = await Promise.all([call.app, call.manifest, call.index].map(factsOf))
  // The native side reads a file of any size, so the size check is first.
  const manifestBytes = isReadableManifest(manifest) ? await readBytes(call.manifest) : null
  checkShowTarget(call, { app, manifest, manifestBytes, index })
  if (!reply.showApp(call.name)) throw new ToolError(appNotShownText())
  return showResultText(call.name)
}
