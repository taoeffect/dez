import sbp from '@sbp/sbp'
import { IMAGE_FOLDERS } from '../model/chat/images'
import { ClipReadError, MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { MEDIA_FOLDERS } from '../model/chat/mediaTags'
import { newStoredFilePath } from '../model/chat/storedFilePaths'
import {
  INPUT_CLIP_TOO_LARGE,
  outputNotStoredText,
  programNotConfinedText,
  programNotStartedText,
  type ClipInput,
  type KeptFile,
  type ProgramEnd,
  type ShippedProgram,
} from '../model/tools/programRuns'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { ToolError } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { workFolderPath } from '../model/tools/workFolders'
import { rawErrorText } from '../utils/errorText'
import { holdingCachePath } from './cacheHolds'
import { clipFromSources, downloadClip, type ClipSource } from './clipSources'
import { discardMadeAssets, type MadeAsset } from './jobs'
import type { BundledTool, BundledToolEnd, BundledToolInput, BundledToolOutput, BundledToolRun } from './nativeTypes'

// The runs of the programs that Dez ships (ffmpeg, ffprobe, Deno), for the
// Dez tools that run them (videoTool.ts, audioTool.ts, assetInfo.ts,
// assetView.ts, jsEval.ts). This module registers no selector. Its texts
// for a model are in model/tools/programRuns.ts; `toolName` is the Dez
// tool of the call, which those texts name.
//
// Each call has its own new work folder in the cache root
// (model/tools/workFolders.ts). The program runs in it and gets only
// copies of the inputs that the call names, under neutral names, so it
// does not change the files of its inputs, and no path of the user's
// computer is in its arguments. Where the OS can, Rust also lets the
// program open only the files of the cache root and of the assets folder
// of the Dez folder, where it cannot delete or move a file
// (src-tauri/src/confinement.rs). Deno runs the code of a model, so its
// rule is tighter (its own work folder, and the app folder of the run when
// it has one), and Rust starts no Deno run where the OS cannot hold it to
// that rule. The folder goes at the end of the call, with all that the
// program wrote. Only the files that Dez keeps move out of it first, into
// the generated folders of the Dez folder.
//
// An error of the system (a native error text) can hold a path: it goes to
// the log only, never into a text for a model.

const PROGRAM_FILES: Readonly<Record<ShippedProgram, BundledTool>> = { ffmpeg: 'dez-ffmpeg', ffprobe: 'dez-ffprobe', deno: 'dez-deno' }

// The start of the native error of a run that Rust refused because the OS
// cannot confine the program (`NO_CONFINEMENT` in
// src-tauri/src/confinement.rs). Only a program that must be confined gets
// it: Deno.
const NO_CONFINEMENT = 'No confinement: '

/** Runs `work` with the path of a new work folder, and deletes the folder
 *  with all that it holds when the work ends, also after an error or a
 *  stop. The folder is not made here: the first write into it makes it. A
 *  delete that fails leaves the folder to the cleanup of the old work
 *  folders (workFolders.ts). Delete Unused Files does not take the folder
 *  until its delete here (cacheHolds.ts). */
export function inWorkFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = workFolderPath(crypto.randomUUID())
  return holdingCachePath(folder, async () => {
    try {
      return await work(folder)
    } finally {
      await sbp('dez.native/deleteAppFile', folder, 'cache', { folder: true }).catch((error: unknown) => {
        console.error(`Failed to delete the work folder ${folder}:`, error)
      })
    }
  })
}

/** The size of the file at `path`; null for a file that Dez cannot read
 *  (it is gone, or the system does not let Dez read it). */
export async function readableFileSize(path: string): Promise<number | null> {
  try {
    return await sbp('dez.controller/images/fileSize', path) as number | null
  } catch (error) {
    console.error('Failed to read the size of an input file of a tool:', error)
    return null
  }
}

/** The file of an input clip for the program, from the first source of
 *  the clip that gives it (`clipFromSources`): a file of this computer,
 *  which the run copies, or null for a clip that is only at its provider's
 *  web address, which is downloaded into the work folder here. Rust copies
 *  and downloads, so the bytes of the clip never come into the webview. A
 *  linked file larger than `MAX_SAVED_CLIP_BYTES` is refused, as a dropped
 *  clip that Dez copies has that cap. Throws a `ClipReadError` for a clip
 *  that no source gives, and the stop of `signal`. */
export async function copyInputClip({ name, clip }: Pick<ClipInput, 'name' | 'clip'>, folder: string, signal: AbortSignal): Promise<BundledToolInput | null> {
  const copy = { root: 'cache', path: `${folder}/${name}` } as const
  return await clipFromSources(clip, signal, async (source: ClipSource) => {
    if (source.kind === 'url') {
      try {
        await downloadClip(source.url, copy, signal)
      } catch (error) {
        // A part of the clip can stay, and a later source of the clip
        // needs the name: a run refuses an input whose name the folder
        // has.
        await sbp('dez.native/deleteAppFile', copy.path, copy.root).catch((deleteError: unknown) => {
          console.error('Failed to delete the part of a clip download:', deleteError)
        })
        throw error
      }
      return null
    }
    const size = await readableFileSize(source.path)
    if (size === null) throw new Error('The file of the clip is gone, or Dez may not read it.')
    if (source.linked && size > MAX_SAVED_CLIP_BYTES) throw new Error(INPUT_CLIP_TOO_LARGE)
    return { name, source: source.path }
  })
}

/** `copyInputClip` for a call of the tool `toolName` that cannot go
 *  without the clip: throws a `ToolError` for a clip that no source
 *  gives, with the text of its problem for the model. */
export async function clipInputFile(input: ClipInput, folder: string, signal: AbortSignal, toolName: string): Promise<BundledToolInput | null> {
  try {
    return await copyInputClip(input, folder, signal)
  } catch (error) {
    if (!(error instanceof ClipReadError)) throw error
    throw new ToolError(clipReadProblemText(input.kind, input.id, toolName, error.problem), error.details, { cause: error })
  }
}

/** One run of `program` in a work folder, to its end. A stop of `signal`
 *  stops the program; this then rejects with the stop, after the program is
 *  gone, so the caller can delete the folder. Throws a `ToolError` for a
 *  run that did not start: the program is missing, the system did not let
 *  Dez make the folder or copy an input, or the program must be confined
 *  and the system cannot confine it. */
export async function runProgram(
  program: ShippedProgram,
  toolName: string,
  run: Omit<BundledToolRun, 'tool'>,
  signal: AbortSignal,
  onOutput: (output: BundledToolOutput) => void,
): Promise<ProgramEnd> {
  signal.throwIfAborted()
  const runId = crypto.randomUUID()
  const cancel = () => {
    sbp('dez.native/cancelBundledTool', runId).catch((error: unknown) => {
      console.error(`Failed to stop ${program}:`, error)
    })
  }
  const ended = sbp('dez.native/runBundledTool', { ...run, tool: PROGRAM_FILES[program] }, runId, onOutput) as Promise<BundledToolEnd>
  signal.addEventListener('abort', cancel, { once: true })
  let end: BundledToolEnd
  try {
    end = await ended
  } catch (error) {
    // The native error text can hold the path of the work folder or of an
    // input file, so the model gets none of it.
    console.error(`Failed to run ${program}:`, error)
    const text = rawErrorText(error).startsWith(NO_CONFINEMENT) ? programNotConfinedText(program, toolName) : programNotStartedText(program, toolName)
    throw new ToolError(text, '', { cause: error })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  signal.throwIfAborted()
  // Only a stop of `signal` cancels a run, and the quit of the app, after
  // which nobody reads a result.
  if (end.kind === 'cancelled') throw new Error(`The run of ${program} was cancelled with no stop of its call.`)
  return end
}

/** A run of ffmpeg for a call of the tool `toolName`, on the input copies
 *  that are already in the work folder `folder`, to its end, with all that
 *  it wrote: the log, where its filters write what they find in a clip.
 *  The log can hold a path, so it goes to a model only through a reader. */
export async function runFfmpegLog(
  args: string[],
  folder: string,
  { toolName, timeoutMs }: { toolName: string, timeoutMs: number },
  signal: AbortSignal,
): Promise<{ end: ProgramEnd, log: string }> {
  let log = ''
  const run = { args, folder, inputs: [], timeoutMs, maxOutputBytes: FFMPEG_OUTPUT_BYTES }
  const end = await runProgram('ffmpeg', toolName, run, signal, ({ text }) => {
    log += text
  })
  return { end, log }
}

/** Moves the new files `files` of a work folder into the generated folders
 *  of the Dez folder, each under a new name, and gives them as made
 *  assets. A move that fails keeps none of them: the ones that moved are
 *  deleted, and a `ToolError` tells the model. */
export async function storeOutputs(folder: string, files: readonly KeptFile[], toolName: string): Promise<MadeAsset[]> {
  const assets: MadeAsset[] = []
  try {
    const appDir = await sbp('dez.native/getAppDir') as string
    for (const { name, kind, type, extension } of files) {
      const target = `${kind === 'image' ? IMAGE_FOLDERS.generated : MEDIA_FOLDERS.generated[kind]}/${crypto.randomUUID()}.${extension}`
      const path = newStoredFilePath(appDir, target, kind)
      await sbp('dez.native/moveAppFile', { root: 'cache', path: `${folder}/${name}` }, { root: 'app', path: target })
      assets.push(kind === 'image' ? { kind, path } : { kind: 'clip', clip: { kind, type, src: path, url: null, expires: null } })
    }
  } catch (error) {
    console.error(`Failed to store the new files of the ${toolName} tool:`, error)
    await discardMadeAssets(assets)
    throw new ToolError(outputNotStoredText(toolName), '', { cause: error })
  }
  return assets
}
