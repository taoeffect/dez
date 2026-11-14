import { byteSizeText } from '../../utils/byteSize'
import { drawnMediaType, wholeImageDrawing, type ImageComposition, type ImageDrawing, type ImageRegion, type ImageSize } from '../chat/imageDrawing'
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
import { frameTimeText, SCENE_CUT_FILTER } from './clipAnalysis'
import { clipReadAdviceText, type InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'
import { FFMPEG_FIXED_ARGS } from './videoTool'

// The `asset_view` tool: a model sees images and clips of its
// conversation again, so that it can check what it and other models made.
// Each asset gives its facts and a picture: an image as it is (a large one
// as a smaller copy, or only a part of it), a video clip as a sheet of
// frames, and an audio clip as a picture of its wave or its spectrogram
// (`sound_picture`), which a video clip can get as a strip under its
// frames; a clip with sound also gives its loudness. With `layout` "grid",
// the images and the frame sheets of a call go into one picture
// (assetGrid.ts). The pictures go to the model through the reply
// (`ToolRunContext.showPictures`, streams/replyPictures.ts), never into the
// section, and a view makes no asset. controller/assetView.ts reads the
// files and runs ffmpeg.
//
// This module must not import chat/toolBlocks.ts or registry.ts: the
// registry imports it, and toolBlocks imports the registry.

/** The most ids of one call with a picture for each asset. */
export const MAX_ASSET_VIEW_IDS = 4

/** The most ids of one call with `layout` "grid". */
export const MAX_ASSET_VIEW_GRID_IDS = 12

/** The frames of a frame sheet at equal steps when the call does not
 *  tell. */
export const DEFAULT_SHEET_FRAMES = 6
const MIN_SHEET_FRAMES = 2
/** The most frames of a frame sheet, and of a sheet of shots when the call
 *  does not tell. */
const MAX_SHEET_FRAMES = 16
export const MAX_SHEET_COLUMNS = 4

/** The white pixels between two frames of a frame sheet, which a grid also
 *  puts between two images. */
export const SHEET_PADDING = 4

/** The longest run of ffmpeg for one clip, as for `ffprobe`: a frame
 *  sheet decodes only a part of the clip. */
export const ASSET_VIEW_TIMEOUT_MS = 60_000

/** How large the pictures of a view are (`detail`): `review` costs little
 *  of the picture budget, `full` shows fine detail. */
export type ViewDetail = 'review' | 'full'
const VIEW_DETAILS: readonly ViewDetail[] = ['review', 'full']

/** How a view lays out the pictures of its assets (`layout`): `separate`,
 *  a picture for each asset; `grid`, one picture for all the images and
 *  video clips (assetGrid.ts). */
export type ViewLayout = 'separate' | 'grid'
const VIEW_LAYOUTS: readonly ViewLayout[] = ['separate', 'grid']

/** The longest side of the picture of an image, by `detail`: a larger
 *  image goes as a smaller copy. No picture has a side over the `full`
 *  one: the Claude API refuses a side over 3,000 px in a request with more
 *  than 20 images, and a refused picture fails each later request of the
 *  reply, as each one sends it again.
 *  https://platform.claude.com/docs/en/build-with-claude/vision */
export const IMAGE_PICTURE_SIDES: Readonly<Record<ViewDetail, number>> = { review: 1568, full: 3000 }

/** The box that each frame of a frame sheet, and each image of a grid,
 *  fits in, by `detail`: a sheet of `MAX_SHEET_COLUMNS` columns stays
 *  under 3,000 px on each side. */
export const FRAME_BOXES: Readonly<Record<ViewDetail, number>> = { review: 320, full: 640 }

/** What a view draws of the sound of a clip (`sound_picture`): its wave,
 *  its spectrogram, or no picture (the loudness still comes). */
export type SoundPicture = 'wave' | 'spectrogram' | 'none'
export type SoundPictureKind = Exclude<SoundPicture, 'none'>
const SOUND_PICTURES: readonly SoundPicture[] = ['wave', 'spectrogram', 'none']

/** The size of the drawing of the sound of a clip as a picture of its
 *  own. A spectrogram gets its axes and its scale around it, so its
 *  picture is larger, by the width of its labels. */
const SOUND_PICTURE_SIZE: ImageSize = { width: 800, height: 200 }

/** The height of the sound strip under the frame sheet of a video clip,
 *  by `detail`: half the frame box. The tallest sheet of `full` (4 rows of
 *  640 pixels) with its strip stays under 3,000 pixels. */
export const SOUND_STRIP_HEIGHTS: Readonly<Record<ViewDetail, number>> = { review: 160, full: 320 }

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
    + 'a video clip as a sheet of frames (left to right, then top to bottom) with the time of each frame: '
    + 'at equal steps (`frames`), at the times that you give (`times`), or one for each shot (`scenes`); '
    + 'an audio clip as a picture of its wave, or of its spectrogram (time runs left to right); '
    + 'with `sound_picture`, a video clip also gets one of these as a strip under its frames. '
    + 'A clip with sound, video or audio, also gets the loudness of the part that you view. You do not hear a clip. '
    + 'View a whole clip first; then, for a part that looks wrong, view it again with `start` and `end` around that part, '
    + 'or with `times` for the frames that you need. '
    + 'You see the pictures after the results of the calls of this round, in this reply only. '
    + 'Each later request of this reply sends them again, so the pictures of one reply have a budget: '
    + `${MAX_REQUEST_IMAGES} pictures less the images of the user's newest message, ${countText(MAX_REPLY_PICTURE_TOKENS)} tokens, `
    + `and ${MAX_REPLY_PICTURE_BYTES / 1024 ** 2} MB of base64. `
    + `Dez counts a picture of W by H pixels as ceil(W / 28) * ceil(H / 28) tokens, at most ${countText(MAX_PICTURE_TOKENS)}: `
    + `a wave picture as ${countText(pictureTokens({ width: 800, height: 200 }))}, a 1920x1080 frame as ${countText(pictureTokens({ width: 1920, height: 1080 }))}. `
    + 'Each result tells the budget that is left. '
    + 'To check a small detail of an image, view only that part of it with `crop`. '
    + 'To compare images and clips, or to check many of them for less of the budget, show them in one picture with `layout` "grid". '
    + "Dez makes the pictures on the user's computer: no request goes to a model.",
  parameters: [
    {
      name: 'assets',
      type: 'string',
      description: `The ids of the images and the clips, as in "@a @c", at most ${MAX_ASSET_VIEW_IDS}, or ${MAX_ASSET_VIEW_GRID_IDS} with \`layout\` "grid".`,
      required: true,
    },
    {
      name: 'frames',
      type: 'integer',
      description: `For a video clip: how many frames its sheet shows, at equal steps over the part, from ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES}. `
        + `Default: ${DEFAULT_SHEET_FRAMES}. With \`scenes\`: the most frames of the sheet, default ${MAX_SHEET_FRAMES}.`,
      required: false,
    },
    {
      name: 'times',
      type: 'string',
      description: `For a video clip: the times of the frames to show, in seconds of the clip, as in "14.96 15", at most ${MAX_SHEET_FRAMES}. `
        + 'Each frame is the first frame at or after its time, and a time that is in the list twice gives that frame and the next one. '
        + 'The result tells the time of each frame, and a time as a result writes it gives that frame again. '
        + 'Give no `frames`, `scenes`, `start`, or `end` with it.',
      required: false,
    },
    {
      name: 'scenes',
      type: 'boolean',
      description: 'For a video clip: true to show one frame for each shot of the part: its first frame, '
        + 'and the first frame after each cut (a sudden change of the whole picture) that Dez finds, with their times. '
        + `\`frames\` is then the most frames, default ${MAX_SHEET_FRAMES}, and the result tells the cuts that the sheet leaves out.`,
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
      name: 'sound_picture',
      type: 'string',
      description: 'For a clip with sound: the picture of its sound, "wave", "spectrogram", or "none". '
        + '"wave" shows the peak level over time. "spectrogram" shows the level of each frequency over time: '
        + 'a hum, a hiss, clicks, a missing range of highs or lows, or which parts are music and which are speech. '
        + '"none" shows no picture of the sound; the loudness still comes. '
        + 'An audio clip gets it as its picture, by default "wave"; its spectrogram has axes of time and frequency and a scale in dBFS. '
        + `A video clip gets it as a strip under its frame sheet, by default "none": the strip is as wide as the sheet, ${SOUND_STRIP_HEIGHTS.review} pixels high `
        + `(${SOUND_STRIP_HEIGHTS.full} with \`detail\` "full"), and it has no axes. `
        + 'It spans the whole part that you view (with `times`, the whole clip), time running left to right, and the result tells its frequency range.',
      required: false,
    },
    {
      name: 'detail',
      type: 'string',
      description: 'How large the pictures are: "review" (the default) or "full". '
        + `With "review", an image is at most ${countText(IMAGE_PICTURE_SIDES.review)} pixels on its longer side, `
        + `and each frame of a sheet and each image of a grid fits in ${FRAME_BOXES.review} by ${FRAME_BOXES.review} pixels; `
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
    {
      name: 'layout',
      type: 'string',
      description: '"separate" (the default) or "grid". With "separate", each asset gets its own picture. '
        + 'With "grid", all the images and video clips of the call go into one picture, top to bottom in the order of `assets`: '
        + `images side by side in rows of at most ${MAX_SHEET_COLUMNS}, each one in the frame box of \`detail\`, `
        + 'and the frame sheet of each video clip, with its sound strip, in rows of its own. An audio clip still gets its own picture. '
        + 'A grid costs less of the picture budget than a picture for each asset, and it shows each image smaller. '
        + 'With fewer than 2 images and video clips, the call shows separate pictures.',
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

/** How the frame sheet of a video clip picks its frames: `frames` frames
 *  at equal steps over the part; the first frame at or after each of
 *  `times` (seconds of the clip, in order); or the first frame of each
 *  shot of the part, at most `frames`. */
export type SheetChoice =
  | { kind: 'steps', frames: number }
  | { kind: 'times', times: number[] }
  | { kind: 'scenes', frames: number }

/** The checked arguments of an `asset_view` call. */
export interface AssetViewCall {
  ids: string[]
  /** The frames of the sheet of a video clip. */
  sheet: SheetChoice
  /** The part of a clip to show, in seconds; `end` null for the end of
   *  the clip. */
  start: number
  end: number | null
  detail: ViewDetail
  layout: ViewLayout
  /** The part of the one image of the call to show; null for all of it. */
  crop: ViewCrop | null
  /** The picture of the sound of a clip; null for the default of its kind
   *  (`soundPictureOf`). */
  soundPicture: SoundPicture | null
}

// The value of the text argument `name` of a call: one of `values`, in any
// case; null for a blank or absent one, which the caller takes as its
// default.
function choiceArgument<T extends string>(args: ToolArguments, name: string, values: readonly T[]): T | null {
  const argument = args[name]
  const text = typeof argument === 'string' ? argument.trim() : ''
  if (text === '') return null
  const value = values.find((candidate) => candidate === text.toLowerCase())
  if (!value) throw new ToolError(`${unknownValuesText(name, [text], `one of: ${values.join(', ')}`)} ${NOT_DONE}`)
  return value
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

// The times of the `times` text `text`, in order (a time that is there
// twice stays twice). Throws a `ToolError` for a word that is no time of a
// clip, and for more times than a sheet has frames.
function timesArgument(text: string): number[] {
  const times = text.split(/[\s,]+/).filter((word) => word !== '').map(Number)
  if (times.some((time) => !Number.isFinite(time) || time < 0)) {
    throw new ToolError(`\`times\` is ${JSON.stringify(text)}: give times in seconds of the clip, from 0 on, as in "14.96 15". ${NOT_DONE}`)
  }
  if (times.length > MAX_SHEET_FRAMES) {
    throw new ToolError(`\`times\` has ${times.length} times, and a frame sheet shows at most ${MAX_SHEET_FRAMES} frames. `
      + `Give at most ${MAX_SHEET_FRAMES} times, and the others in another call. ${NOT_DONE}`)
  }
  return times.sort((a, b) => a - b)
}

// The frame choice of a call. Throws a `ToolError` for a bad `times`, for
// a `times` with another argument that picks frames or a part, and for a
// `frames` out of its range. A blank `times` is none.
function sheetArgument(args: ToolArguments): SheetChoice {
  const timesText = typeof args.times === 'string' ? args.times.trim() : ''
  if (timesText !== '') {
    const others = ['frames', 'scenes', 'start', 'end'].filter((name) => (name === 'scenes' ? args.scenes === true : args[name] !== undefined))
    if (others.length > 0) {
      const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(others.map((name) => `\`${name}\``))
      throw new ToolError(`\`times\` picks the frames of the sheet itself, and the call also gives ${names}. Give \`times\` alone, or no \`times\`. ${NOT_DONE}`)
    }
    return { kind: 'times', times: timesArgument(timesText) }
  }
  const scenes = args.scenes === true
  const frames = typeof args.frames === 'number' ? args.frames : scenes ? MAX_SHEET_FRAMES : DEFAULT_SHEET_FRAMES
  if (frames < MIN_SHEET_FRAMES || frames > MAX_SHEET_FRAMES) {
    throw new ToolError(`\`frames\` is ${frames}, and a frame sheet shows ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES} frames. `
      + `Give a number from ${MIN_SHEET_FRAMES} to ${MAX_SHEET_FRAMES}. ${NOT_DONE}`)
  }
  return { kind: scenes ? 'scenes' : 'steps', frames }
}

/** The checked arguments of an `asset_view` call. Throws a `ToolError` for
 *  a bad `assets` (`assetIdsArgument`), more ids than its `layout` takes, a
 *  `frames` out of its range, a bad `times` or one with `frames`,
 *  `scenes`, `start`, or `end`, a `start` before 0, an `end` that is not
 *  after `start`, an unknown `detail`, `layout`, or `sound_picture`, a bad
 *  `crop`, and a `crop` for more than one asset. Whether the asset of a
 *  `crop` is an image, the caller checks. A blank `times`, `detail`,
 *  `layout`, `crop`, or `sound_picture` is none. */
export function assetViewCall(args: ToolArguments): AssetViewCall {
  const ids = assetIdsArgument(args, { max: MAX_ASSET_VIEW_GRID_IDS, notDone: NOT_DONE })
  const layout = choiceArgument(args, 'layout', VIEW_LAYOUTS) ?? 'separate'
  if (layout === 'separate' && ids.length > MAX_ASSET_VIEW_IDS) {
    throw new ToolError(`\`assets\` names ${ids.length} images and clips, and a call with a picture for each one takes at most ${MAX_ASSET_VIEW_IDS}. `
      + `Call again with \`layout\` "grid" (at most ${MAX_ASSET_VIEW_GRID_IDS}, in one picture), `
      + `or with the first ${MAX_ASSET_VIEW_IDS}, then again with the rest. ${NOT_DONE}`)
  }
  const sheet = sheetArgument(args)
  const start = typeof args.start === 'number' ? args.start : 0
  if (start < 0) throw new ToolError(`\`start\` is ${start}: give a second of the clip, from 0 on. ${NOT_DONE}`)
  const end = typeof args.end === 'number' ? args.end : null
  if (end !== null && end <= start) {
    throw new ToolError(`\`end\` (${end}) is not after \`start\` (${start}): give an \`end\` after \`start\`, or no \`end\` for the end of the clip. ${NOT_DONE}`)
  }
  const detail = choiceArgument(args, 'detail', VIEW_DETAILS) ?? 'review'
  const cropText = typeof args.crop === 'string' ? args.crop.trim() : ''
  const crop = cropText === '' ? null : cropArgument(cropText)
  if (crop && ids.length > 1) {
    throw new ToolError(`\`crop\` is a part of one image, and \`assets\` names ${ids.length} assets. `
      + `Give \`assets\` only the image to crop, or give no \`crop\`. ${NOT_DONE}`)
  }
  const soundPicture = choiceArgument(args, 'sound_picture', SOUND_PICTURES)
  return { ids, sheet, start, end, detail, layout, crop, soundPicture }
}

/** The picture of the sound of a clip of `kind` that `call` draws: the one
 *  of `sound_picture`, else the wave of an audio clip and none for a video
 *  clip, whose frame sheet is its picture. */
export function soundPictureOf({ soundPicture }: Pick<AssetViewCall, 'soundPicture'>, kind: MediaTagKind): SoundPicture {
  return soundPicture ?? (kind === 'audio' ? 'wave' : 'none')
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

/** `size` made smaller to at most `side` pixels on its longer side; never
 *  larger. */
export function sizeWithin(size: ImageSize, side: number): ImageSize {
  const scale = Math.min(1, side / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
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

/** The longer side at which a JPEG picture with the longer side `longer`,
 *  whose file is over `MAX_PICTURE_BYTES`, is drawn again: the next side of
 *  `SMALLER_PICTURE_SIDES` under it. Undefined when there is none. */
export function smallerPictureSide(longer: number): number | undefined {
  return SMALLER_PICTURE_SIDES.find((candidate) => candidate < longer)
}

/** The next drawing of a picture whose `drawing` gave a file over
 *  `MAX_PICTURE_BYTES`: a PNG goes as a JPEG copy of the same size, and a
 *  JPEG as a copy at `smallerPictureSide`. Null when there is no smaller
 *  side. */
export function smallerPictureDrawing(drawing: ImageDrawing): ImageDrawing | null {
  const longer = Math.max(drawing.width, drawing.height)
  const side = drawing.mediaType === 'image/jpeg' ? smallerPictureSide(longer) : longer
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

// The time from which the select filter of a sheet takes the first frame
// at or after `seconds`: rounded down to the millisecond, then one more
// millisecond, as a target equal to the time of a frame can be a little
// after it in floating point, and `gte` then takes the next frame. A frame
// time that a text writes (`frameTimeText`, to the millisecond) is at most
// half a millisecond off, so it gives the same frame again.
function frameTarget(seconds: number): number {
  return Math.max(0, Math.floor(seconds * 1000) / 1000 - 0.001)
}

// The filters of a sheet of `frames` frames after the ones that pick them:
// each frame scaled into a square of `box` pixels, in the rows of
// `sheetGrid`. `nb_frames` writes the sheet right after its last frame, so
// that `-frames:v 1` ends the run there; a run that gives fewer frames
// writes it at the end of its input.
function sheetFilters(frames: number, box: number): string[] {
  const { columns, rows } = sheetGrid(frames)
  return [
    `scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    'setsar=1',
    `tile=${columns}x${rows}:nb_frames=${frames}:padding=${SHEET_PADDING}:color=white`,
  ]
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
  const offset = frameTarget(step / 2)
  const filters = [`select='gte(t\\,${offset.toFixed(3)}+${step.toFixed(6)}*selected_n)'`, 'showinfo', ...sheetFilters(frames, box)]
  return [...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs(part), '-i', input, '-map', '0:v:0', '-vf', filters.join(','), ...pictureOutputArgs(output)]
}

/** The ffmpeg arguments of the frame sheet of the clip file `input`, the
 *  JPEG file `output`: the first frame at or after each of `times`
 *  (seconds of the clip, in order), as `frameSheetArgs` lays them out. The
 *  target of each time is for the next frame that the sheet takes, so a
 *  time that is there twice takes that frame and the next one. The run
 *  reads the clip from `from` (`-ss`; `sheetFrameTimes` adds it back),
 *  which shifts the times of its frames by up to a tick of the time base
 *  of the stream, a whole frame for some files: so the frames of exact
 *  times of the clip need `from` 0, and the frames that an earlier run
 *  found (`sceneCutsArgs`) need the `from` of that run. */
export function timesSheetArgs(input: string, output: string, from: number, times: readonly number[], box: number): string[] {
  const select = times.reduceRight((rest, time, index) => `if(eq(selected_n\\,${index})\\,gte(t\\,${frameTarget(time - from).toFixed(3)})\\,${rest})`, '0')
  const filters = [`select='${select}'`, 'showinfo', ...sheetFilters(times.length, box)]
  return [
    ...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs({ start: from, end: null }), '-i', input, '-map', '0:v:0', '-vf', filters.join(','),
    ...pictureOutputArgs(output),
  ]
}

/** The ffmpeg arguments that log the cuts of `part` of the clip file
 *  `input` (`SCENE_CUT_FILTER`; `cutTimes` reads them, from the start of
 *  the part) and write nothing. */
export function sceneCutsArgs(input: string, part: ClipPart): string[] {
  return [...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs(part), '-i', input, '-map', '0:v:0', '-vf', SCENE_CUT_FILTER, '-f', 'null', '-']
}

const SHOWINFO_FRAME = /\[Parsed_showinfo_\d+ @ [^\]]*\] n:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g

/** The times of the frames of a sheet, in seconds of the clip, in sheet
 *  order, from the log of its run (`frameSheetArgs`, `timesSheetArgs`):
 *  what `showinfo` gives, never a guess, plus `from`, where the run started
 *  to read. */
export function sheetFrameTimes(log: string, from: number, frames: number): number[] {
  return Array.from(log.matchAll(SHOWINFO_FRAME), (match) => from + Number(match[1])).slice(0, frames)
}

// ffmpeg logs this line when it read its input to the end and no frame
// came out of the filters. A damaged clip can log it too, after a frame
// that did not decode; one that it cannot decode at all logs "Cannot
// determine format of input … after EOF" in its place.
const NO_FILTERED_FRAMES = 'No filtered frames for output stream'

// The error lines of ffmpeg about a packet or a frame of the input that it
// could not read or decode, whatever the format and the codec.
const INPUT_ERROR = /Decoding error:|Error submitting .* to decoder|corrupt decoded frame|Error during demuxing:/

/** Whether the log of a run that gave no frame tells that the part has
 *  none: ffmpeg read the clip to the end of the part with no error. A
 *  damaged clip also gives no frame, and its log tells otherwise. For a
 *  run on the sound of a clip (`audioViewArgs`), the part has no sample of
 *  the sound: the sound ends before it, or starts after it. */
export function partHasNoFrame(log: string): boolean {
  return log.includes(NO_FILTERED_FRAMES) && !INPUT_ERROR.test(log)
}

const LOUDNESS_FILTER = 'ebur128=framelog=quiet:peak=true'

/** A picture of the sound that a loudness run draws (`audioViewArgs`):
 *  the wave or the spectrogram of the part, into the JPEG file `output`.
 *  `strip`: the size of a strip under a frame sheet, with no axes; null
 *  for a picture of its own (`SOUND_PICTURE_SIZE`), where a spectrogram
 *  gets its axes of time and frequency and its dBFS scale around it. */
export interface SoundDraw {
  kind: SoundPictureKind
  output: string
  strip: ImageSize | null
}

// The filter that draws `draw`. A wave has the height of its peaks on a
// square-root scale, so that a quiet part still shows. A spectrogram keeps
// the linear frequency scale of ffmpeg: its bins are linear, so a log
// scale smears the low notes over a wide band.
function soundDrawFilter({ kind, strip }: SoundDraw): string {
  const { width, height } = strip ?? SOUND_PICTURE_SIZE
  return kind === 'wave'
    ? `showwavespic=s=${width}x${height}:colors=white:scale=sqrt:filter=peak`
    : `showspectrumpic=s=${width}x${height}:legend=${strip ? 0 : 1}`
}

/** The ffmpeg arguments that read the loudness of `part` of the clip file
 *  `input` (`loudnessOf` reads the log), and with `draw`, also draw the
 *  wave or the spectrogram of that part. */
export function audioViewArgs(input: string, part: ClipPart, draw: SoundDraw | null): string[] {
  const graph = draw === null
    ? `[0:a:0]${LOUDNESS_FILTER}[e]`
    : `[0:a:0]asplit[d][l];[d]${soundDrawFilter(draw)}[p];[l]${LOUDNESS_FILTER}[e]`
  return [
    ...FFMPEG_FIXED_ARGS, '-v', 'info', ...partArgs(part), '-i', input, '-filter_complex', graph,
    ...(draw === null ? [] : ['-map', '[p]', ...pictureOutputArgs(draw.output)]),
    '-map', '[e]', '-f', 'null', '-',
  ]
}

/** The drawing of the frame sheet of a video clip with its sound strip
 *  under it (dez.controller/images/compose), from their `sizes`: the sheet
 *  as it is, then, `SHEET_PADDING` lower, the strip at the width of the
 *  sheet, on white, as a JPEG. */
export function soundStripLayout([sheet, strip]: readonly ImageSize[]): ImageComposition {
  const y = sheet.height + SHEET_PADDING
  return {
    width: sheet.width,
    height: y + strip.height,
    places: [{ x: 0, y: 0, width: sheet.width, height: sheet.height }, { x: 0, y, width: sheet.width, height: strip.height }],
    // A JPEG has no transparent pixels.
    background: '#ffffff',
    mediaType: 'image/jpeg',
  }
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

/** A picture of a view, of `size` pixels (null: not known), what it shows
 *  (the text of the label that goes before it), and the line that tells
 *  about it (the frame times, the wave, a smaller copy, the parts of a
 *  grid), which the result has only while the picture goes; null for
 *  none. */
export interface ViewPicture {
  part: PicturePart
  size: ImageSize | null
  shows: string
  note: string | null
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
  picture: ViewPicture | null
}

/** The one picture of the images and the video clips of a view with
 *  `layout` "grid" (assetGrid.ts), or the notes of why it has none. */
export interface AssetViewGrid {
  picture: ViewPicture | null
  notes: string[]
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

/** The ids `ids` as a text writes them: "@a, @b, and @c". */
export function idsListText(ids: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(ids.map((id) => `@${id}`))
}

/** The note of the grid of `ids`, whose picture costs `cost`, more than the
 *  budget `left` of the reply. */
export function gridCostNote(ids: readonly string[], cost: PictureBudget, left: PictureBudget): string {
  return `No grid picture of ${idsListText(ids)}: it costs ${tokensAndBytesText(cost)}, `
    + `and this reply had only ${tokensAndBytesText(left)} left for pictures. In a later reply, call asset_view again to see them.`
}

/** The note of the grid of `ids`, which the webview could not draw. */
export function gridNotDrawnNote(ids: readonly string[]): string {
  return `No grid picture of ${idsListText(ids)}: Dez could not draw it. Help › Developer Console shows the cause. `
    + 'This is not a fault of the call. To see them, call again with `layout` "separate".'
}

/** The note of the grid of `ids`, whose smallest JPEG copy is still over
 *  `MAX_PICTURE_BYTES`. */
export function gridTooLargeNote(ids: readonly string[]): string {
  return `No grid picture of ${idsListText(ids)}: even the smallest JPEG copy that Dez draws of the grid is too large to send. `
    + 'Call again with fewer assets, or with `layout` "separate".'
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

function timesListText(times: readonly number[]): string {
  return `${times.map(frameTimeText).join(', ')} s`
}

// The layout of the frames at `times` of a sheet whose run asked for
// `frames` frames. A clip can give fewer (a low frame rate, a time after
// the end of its picture), and they still fill the rows of the grid of
// `frames`.
function sheetLayoutText(times: readonly number[], frames: number): string {
  const { columns } = sheetGrid(frames)
  const rows = times.length <= columns ? 'in one row' : `in rows of ${columns}, left to right, then top to bottom`
  return `${times.length} ${times.length === 1 ? 'frame' : 'frames'} ${rows}, at ${timesListText(times)}`
}

/** The note and the picture text of the frame sheet of the video clip
 *  `id`, with its frames at `times`, whose run asked for `frames` frames at
 *  equal steps over `part`: its part, its rows, and the time of each
 *  frame. */
export function frameSheetTexts(id: string, part: ClipPart, times: readonly number[], frames: number): { note: string, shows: string } {
  const layout = sheetLayoutText(times, frames)
  return {
    note: `Frame sheet of ${partText(part)}: ${layout}.`,
    shows: `the frame sheet of the video clip @${id}: ${layout}`,
  }
}

/** The note and the picture text of the frame sheet of the video clip
 *  `id`, with its frames at `times`, for the `times` `asked` of a call, of
 *  which its run asked for the first `frames` (the times before the end of
 *  the clip). */
export function timesSheetTexts(id: string, asked: readonly number[], times: readonly number[], frames: number): { note: string, shows: string } {
  const layout = sheetLayoutText(times, frames)
  return {
    note: `Frame sheet of the first frame at or after each of \`times\` ${timesListText(asked)}: ${layout}.`,
    shows: `the frame sheet of the video clip @${id}: ${layout}`,
  }
}

/** The note of the `times` of a call that gave no frame. */
export function missingTimesNote(times: readonly number[]): string {
  return `No frame at or after ${timesListText(times)}: the picture of the clip ends before ${times.length === 1 ? 'that time' : 'these times'}.`
}

/** The note and the picture text of the frame sheet of the shots of `part`
 *  of the video clip `id`, with its frames at `times`, whose run asked for
 *  `frames` frames: the first frame of the part and the first frame after
 *  each of the first `frames - 1` of `cuts`, the times of the cuts of the
 *  part. */
export function scenesSheetTexts(id: string, part: ClipPart, times: readonly number[], frames: number, cuts: readonly number[]): { note: string, shows: string } {
  const layout = sheetLayoutText(times, frames)
  const leftOut = cuts.slice(frames - 1)
  const found = cuts.length === 0
    ? 'Dez found no cut in the part.'
    : `Dez found ${cuts.length} ${cuts.length === 1 ? 'cut' : 'cuts'} in the part`
      + (leftOut.length === 0
        ? '.'
        : `, and the sheet leaves out the last ${leftOut.length === 1 ? 'one' : leftOut.length}, from ${frameTimeText(leftOut[0])} s on: `
          + `to see ${leftOut.length === 1 ? 'it' : 'them'}, call again with \`scenes\` and \`start\` ${frameTimeText(leftOut[0])}.`)
  const frameKinds = cuts.length === 0 ? 'The frame is the first frame of the part' : 'The first frame is the first frame of the part, and each other one the first frame after a cut'
  return {
    note: `Frame sheet of the shots of ${partText(part)}: ${layout}. ${frameKinds}. ${found}`,
    shows: `the frame sheet of the shots of the video clip @${id}: ${layout}`,
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
 *  a view with `detail`, whose frames the argument `choice` picked. */
export function sheetTooLargeNote(detail: ViewDetail, choice: 'frames' | 'times'): string {
  return `No frame sheet: its file is too large to send. Call again with fewer \`${choice}\`${detail === 'full' ? ', or with `detail` "review"' : ''}.`
}

// What a view does not give of the sound of a clip: the picture `picture`
// (nothing for "none"), and with `loudness`, its loudness. One of the two
// at least.
function missingSoundText(picture: SoundPicture, loudness: boolean): string {
  return `No ${[...(picture === 'none' ? [] : [picture]), ...(loudness ? ['loudness'] : [])].join(' and no ')}`
}

/** The note of a clip with no sound stream, for a view that would draw
 *  `picture` of its sound, and with `loudness`, tell its loudness: not
 *  "none" with no loudness. */
export function noSoundNote(picture: SoundPicture, loudness: boolean): string {
  return `${missingSoundText(picture, loudness)}: the clip has no sound.`
}

/** The note of `part` of a clip whose sound has no sample in the part
 *  (`partHasNoFrame`), for a run that also drew `picture` of the sound. */
export function soundlessPartNote(part: ClipPart, picture: SoundPicture): string {
  return `${missingSoundText(picture, true)}: the sound of the clip has no sample in ${partText(part)}.`
}

/** The note and the picture text of `picture` of the sound of `part` of
 *  the clip `id`, of `kind`, as a picture of its own (`SoundDraw`) of
 *  `size` (null: not known). */
export function soundPictureTexts(id: string, kind: MediaTagKind, picture: SoundPictureKind, part: ClipPart, size: ImageSize | null): { note: string, shows: string } {
  const pixels = size ? `${size.width}x${size.height} pixels, ` : ''
  if (picture === 'wave') {
    return {
      note: `Wave picture of ${partText(part)}: ${pixels}time runs left to right, and the height is the peak level on a square-root scale.`,
      shows: `the wave of the ${kind} clip @${id}, ${partText(part)}, time runs left to right`,
    }
  }
  // The time axes of ffmpeg start at 0 at the start of the part (`-ss`).
  const seconds = part.start > 0 ? `in seconds from the start of the part (add ${shortNumber(part.start)} s for the time in the clip)` : 'in seconds of the clip'
  return {
    note: `Spectrogram of ${partText(part)}: ${pixels}time runs left to right, on the axes at the top and the bottom ${seconds}; `
      + 'the frequency runs bottom to top, on the axis at the left in Hz, on a linear scale; '
      + 'and the color is the level of each frequency, on the scale at the right in dBFS.',
    shows: `the spectrogram of the ${kind} clip @${id}, ${partText(part)}, time runs left to right and the frequency bottom to top`,
  }
}

/** The note and the picture text of the sound strip of `picture` under a
 *  frame sheet, of `part` of a sound of `sampleRate` (null: not known), of
 *  `size`. The strip has no axes, so the note tells them. */
export function soundStripTexts(picture: SoundPictureKind, part: ClipPart, size: ImageSize, sampleRate: number | null): { note: string, shows: string } {
  const strip = `Under the frames: the ${picture} of the sound of ${partText(part)}, a strip of ${size.width}x${size.height} pixels`
  const time = 'time runs left to right over the whole width of the sheet'
  const top = sampleRate === null ? 'half the sample rate' : `${countText(sampleRate / 2)} Hz`
  return {
    note: picture === 'wave'
      ? `${strip}; ${time}, and the height is the peak level on a square-root scale.`
      : `${strip} with no axes; ${time}, the frequency bottom to top from 0 to ${top} on a linear scale, `
        + 'and the color is the level: black is silent, then blue, purple, red, orange, yellow, and white, the loudest.',
    shows: `under the frames, the ${picture} of its sound, ${partText(part)}, time runs left to right`,
  }
}

/** The note of the sound strip of `picture` that Dez could not read from
 *  ffmpeg, or could not draw under the frame sheet. */
export function soundStripFailedNote(picture: SoundPictureKind): string {
  return `No ${picture} strip: Dez could not put it under the frame sheet, so the picture is the sheet alone. `
    + 'Help › Developer Console shows the cause. This is not a fault of the call.'
}

/** The note of the sound strip of `picture` with which the frame sheet is
 *  over `MAX_PICTURE_BYTES`, for a view with `detail`. */
export function soundStripTooLargeNote(picture: SoundPictureKind, detail: ViewDetail): string {
  return `No ${picture} strip: the frame sheet with it is too large to send, so the picture is the sheet alone. `
    + `To see the ${picture}, call again with fewer frames${detail === 'full' ? ', or with `detail` "review"' : ''}.`
}

/** The note of the loudness of `part`. */
export function loudnessNote(part: ClipPart, { integrated, range, truePeak }: Loudness): string {
  return `Loudness of ${partText(part)}: ${integrated} LUFS integrated, ${range} LU range, ${truePeak} dBFS true peak.`
}

/** The note of a run of ffmpeg that took longer than its time limit. */
export const VIEW_TIMED_OUT_NOTE = `ffmpeg took longer than ${ASSET_VIEW_TIMEOUT_MS / 1000} s, so Dez stopped it, and it shows no more of this clip. `
  + 'Call again with a shorter part (`start` and `end`).'

/** The note of a `times` run of ffmpeg that took longer than its time
 *  limit: it reads the clip from its start to the frame of the last time. */
export const TIMES_TIMED_OUT_NOTE = `ffmpeg took longer than ${ASSET_VIEW_TIMEOUT_MS / 1000} s, so Dez stopped it, and it shows no more of this clip. `
  + 'For `times`, ffmpeg reads the clip from its start to the last time. Call again with earlier `times`, '
  + 'or with `start` and `end` around the part and no `times`.'

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
 *  (`ToolRunContext.showPictures`): those of the assets, then the grid. */
export function assetViewPictures(items: readonly AssetViewItem[], grid: AssetViewGrid | null): ReplyPicture[] {
  return [...items.map(({ picture }) => picture), grid?.picture ?? null]
    .flatMap((picture) => (picture ? [{ label: `asset_view: ${picture.shows}.`, picture: picture.part, size: picture.size }] : []))
}

/** The result text of an `asset_view` call: for each asset, a line as in
 *  `@a | image | PNG | 1024x768 | 1.2 MB`, then the note of its picture and
 *  its other notes; then the note of the `grid` picture, or why it has
 *  none. The last lines tell where the pictures are and the picture budget
 *  that the reply has `left`, or that the model of the reply gets no
 *  pictures (`left` null). */
export function assetViewText(items: readonly AssetViewItem[], grid: AssetViewGrid | null, left: PictureBudget | null): string {
  const lines = [
    ...items.flatMap((item) => [`@${item.id} | ${item.kind} | ${item.facts}`, ...(item.picture?.note ? [item.picture.note] : []), ...item.notes]),
    ...(grid?.picture?.note ? [grid.picture.note] : []),
    ...(grid?.notes ?? []),
  ]
  if (left === null) {
    lines.push('This model gets no pictures, so Dez gives only the facts, and the loudness of a clip with sound.')
    return lines.join('\n')
  }
  if (grid?.picture || items.some((item) => item.picture)) {
    lines.push('You see each picture after the results of the calls of this round, after a line that names it. '
      + 'You see the pictures in this reply only. In a later reply, call asset_view again to see them again.')
  }
  lines.push(`Picture budget left in this reply: ${left.pictures} ${left.pictures === 1 ? 'picture' : 'pictures'}, ${tokensAndBytesText(left)}.`)
  return lines.join('\n')
}
