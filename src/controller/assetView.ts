import sbp from '@sbp/sbp'
import type { DrawnImage, ImageComposition, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { jpegSize } from '../model/chat/jpegSize'
import type { PicturePart, Section } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import type { ModelInfo } from '../model/providers/types'
import { conversationAssets } from '../model/streams/mediaRequest'
import { budgetAfter, NO_PICTURE_BUDGET, pictureCost } from '../model/streams/replyPictures'
import { gridLayout, gridTexts, type GridLayout, type GridPiece } from '../model/tools/assetGrid'
import { probedClipFacts, type ClipProbeFacts } from '../model/tools/assetFacts'
import { cutTimes } from '../model/tools/clipAnalysis'
import {
  ASSET_VIEW_TIMEOUT_MS,
  ASSET_VIEW_TOOL,
  ASSET_VIEW_WORDING,
  assetViewCall,
  assetViewPictures,
  assetViewText,
  audioViewArgs,
  clipNotReadNote,
  clipPart,
  cropOfClipText,
  cropRegion,
  cropTexts,
  cropUnderPixelText,
  FRAME_BOXES,
  frameSheetArgs,
  frameSheetTexts,
  gridCostNote,
  gridNotDrawnNote,
  gridTooLargeNote,
  IMAGE_PICTURE_SIDES,
  imagePictureDrawing,
  imagePictureShows,
  loudnessNote,
  loudnessOf,
  MAX_PICTURE_BYTES,
  missingTimesNote,
  NO_VIDEO_STREAM_NOTE,
  noFramesNote,
  noSoundNote,
  partHasNoFrame,
  PICTURE_LIMIT_NOTE,
  pictureCostNote,
  PICTURE_NOT_DRAWN_NOTE,
  PICTURE_NOT_READ_NOTE,
  PICTURE_TOO_LARGE_NOTE,
  sceneCutsArgs,
  scenesSheetTexts,
  sheetFrameTimes,
  sheetTooLargeNote,
  smallerCopyNote,
  smallerPictureDrawing,
  smallerPictureSide,
  SOUND_STRIP_HEIGHTS,
  soundlessPartNote,
  soundPictureOf,
  soundPictureTexts,
  soundStripFailedNote,
  soundStripLayout,
  soundStripTexts,
  soundStripTooLargeNote,
  TIMES_TIMED_OUT_NOTE,
  timesSheetArgs,
  timesSheetTexts,
  UNKNOWN_LENGTH_NOTE,
  VIEW_FAILED_NOTE,
  VIEW_TIMED_OUT_NOTE,
  type AssetViewCall,
  type AssetViewGrid,
  type AssetViewItem,
  type ClipPart,
  type PictureChoice,
  type SoundDraw,
  type SoundPicture,
  type SoundPictureKind,
  type ViewDetail,
  type ViewPicture,
} from '../model/tools/assetView'
import { clipInput, type ClipInput, type ProgramEnd } from '../model/tools/programRuns'
import { unknownAssetsText } from '../model/tools/toolInputs'
import { ToolError, type ToolArguments, type ToolRunResult } from '../model/tools/types'
import { probeClip, readImageFacts, type PicturePlan } from './assetInfo'
import { inWorkFolder, runFfmpegLog } from './programRuns'
import { saveShownPictures } from './shownPictures'
import type { ToolRunContext } from './tools'

// The work of the `asset_view` tool (model/tools/assetView.ts): it gives
// the facts and a picture of each image and clip that a call names, and
// shows the pictures to the model of the reply (`showPictures`). This
// module registers no selector: the `asset_view` runner (tools.ts) calls
// it.
//
// A picture is always bytes, read once here: each later request of the
// reply sends the same bytes (the prompt cache), and a file that the user
// deletes during the reply cannot fail those requests. The pictures of the
// clips are made in a work folder, which goes at the end of the call. The
// only files that a view keeps are the copies of the pictures that it
// showed, for the panel of its chip (shownPictures.ts). The log of ffmpeg
// goes to the console only, as it can hold a path: the model gets only the
// times and the loudness that Dez reads from it.

// The view of the image `id`, whose file is at `path`, for `call`: its
// facts as `asset_info` gives them (`readImageFacts`), and its picture,
// drawn when it cannot go as it is (`imagePictureDrawing`). An image that
// the webview cannot decode gives no picture: its file could make the
// provider refuse the request. Throws a `ToolError` for a crop of less
// than one pixel of the image.
async function viewImage(id: string, path: string, call: AssetViewCall, choice: PictureChoice): Promise<AssetViewItem> {
  // Not `ImageDrawing | null = null`: TypeScript would take the variable
  // for null after the callback, which sets it.
  let drawing = null as ImageDrawing | null
  const plan: PicturePlan = (size, bytes, mediaType) => (drawing = imagePictureDrawing(call, size, bytes, mediaType))
  const image = await readImageFacts(id, path, choice === 'show' ? plan : undefined)
  const item: AssetViewItem = { id, kind: 'image', facts: image.facts, notes: [], picture: null }
  if (image.kind === 'notDrawn') item.notes.push(PICTURE_NOT_DRAWN_NOTE)
  if (image.kind !== 'read') return item
  if (call.crop && !cropRegion(call.crop, image.size)) throw new ToolError(cropUnderPixelText(id, image.size))
  if (choice === 'overLimit') item.notes.push(PICTURE_LIMIT_NOTE)
  if (choice !== 'show') return item

  const { file, mediaType, size } = image
  let { drawn } = image
  // The size of the file of a drawing is known only after the draw: the
  // PNG drawing of a small file can be much larger than the file (an SVG
  // that holds a photo, an AVIF), and so can the JPEG copy of fine detail.
  // So a drawing that is too large is drawn again smaller until it fits.
  while (drawn && drawn.bytes.length > MAX_PICTURE_BYTES) {
    // A drawing came from the plan, so `drawing` is set.
    const next = smallerPictureDrawing(drawing as ImageDrawing)
    if (!next) {
      console.error(`The smallest picture of the image @${id} has ${drawn.bytes.length} bytes, more than Dez sends.`)
      item.notes.push(PICTURE_TOO_LARGE_NOTE)
      return item
    }
    try {
      // Never null: the plan gives a drawing.
      drawn = await sbp('dez.controller/images/redraw', file, () => next, 'image/jpeg') as DrawnImage
    } catch (error) {
      console.error(`Failed to draw the smaller picture of the image @${id}:`, error)
      item.notes.push(PICTURE_NOT_DRAWN_NOTE)
      return item
    }
    drawing = next
  }
  if (drawn) {
    const part: PicturePart = { type: 'picture', mediaType: drawn.mediaType, bytes: drawn.bytes }
    const picture: ImageSize = { width: drawn.width, height: drawn.height }
    const texts = call.crop
      ? cropTexts(id, (drawing as ImageDrawing).crop, picture, call.detail)
      // With no crop, only the copy of a too large image is a JPEG drawing.
      : { shows: imagePictureShows(id), note: drawn.mediaType === 'image/jpeg' ? smallerCopyNote(picture, size, call.detail) : null }
    item.picture = { part, size: picture, ...texts }
  } else if (mediaType) {
    item.picture = { part: { type: 'picture', mediaType, bytes: new Uint8Array(await file.arrayBuffer()) }, size, shows: imagePictureShows(id), note: null }
  }
  return item
}

/** A member of the grid picture of a view (`layout` "grid"): the file of
 *  its piece (an image, or the JPEG of a frame sheet), and the note of a
 *  frame sheet, which its asset gets only when the grid goes. */
interface GridMember {
  file: Blob
  piece: GridPiece
  note: string | null
}

// The view of the image `id`, whose file is at `path`, for a grid: its
// facts as `asset_info` gives them, and, when `choice` lets the view make
// a picture, its file as a member of the grid, which draws it whole. An
// image that the webview cannot decode is no member.
async function gridImage(id: string, path: string, choice: PictureChoice): Promise<{ item: AssetViewItem, member: GridMember | null }> {
  const image = await readImageFacts(id, path)
  const item: AssetViewItem = { id, kind: 'image', facts: image.facts, notes: [], picture: null }
  if (image.kind !== 'read') return { item, member: null }
  if (choice === 'overLimit') item.notes.push(PICTURE_LIMIT_NOTE)
  return { item, member: choice === 'show' ? { file: image.file, piece: { kind: 'image', id }, note: null } : null }
}

// The grid picture of `members`, for a view with `detail`, or the note of
// why it has none. As the picture of an image, a grid whose file is too
// large is drawn again smaller until it fits.
async function gridView(members: readonly GridMember[], detail: ViewDetail): Promise<AssetViewGrid> {
  const pieces = members.map(({ piece }) => piece)
  const ids = pieces.map(({ id }) => id)
  const files = members.map(({ file }) => file)
  const draw = async (side: number): Promise<{ drawn: DrawnImage, layout: GridLayout }> => {
    // Not `GridLayout | null = null`: TypeScript would take the variable
    // for null after the callback, which sets it.
    let layout = null as GridLayout | null
    const drawn = await sbp('dez.controller/images/compose', files, (sizes: readonly ImageSize[]) => (layout = gridLayout(pieces, sizes, detail, side))) as DrawnImage
    // A drawing came from the plan, so `layout` is set.
    return { drawn, layout: layout as GridLayout }
  }
  try {
    let { drawn, layout } = await draw(IMAGE_PICTURE_SIDES[detail])
    while (drawn.bytes.length > MAX_PICTURE_BYTES) {
      const side = smallerPictureSide(Math.max(drawn.width, drawn.height))
      if (side === undefined) {
        console.error(`The smallest grid picture of ${ids.map((id) => `@${id}`).join(' ')} has ${drawn.bytes.length} bytes, more than Dez sends.`)
        return { picture: null, notes: [gridTooLargeNote(ids)] }
      }
      ({ drawn, layout } = await draw(side))
    }
    const part: PicturePart = { type: 'picture', mediaType: drawn.mediaType, bytes: drawn.bytes }
    return { picture: { part, size: { width: drawn.width, height: drawn.height }, ...gridTexts(pieces, layout, detail) }, notes: [] }
  } catch (error) {
    console.error(`Failed to draw the grid picture of ${ids.map((id) => `@${id}`).join(' ')}:`, error)
    return { picture: null, notes: [gridNotDrawnNote(ids)] }
  }
}

// The time limit and the tool name of each run of ffmpeg for a view.
const VIEW_RUN = { toolName: ASSET_VIEW_TOOL.name, timeoutMs: ASSET_VIEW_TIMEOUT_MS }

/** A JPEG picture that a run of ffmpeg wrote, with its size (null: not
 *  known). */
interface RunPicture {
  part: PicturePart
  size: ImageSize | null
}

// The JPEG picture `name` that a run wrote into the work folder `folder`;
// null when it is not there.
async function readPicture(folder: string, name: string): Promise<RunPicture | null> {
  try {
    const bytes = await sbp('dez.native/loadAppFileBytes', `${folder}/${name}`, 'cache') as Uint8Array
    return { part: { type: 'picture', mediaType: 'image/jpeg', bytes }, size: jpegSize(bytes) }
  } catch (error) {
    console.error(`Failed to read the picture ${name} of an asset_view run:`, error)
    return null
  }
}

// The note of a run that did not end well, with its log to the console;
// null for a run that ended well. `timedOutNote` is the note of a run that
// took longer than its time limit.
function runProblemNote(clip: ClipAttachment, { end, log }: { end: ProgramEnd, log: string }, timedOutNote = VIEW_TIMED_OUT_NOTE): string | null {
  if (end.kind === 'exited' && end.code === 0) return null
  console.error(`ffmpeg could not make the view of the ${clip.kind} clip @${clip.id}:`, end, log)
  return end.kind === 'timedOut' ? timedOutNote : VIEW_FAILED_NOTE
}

/** One ffmpeg run that writes a frame sheet (`frameSheetArgs`,
 *  `timesSheetArgs`) into the work folder. */
interface SheetRunPlan {
  args: string[]
  /** The file of the sheet in the work folder. */
  name: string
  /** Where the run starts to read the clip, in seconds. */
  from: number
  /** The frames that the run asks for. */
  frames: number
  /** The notes of a sheet whose file is too large, and of a run that took
   *  too long. */
  tooLargeNote: string
  timedOutNote: string
}

type SheetRun =
  | { kind: 'sheet', times: number[], picture: RunPicture }
  | { kind: 'noFrame' }
  // `failed`: the run failed or took too long (`runProblemNote`).
  | { kind: 'note', note: string, failed: boolean }

// The run `plan` for the clip `clip`, on the copy that is already in the
// work folder `folder`: the sheet with the times of its frames, else that
// the run found no frame to take, else the note of what went wrong.
async function sheetRun(clip: ClipAttachment, plan: SheetRunPlan, folder: string, signal: AbortSignal): Promise<SheetRun> {
  const ran = await runFfmpegLog(plan.args, folder, VIEW_RUN, signal)
  const times = sheetFrameTimes(ran.log, plan.from, plan.frames)
  // A run with no frame to take makes ffmpeg fail, as it has nothing to
  // write. A damaged clip fails in the same way: its run is a failed view.
  if (times.length === 0 && ran.end.kind === 'exited' && partHasNoFrame(ran.log)) return { kind: 'noFrame' }
  const problem = runProblemNote(clip, ran, plan.timedOutNote)
  if (problem !== null) return { kind: 'note', note: problem, failed: true }
  const picture = await readPicture(folder, plan.name)
  if (!picture) return { kind: 'note', note: PICTURE_NOT_READ_NOTE, failed: false }
  // The file of a sheet of fine detail (noise, film grain) can be over the
  // limit, mostly at the `full` box.
  if (picture.part.bytes.length > MAX_PICTURE_BYTES) return { kind: 'note', note: plan.tooLargeNote, failed: false }
  return { kind: 'sheet', times, picture }
}

/** The frame sheet of a video clip and its notes. `failed`: a run failed
 *  or took too long, and its note tells that Dez shows no more of the
 *  clip, so the view runs nothing more on it. */
interface SheetView extends Pick<AssetViewItem, 'notes' | 'picture'> {
  failed?: boolean
}

// The frame sheet of `frames` frames at equal steps over `part` of the
// video clip `input`, for a view with `detail`.
async function stepsSheet(input: ClipInput, frames: number, part: ClipPart, detail: ViewDetail, folder: string, signal: AbortSignal): Promise<SheetView> {
  if (part.end === null) return { notes: [UNKNOWN_LENGTH_NOTE], picture: null }
  const name = `${input.id}-frames.jpg`
  const args = frameSheetArgs(input.name, name, { start: part.start, end: part.end }, frames, FRAME_BOXES[detail])
  const plan = { args, name, from: part.start, frames, tooLargeNote: sheetTooLargeNote(detail, 'frames'), timedOutNote: VIEW_TIMED_OUT_NOTE }
  const ran = await sheetRun(input.clip, plan, folder, signal)
  if (ran.kind === 'noFrame') return { notes: [noFramesNote(part)], picture: null }
  if (ran.kind === 'note') return { notes: [ran.note], picture: null, failed: ran.failed }
  const { note, shows } = frameSheetTexts(input.id, part, ran.times, frames)
  return { notes: [], picture: { ...ran.picture, shows, note } }
}

// The frame sheet of the first frame at or after each of `times` (in
// order) of the video clip `input`, of `seconds` (null: not known), for a
// view with `detail`. A time at or after the end of the clip has no frame,
// so it gets no place in the sheet. The run reads the clip from its start
// (`timesSheetArgs`).
async function timesSheet(input: ClipInput, times: readonly number[], seconds: number | null, detail: ViewDetail, folder: string, signal: AbortSignal): Promise<SheetView> {
  const inClip = seconds === null ? times : times.filter((time) => time < seconds)
  if (inClip.length === 0) return { notes: [missingTimesNote(times)], picture: null }
  const name = `${input.id}-frames.jpg`
  const args = timesSheetArgs(input.name, name, 0, inClip, FRAME_BOXES[detail])
  const plan = { args, name, from: 0, frames: inClip.length, tooLargeNote: sheetTooLargeNote(detail, 'times'), timedOutNote: TIMES_TIMED_OUT_NOTE }
  const ran = await sheetRun(input.clip, plan, folder, signal)
  if (ran.kind === 'noFrame') return { notes: [missingTimesNote(times)], picture: null }
  if (ran.kind === 'note') return { notes: [ran.note], picture: null, failed: ran.failed }
  // The times are in order, so the times that got no frame (the picture of
  // the clip ends before them) are the last ones.
  const missing = times.slice(ran.times.length)
  const { note, shows } = timesSheetTexts(input.id, times, ran.times, inClip.length)
  return { notes: missing.length > 0 ? [missingTimesNote(missing)] : [], picture: { ...ran.picture, shows, note } }
}

// The frame sheet of the shots of `part` of the video clip `input`, of at
// most `frames` frames, for a view with `detail`: a run that finds the
// cuts, then the sheet of the first frame of the part and of the first
// frame after each cut. The grid of a sheet is fixed before its run, so
// one run cannot do both. Both runs read the part with the same `-ss`, so
// the frames of the second are those of the cuts of the first.
async function scenesSheet(input: ClipInput, frames: number, part: ClipPart, detail: ViewDetail, folder: string, signal: AbortSignal): Promise<SheetView> {
  const cutsRan = await runFfmpegLog(sceneCutsArgs(input.name, part), folder, VIEW_RUN, signal)
  const problem = runProblemNote(input.clip, cutsRan)
  if (problem !== null) return { notes: [problem], picture: null, failed: true }
  const cuts = cutTimes(cutsRan.log).map((time) => part.start + time)
  const times = [part.start, ...cuts].slice(0, frames)
  const name = `${input.id}-frames.jpg`
  const args = timesSheetArgs(input.name, name, part.start, times, FRAME_BOXES[detail])
  const plan = { args, name, from: part.start, frames: times.length, tooLargeNote: sheetTooLargeNote(detail, 'frames'), timedOutNote: VIEW_TIMED_OUT_NOTE }
  const ran = await sheetRun(input.clip, plan, folder, signal)
  if (ran.kind === 'noFrame') return { notes: [noFramesNote(part)], picture: null }
  if (ran.kind === 'note') return { notes: [ran.note], picture: null, failed: ran.failed }
  const { note, shows } = scenesSheetTexts(input.id, part, ran.times, times.length, cuts)
  return { notes: [], picture: { ...ran.picture, shows, note } }
}

// The frame sheet of `part` of the video clip `input`, of `seconds` (null:
// not known), with the frames that `call` picks.
function frameSheet(input: ClipInput, call: AssetViewCall, seconds: number | null, part: ClipPart, folder: string, signal: AbortSignal): Promise<SheetView> {
  const { sheet, detail } = call
  if (sheet.kind === 'times') return timesSheet(input, sheet.times, seconds, detail, folder, signal)
  if (sheet.kind === 'scenes') return scenesSheet(input, sheet.frames, part, detail, folder, signal)
  return stepsSheet(input, sheet.frames, part, detail, folder, signal)
}

// The drawing of `picture` of the sound of the clip `input` (none for
// "none"): a strip of `strip` pixels under a frame sheet, or a picture of
// its own (`strip` null).
function soundDraw(input: ClipInput, picture: SoundPicture, strip: ImageSize | null): SoundDraw | null {
  return picture === 'none' ? null : { kind: picture, output: `${input.id}-${picture}${strip ? '-strip' : ''}.jpg`, strip }
}

// The loudness of the sound of `part` of the clip `input`, and with
// `draw`, the picture of its sound: their notes, and the picture as ffmpeg
// drew it, which the caller gives its texts.
async function soundView(input: ClipInput, part: ClipPart, draw: SoundDraw | null, folder: string, signal: AbortSignal): Promise<{ notes: string[], picture: RunPicture | null }> {
  const ran = await runFfmpegLog(audioViewArgs(input.name, part, draw), folder, VIEW_RUN, signal)
  // A part with no sample of the sound (a video clip whose sound ends
  // before the part) is no failure. Its run with a picture fails, as it has
  // no picture to write, and its run with no picture logs a loudness
  // summary of nothing, with a true peak of 0 dBFS: neither may reach the
  // model.
  if (ran.end.kind === 'exited' && partHasNoFrame(ran.log)) return { notes: [soundlessPartNote(part, draw?.kind ?? 'none')], picture: null }
  const problem = runProblemNote(input.clip, ran)
  const loudness = problem === null ? loudnessOf(ran.log) : null
  if (!loudness) {
    if (problem === null) console.error(`ffmpeg gave no loudness of the ${input.clip.kind} clip @${input.id}:`, ran.log)
    return { notes: [problem ?? VIEW_FAILED_NOTE], picture: null }
  }
  const notes = [loudnessNote(part, loudness)]
  if (draw === null) return { notes, picture: null }
  const picture = await readPicture(folder, draw.output)
  if (!picture) return { notes: [...notes, draw.strip ? soundStripFailedNote(draw.kind) : PICTURE_NOT_READ_NOTE], picture: null }
  return { notes, picture }
}

// The frame sheet `sheet` of the video clip `id` with the strip `strip` of
// `kind` of the sound of `part` (of `sampleRate`) under it, as one picture
// (`soundStripLayout`), for a view with `detail`. When the webview cannot
// draw it, or its file is too large, the picture is the sheet alone, with
// the note of why.
async function withSoundStrip(
  id: string,
  sheet: ViewPicture,
  strip: RunPicture,
  { kind, part, sampleRate, detail }: { kind: SoundPictureKind, part: ClipPart, sampleRate: number | null, detail: ViewDetail },
): Promise<{ picture: ViewPicture, notes: string[] }> {
  try {
    // Not `ImageComposition | null = null`: as in gridView.
    let layout = null as ImageComposition | null
    const files = [sheet.part, strip.part].map(({ bytes, mediaType }) => new Blob([bytes], { type: mediaType }))
    const drawn = await sbp('dez.controller/images/compose', files, (sizes: readonly ImageSize[]) => (layout = soundStripLayout(sizes))) as DrawnImage
    if (drawn.bytes.length > MAX_PICTURE_BYTES) return { picture: sheet, notes: [soundStripTooLargeNote(kind, detail)] }
    // A drawing came from the plan, so `layout` is set; its second place
    // is the strip.
    const { width, height } = (layout as ImageComposition).places[1]
    const texts = soundStripTexts(kind, part, { width, height }, sampleRate)
    return {
      picture: {
        part: { type: 'picture', mediaType: drawn.mediaType, bytes: drawn.bytes },
        size: { width: drawn.width, height: drawn.height },
        shows: `${sheet.shows}; ${texts.shows}`,
        note: sheet.note === null ? texts.note : `${sheet.note} ${texts.note}`,
      },
      notes: [],
    }
  } catch (error) {
    console.error(`Failed to draw the ${kind} strip of the video clip @${id} under its frame sheet:`, error)
    return { picture: sheet, notes: [soundStripFailedNote(kind)] }
  }
}

// The view of `part` of the video clip `input`, of the facts `facts`, for
// `call`: its frame sheet when `choice` lets the view make a picture, then
// the loudness of its sound, unless a run of the sheet failed, with the
// picture of its sound that `call` asks for (`soundPictureOf`): a strip
// under the sheet, or a picture of its own when the clip has no sheet. A
// clip with no picture still gets the loudness of its sound. One with no
// sound gets no loudness and no note about it, as its facts tell it, but
// for the picture of its sound that the call asks for.
async function videoView(input: ClipInput, facts: ClipProbeFacts, part: ClipPart, call: AssetViewCall, choice: PictureChoice, folder: string, signal: AbortSignal): Promise<Pick<AssetViewItem, 'notes' | 'picture'>> {
  const frames: SheetView = facts.video === null
    ? { notes: [NO_VIDEO_STREAM_NOTE], picture: null }
    : choice === 'show' ? await frameSheet(input, call, facts.seconds, part, folder, signal) : { notes: [], picture: null }
  const asked = soundPictureOf(call, 'video')
  const picture = choice === 'show' ? asked : 'none'
  const limitNotes = choice === 'overLimit' && (facts.video !== null || (facts.audio !== null && asked !== 'none')) ? [PICTURE_LIMIT_NOTE] : []
  if (facts.audio === null || frames.failed) {
    const noSound = facts.audio === null && asked !== 'none' ? [noSoundNote(asked, false)] : []
    return { notes: [...frames.notes, ...noSound, ...limitNotes], picture: frames.picture }
  }
  const sheet = frames.picture
  // The strip is as wide as the sheet. A sheet of an unknown size gets a
  // strip that the drawing stretches to its width.
  const draw = soundDraw(input, picture, sheet && { width: sheet.size?.width ?? FRAME_BOXES[call.detail], height: SOUND_STRIP_HEIGHTS[call.detail] })
  const sound = await soundView(input, part, draw, folder, signal)
  const notes = [...frames.notes, ...sound.notes]
  if (!draw || !sound.picture) return { notes: [...notes, ...limitNotes], picture: sheet }
  if (!sheet) {
    return { notes: [...notes, ...limitNotes], picture: { ...sound.picture, ...soundPictureTexts(input.id, 'video', draw.kind, part, sound.picture.size) } }
  }
  const joined = await withSoundStrip(input.id, sheet, sound.picture, { kind: draw.kind, part, sampleRate: facts.audio.sampleRate, detail: call.detail })
  return { notes: [...notes, ...joined.notes, ...limitNotes], picture: joined.picture }
}

// The view of `clip`: its facts from ffprobe, and its frame sheet, or the
// picture of its sound, and its loudness, from ffmpeg, all on one copy in
// the work folder `folder`. A clip that Dez cannot read fails only its own
// view.
async function viewClip(clip: ClipAttachment, call: AssetViewCall, choice: PictureChoice, folder: string, signal: AbortSignal): Promise<AssetViewItem> {
  const input = clipInput(clip)
  const probed = await probeClip(input, folder, signal, ASSET_VIEW_TOOL.name)
  const item: AssetViewItem = { id: clip.id, kind: clip.kind, facts: probedClipFacts(clip, probed), notes: [], picture: null }
  if (probed.kind === 'notRead') return { ...item, notes: [clipNotReadNote(clip.id, probed.problem)] }
  if (probed.kind === 'notProbed') return item

  const { facts } = probed
  const part = clipPart(call, facts.seconds)
  if (typeof part === 'string') return { ...item, notes: [part] }
  if (clip.kind === 'video') return { ...item, ...await videoView(input, facts, part, call, choice, folder, signal) }
  const asked = soundPictureOf(call, 'audio')
  if (facts.audio === null) return { ...item, notes: [noSoundNote(asked, true)] }
  const picture = choice === 'show' ? asked : 'none'
  const draw = soundDraw(input, picture, null)
  const sound = await soundView(input, part, draw, folder, signal)
  return {
    ...item,
    notes: [...sound.notes, ...(choice === 'overLimit' && asked !== 'none' ? [PICTURE_LIMIT_NOTE] : [])],
    picture: draw && sound.picture && { ...sound.picture, ...soundPictureTexts(clip.id, 'audio', draw.kind, part, sound.picture.size) },
  }
}

/** The result of an `asset_view` call with the arguments `args`, for the
 *  conversation `sections`, after it showed the pictures of the call to
 *  the model of the reply (`context.showPictures`): its text, and the
 *  saved copies of those pictures (`saveShownPictures`). Each picture that
 *  fits in what is left of the picture budget of the reply goes; an asset
 *  whose picture does not fit gets a note in its place. With `layout`
 *  "grid" and at least 2 images and video clips, those go into one grid
 *  picture, after the pictures of the other assets. Throws a `ToolError`
 *  for bad arguments, for an id that names no image and no clip of the
 *  conversation, and for a crop of a clip or of less than one pixel. A
 *  model that reads no images (`imageInput` false) gets the facts and the
 *  loudness only. A stop of `signal` stops a run of a program and rejects
 *  with the stop. */
export async function assetViewResult(
  args: ToolArguments,
  sections: readonly Section[],
  signal: AbortSignal,
  context: Pick<ToolRunContext, 'model' | 'pictureBudget' | 'showPictures'>,
): Promise<Omit<ToolRunResult, 'isError'>> {
  const call = assetViewCall(args)
  const assets = conversationAssets(sections)
  const unknown = call.ids.filter((id) => !assets.images.has(id) && !assets.clips.has(id))
  if (unknown.length > 0) throw new ToolError(unknownAssetsText(unknown, assets, ASSET_VIEW_WORDING))
  // A call with a crop names one asset.
  const croppedClip = call.crop && assets.clips.get(call.ids[0])
  if (croppedClip) throw new ToolError(cropOfClipText(croppedClip.id, croppedClip.kind))

  const model = sbp('dez.model/modelCache/model', context.model.providerId, context.model.modelId) as ModelInfo | null
  const imageInput = model?.imageInput !== false
  let left = imageInput ? context.pictureBudget() : NO_PICTURE_BUDGET
  // With nothing left of one part of the budget, no picture fits, so Dez
  // does not make one. Else only the made picture tells its cost.
  const pictureChoice = (): PictureChoice => (!imageInput ? 'noImageInput' : left.pictures > 0 && left.tokens > 0 && left.bytes > 0 ? 'show' : 'overLimit')
  // A grid is one picture, so its choice is made once, before the pictures
  // of the other assets take their part of the budget.
  const gridIds = imageInput && call.layout === 'grid' ? call.ids.filter((id) => assets.images.has(id) || assets.clips.get(id)?.kind === 'video') : []
  const inGrid = new Set(gridIds.length >= 2 ? gridIds : [])
  const gridChoice = pictureChoice()
  const members: GridMember[] = []
  const view = async (folder: string | null): Promise<AssetViewItem[]> => {
    const items: AssetViewItem[] = []
    for (const id of call.ids) {
      signal.throwIfAborted()
      const path = assets.images.get(id)
      if (path !== undefined && inGrid.has(id)) {
        const { item, member } = await gridImage(id, path, gridChoice)
        if (member) members.push(member)
        items.push(item)
        continue
      }
      const choice = inGrid.has(id) ? gridChoice : pictureChoice()
      // `folder` is a folder when the call names a clip.
      const item = path !== undefined
        ? await viewImage(id, path, call, choice)
        : await viewClip(assets.clips.get(id) as ClipAttachment, call, choice, folder as string, signal)
      if (item.picture && inGrid.has(id)) {
        // The picture of a video clip of the grid (its frame sheet, with
        // its sound strip) is a member of it.
        const { part, shows, note } = item.picture
        members.push({ file: new Blob([part.bytes], { type: part.mediaType }), piece: { kind: 'sheet', id, shows }, note })
        item.picture = null
      } else if (item.picture) {
        const cost = pictureCost(item.picture.part, item.picture.size)
        const after = budgetAfter(left, cost)
        if (after) {
          left = after
        } else {
          item.notes.push(pictureCostNote(cost, left))
          item.picture = null
        }
      }
      items.push(item)
    }
    return items
  }
  const items = call.ids.some((id) => assets.clips.has(id)) ? await inWorkFolder(view) : await view(null)
  const grid = members.length > 0 ? await gridView(members, call.detail) : null
  if (grid?.picture) {
    const cost = pictureCost(grid.picture.part, grid.picture.size)
    const after = budgetAfter(left, cost)
    if (after) {
      left = after
      // The note of a frame sheet goes first, as the note of a picture.
      for (const { piece, note } of members) {
        if (note) items.find((item) => item.id === piece.id)?.notes.unshift(note)
      }
    } else {
      grid.notes.push(gridCostNote(members.map(({ piece }) => piece.id), cost, left))
      grid.picture = null
    }
  }
  const pictures = assetViewPictures(items, grid)
  context.showPictures(pictures)
  // A stopped call gives no result, so its copies would have no block.
  signal.throwIfAborted()
  const content = assetViewText(items, grid, imageInput ? left : null)
  const copies = await saveShownPictures(pictures)
  return copies.length > 0 ? { content, pictures: copies } : { content }
}
