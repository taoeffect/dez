import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import { isJsonObject } from '../../utils/json'
import { oneLineCut } from '../../utils/oneLineCut'
import { startOf } from '../../utils/textCut'
import {
  APP_RUN_MAX_FRAMES,
  APP_RUN_MAX_OUTPUT_BYTES,
  FRAMES_JSON_EXAMPLE,
  FRAMES_MAX_FPS,
  FRAMES_MAX_SIDE,
  FRAMES_MIN_FPS,
  kindName,
  type AppsTree,
  type AppsTreeEntry,
} from './appsTool'
import { isWholeNumberIn, unknownFieldsProblem } from './inputDecode'
import type { KeptFile } from './programRuns'

// The frame sequences of a script run (`apps invoke` of a script app, or a
// `js_eval` call): a folder `<name>.frames` directly in the output folder
// holds the frames of one clip and `frames.json`, the facts of the clip.
// After the run, Dez encodes the frames with its ffmpeg into one clip,
// which it keeps as one output file of the run. So code that draws one
// frame at a time (with a canvas of skia-canvas, or as raw pixels) makes a
// clip with no encoder:
// - with `"alpha": true`, the clip is MOV with the PNG codec, which keeps
//   the alpha of each pixel, for an overlay with `video ffmpeg`;
// - with no alpha, it is H.264 in MP4 (yuv420p, BT.709), which every
//   player plays.
// `FrameWriter` of dez-media/frames (src-tauri/libs/dez-media/frames.js)
// writes such a folder.
//
// This module has the pure parts: the checks of a folder and of its
// frames.json, the arguments of the ffmpeg run, the read of its progress,
// and the texts. controller/frameSequences.ts does the run. Each text of
// a sequence that Dez does not keep is a part of a sentence of a tool
// result (`ScriptRunOutputs.notKept`, appInvoke.ts).

/** The ending of the name of a folder of the output folder that holds a
 *  frame sequence. */
export const FRAMES_FOLDER_ENDING = '.frames'

/** The file of a frame sequence that gives its facts. */
export const FRAMES_FILE = 'frames.json'

/** The most bytes of a frames.json that Dez reads. */
export const FRAMES_FILE_MAX_BYTES = 64 * 1024

/** The state of a job while Dez encodes the frame sequences of its run. */
export const FRAMES_ENCODE_STATE = 'Dez encodes the frame sequences of the output folder into clips.'

// The formats of the frames of a sequence: PNG files, or raw RGBA (4 bytes
// for each pixel, row after row, with no header). Each is the ending of a
// frame file.
const FRAME_FORMATS = ['png', 'rgba'] as const

/** The format of the frames of a sequence (`FRAME_FORMATS`). */
export type FrameFormat = typeof FRAME_FORMATS[number]

/** A frame sequence that passed its checks: the facts of its frames.json
 *  and the format of its frames. */
export interface FrameSequence {
  fps: number
  width: number
  height: number
  count: number
  alpha: boolean
  format: FrameFormat
}

// The name of a frame: its number from 0 with 6 digits, which hold more
// than `APP_RUN_MAX_FRAMES`, and the ending of its format. A name with no
// fixed length would make the order of the names differ from the order of
// the numbers.
const FRAME_DIGITS = 6
const FRAME_NAME = new RegExp(`^(\\d{${FRAME_DIGITS}})\\.(${FRAME_FORMATS.join('|')})$`)

const FRAMES_FIELDS = ['fps', 'width', 'height', 'count', 'alpha']

// The most characters of a name of an entry in a text: the code of a run
// can make a name of any length.
const SHOWN_NAME_CHARS = 100

const FOLDER_RULE = `a frame sequence holds only ${FRAMES_FILE} and its frames, named `
  + FRAME_FORMATS.map((format) => `${frameFileName(0, format)}, ${frameFileName(1, format)}, and so on`).join(', or ')

/** Whether the entry `name` of the output folder, a folder, is a frame
 *  sequence. */
export function isFramesFolderName(name: string): boolean {
  return name.length > FRAMES_FOLDER_ENDING.length && name.endsWith(FRAMES_FOLDER_ENDING)
}

/** The name of the frame `index` (from 0) of the format `format`:
 *  `000041.png`. */
export function frameFileName(index: number, format: FrameFormat): string {
  return `${String(index).padStart(FRAME_DIGITS, '0')}.${format}`
}

/** The type of the clip of a sequence, as Dez stores it. */
export function sequenceClipType({ alpha }: Pick<FrameSequence, 'alpha'>): Pick<KeptFile, 'kind' | 'type' | 'extension'> {
  return alpha ? { kind: 'video', type: 'video/quicktime', extension: 'mov' } : { kind: 'video', type: 'video/mp4', extension: 'mp4' }
}

/** What a result tells of the clip of `sequence`: `90 frames, H.264 in
 *  MP4`. */
export function sequenceText({ count, alpha }: Pick<FrameSequence, 'count' | 'alpha'>): string {
  return `${countOf(count, 'frame')}, ${alpha ? 'PNG in MOV with alpha' : 'H.264 in MP4'}`
}

/** Whether Dez reads the frames.json of the sequence listed as `tree`: a
 *  plain file directly in its folder, not larger than
 *  `FRAMES_FILE_MAX_BYTES`. `checkedSequence` tells why it reads none. */
export function readsFramesFile(tree: AppsTree): boolean {
  const entry = tree.entries.find(({ path }) => path === FRAMES_FILE)
  return entry !== undefined && entry.kind === 'file' && entry.size <= FRAMES_FILE_MAX_BYTES
}

// The facts of the frames.json with the bytes `bytes`, or what is wrong
// with them: a part of a sentence.
function parsedFacts(bytes: Uint8Array): Omit<FrameSequence, 'format'> | string {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    value = undefined
  }
  if (!isJsonObject(value)) return `it must be one JSON object, as in ${FRAMES_JSON_EXAMPLE}`
  const unknown = unknownFieldsProblem(value, FRAMES_FIELDS, 'it')
  if (unknown !== null) return unknown
  const { fps, width, height, count, alpha } = value
  if (!(typeof fps === 'number' && fps >= FRAMES_MIN_FPS && fps <= FRAMES_MAX_FPS)) {
    return `"fps" must be a number from ${FRAMES_MIN_FPS} to ${FRAMES_MAX_FPS}: the frames a second of the clip`
  }
  if (!isWholeNumberIn(width, 1, FRAMES_MAX_SIDE) || !isWholeNumberIn(height, 1, FRAMES_MAX_SIDE)) {
    return `"width" and "height" must each be a whole number from 1 to ${countText(FRAMES_MAX_SIDE)}: the size of each frame in pixels`
  }
  if (!isWholeNumberIn(count, 1, APP_RUN_MAX_FRAMES)) return `"count" must be a whole number from 1 to ${countText(APP_RUN_MAX_FRAMES)}: the number of frames`
  if (alpha !== undefined && typeof alpha !== 'boolean') return '"alpha" must be true or false (leave it out for false): whether the clip keeps the alpha of each pixel'
  // H.264 stores the color of each 2 × 2 pixels once (4:2:0).
  if (alpha !== true && (width % 2 !== 0 || height % 2 !== 0)) {
    return `it gives the size ${width} × ${height}, and a clip with no alpha (H.264) needs an even width and an even height`
  }
  return { fps, width, height, count, alpha: alpha === true }
}

// How a text names the entry `entry` of a frames folder.
function entryText({ path, kind }: AppsTreeEntry): string {
  const quoted = JSON.stringify(startOf(path, SHOWN_NAME_CHARS))
  return kind === 'other' ? `${quoted}, ${kindName(kind)}` : `the ${kind} ${quoted}`
}

/** A frame sequence after its checks, or why Dez does not keep it: a part
 *  of a sentence, as `ListedOutputs.notKept`. */
export type CheckedSequence = { sequence: FrameSequence } | { notKept: string }

/** The check of the frame sequence `name` of the output folder, from the
 *  listing `tree` of its folder (with `APP_RUN_MAX_FRAMES` + 1 entries)
 *  and the bytes `json` of its frames.json (null for none:
 *  `readsFramesFile` tells to read none, or the read failed). The folder
 *  holds only frames.json and the frames, as plain files: the frames from
 *  0 with no gap, all of one format, as many as frames.json gives. A raw
 *  frame has the bytes of its size, and no frame is empty. The listing
 *  gives the sizes, so Dez reads no frame: ffmpeg finds a PNG frame that
 *  it cannot read (`encodedClipProblem`). */
export function checkedSequence(name: string, tree: AppsTree, json: Uint8Array | null): CheckedSequence {
  const refused = (problem: string): CheckedSequence => ({ notKept: `${name}/ (${problem})` })
  if (tree.kind !== 'folder') return refused('Dez could not list it')
  // An entry below a folder of the sequence does not count: the folder
  // itself refuses the sequence.
  const direct = tree.entries.filter(({ path }) => !path.includes('/')).sort((one, other) => one.path.localeCompare(other.path, 'en'))
  const frames = new Map<number, AppsTreeEntry>()
  const formats = new Set<FrameFormat>()
  let jsonSize: number | null = null
  for (const entry of direct) {
    if (entry.kind === 'file' && entry.path === FRAMES_FILE) {
      jsonSize = entry.size
      continue
    }
    const frame = FRAME_NAME.exec(entry.path)
    if (entry.kind !== 'file' || frame === null) return refused(`a frame sequence that holds ${entryText(entry)}: ${FOLDER_RULE}`)
    frames.set(Number(frame[1]), entry)
    formats.add(frame[2] as FrameFormat)
  }
  // The entries of the folder come first in a listing, so a cut listing
  // holds only frames and frames.json: more than the listing holds.
  if (tree.more) return refused(`more than ${countText(APP_RUN_MAX_FRAMES)} frames, the most that Dez encodes into one clip`)
  if (formats.size > 1) return refused('frames of two formats, .png and .rgba: the frames of a sequence are all PNG files, or all raw RGBA')
  if (jsonSize === null) return refused(`a frame sequence with no ${FRAMES_FILE}, which gives the facts of its clip, as in ${FRAMES_JSON_EXAMPLE}`)
  if (jsonSize > FRAMES_FILE_MAX_BYTES) return refused(`its ${FRAMES_FILE} is larger than ${byteSizeText(FRAMES_FILE_MAX_BYTES)}`)
  if (json === null) return refused(`Dez could not read its ${FRAMES_FILE}`)
  const facts = parsedFacts(json)
  if (typeof facts === 'string') return refused(`its ${FRAMES_FILE} is not valid: ${facts}`)

  const [format = 'png'] = formats
  const given = `its ${FRAMES_FILE} gives ${countOf(facts.count, 'frame')}`
  const rawBytes = facts.width * facts.height * 4
  for (let index = 0; index < facts.count; index++) {
    const frame = frames.get(index)
    if (frame === undefined) return refused(`${given}, and the frame ${frameFileName(index, format)} is missing: the frames are named from ${frameFileName(0, format)}, with no gap`)
    if (frame.size === 0) return refused(`its frame ${frame.path} is empty`)
    if (format === 'rgba' && frame.size !== rawBytes) {
      return refused(`its raw frame ${frame.path} has ${countOf(frame.size, 'byte')}, and a raw frame of ${facts.width} × ${facts.height} pixels has ${countText(rawBytes)}: `
        + '4 bytes for each pixel, in the order R, G, B, A, row after row')
    }
  }
  if (frames.size > facts.count) {
    const extra = [...frames.keys()].reduce((least, index) => index >= facts.count && index < least ? index : least, Infinity)
    return refused(`${given}, but it also holds the frame ${frameFileName(extra, format)}`)
  }
  return { sequence: { ...facts, format } }
}

// What every encode run of ffmpeg starts with:
// - `-v error`: the error output has only the errors, which go to the log;
// - `-progress pipe:1`: ffmpeg writes its progress to its standard output
//   as blocks of `key=value` lines; `frame` is the count of the frames
//   that it encoded so far (`encodedFrameCount`).
const ENCODE_RUN_ARGS: readonly string[] = ['-nostdin', '-hide_banner', '-nostats', '-v', 'error', '-progress', 'pipe:1']

/** The arguments of the ffmpeg run that encodes `sequence`, whose folder
 *  is `folder` (a path from the work folder of the run), into the new file
 *  `clip` of the work folder (`sequenceClipType`). */
export function frameEncodeArgs(folder: string, sequence: FrameSequence, clip: string): string[] {
  const { fps, width, height, count, alpha, format } = sequence
  // image2 reads the frames from 000000 to the first missing number. A raw
  // frame has no header, so its size and its pixel format come first.
  const input = [
    '-f', 'image2', '-pattern_type', 'sequence', '-start_number', '0', '-framerate', String(fps),
    ...(format === 'rgba' ? ['-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-c:v', 'rawvideo'] : []),
    '-i', `${folder}/%0${FRAME_DIGITS}d.${format}`,
  ]
  // ffmpeg scales a PNG frame of another size to the size of the first
  // frame, with no error; this scale gives the clip the size of
  // frames.json in every case. With no alpha: the colors of BT.709 in the
  // TV range, as players read H.264 of this size. The scale converts the
  // pixels, and `setparams` tags them, so that the MP4 tells it: the color
  // flags of the output do not reach it.
  const output = alpha
    ? ['-vf', `scale=${width}:${height},format=rgba`, '-c:v', 'png', '-f', 'mov']
    : [
        '-vf', `scale=${width}:${height}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-f', 'mp4',
      ]
  // `-fs` stops a clip that grows past the size that Dez keeps, but only
  // after its first writes to the disk: Dez still checks the size of the
  // clip (`encodedClipProblem`).
  return [...ENCODE_RUN_ARGS, ...input, '-frames:v', String(count), ...output, '-fs', String(APP_RUN_MAX_OUTPUT_BYTES + 1), clip]
}

/** The count of the frames that an encode run wrote, from the end of its
 *  progress output; null for none. */
export function encodedFrameCount(progress: string): number | null {
  const last = Array.from(progress.matchAll(/^frame=\s*(\d+)\s*$/gm)).at(-1)?.[1]
  return last === undefined ? null : Number(last)
}

/** Why Dez does not keep the clip that an encode run of the sequence
 *  `name` made, a part of a sentence; null for a clip that Dez keeps.
 *  `size` is the size of the clip (null: there is no clip), and `frames`
 *  the frames that ffmpeg encoded (`encodedFrameCount`). A PNG frame that
 *  ffmpeg cannot read is one that it leaves out, with no error, so the
 *  count tells it. */
export function encodedClipProblem(name: string, sequence: FrameSequence, { size, frames }: { size: number | null, frames: number | null }): string | null {
  if (size === null || size === 0) return `${name}/ (ffmpeg made no clip of it)`
  if (size > APP_RUN_MAX_OUTPUT_BYTES) {
    return `${name}/ (its clip is larger than ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)}, the most that Dez keeps of one file of a run: give it fewer frames, or smaller ones)`
  }
  if (frames === sequence.count) return null
  const read = `ffmpeg encoded ${countText(frames ?? 0)} of its ${countOf(sequence.count, 'frame')}`
  return `${name}/ (${read}: ${sequence.format === 'png' ? 'a frame is no PNG file that ffmpeg can read' : 'ffmpeg could not read a frame'})`
}

// The most characters of the error of a failed encode run in a result.
const SHOWN_ERROR_CHARS = 200

/** The error of a failed encode run, for `encodeFailedText`: the last line
 *  of its error output `errors`, with no `[png @ 0xffff8a444870]` mark of
 *  the part of ffmpeg that wrote it (the address tells a model nothing);
 *  empty for no line. The line can hold a path: give it through
 *  `withoutLocalPaths`. */
export function encodeErrorLine(errors: string): string {
  const line = errors.split(/[\r\n]+/).map((text) => text.trim()).filter((text) => text !== '').at(-1) ?? ''
  return oneLineCut(line.replace(/\[[^\]\n]* @ 0x[0-9a-f]+\]\s*/g, ''), SHOWN_ERROR_CHARS)
}

/** Why Dez does not keep the sequence `name`, whose encode run failed;
 *  `error` is the error of the run, with no local path
 *  (`encodeErrorLine`; empty for none). */
export function encodeFailedText(name: string, error: string): string {
  return `${name}/ (ffmpeg could not encode it${error === '' ? '' : `: ${error}`})`
}
