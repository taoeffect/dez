import { byteSizeText } from '../../utils/byteSize'
import type { AppKind } from './appManifest'
import {
  APP_RUN_MAX_DECODED_BYTES,
  APPS_INVOKE,
  APPS_TOOL,
  DECODE_EXAMPLE,
  DECODE_MAX_FPS,
  DECODE_MAX_RATE,
  DECODE_MAX_SIDE,
  DECODE_MIN_FPS,
  DECODE_MIN_RATE,
  type AppsPath,
} from './appsTool'
import type { ClipProbeFacts } from './assetFacts'
import { clipStreams } from './assetInfo'
import { ASSET_NAMES } from './jobs'
import type { ClipInput } from './programRuns'
import { ToolError, type SubcommandArguments } from './types'

// The decode of the input clips of a run of a script app (`apps invoke`
// with `decode`, or the `decode` field of the manifest of the app): before
// the code runs, ffmpeg decodes each clip of the call into raw files of
// the run folder, so that the code needs no decoder. The readers of
// dez-media take those files as they are (`f32Samples`, `rgbFrames`,
// src-tauri/libs/dez-media/decoded.js):
// - audio: the sound mixed to one channel, at the asked samples a second,
//   as float32 little-endian (`-f f32le`);
// - frames: the picture of a video clip scaled to exactly the asked size,
//   as rows of RGB pixels (`-pix_fmt rgb24 -f rawvideo`), frame after
//   frame: at the asked frames a second, or each frame of the clip once.
//
// This module has the pure parts: the checks of a decode, the arguments
// of its ffmpeg runs, the facts that the code gets in `dez.inputs`
// (appRunDescription, appInvoke.ts), and the texts. controller/
// inputDecode.ts does the runs. Every text here is a tool result: it goes
// to the chat provider.

/** The audio of a decode: its samples a second. */
export interface AudioDecode {
  rate: number
}

/** The frames of a decode: the size of each frame in pixels, and the
 *  frames a second (null: each frame of the clip once). */
export interface FrameDecode {
  width: number
  height: number
  fps: number | null
}

/** What a run decodes of each input clip: null for a part that it does
 *  not decode. */
export interface InputDecode {
  audio: AudioDecode | null
  frames: FrameDecode | null
}

/** The decode that decodes nothing: each clip goes to the code only as its
 *  file. */
export const NO_DECODE: InputDecode = { audio: null, frames: null }

/** Whether `decode` asks for a part. */
export function asksForDecode(decode: InputDecode): boolean {
  return decode.audio !== null || decode.frames !== null
}

/** The state of a job while Dez decodes its input clips. */
export const APP_DECODES_STATE = 'Dez decodes the input clips.'

// What Dez did not do for a call that it refuses.
const NOT_DONE = 'Dez started no job.'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => JSON.stringify(name))
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

// What is wrong with the fields of the object `value` at `where` that are
// not in `known`; null when it has none.
function unknownFieldsProblem(value: Record<string, unknown>, known: readonly string[], where: string): string | null {
  const unknown = Object.keys(value).filter((key) => !known.includes(key))
  if (unknown.length === 0) return null
  return `${where} has the field${unknown.length === 1 ? '' : 's'} ${quotedList(unknown)}, which Dez does not know: it takes only ${quotedList(known)}`
}

function isWholeNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

// The audio of a decode from `value`, or what is wrong with it.
function parsedAudio(value: unknown): AudioDecode | string {
  if (!isObject(value)) return '`audio` must be an object, as in {"rate": 22050}'
  const unknown = unknownFieldsProblem(value, ['rate'], '`audio`')
  if (unknown !== null) return unknown
  if (!isWholeNumberIn(value.rate, DECODE_MIN_RATE, DECODE_MAX_RATE)) {
    return `\`audio.rate\` must be a whole number from ${DECODE_MIN_RATE} to ${DECODE_MAX_RATE}: the samples a second, as in {"rate": 22050}`
  }
  return { rate: value.rate }
}

// The frames of a decode from `value`, or what is wrong with them.
function parsedFrames(value: unknown): FrameDecode | string {
  if (!isObject(value)) return '`frames` must be an object, as in {"width": 96, "height": 54}'
  const unknown = unknownFieldsProblem(value, ['width', 'height', 'fps'], '`frames`')
  if (unknown !== null) return unknown
  const { width, height, fps } = value
  if (!isWholeNumberIn(width, 1, DECODE_MAX_SIDE) || !isWholeNumberIn(height, 1, DECODE_MAX_SIDE)) {
    return `\`frames.width\` and \`frames.height\` must each be a whole number from 1 to ${DECODE_MAX_SIDE}: the size of each frame in pixels, as in {"width": 96, "height": 54}`
  }
  if (fps !== undefined && !(typeof fps === 'number' && fps >= DECODE_MIN_FPS && fps <= DECODE_MAX_FPS)) {
    return `\`frames.fps\` must be a number from ${DECODE_MIN_FPS} to ${DECODE_MAX_FPS}: the frames a second. Leave it out for each frame of the clip once`
  }
  return { width, height, fps: fps ?? null }
}

// The decode that `value` asks for, or what is wrong with it: a sentence
// with no end mark.
function parsedDecode(value: unknown): InputDecode | string {
  if (!isObject(value)) return `it must be a JSON object, as in ${DECODE_EXAMPLE}`
  const unknown = unknownFieldsProblem(value, ['audio', 'frames'], 'it')
  if (unknown !== null) return unknown
  const audio = value.audio === undefined ? null : parsedAudio(value.audio)
  if (typeof audio === 'string') return audio
  const frames = value.frames === undefined ? null : parsedFrames(value.frames)
  if (typeof frames === 'string') return frames
  return { audio, frames }
}

/** The decode of the `decode` argument of an `invoke` call; null for a
 *  call with none. Throws a `ToolError` for a value that is no decode. */
export function callDecode(args: SubcommandArguments): InputDecode | null {
  if (args.decode === undefined) return null
  const decode = parsedDecode(args.decode)
  if (typeof decode === 'string') throw new ToolError(`\`decode\` is not valid: ${decode}. ${NOT_DONE}`)
  return decode
}

/** The decode of the `decode` field of the manifest at `manifest`, whose
 *  bytes are `bytes`; null for a manifest with no such field, and for
 *  bytes that are no JSON object (`checkedAppKind`, appsTool.ts, refuses
 *  them first). A list of the apps does not read this field, so an app
 *  whose field is not valid still lists. Throws a `ToolError` for a field
 *  that is no decode. */
export function manifestDecode(bytes: Uint8Array | null, manifest: AppsPath): InputDecode | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()))
  } catch {
    return null
  }
  if (!isObject(value) || value.decode === undefined) return null
  const decode = parsedDecode(value.decode)
  if (typeof decode === 'string') {
    throw new ToolError(`The field "decode" of ${manifest.virtual} is not valid: ${decode}. Write the field again, or delete it, `
      + `or give the call its own \`decode\`, which the run takes in place of the field. ${NOT_DONE}`)
  }
  return decode
}

/** The decode of a run of the app `app` of the kind `kind`, whose
 *  manifest has the bytes `manifestBytes`: the `decode` of the call
 *  (`callDecode`), which takes the place of the manifest's field as a
 *  whole, or else that field (`manifestDecode`). Only a script app
 *  decodes: a UI app reads the bytes of each input itself. Throws a
 *  `ToolError` for a field of the manifest that is no decode, and for a
 *  decode of a UI app. */
export function runDecode({ app, manifest, decode }: { app: AppsPath, manifest: AppsPath, decode: InputDecode | null }, kind: AppKind, manifestBytes: Uint8Array | null): InputDecode {
  const resolved = decode ?? manifestDecode(manifestBytes, manifest) ?? NO_DECODE
  if (kind === 'ui' && asksForDecode(resolved)) {
    throw new ToolError(decode !== null
      ? `${app.virtual} is a UI app, and only a script app takes \`decode\`: the page of a UI app reads the bytes of each input and decodes them itself. Call again without \`decode\`. ${NOT_DONE}`
      : `${manifest.virtual} has the field "decode", which only a script app takes: the page of a UI app reads the bytes of each input and decodes them itself. `
        + `Delete the field, or give the call \`"decode": {}\`. ${NOT_DONE}`)
  }
  return resolved
}

/** The decoded files of a clip: the audio, and the frames, each with
 *  the name of its file in the run folder. */
export interface ClipDecodePlan {
  /** Null for no audio file: the decode asks for none, or the clip has no
   *  sound. */
  audio: { name: string, rate: number } | null
  /** Null for no frames file: the decode asks for none, or the clip has no
   *  picture (an audio clip with a cover picture has none). `fps` is the
   *  asked one (null: each frame of the clip once); `fileFps` is the one of
   *  the file: the asked one, else the clip's, from its probe (null: not
   *  known). */
  frames: { name: string, width: number, height: number, fps: number | null, fileFps: number | null } | null
}

/** The decoded files of the clip of `input`, whose probe gave `facts`,
 *  by `decode`. Each name is the id of the clip and an ending of no clip
 *  type, so no input copy (`clipInput`) has it. */
export function clipDecodePlan(input: Pick<ClipInput, 'id' | 'kind'>, facts: ClipProbeFacts, decode: InputDecode): ClipDecodePlan {
  const streams = clipStreams(input.kind, facts)
  const { audio, frames } = decode
  return {
    audio: audio && streams.sound ? { name: `${input.id}.f32`, rate: audio.rate } : null,
    frames: frames && streams.picture
      ? { name: `${input.id}.rgb`, width: frames.width, height: frames.height, fps: frames.fps, fileFps: frames.fps ?? facts.video?.fps ?? null }
      : null,
  }
}

/** Whether `plan` has a file to decode. */
export function hasDecodedFiles(plan: ClipDecodePlan): boolean {
  return plan.audio !== null || plan.frames !== null
}

// What every decode run of ffmpeg starts with. `-v error`: the error
// output goes into an error result; a lower level prints the metadata of
// the input.
const DECODE_RUN_ARGS: readonly string[] = ['-nostdin', '-hide_banner', '-nostats', '-v', 'error']

/** The arguments of the one ffmpeg run that writes the files of `plan`
 *  from the clip file `input`.
 *
 *  - `-map 0:a:0`, `-map 0:v:0`: the first stream of each kind, as the
 *    probe reads it.
 *  - `-fps_mode passthrough`: each frame that the decoder gives goes out
 *    once, with no frame added or dropped for a constant rate. With
 *    `fps`, the fps filter makes the frames of that rate first.
 *  - `scale=W:H` scales to exactly that size, so the aspect ratio of the
 *    clip can change: the code asked for that size.
 *  - `-fs`: ffmpeg ends a file, with no error, when it has this size, so a
 *    decode that is too large does not fill the disk. A file can end up to
 *    one packet (one frame) larger: the caller checks the real sizes.
 *    `maxBytes` is what is left of `APP_RUN_MAX_DECODED_BYTES`. */
export function clipDecodeArgs(input: string, plan: ClipDecodePlan, maxBytes: number): string[] {
  const sizeLimit = ['-fs', String(maxBytes + 1)]
  const audio = plan.audio
    ? ['-map', '0:a:0', '-ac', '1', '-ar', String(plan.audio.rate), '-c:a', 'pcm_f32le', ...sizeLimit, '-f', 'f32le', plan.audio.name]
    : []
  const frames = plan.frames ? framesArgs(plan.frames, sizeLimit) : []
  return [...DECODE_RUN_ARGS, '-i', input, ...audio, ...frames]
}

// The arguments of the frames output `frames` of a decode run, with the
// size limit `sizeLimit` (`clipDecodeArgs`).
function framesArgs({ name, width, height, fps }: NonNullable<ClipDecodePlan['frames']>, sizeLimit: readonly string[]): string[] {
  const scale = `scale=${width}:${height}`
  return [
    '-map', '0:v:0', '-vf', fps === null ? scale : `fps=${fps},${scale}`, '-fps_mode', 'passthrough',
    '-pix_fmt', 'rgb24', ...sizeLimit, '-f', 'rawvideo', name,
  ]
}

/** What the code gets of the decode of one clip, with the name of each
 *  file in the run folder. A part is absent when the decode asks for none,
 *  and null for a clip without its stream. `count` is the count of samples
 *  or of frames in the file. */
export interface DecodedClip {
  audio?: { name: string, rate: number, count: number } | null
  frames?: { name: string, width: number, height: number, fps: number | null, count: number } | null
}

/** What the decode of `plan` by `decode` gave, from `sizes`, the sizes of
 *  the files of the run folder by name. A file that is not there gives
 *  null, as a clip without its stream does. */
export function decodedClip(plan: ClipDecodePlan, decode: InputDecode, sizes: ReadonlyMap<string, number>): DecodedClip {
  const decoded: DecodedClip = {}
  if (decode.audio) {
    const size = plan.audio && sizes.get(plan.audio.name)
    decoded.audio = plan.audio && size != null ? { name: plan.audio.name, rate: plan.audio.rate, count: Math.floor(size / 4) } : null
  }
  if (decode.frames) {
    const { frames } = plan
    const size = frames && sizes.get(frames.name)
    decoded.frames = frames && size != null
      ? { name: frames.name, width: frames.width, height: frames.height, fps: frames.fileFps, count: Math.floor(size / (frames.width * frames.height * 3)) }
      : null
  }
  return decoded
}

/** The bytes of the decoded files of `plan`, from `sizes` (as in
 *  `decodedClip`). */
export function decodedBytes(plan: ClipDecodePlan, sizes: ReadonlyMap<string, number>): number {
  return [plan.audio?.name, plan.frames?.name].reduce((sum, name) => sum + (name === undefined ? 0 : sizes.get(name) ?? 0), 0)
}

/** The facts of `decoded` in an input of `dez.inputs`, with the path of
 *  each file in the run folder `runFolder`. */
export function decodedInputFacts(decoded: DecodedClip, runFolder: string): Record<string, unknown> {
  const facts: Record<string, unknown> = {}
  if (decoded.audio !== undefined) {
    facts.audio = decoded.audio && { path: `${runFolder}/${decoded.audio.name}`, rate: decoded.audio.rate, count: decoded.audio.count }
  }
  if (decoded.frames !== undefined) {
    const { frames } = decoded
    facts.frames = frames && { path: `${runFolder}/${frames.name}`, width: frames.width, height: frames.height, fps: frames.fps, count: frames.count }
  }
  return facts
}

/** The error result of a job whose decode of the clip of `input` failed:
 *  ffprobe or ffmpeg could not read it. The details tell how
 *  (`ffmpegRunDetails`, `DECODE_NOT_PROBED_DETAILS`). */
export function decodeFailedText({ kind, id }: Pick<ClipInput, 'kind' | 'id'>): string {
  return `Dez could not decode the ${ASSET_NAMES[kind]} @${id} for the run: its file is broken, or it has a type that the ffmpeg of Dez does not read. `
    + `The app did not run. This is not a fault of the call. Leave @${id} out of \`inputs\`, or give the call \`"decode": {}\`: the code then gets only the file of the clip.`
}

/** The details of `decodeFailedText` for a clip whose facts ffprobe could
 *  not read. */
export const DECODE_NOT_PROBED_DETAILS = 'ffprobe could not read the facts of the file.'

/** The error result of a job whose decoded files are larger than
 *  `APP_RUN_MAX_DECODED_BYTES` together. */
export const DECODED_TOO_LARGE_TEXT = `The decoded files of the input clips are larger than ${byteSizeText(APP_RUN_MAX_DECODED_BYTES)} together, `
  + `the most that Dez decodes for one run, so Dez stopped the decode. The app did not run. `
  + `Call ${APPS_TOOL.name} ${APPS_INVOKE} again with a smaller \`decode\`: a smaller frame size, fewer frames a second, or fewer audio samples a second. `
  + 'Or cut the clips first, or give the run fewer clips.'
