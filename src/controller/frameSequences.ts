import sbp from '@sbp/sbp'
import { APP_RUN_MAX_FRAMES } from '../model/tools/appsTool'
import {
  checkedSequence,
  encodedClipProblem,
  encodedFrameCount,
  encodeErrorLine,
  encodeFailedText,
  frameEncodeArgs,
  FRAMES_ENCODE_STATE,
  FRAMES_FILE,
  readsFramesFile,
  sequenceClipType,
  type FrameSequence,
} from '../model/tools/frameSequences'
import { withoutLocalPaths } from '../model/tools/localPaths'
import { ToolError } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import type { DecodeRun } from './inputDecode'
import type { FileTree } from './nativeTypes'
import { runProgram, wholeLinesEnd } from './programRuns'

// The encode of a frame sequence of the output folder of a script run (a
// script app or the code of a `js_eval` call; model/tools/frameSequences.ts)
// into one clip, with the ffmpeg that Dez ships. This module registers no
// selector: `keptOutputs` (appInvoke.ts) calls it after the code ended.
//
// Dez trusts no frame that the code made. It checks the folder from its
// listing, and ffmpeg runs under the OS rule of its program, so a frame
// can make it open no file outside the cache root and the assets. The
// clip is a new file that ffmpeg writes into the run folder, under a name
// that the code could not know, after the code ended: no code can change
// it, so Dez moves it into the Dez folder as it is, with no read.

// The most characters that Dez keeps of the end of each output stream of
// an encode run: the last progress block (about 300 characters), and the
// error output, whose last line goes into a result.
const OUTPUT_END_CHARS = 1000

/** The clip of a frame sequence after its encode: the name of the clip in
 *  the run folder, and the facts of the sequence; or why Dez does not keep
 *  it (a part of a sentence, as `ListedOutputs.notKept`). */
export type EncodedSequence = { clip: string, sequence: FrameSequence } | { notKept: string }

// The bytes of the frames.json at `path` of the cache root; null for a
// file that Dez cannot read.
async function framesFileBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await sbp('dez.native/loadAppFileBytes', path, 'cache') as Uint8Array
  } catch (error) {
    console.error(`Failed to read the ${FRAMES_FILE} of a frame sequence of a script run:`, error)
    return null
  }
}

/** Checks the frame sequence `name` of the output folder `outputFolder` (a
 *  path from the run folder `folder`) and encodes it into a new clip of the
 *  run folder (`checkedSequence`, `frameEncodeArgs`). `run` is the call of
 *  the run (`DecodeRun`), whose time limit the encode has too.
 *
 *  Throws a `ToolError` for an encode that did not start or did not end
 *  within the time limit (the clock of the caller ends it first in most
 *  cases), and the stop of `signal`. */
export async function encodedSequence(folder: string, outputFolder: string, name: string, run: DecodeRun, signal: AbortSignal): Promise<EncodedSequence> {
  const path = `${outputFolder}/${name}`
  const tree = await sbp('dez.native/listFileTree', `${folder}/${path}`, APP_RUN_MAX_FRAMES + 1, 'cache') as FileTree
  const json = readsFramesFile(tree) ? await framesFileBytes(`${folder}/${path}/${FRAMES_FILE}`) : null
  const checked = checkedSequence(name, tree, json)
  if ('notKept' in checked) return checked
  signal.throwIfAborted()

  const { sequence } = checked
  const clip = `${crypto.randomUUID()}.${sequenceClipType(sequence).extension}`
  let progress = ''
  let errors = ''
  let errorsCut = false
  const args = frameEncodeArgs(path, sequence, clip)
  const end = await runProgram('ffmpeg', run.toolName, { args, folder, inputs: [], timeoutMs: run.timeoutMs, maxOutputBytes: FFMPEG_OUTPUT_BYTES }, signal, ({ stream, text }) => {
    if (stream === 'stdout') {
      progress = (progress + text).slice(-OUTPUT_END_CHARS)
      return
    }
    errors += text
    errorsCut ||= errors.length > OUTPUT_END_CHARS
    errors = errors.slice(-OUTPUT_END_CHARS)
  })
  if (end.kind === 'timedOut') throw new ToolError(run.texts.timedOut(run.timeoutMs, FRAMES_ENCODE_STATE))
  if (end.kind !== 'exited' || end.code !== 0) {
    console.error(`ffmpeg could not encode the frame sequence ${name} of a script run:`, end, errors)
    // The error output can name a path that the data of a frame holds.
    return { notKept: encodeFailedText(name, withoutLocalPaths(encodeErrorLine(wholeLinesEnd(errors, errorsCut)))) }
  }

  const made = await sbp('dez.native/listFileTree', `${folder}/${clip}`, 0, 'cache') as FileTree
  const problem = encodedClipProblem(name, sequence, { size: made.kind === 'file' ? made.size : null, frames: encodedFrameCount(progress) })
  if (problem !== null) {
    console.error(`Dez does not keep the clip of the frame sequence ${name} of a script run:`, problem, errors)
    return { notKept: problem }
  }
  return { clip, sequence }
}
