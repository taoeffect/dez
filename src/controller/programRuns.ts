import sbp from '@sbp/sbp'
import { IMAGE_FOLDERS } from '../model/chat/images'
import { ClipReadError, MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { MEDIA_FOLDERS, type MediaTagData } from '../model/chat/mediaTags'
import { newStoredFilePath } from '../model/chat/storedFilePaths'
import { conversationWorkFolder } from '../model/tools/conversationWork'
import { unreadableImageText } from '../model/tools/imageTool'
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
import type { AppFileRoot, BundledTool, BundledToolEnd, BundledToolInput, BundledToolOutput, BundledToolRun } from './nativeTypes'

// The runs of the programs that Dez ships (ffmpeg, ffprobe, Deno), for the
// Dez tools that run them (videoTool.ts, audioTool.ts, assetInfo.ts,
// assetView.ts, jsEval.ts, appInvoke.ts). This module registers no
// selector. Its texts for a model are in model/tools/programRuns.ts;
// `toolName` is the Dez tool of the call, which those texts name.
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
// program wrote. Only the files that Dez keeps leave it first, for the
// generated folders of the Dez folder: a move for a program that Dez
// trusts (`storeOutputs`), a checked copy for the code of an app
// (appInvoke.ts).
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
 *  folders (workFolders.ts). Delete Unreferenced Files does not take the
 *  folder until its delete here (cacheHolds.ts). */
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

/** The folder at `path` of the root folder `root` on this computer, as a
 *  text of a Deno run can name it: `joined` is the path that Dez made from
 *  the root, which Rust gives Deno as a folder that the code can open, and
 *  `forms` has it with the real path, which Deno gives its code (the two
 *  differ when a folder above is a link). The folder must be there.
 *
 *  Throws a `ToolError` when Dez cannot get the real path: without it, a
 *  text of the run could show the model a path of the user's computer. */
export async function folderPathForms(path: string, root: AppFileRoot, toolName: string): Promise<{ joined: string, forms: string[] }> {
  try {
    const joined = `${await sbp('dez.native/getAppDir', root) as string}/${path}`
    return { joined, forms: [...new Set([await sbp('dez.native/canonicalPath', joined) as string, joined])] }
  } catch (error) {
    console.error('Failed to get the real path of a folder of a Deno run:', error)
    throw new ToolError(programNotStartedText('deno', toolName), '', { cause: error })
  }
}

/** The work folder of the conversation `conversationId` for a Deno run of
 *  a call of the tool `toolName` (model/tools/conversationWork.ts), in the
 *  forms of `folderPathForms`. Dez makes the folder when it is missing,
 *  as the real path needs a folder that is there. `joined` is the path
 *  that the code of the run gets (`dez.workFolder`): Deno compares the
 *  paths of its flags as text, and Rust gives it this form.
 *
 *  Throws a `ToolError` when Dez cannot make the folder or get its real
 *  path. */
export async function conversationWorkForms(conversationId: string, toolName: string): Promise<{ joined: string, forms: string[] }> {
  const folder = conversationWorkFolder(conversationId)
  try {
    if (folder === null) throw new Error(`The conversation id ${JSON.stringify(conversationId)} can name no folder.`)
    await sbp('dez.native/createFolder', folder, 'app')
  } catch (error) {
    console.error('Failed to make the work folder of a conversation:', error)
    throw new ToolError(programNotStartedText('deno', toolName), '', { cause: error })
  }
  return folderPathForms(folder, 'app', toolName)
}

/** The file of an input image that goes to the program as it is: the
 *  image's own file, which the run copies under `name`. Throws a
 *  `ToolError` for an image whose file Dez cannot read. */
export async function imageInputAsIs({ id, name, path }: { id: string, name: string, path: string }): Promise<BundledToolInput> {
  if (await readableFileSize(path) === null) throw new ToolError(unreadableImageText(id))
  return { name, source: path }
}

/** The file of an input clip for the program, from the first source of
 *  the clip that gives it (`clipFromSources`): a file of this computer,
 *  which the run copies, or null for a clip that is only at its provider's
 *  web address, which is downloaded into the work folder here. Rust copies
 *  and downloads, so the bytes of the clip never come into the webview. A
 *  linked file larger than `MAX_SAVED_CLIP_BYTES` is refused, as a dropped
 *  clip that Dez copies has that cap. Throws a `ClipReadError` for a clip
 *  that no source gives, and the stop of `signal`. */
export async function copyInputClip({ name, clip }: { name: string, clip: Pick<MediaTagData, 'src' | 'url' | 'expires'> }, folder: string, signal: AbortSignal): Promise<BundledToolInput | null> {
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

/** Writes `text` to the input of a run, after the texts of the earlier
 *  writes (`dez.native/writeBundledToolInput`). Only a run with `stdin` has
 *  an input. It resolves when the text is in the queue of the run, and
 *  rejects when the run ended or its program closed its input. Wait for
 *  each write before the next one: two writes at one time have no order. */
export type ProgramInputWriter = (text: string) => Promise<void>

/** One run of `program` in a work folder, to its end. A stop of `signal`
 *  stops the program; this then rejects with the stop, after the program is
 *  gone, so the caller can delete the folder. Throws a `ToolError` for a
 *  run that did not start: the program is missing, the system did not let
 *  Dez make the folder or copy an input, or the program must be confined
 *  and the system cannot confine it.
 *
 *  `onOutput` gets each piece that the program writes, and the writer of
 *  the input of the run. A write can go only from an output on: before the
 *  first one, the run may not be active yet. `onOutput` must not throw: a
 *  throw ends the run as one that did not start. */
export async function runProgram(
  program: ShippedProgram,
  toolName: string,
  run: Omit<BundledToolRun, 'tool'>,
  signal: AbortSignal,
  onOutput: (output: BundledToolOutput, writeInput: ProgramInputWriter) => void,
): Promise<ProgramEnd> {
  signal.throwIfAborted()
  const runId = crypto.randomUUID()
  const cancel = () => {
    sbp('dez.native/cancelBundledTool', runId).catch((error: unknown) => {
      console.error(`Failed to stop ${program}:`, error)
    })
  }
  const writeInput: ProgramInputWriter = (text) => sbp('dez.native/writeBundledToolInput', runId, text) as Promise<void>
  const ended = sbp('dez.native/runBundledTool', { ...run, tool: PROGRAM_FILES[program] }, runId, (output: BundledToolOutput) => onOutput(output, writeInput)) as Promise<BundledToolEnd>
  signal.addEventListener('abort', cancel, { once: true })
  let end: BundledToolEnd
  try {
    end = await ended
  } catch (error) {
    // The native error text can hold the path of the work folder or of an
    // input file, so the model gets none of it.
    console.error(`Failed to run ${program}:`, error)
    const text = rawErrorText(error).startsWith(NO_CONFINEMENT) ? programNotConfinedText(program) : programNotStartedText(program, toolName)
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

/** The kept end `kept` of the error output of a run, whose start Dez
 *  `cut`: after a cut, only its whole lines. The cut can fall inside a
 *  path, and `withoutLocalPaths` does not see the rest of a path as a
 *  path. */
export function wholeLinesEnd(kept: string, cut: boolean): string {
  if (!cut) return kept
  const lineEnd = kept.search(/[\r\n]/)
  return lineEnd < 0 ? '' : kept.slice(lineEnd + 1)
}

/** A new file in the generated folder of its kind, under a new name, for
 *  a file that a run or an app gives back. Nothing is written yet. */
export interface GeneratedFile {
  /** The path relative to the app root, for the native file calls. */
  target: string
  /** The absolute path. */
  path: string
  /** The file as a made asset. */
  asset: MadeAsset
}

/** A `GeneratedFile` of the type `type` in the app root `appDir`. */
export function newGeneratedFile(appDir: string, { kind, type, extension }: Pick<KeptFile, 'kind' | 'type' | 'extension'>): GeneratedFile {
  const target = `${kind === 'image' ? IMAGE_FOLDERS.generated : MEDIA_FOLDERS.generated[kind]}/${crypto.randomUUID()}.${extension}`
  const path = newStoredFilePath(appDir, target, kind)
  return { target, path, asset: kind === 'image' ? { kind, path } : { kind: 'clip', clip: { kind, type, src: path, url: null, expires: null } } }
}

/** Moves the new files `files` of a work folder into the generated folders
 *  of the Dez folder, each under a new name, and gives them as made
 *  assets. A move that fails keeps none of them: the ones that moved are
 *  deleted, and a `ToolError` tells the model. */
export async function storeOutputs(folder: string, files: readonly KeptFile[], toolName: string): Promise<MadeAsset[]> {
  const assets: MadeAsset[] = []
  try {
    const appDir = await sbp('dez.native/getAppDir') as string
    for (const file of files) {
      const { target, asset } = newGeneratedFile(appDir, file)
      await sbp('dez.native/moveAppFile', { root: 'cache', path: `${folder}/${file.name}` }, { root: 'app', path: target })
      assets.push(asset)
    }
  } catch (error) {
    console.error(`Failed to store the new files of the ${toolName} tool:`, error)
    await discardMadeAssets(assets)
    throw new ToolError(outputNotStoredText(toolName), '', { cause: error })
  }
  return assets
}
