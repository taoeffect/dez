import type { ClipReadProblem } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import type { PicturePart } from '../chat/types'
import { MAX_REPLY_PICTURES, type ReplyPicture } from '../streams/replyPictures'
import { assetIdsArgument } from './arguments'
import { shortNumber } from './assetFacts'
import { clipReadAdviceText, type InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'
import { FFMPEG_FIXED_ARGS } from './videoTool'

// The `asset_view` tool: a model sees images and clips of its
// conversation again, so that it can check what it and other models made.
// Each asset gives its facts and a picture: an image as it is, a video
// clip as a sheet of frames, and an audio clip as a picture of its wave,
// with its loudness. The pictures go to the model through the reply
// (`ToolRunContext.showPictures`, streams/replyPictures.ts), never into
// the section, and a view makes no asset. controller/assetView.ts reads
// the files and runs ffmpeg.
//
// This module must not import chat/toolBlocks.ts or registry.ts: the
// registry imports it, and toolBlocks imports the registry.

/** The most ids of one call. */
export const MAX_ASSET_VIEW_IDS = 4

/** The frames of a frame sheet when the call does not tell. */
export const DEFAULT_SHEET_FRAMES = 6
const MIN_SHEET_FRAMES = 2
const MAX_SHEET_FRAMES = 16
const MAX_SHEET_COLUMNS = 4

/** The longest run of ffmpeg for one clip, as for `ffprobe`: a frame
 *  sheet decodes only a part of the clip. */
export const ASSET_VIEW_TIMEOUT_MS = 60_000

// The description is static (no counts that change, no dates): the tools
// array is in the provider's prompt cache.
export const ASSET_VIEW_TOOL: ToolDefinition = {
  name: 'asset_view',
  description: 'Show you images and clips of this conversation, so that you can check them: '
    + 'what you and other models made (the intermediate parts and the final result), before you use them or tell the user that the work is done. '
    + 'For each one, you get its facts (as asset_info gives them) and a picture: an image as it is; '
    + 'a video clip as a sheet of frames at equal steps (left to right, then top to bottom), with the time of each frame; '
    + 'an audio clip as a picture of its wave (time runs left to right), with its loudness. You do not hear a clip. '
    + 'You see the pictures after the results of the calls of this round, in this reply only, '
    + `and one reply shows at most ${MAX_REPLY_PICTURES} pictures. Dez makes them on the user's computer: no request goes to a model.`,
  parameters: [
    {
      name: 'assets',
      type: 'string',
      description: `The ids of the images and the clips, as in "@a @c", at most ${MAX_ASSET_VIEW_IDS}.`,
      required: true,
    },
    {
      name: 'frames',
      type: 'integer',
      description: `For a video clip: how many frames its sheet shows, from ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES}. Default: ${DEFAULT_SHEET_FRAMES}.`,
      required: false,
    },
    {
      name: 'start',
      type: 'number',
      description: 'For a clip: the second of the clip where the part to show starts. Default: 0.',
      required: false,
    },
    {
      name: 'end',
      type: 'number',
      description: 'For a clip: the second of the clip where the part to show ends. Default: the end of the clip.',
      required: false,
    },
  ],
}

const NOT_DONE = 'Dez showed nothing.'

/** The words of `asset_view` in the text of an id that names no image and
 *  no clip (`unknownAssetsText`). */
export const ASSET_VIEW_WORDING: InputWording = { argument: '`assets`', notDone: NOT_DONE }

/** The checked arguments of an `asset_view` call. */
export interface AssetViewCall {
  ids: string[]
  /** The frames of the sheet of a video clip. */
  frames: number
  /** The part of a clip to show, in seconds; `end` null for the end of
   *  the clip. */
  start: number
  end: number | null
}

/** The checked arguments of an `asset_view` call. Throws a `ToolError` for
 *  a bad `assets` (`assetIdsArgument`), a `frames` out of its range, a
 *  `start` before 0, and an `end` that is not after `start`. */
export function assetViewCall(args: ToolArguments): AssetViewCall {
  const ids = assetIdsArgument(args, { max: MAX_ASSET_VIEW_IDS, notDone: NOT_DONE })
  const frames = typeof args.frames === 'number' ? args.frames : DEFAULT_SHEET_FRAMES
  if (frames < MIN_SHEET_FRAMES || frames > MAX_SHEET_FRAMES) {
    throw new ToolError(`\`frames\` is ${frames}, and a frame sheet shows ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES} frames. `
      + `Give a number from ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES}. ${NOT_DONE}`)
  }
  const start = typeof args.start === 'number' ? args.start : 0
  if (start < 0) throw new ToolError(`\`start\` is ${start}: give a second of the clip, from 0 on. ${NOT_DONE}`)
  const end = typeof args.end === 'number' ? args.end : null
  if (end !== null && end <= start) {
    throw new ToolError(`\`end\` (${end}) is not after \`start\` (${start}): give an \`end\` after \`start\`, or no \`end\` for the end of the clip. ${NOT_DONE}`)
  }
  return { ids, frames, start, end }
}

/** The part of a clip that a view shows, in seconds from the start of the
 *  clip. `end` is null when the call gives no end and the length of the
 *  clip is not known. */
export interface ClipPart {
  start: number
  end: number | null
}

/** The part of a clip of `seconds` (null: not known) that `call` shows,
 *  or the text of why it shows none: a `start` at or after the end of the
 *  clip. An `end` after the end of the clip stops at that end. */
export function clipPart(call: AssetViewCall, seconds: number | null): ClipPart | string {
  if (seconds !== null && call.start >= seconds) {
    return `\`start\` (${shortNumber(call.start)} s) is not before the end of the clip (${shortNumber(seconds)} s), so Dez showed none of it: give a smaller \`start\`.`
  }
  return { start: call.start, end: call.end === null ? seconds : seconds === null ? call.end : Math.min(call.end, seconds) }
}

function partText({ start, end }: ClipPart): string {
  return `${shortNumber(start)} s to ${end === null ? 'the end' : `${shortNumber(end)} s`}`
}

// The input options that read only `part` of the input file. With them,
// the times of the frames start at 0 at `part.start`, so the frame sheet
// adds it (`sheetFrameTimes`).
function partArgs({ start, end }: ClipPart): string[] {
  return [...(start > 0 ? ['-ss', start.toFixed(3)] : []), ...(end === null ? [] : ['-to', end.toFixed(3)])]
}

// The options of the one JPEG picture of a run: `-update 1` writes one
// file that is no image sequence.
function pictureOutputArgs(output: string): string[] {
  return ['-frames:v', '1', '-update', '1', '-q:v', '3', output]
}

/** The grid of a frame sheet: at most `MAX_SHEET_COLUMNS` columns, and
 *  the rows as even as can be. */
export function sheetGrid(frames: number): { columns: number, rows: number } {
  const rows = Math.ceil(frames / MAX_SHEET_COLUMNS)
  return { columns: Math.ceil(frames / rows), rows }
}

/** The ffmpeg arguments of the frame sheet of the clip file `input`, the
 *  JPEG file `output`: `frames` frames at equal steps over `part`, each one
 *  the first frame at or after the middle of its step, each one scaled
 *  into a 320 by 320 box, in the rows of `sheetGrid`. `showinfo` logs the
 *  time of each frame that the sheet takes (`sheetFrameTimes`), so `-v
 *  info` follows the fixed arguments: the later `-v` wins. */
export function frameSheetArgs(input: string, output: string, part: { start: number, end: number }, frames: number): string[] {
  const step = (part.end - part.start) / frames
  // The first target is half a step in. It is rounded down to the
  // millisecond, then one more millisecond: a target equal to the time of a
  // frame can be a little after it in floating point, and `gte` then takes
  // the next frame.
  const offset = Math.max(0, Math.floor(step / 2 * 1000) / 1000 - 0.001)
  const { columns, rows } = sheetGrid(frames)
  const filters = [
    `select='gte(t\\,${offset.toFixed(3)}+${step.toFixed(6)}*selected_n)'`,
    'showinfo',
    'scale=w=320:h=320:force_original_aspect_ratio=decrease:force_divisible_by=2',
    'setsar=1',
    `tile=${columns}x${rows}:padding=4:color=white`,
  ]
  return [...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs(part), '-i', input, '-map', '0:v:0', '-vf', filters.join(','), ...pictureOutputArgs(output)]
}

const SHOWINFO_FRAME = /\[Parsed_showinfo_\d+ @ [^\]]*\] n:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g

/** The times of the frames of a sheet, in seconds of the clip, in sheet
 *  order, from the log of its `frameSheetArgs` run: what `showinfo` gives,
 *  never a guess, plus the start of the part. */
export function sheetFrameTimes(log: string, start: number, frames: number): number[] {
  return Array.from(log.matchAll(SHOWINFO_FRAME), (match) => start + Number(match[1])).slice(0, frames)
}

// ffmpeg logs this line when it read its input to the end and no frame
// came out of the filters. A damaged clip can log it too, after a frame
// that did not decode; one that it cannot decode at all logs "Cannot
// determine format of input … after EOF" in its place.
const NO_FILTERED_FRAMES = 'No filtered frames for output stream'

// The error lines of ffmpeg about a packet or a frame of the input that it
// could not read or decode, whatever the format and the codec.
const INPUT_ERROR = /Decoding error:|Error submitting .* to decoder|corrupt decoded frame|Error during demuxing:/

/** Whether the log of a `frameSheetArgs` run that gave no frame tells that
 *  the part has none: ffmpeg read the clip to the end of the part with no
 *  error. A damaged clip also gives no frame, and its log tells otherwise. */
export function partHasNoFrame(log: string): boolean {
  return log.includes(NO_FILTERED_FRAMES) && !INPUT_ERROR.test(log)
}

const LOUDNESS_FILTER = 'ebur128=framelog=quiet:peak=true'

/** The ffmpeg arguments that read the loudness of `part` of the clip file
 *  `input` (`loudnessOf` reads the log), and with `wave`, also draw the
 *  wave of that part into the JPEG file `wave`: 800 by 200 pixels, the
 *  height of the peaks on a square-root scale, so that a quiet part still
 *  shows. */
export function audioViewArgs(input: string, part: ClipPart, wave: string | null): string[] {
  const graph = wave === null
    ? `[0:a:0]${LOUDNESS_FILTER}[e]`
    : `[0:a:0]asplit[w][l];[w]showwavespic=s=800x200:colors=white:scale=sqrt:filter=peak[p];[l]${LOUDNESS_FILTER}[e]`
  return [
    ...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs(part), '-i', input, '-filter_complex', graph,
    ...(wave === null ? [] : ['-map', '[p]', ...pictureOutputArgs(wave)]),
    '-map', '[e]', '-f', 'null', '-',
  ]
}

/** The loudness of a part of a clip, as the `ebur128` filter writes the
 *  numbers (`-inf` for silence). */
export interface Loudness {
  /** In LUFS. */
  integrated: string
  /** In LU. */
  range: string
  /** In dBFS. */
  truePeak: string
}

/** The loudness from the summary in the log of an `audioViewArgs` run;
 *  null when the log has none. */
export function loudnessOf(log: string): Loudness | null {
  const at = log.lastIndexOf('Summary:')
  if (at < 0) return null
  const summary = log.slice(at)
  const integrated = /\bI:\s+(-?(?:inf|[\d.]+))\s+LUFS/.exec(summary)?.[1]
  const range = /\bLRA:\s+(-?(?:inf|[\d.]+))\s+LU\b/.exec(summary)?.[1]
  const truePeak = /\bPeak:\s+(-?(?:inf|[\d.]+))\s+dBFS/.exec(summary)?.[1]
  return integrated === undefined || range === undefined || truePeak === undefined ? null : { integrated, range, truePeak }
}

/** What a view gives for one asset. */
export interface AssetViewItem {
  id: string
  kind: 'image' | MediaTagKind
  /** Its facts (`imageFactsText`, `clipFactsText`), or the text of why Dez
   *  could not read it. */
  facts: string
  /** More lines: the frame times, the loudness, why there is no picture. */
  notes: string[]
  /** Its picture, and what the picture shows (the text of the label that
   *  goes before it); null for none. */
  picture: { part: PicturePart, shows: string } | null
}

/** Whether a view makes the picture of an asset: `show`; `overLimit`
 *  when the reply has shown `MAX_REPLY_PICTURES` pictures; `noImageInput`
 *  when the model of the reply reads no images. */
export type PictureChoice = 'show' | 'overLimit' | 'noImageInput'

/** The note of an asset whose picture the reply cannot show any more. */
export const PICTURE_LIMIT_NOTE = `No picture: this reply has shown ${MAX_REPLY_PICTURES} pictures, the most of one reply. `
  + 'In a later reply, call asset_view again to see it.'

/** The note of an image whose picture is a smaller JPEG copy, of `width`
 *  by `height` pixels. */
export function smallerCopyNote(width: number, height: number): string {
  return `The picture is a smaller JPEG copy, of ${width}x${height} pixels: the image is too large to send as it is.`
}

/** The note of an image whose picture the webview could not draw (its
 *  smaller copy, or the PNG copy of a type that does not go as it is). */
export const PICTURE_NOT_DRAWN_NOTE = 'No picture: Dez could not draw the copy of this image that it sends. '
  + 'Help › Developer Console shows the cause. This is not a fault of the call.'

/** What the picture of the image `id` shows. */
export function imagePictureShows(id: string): string {
  return `the image @${id}`
}

/** The note and the picture text of the frame sheet of the video clip
 *  `id`, whose run asked for `frames` frames: its part, its rows, and the
 *  time of each frame. A clip with fewer frames than that (a low frame
 *  rate) gives fewer, and they still fill the rows of the grid of
 *  `frames`. */
export function frameSheetTexts(id: string, part: ClipPart, times: readonly number[], frames: number): { note: string, shows: string } {
  const { columns } = sheetGrid(frames)
  const rows = times.length <= columns ? 'in one row' : `in rows of ${columns}, left to right, then top to bottom`
  const layout = `${times.length} ${times.length === 1 ? 'frame' : 'frames'} ${rows}, at ${times.map(shortNumber).join(', ')} s`
  return {
    note: `Frame sheet of ${partText(part)}: ${layout}.`,
    shows: `the frame sheet of the video clip @${id}: ${layout}`,
  }
}

/** The note when ffmpeg gave no frame of `part`. */
export function noFramesNote(part: ClipPart): string {
  return `No frame sheet: ffmpeg found no frame in ${partText(part)} of the clip.`
}

/** The note of a video clip whose length Dez does not know, for a call
 *  that gives no `end`. */
export const UNKNOWN_LENGTH_NOTE = 'No frame sheet: Dez does not know the length of this clip, so it cannot space the frames. Call again with `end`.'

/** The note of a video clip with no picture stream. */
export const NO_VIDEO_STREAM_NOTE = 'No frame sheet: the clip has no picture.'

/** The note of an audio clip with no sound stream. */
export const NO_AUDIO_STREAM_NOTE = 'No wave and no loudness: the clip has no sound.'

/** The note and the picture text of the wave of the audio clip `id`. */
export function waveTexts(id: string, part: ClipPart): { note: string, shows: string } {
  return {
    note: `Wave picture of ${partText(part)}: 800x200 pixels, time runs left to right, and the height is the peak level on a square-root scale.`,
    shows: `the wave of the audio clip @${id}, ${partText(part)}, time runs left to right`,
  }
}

/** The note of the loudness of `part`. */
export function loudnessNote(part: ClipPart, { integrated, range, truePeak }: Loudness): string {
  return `Loudness of ${partText(part)}: ${integrated} LUFS integrated, ${range} LU range, ${truePeak} dBFS true peak.`
}

/** The note of a run of ffmpeg that took longer than its time limit. */
export const VIEW_TIMED_OUT_NOTE = `ffmpeg took longer than ${ASSET_VIEW_TIMEOUT_MS / 1000} s, so Dez stopped it, and it shows no more of this clip. `
  + 'Call again with a shorter part (`start` and `end`).'

/** The note of a run of ffmpeg that failed. Its log goes to the console
 *  only: it can hold a path. */
export const VIEW_FAILED_NOTE = 'ffmpeg could not read this clip, so Dez shows no more of it. The file may be damaged; '
  + 'Help › Developer Console shows the cause. This is not a fault of the call.'

/** The note of a picture that ffmpeg made but Dez could not read. */
export const PICTURE_NOT_READ_NOTE = 'No picture: Dez could not read the picture that ffmpeg made of this clip. '
  + 'Help › Developer Console shows the cause. This is not a fault of the call.'

/** The note of the clip `id` that Dez could not read (`ClipReadError`).
 *  Its facts (`clipNotReadFacts`) tell what happened; the details of an
 *  unreadable clip go to the console only, as they can hold a path. */
export function clipNotReadNote(id: string, problem: ClipReadProblem): string {
  const advice = clipReadAdviceText(id, ASSET_VIEW_TOOL.name, problem)
  return problem === 'unreadable' ? `Help › Developer Console shows the cause. ${advice}` : advice
}

/** The pictures of a view, each with its label, for the reply
 *  (`ToolRunContext.showPictures`). */
export function assetViewPictures(items: readonly AssetViewItem[]): ReplyPicture[] {
  return items.flatMap((item) => (item.picture ? [{ label: `asset_view: ${item.picture.shows}.`, picture: item.picture.part }] : []))
}

/** The result text of an `asset_view` call: for each asset, a line as in
 *  `@a | image | PNG | 1024x768 | 1.2 MB`, then its notes. The last line
 *  tells where the pictures are, or that the model of the reply gets none
 *  (`imageInput` false). */
export function assetViewText(items: readonly AssetViewItem[], imageInput: boolean): string {
  const lines = items.flatMap((item) => [`@${item.id} | ${item.kind} | ${item.facts}`, ...item.notes])
  if (!imageInput) lines.push('This model gets no pictures, so Dez gives only the facts, and the loudness of an audio clip.')
  else if (items.some((item) => item.picture)) {
    lines.push('You see each picture after the results of the calls of this round, after a line that names it. '
      + 'You see the pictures in this reply only. In a later reply, call asset_view again to see them again.')
  }
  return lines.join('\n')
}
