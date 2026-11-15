import sbp from '@sbp/sbp'
import { expect, vi } from 'vitest'
import { ToolError } from '../model/tools/types'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import type { JobOutcome, JobWork, MadeAsset } from './jobs'
import type { AppFileEntry, AppFileRef, BundledToolEnd, BundledToolOutput, BundledToolRun } from './nativeTypes'

// Shared helpers of the unit tests of the controller code that runs the
// programs that Dez ships (videoTool.ts, audioTool.ts, the frame sheets of
// compaction.ts, and the tool calls of tools.ts and stream.ts) and the jobs
// of a reply (jobs.ts): a stub of the native side, the outputs of the
// programs, and helpers for the work of a call or a job.
//
// An import of this module registers the stub selectors of the app
// folders, the files, the downloads, and the program runs
// (`dez.native/*`, `dez.controller/images/fileSize`, and
// `dez.provider/chatImageSizes`), so a test file must register none of
// them. Each test starts with `resetNative()`.

export const APP_DIR = '/home/u/.config/dez'
export const CACHE_DIR = '/home/u/.cache/dez'
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
  'dez.native/runBundledTool' (run: BundledToolRun, runId: string, onOutput: (output: BundledToolOutput) => void): Promise<BundledToolEnd> {
    native.runs.push({ run, runId })
    return native.program(run, onOutput)
  },
  async 'dez.native/cancelBundledTool' (runId: string): Promise<void> {
    native.cancelledRuns.push(runId)
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
