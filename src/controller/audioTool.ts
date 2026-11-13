import sbp from '@sbp/sbp'
import { MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import type { MediaTagData } from '../model/chat/mediaTags'
import type { ClipAttachment } from '../model/providers/clipInputs'
import {
  AUDIO_CUT_FILE,
  AUDIO_CUT_TOO_LARGE_TEXT,
  AUDIO_NOT_FOUND_DETAILS,
  AUDIO_RUN_OUTPUT_BYTES,
  AUDIO_RUN_TIMEOUT_MS,
  AUDIO_TOOL,
  audioCutArgs,
  audioDecodeFailedText,
  audioEmptyCutText,
  audioLengthArgs,
  audioRunDetails,
  audioTimedOutText,
  writtenAudioSeconds,
  type AudioCutRequest,
} from '../model/tools/audioTool'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { clipInput } from '../model/tools/programRuns'
import { ToolError } from '../model/tools/types'
import type { AppFileEntry, BundledToolInput } from './nativeTypes'
import { clipInputFile, inWorkFolder, runProgram, storeOutputs } from './programRuns'

// The work of the `audio` tool (model/tools/audioTool.ts): the runs of
// ffmpeg, a program that Dez ships, on a copy of an audio clip in a new
// work folder (programRuns.ts). This module registers no selector: the
// `audio` runner (tools.ts) starts the work, after the checks of the call.
//
// A call waits for its work (it is no job): ffmpeg cuts a song in a
// fraction of a second. A stop of `signal` stops the program and rejects
// with the stop, and the work folder goes at every end.
//
// Every `ToolError` of this module is a tool result: it goes to the chat
// provider, so it holds no path.

// The most characters that Dez keeps of the end of each output stream of
// a run: the last progress block (about 150 characters), and the error
// output that goes into an error result.
const OUTPUT_END_CHARS = 1000

// The copy of the clip of a call in the work folder `folder`: the name of
// the file, and what the first run of the folder must copy into it (a run
// refuses an input whose name the folder has; a clip that was downloaded
// is there). Throws a `ToolError` for a clip that Dez cannot read.
async function clipCopy(clip: ClipAttachment, folder: string, signal: AbortSignal): Promise<{ name: string, inputs: BundledToolInput[] }> {
  const input = clipInput(clip)
  const copy = await clipInputFile(input, folder, signal, AUDIO_TOOL.name)
  return { name: input.name, inputs: copy ? [copy] : [] }
}

// The kept end `kept` of the error output of a run, whose start Dez `cut`:
// after a cut, only its whole lines. The cut can fall inside a path, and
// `withoutLocalPaths` does not see the rest of a path as a path.
function wholeLinesEnd(kept: string, cut: boolean): string {
  if (!cut) return kept
  const lineEnd = kept.search(/[\r\n]/)
  return lineEnd < 0 ? '' : kept.slice(lineEnd + 1)
}

// One ffmpeg run on the clip `id` in `folder`, to its end: the seconds of
// audio that it wrote, or null for none (`writtenAudioSeconds`). Throws a
// `ToolError` for a run that failed.
async function writtenSeconds(id: string, args: string[], folder: string, inputs: BundledToolInput[], signal: AbortSignal): Promise<number | null> {
  let progress = ''
  let errors = ''
  let errorsCut = false
  const run = { args, folder, inputs, timeoutMs: AUDIO_RUN_TIMEOUT_MS, maxOutputBytes: AUDIO_RUN_OUTPUT_BYTES }
  const end = await runProgram('ffmpeg', AUDIO_TOOL.name, run, signal, ({ stream, text }) => {
    if (stream === 'stdout') {
      progress = (progress + text).slice(-OUTPUT_END_CHARS)
      return
    }
    errors += text
    errorsCut ||= errors.length > OUTPUT_END_CHARS
    errors = errors.slice(-OUTPUT_END_CHARS)
  })
  if (end.kind === 'timedOut') throw new ToolError(audioTimedOutText(id))
  // The error output can name a path that the data of the file holds.
  if (end.kind !== 'exited' || end.code !== 0) throw new ToolError(audioDecodeFailedText(id), withoutLocalPaths(audioRunDetails(end, wholeLinesEnd(errors, errorsCut))))
  return writtenAudioSeconds(progress)
}

// The length in seconds of the clip `id`, whose copy `name` is in
// `folder` after `inputs`: ffmpeg decodes the whole clip.
async function decodedSeconds(id: string, name: string, folder: string, inputs: BundledToolInput[], signal: AbortSignal): Promise<number> {
  const seconds = await writtenSeconds(id, audioLengthArgs(name), folder, inputs, signal)
  if (seconds === null) throw new ToolError(audioDecodeFailedText(id), AUDIO_NOT_FOUND_DETAILS)
  return seconds
}

/** The exact length of the audio clip `clip` in seconds. Throws a
 *  `ToolError` for a clip that Dez cannot read or decode. */
export function audioClipSeconds(clip: ClipAttachment, signal: AbortSignal): Promise<number> {
  return inWorkFolder(async (folder) => {
    const { name, inputs } = await clipCopy(clip, folder, signal)
    return decodedSeconds(clip.id, name, folder, inputs, signal)
  })
}

/** The new clip of a cut: a stored WAV file of the generated audio, and
 *  its length. */
export interface AudioCut {
  clip: Omit<MediaTagData, 'id' | 'other'>
  seconds: number
}

/** Cuts the part `request` of the audio clip `clip` into a new stored WAV
 *  clip. One ffmpeg run makes the cut and tells its length, so the whole
 *  clip is decoded a second time only for the error text of a part that
 *  holds no audio. Throws a `ToolError` for that part, for a clip that Dez
 *  cannot read or decode, and for a new file that Dez cannot store.
 *
 *  The caller owns the new file: it writes the clip's tag, or deletes the
 *  file. */
export function cutAudioClip(clip: ClipAttachment, request: AudioCutRequest, signal: AbortSignal): Promise<AudioCut> {
  return inWorkFolder(async (folder) => {
    const { name, inputs } = await clipCopy(clip, folder, signal)
    const seconds = await writtenSeconds(clip.id, audioCutArgs(name, request), folder, inputs, signal)
    // The copy of the clip is in the folder now, so the second run gets no
    // input to copy.
    if (seconds === null) throw new ToolError(audioEmptyCutText(clip.id, request.start, await decodedSeconds(clip.id, name, folder, [], signal)))

    const files = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
    const size = files.find((file) => file.name === AUDIO_CUT_FILE.name)?.size ?? 0
    if (size > MAX_SAVED_CLIP_BYTES) throw new ToolError(AUDIO_CUT_TOO_LARGE_TEXT)
    const [asset] = await storeOutputs(folder, [AUDIO_CUT_FILE], AUDIO_TOOL.name)
    // `AUDIO_CUT_FILE` is a clip, so its asset is one.
    if (asset.kind !== 'clip') throw new Error('The cut of an audio clip gave no clip.')
    return { clip: asset.clip, seconds }
  })
}
