import { byteSizeText } from '../../utils/byteSize'
import { drawnMediaType, wholeImageDrawing, type ImageDrawing, type ImageRegion, type ImageSize } from '../chat/imageDrawing'
import type { ImageMediaType } from '../chat/images'
import type { ClipReadProblem } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import type { PicturePart } from '../chat/types'
import {
  MAX_PICTURE_TOKENS,
  MAX_REPLY_PICTURE_BYTES,
  MAX_REPLY_PICTURE_TOKENS,
  MAX_REQUEST_IMAGES,
  pictureTokens,
  type PictureBudget,
  type ReplyPicture,
} from '../streams/replyPictures'
import { assetIdsArgument, unknownValuesText } from './arguments'
import { shortNumber } from './assetFacts'
import { clipReadAdviceText, type InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'
import { FFMPEG_FIXED_ARGS } from './videoTool'

// The `asset_view` tool: a model sees images and clips of its
// conversation again, so that it can check what it and other models made.
// Each asset gives its facts and a picture: an image as it is (a large one
// as a smaller copy, or only a part of it), a video clip as a sheet of
// frames, and an audio clip as a picture of its wave,
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

/** How large the pictures of a view are (`detail`): `review` costs little
 *  of the picture budget, `full` shows fine detail. */
export type ViewDetail = 'review' | 'full'
const VIEW_DETAILS: readonly ViewDetail[] = ['review', 'full']

/** The longest side of the picture of an image, by `detail`: a larger
 *  image goes as a smaller copy. No picture has a side over the `full`
 *  one: the Claude API refuses a side over 3,000 px in a request with more
 *  than 20 images, and a refused picture fails each later request of the
 *  reply, as each one sends it again.
 *  https://platform.claude.com/docs/en/build-with-claude/vision */
export const IMAGE_PICTURE_SIDES: Readonly<Record<ViewDetail, number>> = { review: 1568, full: 3000 }

/** The box that each frame of a frame sheet fits in, by `detail`: a sheet
 *  of `MAX_SHEET_COLUMNS` columns stays under 3,000 px on each side. */
export const FRAME_BOXES: Readonly<Record<ViewDetail, number>> = { review: 320, full: 640 }

/** The most bytes of the file of a picture: in base64, a file of this size
 *  stays under the 5 MB image limit of the Anthropic API. */
export const MAX_PICTURE_BYTES = 3_750_000

// A count as the texts write it: `57,408`.
function countText(count: number): string {
  return count.toLocaleString('en-US')
}

// The description is static (no counts that change, no dates): the tools
// array is in the provider's prompt cache.
export const ASSET_VIEW_TOOL: ToolDefinition = {
  name: 'asset_view',
  description: 'Show you images and clips of this conversation, so that you can check them: '
    + 'what you and other models made (the intermediate parts and the final result), before you use them or tell the user that the work is done. '
    + 'For each one, you get its facts (as asset_info gives them) and a picture: an image as it is, or a smaller copy of a large one (see `detail`); '
    + 'a video clip as a sheet of frames at equal steps (left to right, then top to bottom), with the time of each frame; '
    + 'an audio clip as a picture of its wave (time runs left to right), with its loudness. You do not hear a clip. '
    + 'You see the pictures after the results of the calls of this round, in this reply only. '
    + 'Each later request of this reply sends them again, so the pictures of one reply have a budget: '
    + `${MAX_REQUEST_IMAGES} pictures less the images of the user's newest message, ${countText(MAX_REPLY_PICTURE_TOKENS)} tokens, `
    + `and ${MAX_REPLY_PICTURE_BYTES / 1024 ** 2} MB of base64. `
    + `Dez counts a picture of W by H pixels as ceil(W / 28) * ceil(H / 28) tokens, at most ${countText(MAX_PICTURE_TOKENS)}: `
    + `a wave picture as ${countText(pictureTokens({ width: 800, height: 200 }))}, a 1920x1080 frame as ${countText(pictureTokens({ width: 1920, height: 1080 }))}. `
    + 'Each result tells the budget that is left. '
    + 'To check a small detail of an image, view only that part of it with `crop`. '
    + "Dez makes the pictures on the user's computer: no request goes to a model.",
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
    {
      name: 'detail',
      type: 'string',
      description: 'How large the pictures are: "review" (the default) or "full". '
        + `With "review", an image is at most ${countText(IMAGE_PICTURE_SIDES.review)} pixels on its longer side, `
        + `and each frame of a sheet fits in ${FRAME_BOXES.review} by ${FRAME_BOXES.review} pixels; `
        + `with "full", at most ${countText(IMAGE_PICTURE_SIDES.full)} pixels, and ${FRAME_BOXES.full} by ${FRAME_BOXES.full}. `
        + '"full" costs more of the picture budget: use it for a detail that "review" does not show.',
      required: false,
    },
    {
      name: 'crop',
      type: 'string',
      description: 'For one image, which `assets` names alone: the part of it to show, as "left top width height", '
        + 'four numbers from 0 to 1 that are fractions of the width and the height of the image, from its top left corner. '
        + '"0.5 0 0.5 0.5" is the top right quarter. '
        + 'Dez shows the part at its own pixels, or as a smaller copy at the size of `detail`.',
      required: false,
    },
  ],
}

const NOT_DONE = 'Dez showed nothing.'

/** The words of `asset_view` in the text of an id that names no image and
 *  no clip (`unknownAssetsText`). */
export const ASSET_VIEW_WORDING: InputWording = { argument: '`assets`', notDone: NOT_DONE }

/** A part of an image, in fractions of its width (`left`, `width`) and of
 *  its height (`top`, `height`), from its top left corner. */
export interface ViewCrop {
  left: number
  top: number
  width: number
  height: number
}

/** The checked arguments of an `asset_view` call. */
export interface AssetViewCall {
  ids: string[]
  /** The frames of the sheet of a video clip. */
  frames: number
  /** The part of a clip to show, in seconds; `end` null for the end of
   *  the clip. */
  start: number
  end: number | null
  detail: ViewDetail
  /** The part of the one image of the call to show; null for all of it. */
  crop: ViewCrop | null
}

// The `detail` of a call; a blank or absent one is the default.
function detailArgument(args: ToolArguments): ViewDetail {
  const text = typeof args.detail === 'string' ? args.detail.trim() : ''
  if (text === '') return 'review'
  const detail = VIEW_DETAILS.find((value) => value === text.toLowerCase())
  if (!detail) throw new ToolError(`${unknownValuesText('detail', [text], `one of: ${VIEW_DETAILS.join(', ')}`)} ${NOT_DONE}`)
  return detail
}

// The part of an image that the `crop` text `text` names. Throws a
// `ToolError` for a text that is not four numbers from 0 to 1, for a part
// with no width or height, and for a part past an edge of the image.
function cropArgument(text: string): ViewCrop {
  const numbers = text.split(/[\s,]+/).filter((word) => word !== '').map(Number)
  const quoted = JSON.stringify(text)
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new ToolError(`\`crop\` is ${quoted}: give four numbers from 0 to 1, "left top width height", as in "0.4 0.1 0.2 0.3". ${NOT_DONE}`)
  }
  const [left, top, width, height] = numbers
  if (width === 0 || height === 0) {
    throw new ToolError(`\`crop\` ${quoted} has a ${width === 0 ? 'width' : 'height'} of 0: give a part with a width and a height above 0. ${NOT_DONE}`)
  }
  // The margin keeps a float error of a sum that ends at the edge from a
  // refusal that would read "1, and the most is 1".
  for (const [start, size, edge, names] of [[left, width, 'right', 'left + width'], [top, height, 'bottom', 'top + height']] as const) {
    if (start + size > 1 + 1e-9) {
      throw new ToolError(`\`crop\` ${quoted} goes past the ${edge} edge of the image: ${names} is ${shortNumber(start + size)}, and the most is 1. ${NOT_DONE}`)
    }
  }
  return { left, top, width, height }
}

/** The checked arguments of an `asset_view` call. Throws a `ToolError` for
 *  a bad `assets` (`assetIdsArgument`), a `frames` out of its range, a
 *  `start` before 0, an `end` that is not after `start`, an unknown
 *  `detail`, a bad `crop`, and a `crop` for more than one asset. Whether
 *  the asset of a `crop` is an image, the caller checks. A blank `detail`
 *  or `crop` is none. */
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
  const detail = detailArgument(args)
  const cropText = typeof args.crop === 'string' ? args.crop.trim() : ''
  const crop = cropText === '' ? null : cropArgument(cropText)
  if (crop && ids.length > 1) {
    throw new ToolError(`\`crop\` is a part of one image, and \`assets\` names ${ids.length} assets. `
      + `Give \`assets\` only the image to crop, or give no \`crop\`. ${NOT_DONE}`)
  }
  return { ids, frames, start, end, detail, crop }
}

/** The pixels of the part `crop` of an image of `size`: each edge on the
 *  nearest line between two pixels. Null for a part of less than one pixel
 *  across or down. */
export function cropRegion(crop: ViewCrop, size: ImageSize): ImageRegion | null {
  const x = Math.round(crop.left * size.width)
  const y = Math.round(crop.top * size.height)
  // `Math.min`: `assetViewCall` lets a part end a float error past the edge.
  const width = Math.min(size.width, Math.round((crop.left + crop.width) * size.width)) - x
  const height = Math.min(size.height, Math.round((crop.top + crop.height) * size.height)) - y
  return width < 1 || height < 1 ? null : { x, y, width, height }
}

// The size of `region` made smaller to at most `side` pixels on its longer
// side; never larger.
function sizeWithin(region: ImageRegion, side: number): ImageSize {
  const scale = Math.min(1, side / Math.max(region.width, region.height))
  return { width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)) }
}

// The drawing of the JPEG copy of the part `region` of an image, on white,
// at most `side` pixels on its longer side.
function jpegPictureDrawing(region: ImageRegion, side: number): ImageDrawing {
  // A JPEG has no transparent pixels.
  return { crop: region, ...sizeWithin(region, side), background: '#ffffff', mediaType: 'image/jpeg' }
}

/** The first drawing of the picture of an image of `size`, whose file has
 *  `bytes` bytes of the type `mediaType` (null: a type that Dez does not
 *  send as it is), for a view with `detail` and `crop`; null for an image
 *  that goes as it is. No side is over the side of `detail`
 *  (`IMAGE_PICTURE_SIDES`). A crop goes at its own pixels, as a JPEG for a
 *  JPEG and else as a PNG, which keeps transparent pixels; a crop of less
 *  than one pixel (`cropRegion`) has no drawing, and the caller refuses
 *  it. An image with a side over that of `detail`, or a file over
 *  `MAX_PICTURE_BYTES`, goes as a JPEG copy. No provider is known to take
 *  SVG images, so an SVG goes as a PNG drawing. A drawing whose file is
 *  still too large goes again as `smallerPictureDrawing`. */
export function imagePictureDrawing(
  { detail, crop }: Pick<AssetViewCall, 'detail' | 'crop'>,
  size: ImageSize,
  bytes: number,
  mediaType: ImageMediaType | null,
): ImageDrawing | null {
  const side = IMAGE_PICTURE_SIDES[detail]
  if (crop) {
    const region = cropRegion(crop, size)
    return region && { crop: region, ...sizeWithin(region, side), mediaType: drawnMediaType(mediaType ?? 'image/png') }
  }
  const whole = wholeImageDrawing(size)
  if (bytes > MAX_PICTURE_BYTES || Math.max(size.width, size.height) > side) return jpegPictureDrawing(whole.crop, side)
  if (mediaType === null || mediaType === 'image/svg+xml') return { ...whole, mediaType: 'image/png' }
  return null
}

// The longer sides of the JPEG copies that a picture whose file is over
// `MAX_PICTURE_BYTES` is drawn again at, one after the other. A JPEG of
// 1,024 by 1,024 pixels of noise is under 2 MB (the shipped ffmpeg, 4:4:4
// at its best quality), so the last one fits.
const SMALLER_PICTURE_SIDES = [2048, 1568, 1024]

/** The next drawing of a picture whose `drawing` gave a file over
 *  `MAX_PICTURE_BYTES`: a PNG goes as a JPEG copy of the same size, and a
 *  JPEG as a copy at the next side of `SMALLER_PICTURE_SIDES` under its
 *  longer side. Null when there is no smaller side. */
export function smallerPictureDrawing(drawing: ImageDrawing): ImageDrawing | null {
  const longer = Math.max(drawing.width, drawing.height)
  const side = drawing.mediaType === 'image/jpeg' ? SMALLER_PICTURE_SIDES.find((candidate) => candidate < longer) : longer
  return side === undefined ? null : jpegPictureDrawing(drawing.crop, side)
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
export function clipPart(call: Pick<AssetViewCall, 'start' | 'end'>, seconds: number | null): ClipPart | string {
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
 *  into a square of `box` pixels (`FRAME_BOXES`), in the rows of
 *  `sheetGrid`. `showinfo` logs the time of each frame that the sheet takes
 *  (`sheetFrameTimes`), so `-v info` follows the fixed arguments: the
 *  later `-v` wins. */
export function frameSheetArgs(input: string, output: string, part: { start: number, end: number }, frames: number, box: number): string[] {
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
    `scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
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
  /** More lines: the loudness, why there is no picture. */
  notes: string[]
  /** Its picture, of `size` pixels (null: not known), what the picture
   *  shows (the text of the label that goes before it), and the line that
   *  tells about the picture (the frame times, the wave, a smaller copy),
   *  which the result has only while the picture goes; null for none. */
  picture: { part: PicturePart, size: ImageSize | null, shows: string, note: string | null } | null
}

/** Whether a view makes the picture of an asset: `show`; `overLimit`
 *  when the picture budget of the reply has nothing left of one of its
 *  parts; `noImageInput` when the model of the reply reads no images. */
export type PictureChoice = 'show' | 'overLimit' | 'noImageInput'

// What a picture costs, or what is left of a budget, but the pictures.
function tokensAndBytesText({ tokens, bytes }: PictureBudget): string {
  return `${countText(tokens)} tokens and ${byteSizeText(bytes)} of base64`
}

/** The note of an asset whose picture Dez did not make: the picture budget
 *  of the reply has nothing left (`overLimit`). */
export const PICTURE_LIMIT_NOTE = 'No picture: this reply has spent its picture budget (the last line tells what is left). '
  + 'In a later reply, call asset_view again to see it.'

/** The note of an asset whose picture costs `cost`, more than the budget
 *  `left` of the reply. */
export function pictureCostNote(cost: PictureBudget, left: PictureBudget): string {
  return `No picture: it costs ${tokensAndBytesText(cost)}, and this reply had only ${tokensAndBytesText(left)} left for pictures. `
    + 'In a later reply, call asset_view again to see it.'
}

// The advice of a picture with fewer pixels than the part of the image that
// it shows, for a view with `detail`; `cropped` for the picture of a crop.
function moreDetailAdvice(detail: ViewDetail, cropped: boolean): string {
  const crop = cropped ? 'with a smaller `crop`' : 'with `crop` for a part of the image'
  return detail === 'review'
    ? `For more detail, call again with \`detail\` "full" (at most ${countText(IMAGE_PICTURE_SIDES.full)} pixels on a side), or ${crop}.`
    : `For more detail, call again ${crop}.`
}

/** The note of an image of `size` whose picture is a JPEG copy of
 *  `picture` pixels, for a view with `detail`: a smaller copy, with how to
 *  see more, or a copy at the size of the image, whose file is too large to
 *  send as it is. */
export function smallerCopyNote(picture: ImageSize, size: ImageSize, detail: ViewDetail): string {
  const pixels = `${picture.width}x${picture.height} pixels`
  if (picture.width < size.width || picture.height < size.height) return `The picture is a smaller JPEG copy, of ${pixels}. ${moreDetailAdvice(detail, false)}`
  return `The picture is a JPEG copy, of ${pixels}: the file of the image is too large to send as it is.`
}

/** The note and the picture text of the picture of the part `region` of
 *  the image `id`, a drawing of `picture` pixels, for a view with
 *  `detail`. */
export function cropTexts(id: string, region: ImageRegion, picture: ImageSize, detail: ViewDetail): { note: string, shows: string } {
  const corners = `from x ${region.x}, y ${region.y} to x ${region.x + region.width}, y ${region.y + region.height}`
  const pixels = `${picture.width}x${picture.height} pixels`
  const drawn = picture.width < region.width || picture.height < region.height
    ? `as a smaller copy, of ${pixels}. ${moreDetailAdvice(detail, true)}`
    : `at its own ${pixels}.`
  return {
    note: `The picture is the part of the image ${corners} (in pixels of the image, from its top left corner), ${drawn}`,
    shows: `the part of the image @${id} ${corners}`,
  }
}

/** The error of a `crop` for the clip `id`, of the kind `kind`. */
export function cropOfClipText(id: string, kind: MediaTagKind): string {
  return `\`crop\` is a part of an image, and @${id} is ${kind === 'audio' ? 'an audio' : 'a video'} clip. Give no \`crop\` for a clip. ${NOT_DONE}`
}

/** The error of a `crop` that takes less than one pixel across or down of
 *  the image `id`, of `size`. */
export function cropUnderPixelText(id: string, size: ImageSize): string {
  return `\`crop\` takes less than one pixel across or down of the image @${id}, which is ${size.width}x${size.height} pixels. `
    + `Give a larger width or height in \`crop\`. ${NOT_DONE}`
}

/** The note of an image whose picture the webview could not draw (its
 *  smaller copy, its part, or the PNG copy of a type that does not go as it
 *  is). */
export const PICTURE_NOT_DRAWN_NOTE = 'No picture: Dez could not draw the copy of this image that it sends. '
  + 'Help › Developer Console shows the cause. This is not a fault of the call.'

/** The note of an image whose smallest JPEG copy (`smallerPictureDrawing`)
 *  is still over `MAX_PICTURE_BYTES`. */
export const PICTURE_TOO_LARGE_NOTE = 'No picture: even the smallest JPEG copy that Dez draws of this image is too large to send. '
  + 'This is not a fault of the call.'

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

/** The note of a frame sheet whose file is over `MAX_PICTURE_BYTES`, for
 *  a view with `detail`. */
export function sheetTooLargeNote(detail: ViewDetail): string {
  return `No frame sheet: its file is too large to send. Call again with fewer \`frames\`${detail === 'full' ? ', or with `detail` "review"' : ''}.`
}

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
  return items.flatMap(({ picture }) => (picture ? [{ label: `asset_view: ${picture.shows}.`, picture: picture.part, size: picture.size }] : []))
}

/** The result text of an `asset_view` call: for each asset, a line as in
 *  `@a | image | PNG | 1024x768 | 1.2 MB`, then the note of its picture and
 *  its other notes. The last lines tell where the pictures are and the
 *  picture budget that the reply has `left`, or that the model of the reply
 *  gets no pictures (`left` null). */
export function assetViewText(items: readonly AssetViewItem[], left: PictureBudget | null): string {
  const lines = items.flatMap((item) => [`@${item.id} | ${item.kind} | ${item.facts}`, ...(item.picture?.note ? [item.picture.note] : []), ...item.notes])
  if (left === null) {
    lines.push('This model gets no pictures, so Dez gives only the facts, and the loudness of an audio clip.')
    return lines.join('\n')
  }
  if (items.some((item) => item.picture)) {
    lines.push('You see each picture after the results of the calls of this round, after a line that names it. '
      + 'You see the pictures in this reply only. In a later reply, call asset_view again to see them again.')
  }
  lines.push(`Picture budget left in this reply: ${left.pictures} ${left.pictures === 1 ? 'picture' : 'pictures'}, ${tokensAndBytesText(left)}.`)
  return lines.join('\n')
}
