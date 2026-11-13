import sbp from '@sbp/sbp'
import { IMAGE_FOLDERS, isImagePath } from '../model/chat/images'
import { ClipReadError, MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { isSavedMediaPath, MEDIA_FOLDERS } from '../model/chat/mediaTags'
import {
  INPUT_CLIP_TOO_LARGE,
  outputNotStoredText,
  programNotStartedText,
  type ClipInput,
  type KeptFile,
  type ProgramEnd,
  type ShippedProgram,
} from '../model/tools/programRuns'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { ToolError } from '../model/tools/types'
import { workFolderPath } from '../model/tools/workFolders'
import { clipFromSources, downloadClip, type ClipSource } from './clipSources'
import { discardJobAssets, type JobAsset } from './jobs'
import type { BundledTool, BundledToolEnd, BundledToolInput, BundledToolOutput, BundledToolRun } from './nativeTypes'

// The runs of ffmpeg and ffprobe, the programs that Dez ships, for the
// Dez tools that use them (videoTool.ts, audioTool.ts). This module
// registers no selector. Its texts for a model are in
// model/tools/programRuns.ts; `toolName` is the Dez tool of the call, which
// those texts name.
//
// Each call has its own new work folder in the cache root
// (model/tools/workFolders.ts). The program runs in it and gets only
// copies of the inputs that the call names, under neutral names, so it
// does not change the files of its inputs, and no path of the user's
// computer is in its arguments. Where the OS can, Rust also lets the
// program open only the files of the cache root and of the assets folder
// of the Dez folder, where it cannot delete or move a file
// (src-tauri/src/confinement.rs). The folder goes at the end of the call,
// with all that the program wrote. Only the files that Dez keeps move out
// of it first, into the generated folders of the Dez folder.
//
// An error of the system (a native error text) can hold a path: it goes to
// the log only, never into a text for a model.

const PROGRAM_FILES: Readonly<Record<ShippedProgram, BundledTool>> = { ffmpeg: 'dez-ffmpeg', ffprobe: 'dez-ffprobe' }

/** Runs `work` with the path of a new work folder, and deletes the folder
 *  with all that it holds when the work ends, also after an error or a
 *  stop. The folder is not made here: the first write into it makes it. A
 *  delete that fails leaves the folder to the cleanup of the old work
 *  folders (workFolders.ts). */
export async function inWorkFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = workFolderPath(crypto.randomUUID())
  try {
    return await work(folder)
  } finally {
    await sbp('dez.native/deleteAppFile', folder, 'cache', { folder: true }).catch((error: unknown) => {
      console.error(`Failed to delete the work folder ${folder}:`, error)
    })
  }
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
 *  clip that Dez copies has that cap. Throws a `ToolError` for a clip that
 *  no source gives, and the stop of `signal`. */
export async function clipInputFile({ kind, id, name, clip }: ClipInput, folder: string, signal: AbortSignal, toolName: string): Promise<BundledToolInput | null> {
  const copy = { root: 'cache', path: `${folder}/${name}` } as const
  try {
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
  } catch (error) {
    if (!(error instanceof ClipReadError)) throw error
    throw new ToolError(clipReadProblemText(kind, id, toolName, error.problem), error.details, { cause: error })
  }
}

/** One run of `program` in a work folder, to its end. A stop of `signal`
 *  stops the program; this then rejects with the stop, after the program is
 *  gone, so the caller can delete the folder. Throws a `ToolError` for a
 *  run that did not start (the program is missing, or the system did not
 *  let Dez make the folder or copy an input). */
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
    throw new ToolError(programNotStartedText(program, toolName), '', { cause: error })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  signal.throwIfAborted()
  // Only a stop of `signal` cancels a run, and the quit of the app, after
  // which nobody reads a result.
  if (end.kind === 'cancelled') throw new Error(`The run of ${program} was cancelled with no stop of its call.`)
  return end
}

/** Moves the new files `files` of a work folder into the generated folders
 *  of the Dez folder, each under a new name, and gives them as the assets
 *  of a job. A move that fails keeps none of them: the ones that moved are
 *  deleted, and a `ToolError` tells the model. */
export async function storeOutputs(folder: string, files: readonly KeptFile[], toolName: string): Promise<JobAsset[]> {
  const assets: JobAsset[] = []
  try {
    const appDir = await sbp('dez.native/getAppDir') as string
    for (const { name, kind, type, extension } of files) {
      const target = `${kind === 'image' ? IMAGE_FOLDERS.generated : MEDIA_FOLDERS.generated[kind]}/${crypto.randomUUID()}.${extension}`
      const path = `${appDir}/${target}`
      // A path that the recognizers of image references and media tags do
      // not take would show as no asset (images/save and media/save have
      // the same check), so no file moves there.
      if (!(kind === 'image' ? isImagePath(path) : isSavedMediaPath(path))) {
        throw new Error(`Dez cannot store files in the Dez folder ${appDir}: the recognizers of stored files do not take its path.`)
      }
      await sbp('dez.native/moveAppFile', { root: 'cache', path: `${folder}/${name}` }, { root: 'app', path: target })
      assets.push(kind === 'image' ? { kind, path } : { kind: 'clip', clip: { kind, type, src: path, url: null, expires: null } })
    }
  } catch (error) {
    console.error(`Failed to store the new files of the ${toolName} tool:`, error)
    await discardJobAssets(assets)
    throw new ToolError(outputNotStoredText(toolName), '', { cause: error })
  }
  return assets
}
