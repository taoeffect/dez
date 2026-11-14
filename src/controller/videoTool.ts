import sbp from '@sbp/sbp'
import { wholeImageDrawing, type DrawnImage, type ImageSize } from '../model/chat/imageDrawing'
import { unreadableImageText } from '../model/tools/imageTool'
import { jobTimedOutText } from '../model/tools/jobs'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { programNotStartedText, type ClipInput, type KeptFile, type ProgramEnd } from '../model/tools/programRuns'
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
  JOIN_READS_CLIPS,
  joinNoVideoText,
  joinPlan,
  joinProbeArgs,
  joinProbeFailedText,
  joinRunResult,
  jpegCopyNotDrawnText,
  jpegCopyNotWrittenText,
  outputFiles,
  OutputStart,
  ProgramLog,
  VIDEO_READS_INPUTS,
  VIDEO_TOOL,
  type ClipFacts,
  type FfmpegCall,
  type ImageInput,
  type JoinCall,
  type ProgramCall,
  type VideoInput,
} from '../model/tools/videoTool'
import type { JobOutcome } from './jobs'
import type { AppFileEntry, BundledToolInput, BundledToolOutput, BundledToolRun } from './nativeTypes'
import { clipInputFile, inWorkFolder, readableFileSize, runProgram, storeOutputs } from './programRuns'

// The work of the `video` tool (model/tools/videoTool.ts): the runs of
// ffmpeg and ffprobe, the programs that Dez ships. This module registers
// no selector: the `video` runners (tools.ts) start the work, after the
// checks of the call. The work folder of a call, the copies of its input
// clips, a run, and the move of the new files are in programRuns.ts.
//
// Every text that leaves this module is a tool result or a job state: it
// goes to the chat provider. A program writes what it likes (a log line
// can hold the absolute path of its work folder, or a path that a file's
// metadata names), so each text with output of a program goes through
// `withoutLocalPaths`. An error of the system (a native error text) can
// hold a path too: it goes to the log only.

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
  let drawn: DrawnImage
  try {
    // The plan always draws, so redraw gives a drawing.
    drawn = await sbp(
      'dez.controller/images/redraw',
      file,
      (size: ImageSize) => ({ ...wholeImageDrawing(size), background: '#ffffff' }),
      'image/jpeg',
    ) as DrawnImage
  } catch (error) {
    console.error(`Failed to draw the JPEG copy of the image @${id}:`, error)
    throw new ToolError(jpegCopyNotDrawnText(id), '', { cause: error })
  }
  try {
    await sbp('dez.native/saveAppFile', `${folder}/${name}`, drawn.bytes, 'cache')
  } catch (error) {
    console.error(`Failed to write the JPEG copy of the image @${id}:`, error)
    throw new ToolError(jpegCopyNotWrittenText(id), '', { cause: error })
  }
  return null
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
    const copy = input.kind === 'image' ? await imageInputFile(input, folder) : await clipInputFile(input, folder, signal, VIDEO_TOOL.name)
    if (copy) copies.push(copy)
  }
  signal.throwIfAborted()
  return copies
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
  return runProgram('ffmpeg', VIDEO_TOOL.name, { ...run, timeoutMs, maxOutputBytes: FFMPEG_OUTPUT_BYTES }, signal, ({ stream, text }) => {
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

// The outcome of a job whose ffmpeg run ended in its time, with the text of
// `result`: the files of `kept` move into the generated folders as the
// assets of the job. A run that failed keeps no file.
async function keptOutcome(result: { text: string, isError: boolean }, folder: string, kept: readonly KeptFile[]): Promise<JobOutcome> {
  const text = withoutLocalPaths(result.text)
  if (result.isError) return { text, isError: true, assets: [] }
  return { text, isError: false, assets: await storeOutputs(folder, kept, VIDEO_TOOL.name) }
}

// One ffprobe run, to its end, with the time limit and the output cap of
// every ffprobe run of the tool.
function runProbe(
  run: Omit<BundledToolRun, 'tool' | 'timeoutMs' | 'maxOutputBytes'>,
  signal: AbortSignal,
  onOutput: (output: BundledToolOutput) => void,
): Promise<ProgramEnd> {
  return runProgram('ffprobe', VIDEO_TOOL.name, { ...run, timeoutMs: FFPROBE_TIMEOUT_MS, maxOutputBytes: FFPROBE_OUTPUT_BYTES }, signal, onOutput)
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
    return keptOutcome(ffmpegRunResult(call, end, files, log, output), folder, files.kept)
  })
}

// The facts of each clip file of a join, by the name of the file, from
// one ffprobe run for each. `copies` are the input files that the first
// run copies into the folder. Throws a `ToolError` for a clip that ffprobe
// cannot read, and for one with no picture.
async function probeJoinClips(clips: readonly ClipInput[], copies: BundledToolInput[], folder: string, signal: AbortSignal): Promise<Map<string, ClipFacts>> {
  const facts = new Map<string, ClipFacts>()
  for (const [index, { id, name }] of clips.entries()) {
    // The whole JSON, not its start: `clipFacts` cannot read a cut one.
    // `FFPROBE_OUTPUT_BYTES` keeps it small.
    let output = ''
    const errorOutput = new OutputStart()
    const end = await runProbe({ args: joinProbeArgs(name), folder, inputs: index === 0 ? copies : [] }, signal, ({ stream, text }) => {
      if (stream === 'stdout') output += text
      else errorOutput.add(text)
    })
    if (end.kind !== 'exited' || end.code !== 0) throw new ToolError(withoutLocalPaths(joinProbeFailedText(id, end, errorOutput.text)))
    const clip = clipFacts(output)
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
        throw new ToolError(programNotStartedText('ffmpeg', VIDEO_TOOL.name), '', { cause: error })
      }
    }
    const log = new ProgramLog()
    const end = await runFfmpeg({ args: plan.args, folder, inputs: [] }, call.timeoutMs, signal, report, log, new OutputStart())
    if (end.kind === 'timedOut') return timedOutOutcome(call.timeoutMs, log)

    const listed = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
    const { kept, notKept } = outputFiles(listed, made)
    const joined = kept.filter((file) => file.name === plan.output)
    return keptOutcome(joinRunResult(plan, call.clips.length, end, joined.length > 0, notKept, log), folder, joined)
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
    const end = await runProbe({ args: call.args, folder, inputs }, signal, ({ stream, text }) => (stream === 'stdout' ? output : errorOutput).add(text))
    if (end.kind !== 'exited' || end.code !== 0) throw new ToolError(withoutLocalPaths(ffprobeFailedText(end, output, errorOutput)))
    return withoutLocalPaths(ffprobeResultText(call.inputs, output, errorOutput))
  })
}
