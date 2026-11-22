import sbp from '@sbp/sbp'
import type { AppRunCaller } from '../model/tools/appInvoke'
import { APP_RUN_MAX_DECODED_BYTES } from '../model/tools/appsTool'
import {
  APP_DECODES_STATE,
  clipDecodeArgs,
  clipDecodePlan,
  DECODE_NOT_PROBED_DETAILS,
  decodedBytes,
  decodedClip,
  hasDecodedFiles,
  type ClipDecodePlan,
  type DecodedClip,
  type InputDecode,
} from '../model/tools/inputDecode'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { ffmpegRunDetails, type ClipInput } from '../model/tools/programRuns'
import { clipReadProblemText } from '../model/tools/toolInputs'
import { ToolError } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { probeClip } from './assetInfo'
import type { AppFileEntry } from './nativeTypes'
import { runFfmpegLog, wholeLinesEnd } from './programRuns'

// The decode of the input clips of a run (model/tools/inputDecode.ts): for
// each clip, one ffprobe run reads its streams, and one ffmpeg run writes
// its decoded files into the work folder of the run. This module registers
// no selector: the work of a job calls it (appInvoke.ts).
//
// The output of ffprobe and ffmpeg can hold a path: only the end of the
// error output of a failed run goes into a text for a model, through
// `withoutLocalPaths`.

// The most characters that Dez keeps of the end of the error output of a
// run, for the details of its error result.
const ERROR_END_CHARS = 1000

// The sizes of the files of the work folder `folder`, by name.
async function fileSizes(folder: string): Promise<Map<string, number>> {
  const files = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
  return new Map(files.map((file) => [file.name, file.size]))
}

// The ffmpeg run that writes the files of `plan` from the copy of the clip
// of `input` in `folder`, with at most `maxBytes` bytes in each file.
// Throws a `ToolError` for a run that failed, and for one that did not end
// within the time limit of the run (the clock of the caller ends it first
// in most cases).
async function decodeClip(input: ClipInput, plan: ClipDecodePlan, maxBytes: number, folder: string, run: DecodeRun, signal: AbortSignal): Promise<void> {
  // With `-nostats` and named output files, ffmpeg writes only errors.
  const { end, log } = await runFfmpegLog(clipDecodeArgs(input.name, plan, maxBytes), folder, run, signal)
  if (end.kind === 'timedOut') throw new ToolError(run.texts.timedOut(run.timeoutMs, APP_DECODES_STATE))
  if (end.kind !== 'exited' || end.code !== 0) {
    console.error(`ffmpeg could not decode the ${input.kind} clip @${input.id}:`, end, log)
    const errorEnd = wholeLinesEnd(log.slice(-ERROR_END_CHARS), log.length > ERROR_END_CHARS)
    // The error output can name a path that the data of the file holds.
    throw new ToolError(run.texts.decodeFailed(input), withoutLocalPaths(ffmpegRunDetails(end, errorEnd, FFMPEG_OUTPUT_BYTES)))
  }
}

/** The run whose decode this is: its caller (the tool of the call, which
 *  the texts name, and the error texts), and its time limit. */
export interface DecodeRun extends AppRunCaller {
  timeoutMs: number
}

/** Decodes the clips `clips` of a run by `decode`, in the work folder
 *  `folder` of the run: it copies (or downloads) each clip into the folder
 *  under its name (`clipInput`), so the run of the code must not give them
 *  as inputs again, and writes the decoded files of each one next to it.
 *  Gives what each clip gave, by id (`decodedClip`).
 *
 *  Throws a `ToolError` for a clip that Dez cannot read or decode, for
 *  decoded files that are larger than `APP_RUN_MAX_DECODED_BYTES`
 *  together, and for a run that did not end in time; and the stop of
 *  `signal`. */
export async function decodeClips(clips: readonly ClipInput[], decode: InputDecode, folder: string, run: DecodeRun, signal: AbortSignal): Promise<Map<string, DecodedClip>> {
  const decoded = new Map<string, DecodedClip>()
  let total = 0
  for (const input of clips) {
    const probed = await probeClip(input, folder, signal, run.toolName)
    if (probed.kind === 'notRead') throw new ToolError(clipReadProblemText(input.kind, input.id, run.toolName, probed.problem))
    if (probed.kind === 'notProbed') throw new ToolError(run.texts.decodeFailed(input), DECODE_NOT_PROBED_DETAILS)
    const plan = clipDecodePlan(input, probed.facts, decode)
    let sizes = new Map<string, number>()
    if (hasDecodedFiles(plan)) {
      await decodeClip(input, plan, APP_RUN_MAX_DECODED_BYTES - total, folder, run, signal)
      sizes = await fileSizes(folder)
    }
    total += decodedBytes(plan, sizes)
    if (total > APP_RUN_MAX_DECODED_BYTES) throw new ToolError(run.texts.decodedTooLarge)
    decoded.set(input.id, decodedClip(plan, decode, sizes))
  }
  return decoded
}
