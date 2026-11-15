import sbp from '@sbp/sbp'
import type { ComposedImage, DrawnImage, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { jpegSize } from '../model/chat/jpegSize'
import type { PictureFile } from '../model/chat/shownPictures'
import type { Section } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import { modelFamily } from '../model/providers/modelFamilies'
import type { ModelInfo } from '../model/providers/types'
import { conversationAssets } from '../model/streams/mediaRequest'
import { budgetAfter, NO_PICTURE_BUDGET, pictureCost, totalCost, type PictureBudget } from '../model/streams/pictureBudget'
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
  gridNotSavedNote,
  gridTooLargeNote,
  IMAGE_PICTURE_SIDES,
  imagePictureDrawing,
  imagePictureShows,
  jpegCopyNote,
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
  PICTURE_NOT_SAVED_NOTE,
  PICTURE_TOO_LARGE_NOTE,
  sceneCutsArgs,
  scenesSheetTexts,
  sheetFrameTimes,
  sheetTooLargeNote,
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
// gives the saved copies of the pictures back with its result
// (`ToolRunResult.pictures`), which the requests of the reply send. This
// module registers no selector: the `asset_view` runner (tools.ts) calls
// it.
//
// A picture is bytes here, read or drawn once, and then a copy in
// `assets/generated/views/` (shownPictures.ts): each later request of the
// reply reads that copy, so it sends the same bytes (the prompt cache),
// and the image or the clip of the picture can change or go meanwhile.
// The pictures of the clips are made in a work folder, which goes at the
// end of the call. The copies are the only files that a view keeps. The
// log of ffmpeg goes to the console only, as it can hold a path: the model
// gets only the times and the loudness that Dez reads from it.

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
    const picture: ImageSize = { width: drawn.width, height: drawn.height }
    const texts = call.crop
      ? cropTexts(id, (drawing as ImageDrawing).crop, picture, call.detail)
      // With no crop, only the copy of a too large image is a JPEG drawing.
      : { shows: imagePictureShows(id), note: drawn.mediaType === 'image/jpeg' ? jpegCopyNote(picture, size, call.detail) : null }
    item.picture = { file: { mediaType: drawn.mediaType, bytes: drawn.bytes }, size: picture, ...texts }
  } else if (mediaType) {
    item.picture = { file: { mediaType, bytes: new Uint8Array(await file.arrayBuffer()) }, size, shows: imagePictureShows(id), note: null }
  }
  return item
}

/** A member of the grid picture of a view (`layout` "grid"): the file of
 *  its piece (an image, or the JPEG of the picture of a video clip), and
 *  for a video clip, that picture, whose note its asset gets only when the
 *  grid goes, and which goes as it is when the grid has no other member. */
interface GridMember {
  file: Blob
  piece: GridPiece
  clipPicture: ViewPicture | null
}

/** What a picture that does not fit in the picture budget of the reply
 *  costs, and what was left of the budget. */
interface OverBudget {
  cost: PictureBudget
  left: PictureBudget
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
  return { item, member: choice === 'show' ? { file: image.file, piece: { kind: 'image', id }, clipPicture: null } : null }
}

// The grid picture of `members`, for a view with `detail`, when `charge`
// takes its cost from the picture budget of the reply, else the note of
// why it has none. As the picture of an image, a grid whose file is too
// large is drawn again smaller until it fits.
async function gridView(members: readonly GridMember[], detail: ViewDetail, charge: (picture: ViewPicture) => OverBudget | null): Promise<AssetViewGrid> {
  const pieces = members.map(({ piece }) => piece)
  const ids = pieces.map(({ id }) => id)
  const mentions = ids.map((id) => `@${id}`).join(' ')
  const files = members.map(({ file }) => file)
  let picture: ViewPicture
  try {
    let side = IMAGE_PICTURE_SIDES[detail]
    for (;;) {
      const { drawn, composition } = await sbp('dez.controller/images/compose', files, (sizes: readonly ImageSize[]) => gridLayout(pieces, sizes, detail, side)) as ComposedImage<GridLayout>
      if (drawn.bytes.length <= MAX_PICTURE_BYTES) {
        const file: PictureFile = { mediaType: drawn.mediaType, bytes: drawn.bytes }
        picture = { file, size: { width: drawn.width, height: drawn.height }, ...gridTexts(pieces, composition, detail) }
        break
      }
      const smaller = smallerPictureSide(Math.max(drawn.width, drawn.height))
      if (smaller === undefined) {
        console.error(`The smallest grid picture of ${mentions} has ${drawn.bytes.length} bytes, more than Dez sends.`)
        return { picture: null, notes: [gridTooLargeNote(ids)] }
      }
      side = smaller
    }
  } catch (error) {
    console.error(`Failed to draw the grid picture of ${mentions}:`, error)
    return { picture: null, notes: [gridNotDrawnNote(ids)] }
  }
  const over = charge(picture)
  return over ? { picture: null, notes: [gridCostNote(ids, over.cost, over.left)] } : { picture, notes: [] }
}

// The time limit and the tool name of each run of ffmpeg for a view.
const VIEW_RUN = { toolName: ASSET_VIEW_TOOL.name, timeoutMs: ASSET_VIEW_TIMEOUT_MS }

/** A JPEG picture that a run of ffmpeg wrote, with its size (null: not
 *  known). */
interface RunPicture {
  file: PictureFile
  size: ImageSize | null
}

// The JPEG picture `name` that a run wrote into the work folder `folder`;
// null when it is not there.
async function readPicture(folder: string, name: string): Promise<RunPicture | null> {
  try {
    const bytes = await sbp('dez.native/loadAppFileBytes', `${folder}/${name}`, 'cache') as Uint8Array
    return { file: { mediaType: 'image/jpeg', bytes }, size: jpegSize(bytes) }
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

/** The frame sheet of a video clip and its notes. `failed`: a run failed
 *  or took too long, and its note tells that Dez shows no more of the
 *  clip, so the view runs nothing more on it. */
interface SheetView extends Pick<AssetViewItem, 'notes' | 'picture'> {
  failed?: boolean
}

/** One ffmpeg run that writes a frame sheet into the work folder, and the
 *  texts of the view that it gives. */
interface SheetRunPlan {
  /** The arguments of the run (`frameSheetArgs`, `timesSheetArgs`), which
   *  writes the sheet into the file `output` of the work folder. */
  args: (output: string) => string[]
  /** Where the run starts to read the clip, in seconds. */
  from: number
  /** The frames that the run asks for. */
  frames: number
  /** The notes of a run that found no frame to take, of a sheet whose file
   *  is too large, and of a run that took too long (when it is not
   *  `VIEW_TIMED_OUT_NOTE`). */
  noFrameNote: string
  tooLargeNote: string
  timedOutNote?: string
  /** The texts of the sheet of the frames at `times`, and the notes of
   *  its asset that go with the sheet. */
  texts: (times: readonly number[]) => Pick<ViewPicture, 'shows' | 'note'> & { notes?: string[] }
}

// The run `plan` for the video clip `input`, on the copy that is already
// in the work folder `folder`: the sheet with its texts, else the note of
// why it has none.
async function sheetRun(input: ClipInput, plan: SheetRunPlan, folder: string, signal: AbortSignal): Promise<SheetView> {
  const output = `${input.id}-frames.jpg`
  const ran = await runFfmpegLog(plan.args(output), folder, VIEW_RUN, signal)
  const times = sheetFrameTimes(ran.log, plan.from, plan.frames)
  // A run with no frame to take makes ffmpeg fail, as it has nothing to
  // write. A damaged clip fails in the same way: its run is a failed view.
  if (times.length === 0 && ran.end.kind === 'exited' && partHasNoFrame(ran.log)) return { notes: [plan.noFrameNote], picture: null }
  const problem = runProblemNote(input.clip, ran, plan.timedOutNote)
  if (problem !== null) return { notes: [problem], picture: null, failed: true }
  const picture = await readPicture(folder, output)
  if (!picture) return { notes: [PICTURE_NOT_READ_NOTE], picture: null }
  // The file of a sheet of fine detail (noise, film grain) can be over the
  // limit, mostly at the `full` box.
  if (picture.file.bytes.length > MAX_PICTURE_BYTES) return { notes: [plan.tooLargeNote], picture: null }
  const { shows, note, notes = [] } = plan.texts(times)
  return { notes, picture: { ...picture, shows, note } }
}

// The frame sheet of `frames` frames at equal steps over `part` of the
// video clip `input`, for a view with `detail`.
async function stepsSheet(input: ClipInput, frames: number, part: ClipPart, detail: ViewDetail, folder: string, signal: AbortSignal): Promise<SheetView> {
  const { start, end } = part
  if (end === null) return { notes: [UNKNOWN_LENGTH_NOTE], picture: null }
  return sheetRun(input, {
    args: (output) => frameSheetArgs(input.name, output, { start, end }, frames, FRAME_BOXES[detail]),
    from: start,
    frames,
    noFrameNote: noFramesNote(part),
    tooLargeNote: sheetTooLargeNote(detail, 'frames'),
    texts: (times) => frameSheetTexts(input.id, part, times, frames),
  }, folder, signal)
}

// The frame sheet of the first frame at or after each of `times` (in
// order) of the video clip `input`, of `seconds` (null: not known), for a
// view with `detail`. A time at or after the end of the clip has no frame,
// so it gets no place in the sheet. The run reads the clip from its start
// (`timesSheetArgs`).
async function timesSheet(input: ClipInput, times: readonly number[], seconds: number | null, detail: ViewDetail, folder: string, signal: AbortSignal): Promise<SheetView> {
  const inClip = seconds === null ? times : times.filter((time) => time < seconds)
  if (inClip.length === 0) return { notes: [missingTimesNote(times)], picture: null }
  return sheetRun(input, {
    args: (output) => timesSheetArgs(input.name, output, 0, inClip, FRAME_BOXES[detail]),
    from: 0,
    frames: inClip.length,
    noFrameNote: missingTimesNote(times),
    tooLargeNote: sheetTooLargeNote(detail, 'times'),
    timedOutNote: TIMES_TIMED_OUT_NOTE,
    texts: (frameTimes) => {
      // The times are in order, so the times that got no frame (the
      // picture of the clip ends before them) are the last ones.
      const missing = times.slice(frameTimes.length)
      return { ...timesSheetTexts(input.id, times, frameTimes, inClip.length), notes: missing.length > 0 ? [missingTimesNote(missing)] : [] }
    },
  }, folder, signal)
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
  return sheetRun(input, {
    args: (output) => timesSheetArgs(input.name, output, part.start, times, FRAME_BOXES[detail]),
    from: part.start,
    frames: times.length,
    noFrameNote: noFramesNote(part),
    tooLargeNote: sheetTooLargeNote(detail, 'frames'),
    texts: (frameTimes) => scenesSheetTexts(input.id, part, frameTimes, times.length, cuts),
  }, folder, signal)
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
// drew it, which the caller gives its texts. A strip that Dez could not
// read gives `stripNote` in place of a note, for the note of its frame
// sheet: it tells of that sheet, so it must go only while the sheet goes.
async function soundView(input: ClipInput, part: ClipPart, draw: SoundDraw | null, folder: string, signal: AbortSignal): Promise<{ notes: string[], picture: RunPicture | null, stripNote?: string }> {
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
  if (!picture) return draw.strip ? { notes, picture: null, stripNote: soundStripFailedNote(draw.kind) } : { notes: [...notes, PICTURE_NOT_READ_NOTE], picture: null }
  return { notes, picture }
}

// `picture` with `note` after the note that it has.
function withNote(picture: ViewPicture, note: string): ViewPicture {
  return { ...picture, note: picture.note === null ? note : `${picture.note} ${note}` }
}

// The frame sheet `sheet` of the video clip `id` with the strip `strip` of
// `kind` of the sound of `part` (of `sampleRate`) under it, as one picture
// (`soundStripLayout`), for a view with `detail`. When the webview cannot
// draw it, or its file is too large, the picture is the sheet alone, with
// the note of why in its own note.
async function withSoundStrip(
  id: string,
  sheet: ViewPicture,
  strip: RunPicture,
  { kind, part, sampleRate, detail }: { kind: SoundPictureKind, part: ClipPart, sampleRate: number | null, detail: ViewDetail },
): Promise<ViewPicture> {
  try {
    const files = [sheet.file, strip.file].map(({ bytes, mediaType }) => new Blob([bytes], { type: mediaType }))
    const { drawn, composition } = await sbp('dez.controller/images/compose', files, soundStripLayout) as ComposedImage
    if (drawn.bytes.length > MAX_PICTURE_BYTES) return withNote(sheet, soundStripTooLargeNote(kind, detail))
    // The second place of the composition is the strip.
    const { width, height } = composition.places[1]
    const texts = soundStripTexts(kind, part, { width, height }, sampleRate)
    return {
      ...withNote(sheet, texts.note),
      file: { mediaType: drawn.mediaType, bytes: drawn.bytes },
      size: { width: drawn.width, height: drawn.height },
      shows: `${sheet.shows}; ${texts.shows}`,
    }
  } catch (error) {
    console.error(`Failed to draw the ${kind} strip of the video clip @${id} under its frame sheet:`, error)
    return withNote(sheet, soundStripFailedNote(kind))
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
  const sheetView: SheetView = facts.video === null
    ? { notes: [NO_VIDEO_STREAM_NOTE], picture: null }
    : choice === 'show' ? await frameSheet(input, call, facts.seconds, part, folder, signal) : { notes: [], picture: null }
  const asked = soundPictureOf(call, 'video')
  const soundKind = choice === 'show' ? asked : 'none'
  const limitNotes = choice === 'overLimit' && (facts.video !== null || (facts.audio !== null && asked !== 'none')) ? [PICTURE_LIMIT_NOTE] : []
  if (facts.audio === null || sheetView.failed) {
    const noSound = facts.audio === null && asked !== 'none' ? [noSoundNote(asked, false)] : []
    return { notes: [...sheetView.notes, ...noSound, ...limitNotes], picture: sheetView.picture }
  }
  const sheet = sheetView.picture
  // The strip is as wide as the sheet. A sheet of an unknown size gets a
  // strip that the drawing stretches to its width.
  const draw = soundDraw(input, soundKind, sheet && { width: sheet.size?.width ?? FRAME_BOXES[call.detail], height: SOUND_STRIP_HEIGHTS[call.detail] })
  const sound = await soundView(input, part, draw, folder, signal)
  const notes = [...sheetView.notes, ...sound.notes, ...limitNotes]
  if (!draw || !sound.picture) return { notes, picture: sheet && sound.stripNote ? withNote(sheet, sound.stripNote) : sheet }
  if (!sheet) {
    return { notes, picture: { ...sound.picture, ...soundPictureTexts(input.id, 'video', draw.kind, part, sound.picture.size) } }
  }
  return { notes, picture: await withSoundStrip(input.id, sheet, sound.picture, { kind: draw.kind, part, sampleRate: facts.audio.sampleRate, detail: call.detail }) }
}

/** The view of `clip`: its facts from ffprobe, and its frame sheet, or the
 *  picture of its sound, and its loudness, from ffmpeg, all on one copy in
 *  the work folder `folder`. A clip that Dez cannot read fails only its own
 *  view. A compaction makes the pictures of its clips with it too
 *  (compaction.ts). */
export async function viewClip(clip: ClipAttachment, call: AssetViewCall, choice: PictureChoice, folder: string, signal: AbortSignal): Promise<AssetViewItem> {
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
  const soundKind = choice === 'show' ? asked : 'none'
  const draw = soundDraw(input, soundKind, null)
  const sound = await soundView(input, part, draw, folder, signal)
  return {
    ...item,
    notes: [...sound.notes, ...(choice === 'overLimit' && asked !== 'none' ? [PICTURE_LIMIT_NOTE] : [])],
    picture: draw && sound.picture && { ...sound.picture, ...soundPictureTexts(clip.id, 'audio', draw.kind, part, sound.picture.size) },
  }
}

/** The result of an `asset_view` call with the arguments `args`, for the
 *  conversation `sections`: its text, and the saved copies of its
 *  pictures (`saveShownPictures`), which the requests of the reply send to
 *  the model. Each picture that fits in what is left of the picture budget
 *  (`context.pictureBudget`) goes; an asset whose picture does not fit, or
 *  whose copy Dez could not save, gets a note in its place. With `layout`
 *  "grid", the images and video clips go into one grid picture, after the
 *  pictures of the other assets, when at least 2 of them give a part of
 *  it; else each one gets its own picture. Throws a `ToolError`
 *  for bad arguments, for an id that names no image and no clip of the
 *  conversation, and for a crop of a clip or of less than one pixel. A
 *  model that reads no images (`imageInput` false) gets the facts and the
 *  loudness only. A stop of `signal` stops a run of a program and rejects
 *  with the stop. */
export async function assetViewResult(
  args: ToolArguments,
  sections: readonly Section[],
  signal: AbortSignal,
  context: Pick<ToolRunContext, 'model' | 'pictureBudget'>,
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
  let left = imageInput ? await context.pictureBudget() : NO_PICTURE_BUDGET
  // A picture costs what the family of the model counts it as, as in the
  // budget of the context (`shownPictureCost`).
  const tokenRule = modelFamily(context.model.modelId).imageTokens
  // With nothing left of one part of the budget, no picture fits, so Dez
  // does not make one. Else only the made picture tells its cost.
  const pictureChoice = (): PictureChoice => (!imageInput ? 'noImageInput' : left.pictures > 0 && left.tokens > 0 && left.bytes > 0 ? 'show' : 'overLimit')
  // Takes the cost of `picture` from what is left of the budget when it
  // fits; else takes nothing, and gives its cost and what was left.
  const charge = (picture: ViewPicture): OverBudget | null => {
    const cost = pictureCost(tokenRule, picture.file, picture.size)
    const after = budgetAfter(left, cost)
    if (!after) return { cost, left }
    left = after
    return null
  }
  // Keeps the picture of its own of `item` when it fits in what is left of
  // the budget (`charge`); else the item gets the note of its cost in place
  // of the picture.
  const keepIfFits = (item: AssetViewItem): void => {
    const over = item.picture && charge(item.picture)
    if (!over) return
    item.notes.push(pictureCostNote(over.cost, over.left))
    item.picture = null
  }
  // The assets of a grid share one choice, made before the pictures of the
  // other assets take their part of the budget. Those pictures can spend
  // the budget, so the draw of the grid checks it again.
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
        // its sound strip, or the picture of its sound alone) is a member
        // of it.
        const { file, shows } = item.picture
        members.push({ file: new Blob([file.bytes], { type: file.mediaType }), piece: { kind: 'clip', id, shows }, clipPicture: item.picture })
        item.picture = null
      } else {
        keepIfFits(item)
      }
      items.push(item)
    }
    return items
  }
  const items = call.ids.some((id) => assets.clips.has(id)) ? await inWorkFolder(view) : await view(null)
  // A stop during the last asset does not wait for the draw of the grid.
  signal.throwIfAborted()
  const membersGo = members.length > 0 && pictureChoice() === 'show'
  // A grid that cannot go gives each of its assets the note that it gets
  // when the call starts with a spent budget (`gridChoice`).
  if (!membersGo) for (const { piece } of members) items.find((item) => item.id === piece.id)?.notes.push(PICTURE_LIMIT_NOTE)
  // An asset of the grid can give no member: an image that the webview
  // cannot decode, or a clip whose sheet failed or has no frame. A grid of
  // the one member that is left would draw it in a frame box, much smaller
  // than its picture with `separate`, so it gets that picture in place of
  // the grid.
  if (membersGo && members.length === 1) {
    const [{ piece, clipPicture }] = members
    const index = items.findIndex(({ id }) => id === piece.id)
    if (clipPicture) {
      items[index].picture = clipPicture
    } else {
      // `gridImage` read the image but made no picture of it.
      items[index] = await viewImage(piece.id, assets.images.get(piece.id) as string, call, 'show')
    }
    keepIfFits(items[index])
  }
  const grid = membersGo && members.length > 1 ? await gridView(members, call.detail, charge) : null
  // A stopped call gives no result, so its copies would have no block.
  signal.throwIfAborted()
  // The owners of the pictures, in the order of `assetViewPictures`.
  const owners = [...items, ...(grid ? [grid] : [])].filter((owner) => owner.picture)
  const copies = await saveShownPictures(assetViewPictures(items, grid))
  for (const [index, copy] of copies.entries()) {
    if (copy) continue
    // A request sends a picture from its copy, so a picture with no copy
    // does not go: its owner tells so, and its cost goes back.
    const owner = owners[index]
    const { file, size } = owner.picture as ViewPicture
    left = totalCost([left, pictureCost(tokenRule, file, size)])
    owner.picture = null
    owner.notes.push(owner === grid ? gridNotSavedNote(members.map(({ piece }) => piece.id)) : PICTURE_NOT_SAVED_NOTE)
  }
  if (grid?.picture) {
    // The note of the picture of a clip goes before its other notes, as
    // for a picture of its own.
    for (const { piece, clipPicture } of members) {
      if (clipPicture?.note) items.find((item) => item.id === piece.id)?.notes.unshift(clipPicture.note)
    }
  }
  const content = assetViewText(items, grid, imageInput ? left : null)
  const saved = copies.flatMap((copy) => (copy ? [copy] : []))
  return saved.length > 0 ? { content, pictures: saved } : { content }
}
