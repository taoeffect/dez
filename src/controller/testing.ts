import sbp from '@sbp/sbp'
import { expect, vi } from 'vitest'
import type { Tab } from '../model/chat/types'
import { NO_CALL_PICTURE_BUDGET } from '../model/streams/pictureBudget'
import { appManifestText, type AppKind } from '../model/tools/appManifest'
import type { JsEvalLine } from '../model/tools/jsEval'
import { CONVERSATION_ID, protocolLine } from '../model/tools/testing'
import { ToolError, type ToolRunResult } from '../model/tools/types'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import { TabJobs, type JobOutcome, type JobWork, type MadeAsset, type ToolJobs } from './jobs'
import type { AppFileEntry, AppFileRef, BundledToolEnd, BundledToolOutput, BundledToolRun, FileTree } from './nativeTypes'
import type { ToolRunCall, ToolRunContext } from './tools'

// Shared helpers of the unit tests of the controller code that runs the
// programs that Dez ships (videoTool.ts, audioTool.ts, jsEval.ts, the
// frame sheets of compaction.ts, and the tool calls of tools.ts and
// stream.ts), the file work of the `apps` tool (appsTool.ts) and the runs
// of its apps (appInvoke.ts), and the jobs of a reply (jobs.ts): a stub of
// the native side, a fake of the files of the app root (`fakeAppFiles`,
// with the files of an app from `appFiles`), the outputs of the programs,
// and helpers for the work of a call or a job.
//
// An import of this module registers the stub selectors of the app
// folders, the resource folder, the real paths, the files, the downloads,
// and the program runs (`dez.native/*`, `dez.controller/images/fileSize`,
// and `dez.provider/chatImageSizes`), so a test file must register none of
// them. Each test starts with `resetNative()`.

export const APP_DIR = '/home/u/.config/dez'
export const CACHE_DIR = '/home/u/.cache/dez'
export const RESOURCE_DIR = '/usr/lib/Dez'
/** The end of a program run with no error. */
export const ENDED: BundledToolEnd = { kind: 'exited', code: 0 }
/** The answer of a download that wrote its file. */
export const SAVED: NativeHttpDownload = { status: 200, statusText: 'OK', headers: {}, saved: true, body: [] }
/** The id in the name of a file that Dez stored. */
export const FILE_ID = /[0-9a-f-]{36}/
/** The reason of the stop of a call. */
export const STOP = new Error('The reply stopped.')
/** The path of the work folder of the conversation of `callContext` in the
 *  app root. */
export const CONVERSATION_WORK_FOLDER = `work/${CONVERSATION_ID}`

const WORK_FOLDER = /^work\/[0-9a-f-]{36}$/

/** What the stub does for one run of a program. */
export type StubProgram = (run: BundledToolRun, onOutput: (output: BundledToolOutput) => void) => Promise<BundledToolEnd>

interface StubDownload {
  request: NativeHttpRequest
  requestId: string
  file: AppFileRef
  rule: NativeDownloadRule
}

// The stub at the start of a test: every list is empty, and every action
// passes.
function newNative() {
  return {
    runs: [] as { run: BundledToolRun, runId: string }[],
    program: (async () => ENDED) as StubProgram,
    cancelledRuns: [] as string[],
    inputWrites: [] as { runId: string, text: string }[],
    // The files of every work folder after a run, and the size of each.
    folderFiles: [] as string[],
    folderFileSize: 10,
    // The entries of a folder; null for `folderFiles`.
    folderEntries: ((): AppFileEntry[] | null => null) as (file: AppFileRef, folders: boolean) => AppFileEntry[] | null,
    listedFolders: [] as AppFileRef[],
    moves: [] as { from: AppFileRef, to: AppFileRef }[],
    moveAppFile: (async () => {}) as (from: AppFileRef, to: AppFileRef) => Promise<void>,
    savedFiles: [] as { file: AppFileRef, content: string | Uint8Array }[],
    saveAppFile: (async () => {}) as (file: AppFileRef, content: string | Uint8Array) => Promise<void>,
    deletedFiles: [] as (AppFileRef & { folder: boolean })[],
    deleteAppFile: (async () => {}) as (file: AppFileRef & { folder: boolean }) => Promise<void>,
    createdFolders: [] as AppFileRef[],
    createFolder: (async () => {}) as (file: AppFileRef) => Promise<void>,
    // What is at a path, and at most `maxEntries` of what is below it;
    // nothing is at a path that a test does not set.
    fileTree: ((): FileTree => ({ kind: 'missing', size: 0, updatedAt: null, entries: [], more: false })) as (file: AppFileRef, maxEntries: number) => FileTree,
    downloads: [] as StubDownload[],
    downloadAppFile: (async () => SAVED) as () => Promise<NativeHttpDownload>,
    cancelledDownloads: [] as string[],
    // The size of a file of the computer; null for one that is gone.
    fileSize: ((): number | null => 10) as (path: string) => number | null,
    // How many bytes a chat request sends for an image
    // (`dez.provider/chatImageSizes`); null for one that Dez cannot send.
    sentImageBytes: ((): number | null => 10) as (path: string) => number | null,
    readFiles: [] as AppFileRef[],
    // The bytes of a file that the code reads (a picture that a program
    // wrote); a throw for one that is not there.
    fileBytes: ((): Uint8Array => new Uint8Array([0xff, 0xd8])) as (file: AppFileRef) => Uint8Array,
    // The path of a file of the resource folder; a throw for a folder that
    // Dez cannot find.
    resourcePath: ((relative: string): string => `${RESOURCE_DIR}/${relative}`) as (relative: string) => string,
    // The real path of a file or a folder; a throw for one that is not
    // there.
    canonicalPath: ((path: string): string => path) as (path: string) => string,
  }
}

/** The stub native side. Each list holds what the code under test asked
 *  for, and each function what the native side then does: a test sets the
 *  ones that it needs. */
export const native = newNative()

/** Puts the stub native side back to its start. */
export function resetNative(): void {
  Object.assign(native, newNative())
}

/** The files of the app root of a test: the bytes of each file by its path
 *  from the root (`apps/notes/main.js`), and null for a folder. */
export type FakeAppFiles = Map<string, Uint8Array | null>

// The folder that holds `path`; empty for a path directly in the root.
function folderOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}

function isAtOrBelow(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

// Where the native side makes, moves, and deletes a folder of the app
// root: only below the folder of the apps and the folder of the work
// folders of the conversations (`allows_folder_change`).
function allowsFolderChange(path: string): boolean {
  return path.startsWith('apps/') || path.startsWith('work/')
}

/** Makes the stub native side keep the files of the app root and of the
 *  resource root in memory, and work on them as the native side works on
 *  the disk (src-tauri/src/persistence.rs), for the tests of code whose
 *  result depends on what its earlier file calls did. Call it after
 *  `resetNative()`. `start` has the text of each file of the app root by
 *  its path from the root, and null for an empty folder; the folders above
 *  each path are there too. `resources` has the files of the resource
 *  root in the same form (`builtInAppFiles`). A test reads and changes the
 *  files of the app root in the map that it gets. A call on the cache root
 *  does what the stub did before.
 *
 *  What it keeps of the native rules:
 *  - a tree listing gives the direct entries first, at most as many as
 *    the call asks for, and tells when there are more;
 *  - nothing is at a path below a file, and a read of what is no file
 *    fails;
 *  - a save and a move make the missing folders above their target;
 *  - a delete of nothing passes, and one with the wrong `folder` fails;
 *  - a file moves over a file, and a folder only to a free path;
 *  - a folder is made, moved, and deleted only below `apps/` and `work/`;
 *  - every save, folder, delete, and move on the resource root fails. */
export function fakeAppFiles(start: Record<string, string | null> = {}, resources: Record<string, string | null> = {}): FakeAppFiles {
  const roots = { app: new Map(), resource: new Map() } as Record<'app' | 'resource', FakeAppFiles>
  const encoder = new TextEncoder()
  // As `mkdir -p`.
  const makeFolders = (files: FakeAppFiles, path: string): void => {
    if (!path) return
    makeFolders(files, folderOf(path))
    const there = files.get(path)
    if (there === undefined) files.set(path, null)
    else if (there !== null) throw new Error(`Not a directory (os error 20): ${path}`)
  }
  const put = (files: FakeAppFiles, path: string, content: string | Uint8Array | null): void => {
    makeFolders(files, content === null ? path : folderOf(path))
    if (content !== null) files.set(path, typeof content === 'string' ? encoder.encode(content) : content.slice())
  }
  for (const [path, content] of Object.entries(start)) put(roots.app, path, content)
  for (const [path, content] of Object.entries(resources)) put(roots.resource, path, content)
  // The files of a root that the fake keeps; undefined for the cache root.
  const filesOf = (file: AppFileRef): FakeAppFiles | undefined => (file.root === 'cache' ? undefined : roots[file.root])
  // The files of a root that a change can reach, as `writable_file_path`.
  const changeable = (file: AppFileRef): FakeAppFiles => {
    if (file.root === 'resource') throw new Error(`Failed to change ${file.path}: the files that Dez ships cannot change`)
    return roots.app
  }

  const before = { ...native }
  native.fileTree = (file, maxEntries) => {
    const files = filesOf(file)
    if (!files) return before.fileTree(file, maxEntries)
    const at = files.get(file.path)
    if (at === undefined) return { kind: 'missing', size: 0, updatedAt: null, entries: [], more: false }
    if (at !== null) return { kind: 'file', size: at.length, updatedAt: 0, entries: [], more: false }
    const depth = (path: string) => path.split('/').length
    const below = [...files]
      .filter(([path]) => path.startsWith(`${file.path}/`))
      .map(([path, content]) => ({ path: path.slice(file.path.length + 1), kind: content === null ? 'folder' as const : 'file' as const, size: content?.length ?? 0, updatedAt: 0 }))
      .sort((a, b) => depth(a.path) - depth(b.path))
    return { kind: 'folder', size: 0, updatedAt: 0, entries: below.slice(0, maxEntries), more: below.length > maxEntries }
  }
  native.fileBytes = (file) => {
    const files = filesOf(file)
    if (!files) return before.fileBytes(file)
    const at = files.get(file.path)
    if (at === undefined) throw new Error(`Failed to read ${file.path}: No such file or directory (os error 2)`)
    if (at === null) throw new Error(`Failed to read ${file.path}: not a regular file`)
    return at.slice()
  }
  native.folderEntries = (file, folders) => {
    const files = filesOf(file)
    if (!files) return before.folderEntries(file, folders)
    return [...files]
      .filter(([path, content]) => folderOf(path) === file.path && (content === null) === folders)
      .map(([path, content]) => ({ name: path.slice(file.path.length + 1), updatedAt: 0, size: content?.length ?? 0 }))
  }
  native.saveAppFile = async (file, content) => {
    if (file.root === 'cache') return before.saveAppFile(file, content)
    const files = changeable(file)
    if (files.get(file.path) === null) throw new Error(`Failed to write ${file.path}: Is a directory (os error 21)`)
    put(files, file.path, content)
  }
  native.createFolder = async (file) => {
    if (file.root === 'cache') return before.createFolder(file)
    const files = changeable(file)
    if (!allowsFolderChange(file.path)) throw new Error(`Failed to make the folder ${file.path}: a folder can be made only below a folder that programs own`)
    makeFolders(files, file.path)
  }
  native.deleteAppFile = async (file) => {
    if (file.root === 'cache') return before.deleteAppFile(file)
    const files = changeable(file)
    if (file.folder && !allowsFolderChange(file.path)) throw new Error(`Failed to delete ${file.path}: a folder can be deleted only below a folder that programs own`)
    const at = files.get(file.path)
    if (at === undefined) return
    if ((at === null) !== file.folder) throw new Error(`Failed to delete ${file.path}: ${file.folder ? 'Not a directory (os error 20)' : 'Is a directory (os error 21)'}`)
    for (const path of [...files.keys()]) if (isAtOrBelow(path, file.path)) files.delete(path)
  }
  native.moveAppFile = async (from, to) => {
    if (from.root === 'cache' || to.root === 'cache') return before.moveAppFile(from, to)
    changeable(from)
    const files = changeable(to)
    const failed = (why: string) => new Error(`Failed to move ${from.path} to ${to.path}: ${why}`)
    const source = files.get(from.path)
    if (source === undefined) throw failed('No such file or directory (os error 2)')
    if (source === null) {
      if (!allowsFolderChange(from.path) || !allowsFolderChange(to.path)) throw failed('a folder can be moved only below a folder that programs own')
      if (files.has(to.path)) throw failed('the target is there already')
      if (isAtOrBelow(to.path, from.path)) throw failed('the target is in the folder itself')
    } else if (files.get(to.path) === null) {
      throw failed('Is a directory (os error 21)')
    }
    makeFolders(files, folderOf(to.path))
    for (const [path, content] of [...files]) {
      if (!isAtOrBelow(path, from.path)) continue
      files.delete(path)
      files.set(`${to.path}${path.slice(from.path.length)}`, content)
    }
  }
  return roots.app
}

/** The start of `fakeAppFiles` for the app `name`: its manifest, of the
 *  kind `kind`, and the files `more`, each by its path in the app (null
 *  for a folder). */
export function appFiles(name: string, more: Record<string, string | null> = {}, kind: AppKind = 'script'): Record<string, string | null> {
  return filesOfApp(`apps/${name}`, name, more, kind)
}

/** `appFiles` for the built-in app `name`, in the resource root: the
 *  `resources` of `fakeAppFiles`. */
export function builtInAppFiles(name: string, more: Record<string, string | null> = {}, kind: AppKind = 'script'): Record<string, string | null> {
  return filesOfApp(`builtin-apps/${name}`, name, more, kind)
}

function filesOfApp(folder: string, name: string, more: Record<string, string | null>, kind: AppKind): Record<string, string | null> {
  return {
    [`${folder}/manifest.json`]: appManifestText({ name, description: `The ${name} app.`, kind }),
    ...Object.fromEntries(Object.entries(more).map(([path, content]) => [`${folder}/${path}`, content])),
  }
}

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return { app: APP_DIR, cache: CACHE_DIR, resource: RESOURCE_DIR }[root as 'app' | 'cache' | 'resource']
  },
  async 'dez.native/resourcePath' (relative: string): Promise<string> {
    return native.resourcePath(relative)
  },
  async 'dez.native/canonicalPath' (path: string): Promise<string> {
    return native.canonicalPath(path)
  },
  'dez.native/runBundledTool' (run: BundledToolRun, runId: string, onOutput: (output: BundledToolOutput) => void): Promise<BundledToolEnd> {
    native.runs.push({ run, runId })
    return native.program(run, onOutput)
  },
  async 'dez.native/cancelBundledTool' (runId: string): Promise<void> {
    native.cancelledRuns.push(runId)
  },
  async 'dez.native/writeBundledToolInput' (runId: string, text: string): Promise<void> {
    native.inputWrites.push({ runId, text })
  },
  async 'dez.native/listAppFiles' (path: string, root = 'app', { folders = false }: { folders?: boolean } = {}): Promise<AppFileEntry[]> {
    const file = { root, path } as AppFileRef
    native.listedFolders.push(file)
    return native.folderEntries(file, folders) ?? native.folderFiles.map((name) => ({ name, updatedAt: 0, size: native.folderFileSize }))
  },
  async 'dez.native/moveAppFile' (from: AppFileRef, to: AppFileRef): Promise<void> {
    await native.moveAppFile(from, to)
    native.moves.push({ from, to })
  },
  async 'dez.native/saveAppFile' (path: string, content: string | Uint8Array, root = 'app'): Promise<void> {
    const file = { root, path } as AppFileRef
    await native.saveAppFile(file, content)
    native.savedFiles.push({ file, content })
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app', { folder = false }: { folder?: boolean } = {}): Promise<void> {
    const file = { root, path, folder } as AppFileRef & { folder: boolean }
    await native.deleteAppFile(file)
    native.deletedFiles.push(file)
  },
  async 'dez.native/createFolder' (path: string, root = 'app'): Promise<void> {
    const file = { root, path } as AppFileRef
    await native.createFolder(file)
    native.createdFolders.push(file)
  },
  async 'dez.native/listFileTree' (path: string, maxEntries: number, root = 'app'): Promise<FileTree> {
    return native.fileTree({ root, path } as AppFileRef, maxEntries)
  },
  'dez.native/downloadAppFile' (request: NativeHttpRequest, requestId: string, file: AppFileRef, rule: NativeDownloadRule): Promise<NativeHttpDownload> {
    native.downloads.push({ request, requestId, file, rule })
    return native.downloadAppFile()
  },
  async 'dez.native/cancelHttpStream' (requestId: string): Promise<void> {
    native.cancelledDownloads.push(requestId)
  },
  async 'dez.native/loadAppFileBytes' (path: string, root = 'app'): Promise<Uint8Array> {
    const file = { root, path } as AppFileRef
    native.readFiles.push(file)
    return native.fileBytes(file)
  },
  async 'dez.controller/images/fileSize' (path: string): Promise<number | null> {
    return native.fileSize(path)
  },
  async 'dez.provider/chatImageSizes' (paths: readonly string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>()
    for (const path of paths) {
      const bytes = native.sentImageBytes(path)
      if (bytes !== null) sizes.set(path, bytes)
    }
    return sizes
  },
})

/** A signal that never stops. */
export function running(): AbortSignal {
  return new AbortController().signal
}

/** The context of the first call of a round of a reply that takes no
 *  image, no clip, and no app, shows no picture, and has no job, with
 *  `more` in place of its parts. Its sections are those of the tab
 *  `tabId` (of `more` too). */
export function callContext(more: Partial<ToolRunContext> = {}): ToolRunContext {
  const context: ToolRunContext = {
    tabId: '',
    conversationId: CONVERSATION_ID,
    model: { providerId: 'venice', modelId: 'venice-glm-5' },
    sections: () => (sbp('dez.model/tab', context.tabId) as Tab | null)?.sections ?? [],
    jobs: new TabJobs(),
    writeImage: () => null,
    writeClip: () => null,
    showApp: () => false,
    pictureBudget: async () => NO_CALL_PICTURE_BUDGET,
    roundResults: [],
    isBridged: false,
    ...more,
  }
  return context
}

/** What the stub of `dez.controller/tools/run` does for one call. */
export type StubTool = (call: ToolRunCall, signal: AbortSignal, context: ToolRunContext) => Promise<ToolRunResult>

/** The result of a stub tool that has nothing to tell. */
export const TOOL_DONE: ToolRunResult = { content: 'done', isError: false }

// The stub tools at the start of a test: no call ran, and each call gives
// `TOOL_DONE`.
function newToolRuns() {
  return {
    calls: [] as ToolRunCall[],
    tool: (async () => TOOL_DONE) as StubTool,
  }
}

/** The stub of the Dez tools, for the tests of the code that runs the tool
 *  calls of a `js_eval` run (toolBridge.ts, jsEval.ts): the calls that
 *  ran, and what a call does. */
export const toolRuns = newToolRuns()

let toolRunsRegistered = false

/** Puts the stub of `dez.controller/tools/run` (`toolRuns`) back to its
 *  start, and registers it at the first call. This module does not
 *  register it on import, as its other stubs: the tests of the real
 *  selector (tools.test.ts) import this module too. Each test of a file
 *  that needs the stub starts with it. */
export function stubToolRuns(): void {
  Object.assign(toolRuns, newToolRuns())
  if (toolRunsRegistered) return
  toolRunsRegistered = true
  sbp('sbp/selectors/register', {
    'dez.controller/tools/run' (call: ToolRunCall, signal: AbortSignal, context: ToolRunContext): Promise<ToolRunResult> {
      toolRuns.calls.push(call)
      return toolRuns.tool(call, signal, context)
    },
  })
}

/** A step that a test ends by hand: `wait` resolves at `finish()`. */
export function heldStep(): { wait: Promise<void>, finish: () => void } {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => { finish = resolve })
  return { wait, finish }
}

/** The options of a job whose time limit no test reaches. */
export const LONG = { timeoutMs: 600_000 }

/** Lets the promise callbacks that are due run, such as those of a work
 *  that ended. Only for a test with fake timers. */
export const settled = () => vi.advanceTimersByTimeAsync(0)

/** The work of a job that its test ends by hand. */
export interface HeldWork {
  work: JobWork
  finish (outcome?: Partial<JobOutcome>): void
  /** The signal and the writers of the state, of the price, and of a kept
   *  file that the job gave its work, and the jobs of the job. */
  signal (): AbortSignal
  report (state: string): void
  reportCost (usd: number | null): void
  keepAsset (asset: MadeAsset): void
  jobs (): ToolJobs
}

export function heldWork(): HeldWork {
  let resolveWork!: (outcome: JobOutcome) => void
  let seen!: { signal: AbortSignal, report: (state: string) => void, reportCost: (usd: number | null) => void, keepAsset: (asset: MadeAsset) => void, jobs: ToolJobs }
  return {
    work: (signal, report, reportCost, keepAsset, jobs) => {
      seen = { signal, report, reportCost, keepAsset, jobs }
      return new Promise<JobOutcome>((resolve) => { resolveWork = resolve })
    },
    finish: (outcome = {}) => resolveWork({ text: '', isError: false, assets: [], ...outcome }),
    signal: () => seen.signal,
    report: (state) => seen.report(state),
    reportCost: (usd) => seen.reportCost(usd),
    keepAsset: (asset) => seen.keepAsset(asset),
    jobs: () => seen.jobs,
  }
}

/** The error of a work that must fail. */
export function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => {
    throw new Error('The work did not fail.')
  }, (error: unknown) => error)
}

/** The result text of a work that must fail with a `ToolError`. */
export async function refusalOf(work: Promise<unknown>): Promise<string> {
  const error = await failureOf(work)
  if (!(error instanceof ToolError)) throw new Error(`The work failed with no ToolError: ${String(error)}`)
  return error.message
}

/** The one work folder of a test, which must be deleted as the last file. */
export function deletedWorkFolder(): string {
  const last = native.deletedFiles.at(-1)
  expect(last).toStrictEqual({ root: 'cache', path: expect.stringMatching(WORK_FOLDER), folder: true })
  return last?.path ?? ''
}

/** A program that writes `text` to a stream, and then ends with `end`. */
export function writes(stream: BundledToolOutput['stream'], text: string, end: BundledToolEnd = ENDED): StubProgram {
  return async (_run, onOutput) => {
    onOutput({ stream, text })
    return end
  }
}

/** A `js_eval` program whose code makes one tool call for each of `calls`
 *  (a selector, or a selector with its arguments), each after the answer
 *  of the one before, and then ends with the line `last`. */
export function callingProgram(calls: readonly (string | { selector: string, arguments: unknown })[], last: JsEvalLine = { type: 'result', text: 'ok' }): StubProgram {
  return async (_run, onOutput) => {
    for (const [index, call] of calls.entries()) {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: index + 1, ...(typeof call === 'string' ? { selector: call } : call) }) })
      await vi.waitFor(() => expect(native.inputWrites).toHaveLength(index + 1))
    }
    onOutput({ stream: 'stdout', text: protocolLine(last) })
    return ENDED
  }
}

/** The last progress block of an ffmpeg run of the `audio` tool that
 *  wrote `seconds` of audio, as the program writes it to its standard
 *  output; null for a run that wrote none. */
export function audioProgress(seconds: number | null): string {
  return `bitrate=1536.0kbits/s\nout_time_us=${seconds === null ? 'N/A' : Math.round(seconds * 1_000_000)}\nprogress=end\n`
}

/** A video stream of a probe output (`probeOutput`,
 *  model/tools/testing.ts): 854 by 480 pixels, 24 frames a second. */
export const H264_STREAM = { codec_name: 'h264', codec_type: 'video', width: 854, height: 480, avg_frame_rate: '24/1', r_frame_rate: '24/1' }

/** The format part of the probe output of a clip of 5.04 s. */
export const CLIP_FORMAT = { duration: '5.040000', size: '1250000' }

/** The showinfo log lines that ffmpeg writes for the frames of a sheet at
 *  `times`, in seconds. */
export function showinfoLog(times: number[]): string {
  return times.map((time, n) => `[Parsed_showinfo_1 @ 0x1] n:   ${n} pts:  ${n} pts_time:${time} duration: 512 fmt:yuv420p\n`).join('')
}
