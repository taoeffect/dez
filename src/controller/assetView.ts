import sbp from '@sbp/sbp'
import { wholeImageDrawing, type ImageDrawing, type ImageSize } from '../model/chat/imageDrawing'
import type { ImageMediaType } from '../model/chat/images'
import type { PicturePart, Section } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import type { ModelInfo } from '../model/providers/types'
import { conversationAssets } from '../model/streams/mediaRequest'
import { probedClipFacts } from '../model/tools/assetInfo'
import {
  ASSET_VIEW_TIMEOUT_MS,
  ASSET_VIEW_TOOL,
  ASSET_VIEW_WORDING,
  assetViewCall,
  assetViewPictures,
  assetViewText,
  audioViewArgs,
  clipPart,
  frameSheetArgs,
  frameSheetTexts,
  imagePictureShows,
  loudnessNote,
  loudnessOf,
  NO_AUDIO_STREAM_NOTE,
  NO_VIDEO_STREAM_NOTE,
  noFramesNote,
  PICTURE_LIMIT_NOTE,
  PICTURE_NOT_DRAWN_NOTE,
  sheetFrameTimes,
  smallerCopyNote,
  UNKNOWN_LENGTH_NOTE,
  VIEW_FAILED_NOTE,
  VIEW_TIMED_OUT_NOTE,
  waveTexts,
  type AssetViewCall,
  type AssetViewItem,
  type ClipPart,
  type PictureChoice,
} from '../model/tools/assetView'
import { clipInput, type ClipInput, type ProgramEnd } from '../model/tools/programRuns'
import { clipReadProblemText, unknownAssetsText } from '../model/tools/toolInputs'
import { ToolError, type ToolArguments } from '../model/tools/types'
import { FFMPEG_OUTPUT_BYTES } from '../model/tools/videoTool'
import { probeClip, readImageFacts } from './assetInfo'
import { inWorkFolder, runProgram } from './programRuns'
import type { ToolRunContext } from './tools'

// The work of the `asset_view` tool (model/tools/assetView.ts): it gives
// the facts and a picture of each image and clip that a call names, and
// shows the pictures to the model of the reply (`showPictures`). This
// module registers no selector: the `asset_view` runner (tools.ts) calls
// it.
//
// A picture is always bytes, read once here: each later request of the
// reply sends the same bytes (the prompt cache), and a file that the user
// deletes during the reply cannot fail those requests. A view keeps no
// file: the pictures of the clips are made in a work folder, which goes at
// the end of the call. The log of ffmpeg goes to the console only, as it
// can hold a path: the model gets only the times and the loudness that Dez
// reads from it.

// An image whose file is larger than this, or whose longer side is longer
// than `MAX_PICTURE_SIDE`, goes as a smaller JPEG copy: in base64, a file
// of this size stays under the 5 MB image limit of the Anthropic API, and
// a provider can refuse a large image. A refusal would fail each later
// request of the reply, as each one sends the picture again.
const MAX_PICTURE_BYTES = 3_750_000
const MAX_PICTURE_SIDE = 4096
const SMALLER_PICTURE_SIDE = 2048

// The drawing of the picture of an image of the type `mediaType` (null:
// a type that Dez does not send as it is) whose file has `bytes` bytes,
// for redraw; null for an image that goes as it is. No provider is known
// to take SVG images, so an SVG goes as a PNG drawing.
function pictureDrawing(size: ImageSize, bytes: number, mediaType: ImageMediaType | null): ImageDrawing | null {
  const longSide = Math.max(size.width, size.height)
  if (bytes > MAX_PICTURE_BYTES || longSide > MAX_PICTURE_SIDE) {
    const scale = Math.min(1, SMALLER_PICTURE_SIDE / longSide)
    return {
      crop: { x: 0, y: 0, width: size.width, height: size.height },
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      // A JPEG has no transparent pixels.
      background: '#ffffff',
      mediaType: 'image/jpeg',
    }
  }
  if (mediaType === null || mediaType === 'image/svg+xml') return { ...wholeImageDrawing(size), mediaType: 'image/png' }
  return null
}

// The view of the image `id`, whose file is at `path`: its facts as
// `asset_info` gives them (`readImageFacts`), and its picture, drawn when
// it cannot go as it is. An image that the webview cannot decode gives no
// picture: its file could make the provider refuse the request.
async function viewImage(id: string, path: string, choice: PictureChoice): Promise<AssetViewItem> {
  const image = await readImageFacts(id, path, choice === 'show' ? pictureDrawing : undefined)
  const item: AssetViewItem = { id, kind: 'image', facts: image.facts, notes: [], picture: null }
  if (image.kind === 'notDrawn') item.notes.push(PICTURE_NOT_DRAWN_NOTE)
  if (image.kind !== 'read') return item
  if (choice === 'overLimit') item.notes.push(PICTURE_LIMIT_NOTE)
  if (choice !== 'show') return item

  const { file, mediaType, drawn } = image
  let part: PicturePart | null
  if (drawn) {
    part = { type: 'picture', mediaType: drawn.mediaType, bytes: drawn.bytes }
    // Only the copy of a too large image is a JPEG drawing.
    if (drawn.mediaType === 'image/jpeg') item.notes.push(smallerCopyNote(drawn.width, drawn.height))
  } else {
    part = mediaType && { type: 'picture', mediaType, bytes: new Uint8Array(await file.arrayBuffer()) }
  }
  item.picture = part && { part, shows: imagePictureShows(id) }
  return item
}

// A run of ffmpeg for a view, on the clip copy that is already in the work
// folder `folder`, with its log.
async function runFfmpeg(args: string[], folder: string, signal: AbortSignal): Promise<{ end: ProgramEnd, log: string }> {
  let log = ''
  const run = { args, folder, inputs: [], timeoutMs: ASSET_VIEW_TIMEOUT_MS, maxOutputBytes: FFMPEG_OUTPUT_BYTES }
  const end = await runProgram('ffmpeg', ASSET_VIEW_TOOL.name, run, signal, ({ text }) => {
    log += text
  })
  return { end, log }
}

// The JPEG picture `name` that a run wrote into the work folder `folder`;
// null when it is not there.
async function readPicture(folder: string, name: string): Promise<PicturePart | null> {
  try {
    const bytes = await sbp('dez.native/loadAppFileBytes', `${folder}/${name}`, 'cache') as Uint8Array
    return { type: 'picture', mediaType: 'image/jpeg', bytes }
  } catch (error) {
    console.error(`Failed to read the picture ${name} of an asset_view run:`, error)
    return null
  }
}

// The note of a run that did not end well, with its log to the console;
// null for a run that ended well.
function runProblemNote(clip: ClipAttachment, { end, log }: { end: ProgramEnd, log: string }): string | null {
  if (end.kind === 'exited' && end.code === 0) return null
  console.error(`ffmpeg could not make the view of the ${clip.kind} clip @${clip.id}:`, end, log)
  return end.kind === 'timedOut' ? VIEW_TIMED_OUT_NOTE : VIEW_FAILED_NOTE
}

// The frame sheet of the video clip `input` over `part`: its notes and
// its picture.
async function frameSheet(input: ClipInput, call: AssetViewCall, part: ClipPart, folder: string, signal: AbortSignal): Promise<Pick<AssetViewItem, 'notes' | 'picture'>> {
  if (part.end === null) return { notes: [UNKNOWN_LENGTH_NOTE], picture: null }
  const name = `${input.id}-frames.jpg`
  const ran = await runFfmpeg(frameSheetArgs(input.name, name, { start: part.start, end: part.end }, call.frames), folder, signal)
  const times = sheetFrameTimes(ran.log, part.start, call.frames)
  // A part with no frame makes ffmpeg fail, as it has nothing to write.
  if (times.length === 0 && ran.end.kind === 'exited') return { notes: [noFramesNote(part)], picture: null }
  const problem = runProblemNote(input.clip, ran)
  if (problem !== null) return { notes: [problem], picture: null }
  const picture = await readPicture(folder, name)
  if (!picture) return { notes: [VIEW_FAILED_NOTE], picture: null }
  const { note, shows } = frameSheetTexts(input.id, part, times, call.frames)
  return { notes: [note], picture: { part: picture, shows } }
}

// The loudness of the audio clip `input` over `part`, and with `wave`, the
// picture of its wave: their notes and the picture.
async function audioView(input: ClipInput, part: ClipPart, wave: boolean, folder: string, signal: AbortSignal): Promise<Pick<AssetViewItem, 'notes' | 'picture'>> {
  const name = wave ? `${input.id}-wave.jpg` : null
  const ran = await runFfmpeg(audioViewArgs(input.name, part, name), folder, signal)
  const problem = runProblemNote(input.clip, ran)
  const loudness = problem === null ? loudnessOf(ran.log) : null
  if (!loudness) {
    if (problem === null) console.error(`ffmpeg gave no loudness of the audio clip @${input.id}:`, ran.log)
    return { notes: [problem ?? VIEW_FAILED_NOTE], picture: null }
  }
  const notes = [loudnessNote(part, loudness)]
  if (name === null) return { notes, picture: null }
  const picture = await readPicture(folder, name)
  if (!picture) return { notes: [...notes, VIEW_FAILED_NOTE], picture: null }
  const { note, shows } = waveTexts(input.id, part)
  return { notes: [note, ...notes], picture: { part: picture, shows } }
}

// The view of `clip`: its facts from ffprobe, and its frame sheet, or its
// wave and loudness, from ffmpeg, all on one copy in the work folder
// `folder`. A clip that Dez cannot read fails only its own view.
async function viewClip(clip: ClipAttachment, call: AssetViewCall, choice: PictureChoice, folder: string, signal: AbortSignal): Promise<AssetViewItem> {
  const input = clipInput(clip)
  const probed = await probeClip(input, folder, signal, ASSET_VIEW_TOOL.name)
  const item: AssetViewItem = { id: clip.id, kind: clip.kind, facts: probedClipFacts(clip, probed), notes: [], picture: null }
  if (probed.kind === 'notRead') return { ...item, notes: [clipReadProblemText(clip.kind, clip.id, ASSET_VIEW_TOOL.name, probed.problem)] }
  if (probed.kind === 'notProbed') return item

  const { facts } = probed
  const part = clipPart(call, facts.seconds)
  if (typeof part === 'string') return { ...item, notes: [part] }
  const limitNotes = choice === 'overLimit' ? [PICTURE_LIMIT_NOTE] : []
  if (clip.kind === 'video') {
    if (facts.video === null) return { ...item, notes: [NO_VIDEO_STREAM_NOTE] }
    // A video clip gives only its frame sheet: with no picture, a view
    // tells no more than `asset_info`.
    if (choice !== 'show') return { ...item, notes: limitNotes }
    return { ...item, ...await frameSheet(input, call, part, folder, signal) }
  }
  if (facts.audio === null) return { ...item, notes: [NO_AUDIO_STREAM_NOTE] }
  const view = await audioView(input, part, choice === 'show', folder, signal)
  return { ...item, ...view, notes: [...view.notes, ...limitNotes] }
}

/** The result text of an `asset_view` call with the arguments `args`, for
 *  the conversation `sections`, after it showed the pictures of the call
 *  to the model of the reply (`context.showPictures`). Throws a
 *  `ToolError` for bad arguments, and for an id that names no image and no
 *  clip of the conversation. A model that reads no images (`imageInput`
 *  false) gets the facts and the loudness only. A stop of `signal` stops a
 *  run of a program and rejects with the stop. */
export async function assetViewResult(
  args: ToolArguments,
  sections: readonly Section[],
  signal: AbortSignal,
  context: Pick<ToolRunContext, 'model' | 'picturesLeft' | 'showPictures'>,
): Promise<string> {
  const call = assetViewCall(args)
  const assets = conversationAssets(sections)
  const unknown = call.ids.filter((id) => !assets.images.has(id) && !assets.clips.has(id))
  if (unknown.length > 0) throw new ToolError(unknownAssetsText(unknown, assets, ASSET_VIEW_WORDING))

  const model = sbp('dez.model/modelCache/model', context.model.providerId, context.model.modelId) as ModelInfo | null
  const imageInput = model?.imageInput !== false
  let picturesLeft = imageInput ? context.picturesLeft() : 0
  const view = async (folder: string | null): Promise<AssetViewItem[]> => {
    const items: AssetViewItem[] = []
    for (const id of call.ids) {
      signal.throwIfAborted()
      const choice: PictureChoice = !imageInput ? 'noImageInput' : picturesLeft > 0 ? 'show' : 'overLimit'
      const path = assets.images.get(id)
      // `folder` is a folder when the call names a clip.
      const item = path !== undefined
        ? await viewImage(id, path, choice)
        : await viewClip(assets.clips.get(id) as ClipAttachment, call, choice, folder as string, signal)
      if (item.picture) picturesLeft -= 1
      items.push(item)
    }
    return items
  }
  const items = call.ids.some((id) => assets.clips.has(id)) ? await inWorkFolder(view) : await view(null)
  context.showPictures(assetViewPictures(items))
  return assetViewText(items, imageInput)
}
