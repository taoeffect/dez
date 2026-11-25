import sbp from '@sbp/sbp'
import type { MessagePart } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import type { ChatClipRules } from '../model/providers/config'
import type { PromptPart } from '../model/streams/mediaRequest'
import {
  CHAT_CLIP_RUN_TIMEOUT_MS,
  chatClipCopies,
  chatClipMaxBytes,
  chatClipNotCopiedText,
  chatClipsTooLargeText,
  chatClipTimedOutText,
  type ChatClipCopy,
} from '../model/tools/chatClips'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { MODEL_INVOKE_TOOL } from '../model/tools/modelInvoke'
import { clipInput, ffmpegRunDetails, type ProgramEnd } from '../model/tools/programRuns'
import { ToolError } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { bytesToBase64 } from '../utils/base64'
import type { AppFileEntry, BundledToolInput } from './nativeTypes'
import { clipInputFile, errorOutputEnd, inWorkFolder, runProgram } from './programRuns'

// The clips of a `model_invoke` request to a text model
// (model/tools/chatClips.ts): ffmpeg makes the copy of each clip in a work
// folder, and Dez reads its bytes into the request. This module registers
// no selector: the job of the call (modelInvoke.ts) runs it before the
// request goes.
//
// Every `ToolError` of this module is the result of the job: it goes to
// the chat provider, so it holds no path.

// The most characters that Dez keeps of the end of the error output of a
// run, for the details of an error result.
const ERROR_END_CHARS = 1000

// How one run that makes a copy ended: its file and size, or the end and
// the error output of a run that made none.
type CopyRun =
  | { kind: 'made', size: number }
  | { kind: 'failed', end: Exclude<ProgramEnd, { kind: 'timedOut' }>, errors: string }

// One ffmpeg run of `copy` in `folder`, to its end. Throws a `ToolError`
// for a run that took longer than its limit.
async function copyRun(modelName: string, clip: ClipAttachment, copy: ChatClipCopy, folder: string, inputs: BundledToolInput[], signal: AbortSignal): Promise<CopyRun> {
  const errors = errorOutputEnd(ERROR_END_CHARS)
  const run = { args: copy.args, folder, inputs, timeoutMs: CHAT_CLIP_RUN_TIMEOUT_MS, maxOutputBytes: FFMPEG_OUTPUT_BYTES }
  const end = await runProgram('ffmpeg', MODEL_INVOKE_TOOL.name, run, signal, ({ stream, text }) => {
    if (stream === 'stderr') errors.add(text)
  })
  if (end.kind === 'timedOut') throw new ToolError(chatClipTimedOutText(modelName, clip.kind, clip.id))
  if (end.kind !== 'exited' || end.code !== 0) return { kind: 'failed', end, errors: errors.text() }
  const files = await sbp('dez.native/listAppFiles', folder, 'cache') as AppFileEntry[]
  return { kind: 'made', size: files.find((file) => file.name === copy.name)?.size ?? 0 }
}

// The request part of `clip`: the first copy of `chatClipCopies` that
// ffmpeg makes within `maxBytes`, what the earlier clips left of the
// limit. A stream copy that fails or that is too large leaves the
// conversion to try, which can be smaller (a FLAC clip as MP3). Throws a
// `ToolError` when no copy fits (its text names the limit of all clips
// together, not `maxBytes`), or when ffmpeg made none.
async function clipPart(modelName: string, clip: ClipAttachment, rules: ChatClipRules, maxBytes: number, signal: AbortSignal): Promise<{ part: MessagePart, size: number }> {
  return inWorkFolder(async (folder) => {
    const input = clipInput(clip)
    const inputCopy = await clipInputFile(input, folder, signal, MODEL_INVOKE_TOOL.name)
    // The first run copies the clip into the folder (a clip that was
    // downloaded is there already); a later run finds it there.
    let inputs = inputCopy ? [inputCopy] : []
    let tooLarge = false
    let failure: Extract<CopyRun, { kind: 'failed' }> | undefined
    for (const copy of chatClipCopies(clip, input.name, rules, maxBytes)) {
      const run = await copyRun(modelName, clip, copy, folder, inputs, signal)
      inputs = []
      if (run.kind === 'failed') {
        failure = run
        continue
      }
      if (run.size > maxBytes) {
        tooLarge = true
        continue
      }
      const data = bytesToBase64(await sbp('dez.native/loadAppFileBytes', `${folder}/${copy.name}`, 'cache') as Uint8Array)
      return { part: { ...copy.form, data }, size: run.size }
    }
    if (tooLarge || !failure) throw new ToolError(chatClipsTooLargeText(modelName, clip.kind, clip.id, chatClipMaxBytes(rules)))
    // The error output can name a path that the data of the file holds.
    throw new ToolError(chatClipNotCopiedText(modelName, clip.kind, clip.id), withoutLocalPaths(ffmpegRunDetails(failure.end, failure.errors, FFMPEG_OUTPUT_BYTES)))
  })
}

/** The content of the user message of a `model_invoke` request to the text
 *  model `modelName` (`ChatInvocation.content`), with the copy of each clip
 *  in place of its clip part, one clip after the other. The provider's
 *  chat requests carry clips by `rules`; `chatContent`
 *  (model/tools/modelInvoke.ts) checked the kinds and the count. The copies
 *  of all clips together can be at most `chatClipMaxBytes(rules)`: a
 *  copy gets only what the earlier ones left.
 *
 *  Throws a `ToolError` for a clip that Dez cannot read, cannot copy, or
 *  whose copy is too large, and the stop of `signal`. */
export async function chatClipParts(content: string | readonly PromptPart[], modelName: string, rules: ChatClipRules | undefined, signal: AbortSignal): Promise<string | MessagePart[]> {
  if (typeof content === 'string') return content
  const parts: MessagePart[] = []
  let bytesLeft = rules ? chatClipMaxBytes(rules) : 0
  for (const part of content) {
    if (part.type !== 'clip') {
      parts.push(part)
      continue
    }
    if (!rules) throw new Error('A chat request carries a clip to a provider whose chat requests carry none.')
    const copy = await clipPart(modelName, part.clip, rules, bytesLeft, signal)
    bytesLeft -= copy.size
    parts.push(copy.part)
  }
  return parts
}
