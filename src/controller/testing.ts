import sbp from '@sbp/sbp'
import { expect } from 'vitest'
import { ToolError } from '../model/tools/types'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import type { AppFileEntry, AppFileRef, BundledToolEnd, BundledToolOutput, BundledToolRun } from './nativeTypes'

// Shared helpers of the unit tests of the controller code that runs the
// programs that Dez ships (videoTool.ts, audioTool.ts, and the tool calls
// of tools.ts and stream.ts): a stub of the native side, and helpers for
// the work of a call.
//
// An import of this module registers the stub selectors of the app
// folders, the files, the downloads, and the program runs
// (`dez.native/*`, and `dez.controller/images/fileSize`), so a test file
// must register none of them. Each test starts with `resetNative()`.

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
  async 'dez.controller/images/fileSize' (path: string): Promise<number | null> {
    return native.fileSize(path)
  },
})

/** A signal that never stops. */
export function running(): AbortSignal {
  return new AbortController().signal
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
