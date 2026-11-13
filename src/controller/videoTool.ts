import sbp from '@sbp/sbp'
import { wholeImageDrawing, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import { IMAGE_FOLDERS, isImagePath } from '../model/chat/images'
import { ClipReadError, MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { isSavedMediaPath, MEDIA_FOLDERS } from '../model/chat/mediaTags'
import { unreadableImageText } from '../model/tools/imageTool'
import { jobTimedOutText } from '../model/tools/jobs'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { ToolError } from '../model/tools/types'
import {
  clipFacts,
  FFMPEG_OUTPUT_BYTES,
  ffmpegRunResult,
  ffmpegStateText,
  FFPROBE_OUTPUT_BYTES,
  FFPROBE_TIMEOUT_MS,
  ffprobeFailedText,
  ffprobeResultText,
  INPUT_CLIP_TOO_LARGE,
  JOIN_READS_CLIPS,
  joinNoVideoText,
  joinPlan,
  joinProbeArgs,
  joinProbeFailedText,
  joinRunResult,
  jpegCopyFailedText,
  OUTPUT_NOT_STORED_TEXT,
  outputFiles,
  OutputStart,
  ProgramLog,
  programNotStartedText,
  VIDEO_READS_INPUTS,
  VIDEO_TOOL,
  type ClipFacts,
  type ClipInput,
  type FfmpegCall,
  type ImageInput,
  type JoinCall,
  type KeptFile,
  type ProgramCall,
  type ProgramEnd,
  type VideoInput,
  type VideoProgram,
} from '../model/tools/videoTool'
import { workFolderPath } from '../model/tools/workFolders'
import { clipFromSources, downloadClip, type ClipSource } from './clipSources'
import { discardJobAssets, type JobAsset, type JobOutcome } from './jobs'
import type { AppFileEntry, BundledTool, BundledToolEnd, BundledToolInput, BundledToolOutput, BundledToolRun } from './nativeTypes'

// The work of the `video` tool (model/tools/videoTool.ts): the runs of
// ffmpeg and ffprobe, the programs that Dez ships. This module registers
// no selector: the `video` runners (tools.ts) start the work, after the
// checks of the call.
//
// Each call has its own new work folder in the cache root
// (model/tools/workFolders.ts). The program runs in it and gets only
// copies of the inputs that the call names, under neutral names, so it
// cannot change a file of the user, and no path of the user's computer is
// in its arguments. The folder goes at the end of the call, with all that
// the program wrote. Only the files that Dez keeps move out of it first,
// into the generated folders of the Dez folder.
//
// Every text that leaves this module is a tool result or a job state: it
// goes to the chat provider. A program writes what it likes (a log line
// can hold the absolute path of its work folder, or a path that a file's
// metadata names), so each text with output of a program goes through
// `withoutLocalPaths`. An error of the system (a native error text) can
// hold a path too: it goes to the log only.

const PROGRAM_FILES: Readonly<Record<VideoProgram, BundledTool>> = { ffmpeg: 'dez-ffmpeg', ffprobe: 'dez-ffprobe' }

// Runs `work` with the path of a new work folder, and deletes the folder
// with all that it holds when the work ends, also after an error or a
// stop. The folder is not made here: the first write into it makes it. A
// delete that fails leaves the folder to the cleanup of the old work
// folders (workFolders.ts).
async function inWorkFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = workFolderPath(crypto.randomUUID())
  try {
    return await work(folder)
  } finally {
    await sbp('dez.native/deleteAppFile', folder, 'cache', { folder: true }).catch((error: unknown) => {
      console.error(`Failed to delete the work folder ${folder}:`, error)
    })
  }
}

// The size of the file at `path`; null for a file that Dez cannot read
// (it is gone, or the system does not let Dez read it).
async function readableFileSize(path: string): Promise<number | null> {
  try {
    return await sbp('dez.controller/images/fileSize', path) as number | null
  } catch (error) {
    console.error('Failed to read the size of an input file of the video tool:', error)
    return null
  }
}

// The file of an input image for the program: the image's own file, which
// the run copies, or null for an image that goes as a JPEG copy, which is
// written into the work folder here. The webview draws the copy on white:
// a JPEG has no transparent pixels.
async function imageInputFile({ id, name, path, jpegCopy }: ImageInput, folder: string): Promise<BundledToolInput | null> {
  if (!jpegCopy) {
    if (await readableFileSize(path) === null) throw new ToolError(unreadableImageText(id))
    return { name, source: path }
  }

  let file: File
  try {
    file = await sbp('dez.controller/images/readFile', path) as File
  } catch (error) {
    console.error(`Failed to read the image @${id}:`, error)
    throw new ToolError(unreadableImageText(id), '', { cause: error })
  }
  try {
    // The plan always draws, so redraw gives a drawing.
    const drawn = await sbp(
      'dez.controller/images/redraw',
      file,
      (size: ImageSize) => ({ ...wholeImageDrawing(size), background: '#ffffff' }),
      'image/jpeg',
    ) as DrawnImage
    await sbp('dez.native/saveAppFile', `${folder}/${name}`, drawn.bytes, 'cache')
  } catch (error) {
    console.error(`Failed to make the JPEG copy of the image @${id}:`, error)
    throw new ToolError(jpegCopyFailedText(id), '', { cause: error })
  }
  return null
}

// The file of an input clip for the program, from the first source of the
// clip that gives it (`clipFromSources`): a file of this computer, which
// the run copies, or null for a clip that is only at its provider's web
// address, which is downloaded into the work folder here. Rust copies and
// downloads, so the bytes of the clip never come into the webview. A
// linked file larger than `MAX_SAVED_CLIP_BYTES` is refused, as a dropped
// clip that Dez copies has that cap.
async function clipInputFile({ kind, id, name, clip }: ClipInput, folder: string, signal: AbortSignal): Promise<BundledToolInput | null> {
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
    throw new ToolError(clipReadProblemText(kind, id, VIDEO_TOOL.name, error.problem), error.details, { cause: error })
  }
}

// Gets the inputs of a call ready. It gives the files that the first run
// of the work folder must copy into it (`BundledToolRun.inputs`; only the
// first, as a run refuses an input whose name the folder has); a JPEG copy
// and a downloaded clip are in the folder after this. Throws a `ToolError`
// for an input that Dez cannot read, and the stop of `signal`.
async function prepareInputs(inputs: readonly VideoInput[], folder: string, signal: AbortSignal): Promise<BundledToolInput[]> {
  const copies: BundledToolInput[] = []
  for (const input of inputs) {
    signal.throwIfAborted()
    const copy = input.kind === 'image' ? await imageInputFile(input, folder) : await clipInputFile(input, folder, signal)
    if (copy) copies.push(copy)
  }
  signal.throwIfAborted()
  return copies
}

// One run of `program` in a work folder, to its end. A stop of `signal`
// stops the program; this then rejects with the stop, after the program is
// gone, so the caller can delete the folder. Throws a `ToolError` for a
// run that did not start (the program is missing, or the system did not
// let Dez make the folder or copy an input).
async function runProgram(
  program: VideoProgram,
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
  // After the run call, never before it: a cancel of a run that the
  // backend does not know yet does nothing (`dez.native/cancelBundledTool`).
  signal.addEventListener('abort', cancel, { once: true })
  let end: BundledToolEnd
  try {
    end = await ended
  } catch (error) {
    // The native error text can hold the path of the work folder or of an
    // input file, so the model gets none of it.
    console.error(`Failed to run ${program}:`, error)
    throw new ToolError(programNotStartedText(program), '', { cause: error })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  signal.throwIfAborted()
  // Only a stop of `signal` cancels a run, and the quit of the app, after
  // which nobody reads a result.
  if (end.kind === 'cancelled') throw new Error(`The run of ${program} was cancelled with no stop of its call.`)
  return end
}

// One ffmpeg run of a job, to its end. Its log goes into `log`, what it
// prints to its standard output into `output`, and its last progress line
// is the state of the job.
function runFfmpeg(
  run: Omit<BundledToolRun, 'tool' | 'timeoutMs' | 'maxOutputBytes'>,
  timeoutMs: number,
  signal: AbortSignal,
  report: (state: string) => void,
  log: ProgramLog,
  output: OutputStart,
): Promise<ProgramEnd> {
  report(ffmpegStateText(''))
  return runProgram('ffmpeg', { ...run, timeoutMs, maxOutputBytes: FFMPEG_OUTPUT_BYTES }, signal, ({ stream, text }) => {
    if (stream === 'stdout') {
      output.add(text)
      return
    }
    log.add(text)
    report(withoutLocalPaths(ffmpegStateText(log.progress)))
  })
}

// The outcome of a job whose ffmpeg run the backend stopped at the time
// limit. The job has the same limit and its own clock (`ReplyJobs`), which
// started before the input files were ready, so it ends the job first in
// most cases; this is the text for the other case.
function timedOutOutcome(timeoutMs: number, log: ProgramLog): JobOutcome {
  return { text: withoutLocalPaths(jobTimedOutText(timeoutMs, ffmpegStateText(log.progress))), isError: true, assets: [] }
}

// Moves the new files `files` of a work folder into the generated folders
// of the Dez folder, each under a new name, and gives them as the assets
// of a job. A move that fails keeps none of them: the ones that moved are
// deleted, and a `ToolError` tells the model.
async function storeOutputs(folder: string, files: readonly KeptFile[]): Promise<JobAsset[]> {
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
    console.error('Failed to store the new files of the video tool:', error)
    await discardJobAssets(assets)
    throw new ToolError(OUTPUT_NOT_STORED_TEXT, '', { cause: error })
  }
  return assets
}

/** The work of the job of a `video ffmpeg` call (`JobWork`): one run of
 *  ffmpeg with the arguments of `call`, in a new work folder that holds
 *  copies of the call's inputs. The new files of the run that Dez stores
 *  (`outputFiles`) are the assets of the job; the text tells what the run
 *  did, with the end of its log. A run that failed keeps no file.
 *
 *  A stop of `signal` (a stop of the reply, or the time limit of the job)
 *  stops the program and rejects, which `ReplyJobs` drops. The work folder
 *  goes at every end. */
export function runFfmpegJob(call: FfmpegCall, signal: AbortSignal, report: (state: string) => void): Promise<JobOutcome> {
  return inWorkFolder(async (folder) => {
    report(VIDEO_READS_INPUTS)
    const inputs = await prepareInputs(call.inputs, folder, signal)
    const log = new ProgramLog()
    const output = new OutputStart()
    const end = await runFfmpeg({ args: call.args, folder, inputs }, call.timeoutMs, signal, report, log, output)
    if (end.kind === 'timedOut') return timedOutOutcome(call.timeoutMs, log)

    const listed = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
    const files = outputFiles(listed, new Set(call.inputs.map((input) => input.name)))
    const result = ffmpegRunResult(call, end, files, log, output)
    const text = withoutLocalPaths(result.text)
    if (result.isError) return { text, isError: true, assets: [] }
    return { text, isError: false, assets: await storeOutputs(folder, files.kept) }
  })
}

// The facts of each clip file of a join, by the name of the file, from
// one ffprobe run for each. `copies` are the input files that the first
// run copies into the folder. Throws a `ToolError` for a clip that ffprobe
// cannot read, and for one with no picture.
async function probeJoinClips(clips: readonly ClipInput[], copies: BundledToolInput[], folder: string, signal: AbortSignal): Promise<Map<string, ClipFacts>> {
  const facts = new Map<string, ClipFacts>()
  for (const [index, { id, name }] of clips.entries()) {
    const output = new OutputStart()
    const errorOutput = new OutputStart()
    const end = await runProgram('ffprobe', {
      args: joinProbeArgs(name),
      folder,
      inputs: index === 0 ? copies : [],
      timeoutMs: FFPROBE_TIMEOUT_MS,
      maxOutputBytes: FFPROBE_OUTPUT_BYTES,
    }, signal, ({ stream, text }) => (stream === 'stdout' ? output : errorOutput).add(text))
    if (end.kind !== 'exited' || end.code !== 0) throw new ToolError(withoutLocalPaths(joinProbeFailedText(id, end, errorOutput.text)))
    const clip = clipFacts(output.text)
    if (!clip) throw new ToolError(joinNoVideoText(id))
    facts.set(name, clip)
  }
  return facts
}

/** The work of the job of a `video join_clips` call (`JobWork`): ffprobe
 *  reads the facts of each clip, `joinPlan` tells how they join (a stream
 *  copy of clips that match, else a new encode), and one ffmpeg run makes
 *  the new clip, which is the asset of the job. The work folder, the stop,
 *  and the texts are as for `runFfmpegJob`. */
export function runJoinJob(call: JoinCall, signal: AbortSignal, report: (state: string) => void): Promise<JobOutcome> {
  return inWorkFolder(async (folder) => {
    report(VIDEO_READS_INPUTS)
    const copies = await prepareInputs(call.inputs, folder, signal)
    report(JOIN_READS_CLIPS)
    const facts = await probeJoinClips(call.inputs, copies, folder, signal)
    // Every clip of `clips` is one of `inputs`, so it has its facts.
    const plan = joinPlan(call.clips.map(({ name }) => ({ name, facts: facts.get(name) as ClipFacts })))

    const made = new Set(call.inputs.map((input) => input.name))
    if (plan.kind === 'copy') {
      made.add(plan.list.name)
      try {
        await sbp('dez.native/saveAppFile', `${folder}/${plan.list.name}`, plan.list.text, 'cache')
      } catch (error) {
        console.error('Failed to write the list file of a join:', error)
        throw new ToolError(programNotStartedText('ffmpeg'), '', { cause: error })
      }
    }
    const log = new ProgramLog()
    const end = await runFfmpeg({ args: plan.args, folder, inputs: [] }, call.timeoutMs, signal, report, log, new OutputStart())
    if (end.kind === 'timedOut') return timedOutOutcome(call.timeoutMs, log)

    const listed = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
    const joined = outputFiles(listed, made).kept.filter((file) => file.name === plan.output)
    const result = joinRunResult(plan, call.clips.length, end, joined.length > 0, log)
    const text = withoutLocalPaths(result.text)
    if (result.isError) return { text, isError: true, assets: [] }
    return { text, isError: false, assets: await storeOutputs(folder, joined) }
  })
}

/** The result text of a `video ffprobe` call: one run of ffprobe with the
 *  arguments of `call`, in a new work folder that holds copies of the
 *  call's inputs. The call waits for it, as the run is short. Throws a
 *  `ToolError` for an input that Dez cannot read and for a run that
 *  failed, with what the program wrote. A stop of `signal` stops the
 *  program and rejects with the stop. */
export function runFfprobe(call: ProgramCall, signal: AbortSignal): Promise<string> {
  return inWorkFolder(async (folder) => {
    const inputs = await prepareInputs(call.inputs, folder, signal)
    const output = new OutputStart()
    const errorOutput = new OutputStart()
    const end = await runProgram('ffprobe', {
      args: call.args,
      folder,
      inputs,
      timeoutMs: FFPROBE_TIMEOUT_MS,
      maxOutputBytes: FFPROBE_OUTPUT_BYTES,
    }, signal, ({ stream, text }) => (stream === 'stdout' ? output : errorOutput).add(text))
    if (end.kind !== 'exited' || end.code !== 0) throw new ToolError(withoutLocalPaths(ffprobeFailedText(end, output, errorOutput)))
    return withoutLocalPaths(ffprobeResultText(call.inputs, output, errorOutput))
  })
}
