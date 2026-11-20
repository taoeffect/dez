import sbp from '@sbp/sbp'
import { expect, vi } from 'vitest'
import { NO_CALL_PICTURE_BUDGET } from '../model/streams/pictureBudget'
import type { JsEvalLine } from '../model/tools/jsEval'
import { ToolError, type ToolRunResult } from '../model/tools/types'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import { TabJobs, type JobOutcome, type JobWork, type MadeAsset } from './jobs'
import type { AppFileEntry, AppFileRef, BundledToolEnd, BundledToolOutput, BundledToolRun, FileTree } from './nativeTypes'
import type { ToolRunCall, ToolRunContext } from './tools'

// Shared helpers of the unit tests of the controller code that runs the
// programs that Dez ships (videoTool.ts, audioTool.ts, the frame sheets of
// compaction.ts, and the tool calls of tools.ts and stream.ts) and the jobs
// of a reply (jobs.ts): a stub of the native side, the outputs of the
// programs, and helpers for the work of a call or a job.
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
    listedFolders: [] as AppFileRef[],
    moves: [] as { from: AppFileRef, to: AppFileRef }[],
    moveAppFile: async (_from: AppFileRef): Promise<void> => {},
    savedFiles: [] as { file: AppFileRef, content: string | Uint8Array }[],
    saveAppFile: async (): Promise<void> => {},
    deletedFiles: [] as (AppFileRef & { folder: boolean })[],
    deleteAppFile: async (): Promise<void> => {},
    createdFolders: [] as AppFileRef[],
    // What is at a path, and below it; nothing is at a path that a test
    // does not set.
    fileTree: ((): FileTree => ({ kind: 'missing', size: 0, updatedAt: null, entries: [], more: false })) as (file: AppFileRef) => FileTree,
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

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? CACHE_DIR : APP_DIR
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
  async 'dez.native/listAppFiles' (path: string, root = 'app'): Promise<AppFileEntry[]> {
    native.listedFolders.push({ root, path } as AppFileRef)
    return native.folderFiles.map((name) => ({ name, updatedAt: 0, size: native.folderFileSize }))
  },
  async 'dez.native/moveAppFile' (from: AppFileRef, to: AppFileRef): Promise<void> {
    await native.moveAppFile(from)
    native.moves.push({ from, to })
  },
  async 'dez.native/saveAppFile' (path: string, content: string | Uint8Array, root = 'app'): Promise<void> {
    await native.saveAppFile()
    native.savedFiles.push({ file: { root, path } as AppFileRef, content })
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app', { folder = false }: { folder?: boolean } = {}): Promise<void> {
    await native.deleteAppFile()
    native.deletedFiles.push({ root, path, folder } as AppFileRef & { folder: boolean })
  },
  async 'dez.native/createFolder' (path: string, root = 'app'): Promise<void> {
    native.createdFolders.push({ root, path } as AppFileRef)
  },
  async 'dez.native/listFileTree' (path: string, _maxEntries: number, root = 'app'): Promise<FileTree> {
    return native.fileTree({ root, path } as AppFileRef)
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

/** The context of a call of a reply that takes no image and no clip,
 *  shows no picture, and has no job, with `more` in place of its parts. */
export function callContext(more: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    tabId: '',
    model: { providerId: 'venice', modelId: 'venice-glm-5' },
    jobs: new TabJobs(),
    writeImage: () => null,
    writeClip: () => null,
    pictureBudget: async () => NO_CALL_PICTURE_BUDGET,
    ...more,
  }
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
   *  file that the job gave its work. */
  signal (): AbortSignal
  report (state: string): void
  reportCost (usd: number | null): void
  keepAsset (asset: MadeAsset): void
}

export function heldWork(): HeldWork {
  let resolveWork!: (outcome: JobOutcome) => void
  let seen!: { signal: AbortSignal, report: (state: string) => void, reportCost: (usd: number | null) => void, keepAsset: (asset: MadeAsset) => void }
  return {
    work: (signal, report, reportCost, keepAsset) => {
      seen = { signal, report, reportCost, keepAsset }
      return new Promise<JobOutcome>((resolve) => { resolveWork = resolve })
    },
    finish: (outcome = {}) => resolveWork({ text: '', isError: false, assets: [], ...outcome }),
    signal: () => seen.signal,
    report: (state) => seen.report(state),
    reportCost: (usd) => seen.reportCost(usd),
    keepAsset: (asset) => seen.keepAsset(asset),
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

/** A protocol line of a `js_eval` run, as the module of Dez writes it
 *  (model/tools/jsEvalRunner.js). */
export function protocolLine(line: JsEvalLine): string {
  return `\x1e${JSON.stringify(line)}\n`
}

/** A `js_eval` program whose code makes one tool call for each of
 *  `selectors`, each after the answer of the one before, and then ends
 *  with the line `last`. */
export function callingProgram(selectors: readonly string[], last: JsEvalLine = { type: 'result', text: 'ok' }): StubProgram {
  return async (_run, onOutput) => {
    for (const [index, selector] of selectors.entries()) {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: index + 1, selector }) })
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
