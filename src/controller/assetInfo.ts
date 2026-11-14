import sbp from '@sbp/sbp'
import { assetPlaces } from '../model/chat/assetOrigins'
import type { DrawnImage, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { imageExtension, imageMediaType, isImageMediaType, type ImageMediaType } from '../model/chat/images'
import { ClipReadError } from '../model/chat/mediaFiles'
import type { Section } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import { conversationAssets } from '../model/streams/mediaRequest'
import { assetProbeArgs, clipProbeFacts, imageFactsText } from '../model/tools/assetFacts'
import {
  ASSET_INFO_TOOL,
  ASSET_INFO_WORDING,
  assetIdsArgument,
  assetInfoLine,
  assetInfoText,
  IMAGE_NOT_DECODED_FACTS,
  IMAGE_NOT_READ_FACTS,
  MAX_ASSET_INFO_IDS,
  probedClipFacts,
  type ProbedClip,
} from '../model/tools/assetInfo'
import { clipInput, type ClipInput } from '../model/tools/programRuns'
import { unknownAssetsText } from '../model/tools/toolInputs'
import { ToolError, type ToolArguments } from '../model/tools/types'
import { FFPROBE_OUTPUT_BYTES, FFPROBE_TIMEOUT_MS } from '../model/tools/videoTool'
import { copyInputClip, inWorkFolder, runProgram } from './programRuns'

// The work of the `asset_info` tool (model/tools/assetInfo.ts): it reads
// the facts of each image and clip that a call names. This module
// registers no selector: the `asset_info` runner (tools.ts) calls it.
//
// A file that Dez cannot read fails only its own line, so that the model
// gets the facts of the others. The cause goes to the log only: a native
// error and the output of ffprobe can hold a path.

/** What `readImageFacts` read of an image. `facts` is its facts text
 *  (`imageFactsText`), or the text of what Dez could not read. */
export type ImageFactsRead =
  /** Dez could not read its file, or the webview could not decode it. */
  | { kind: 'notRead', facts: string }
  /** The webview decoded it, but could not draw the picture of the plan. */
  | { kind: 'notDrawn', facts: string }
  /** The type of its bytes, and the drawing of the plan (null: none). */
  | { kind: 'read', facts: string, file: File, mediaType: ImageMediaType | null, drawn: DrawnImage | null }

/** The drawing, with its type, of the picture of an image of `size`,
 *  whose file has `bytes` bytes of the type `mediaType`; null for none. */
export type PicturePlan = (size: ImageSize, bytes: number, mediaType: ImageMediaType | null) => ImageDrawing | null

/** The facts of the image `id`, whose file is at `path`, for `asset_info`
 *  and `asset_view`, which must give the same facts: one read of the file,
 *  and a decode in the webview for its size in pixels, as for the `image`
 *  tool. The format is the type of the bytes, as the asset protocol tells
 *  it, so a linked file whose extension does not match its bytes gets the
 *  right format. `plan` (asset_view) gives the drawing of a picture; a
 *  drawing that fails after the decode keeps the size in the facts. */
export async function readImageFacts(id: string, path: string, plan: PicturePlan = () => null): Promise<ImageFactsRead> {
  let file: File
  try {
    file = await sbp('dez.controller/images/readFile', path) as File
  } catch (error) {
    console.error(`Failed to read the image @${id}:`, error)
    return { kind: 'notRead', facts: IMAGE_NOT_READ_FACTS }
  }
  const mediaType = isImageMediaType(file.type) ? file.type : imageMediaType(path)
  const extension = mediaType && imageExtension(mediaType)
  // Not `ImageSize | null = null`: TypeScript would take the variable for
  // null after the callback, which sets it.
  let size = null as ImageSize | null
  let drawn: DrawnImage | null
  try {
    // Every plan names the type of its drawing, so 'image/png' is only
    // the type that redraw needs.
    drawn = await sbp('dez.controller/images/redraw', file, (decoded: ImageSize) => {
      size = decoded
      return plan(decoded, file.size, mediaType)
    }, 'image/png') as DrawnImage | null
  } catch (error) {
    // Redraw gives the size to the plan after the decode, so with a size,
    // only the drawing failed.
    if (size === null) {
      console.error(`Failed to decode the image @${id}:`, error)
      return { kind: 'notRead', facts: `${imageFactsText(extension, null, file.size)} | ${IMAGE_NOT_DECODED_FACTS}` }
    }
    console.error(`Failed to draw the picture of the image @${id}:`, error)
    return { kind: 'notDrawn', facts: imageFactsText(extension, size, file.size) }
  }
  return { kind: 'read', facts: imageFactsText(extension, size, file.size), file, mediaType, drawn }
}

/** The probe of the clip of `input` for a call of the tool `toolName`: one
 *  ffprobe run on its copy in the work folder `folder`, under the name
 *  `input.name` (`clipInput`). The copy stays in the folder for later runs,
 *  which must not give it again as an input: a run refuses an input whose
 *  name the folder already has. ffprobe reads one input file in a run, so
 *  each clip has its own run. */
export async function probeClip(input: ClipInput, folder: string, signal: AbortSignal, toolName: string): Promise<ProbedClip> {
  const { clip } = input
  let copy
  try {
    copy = await copyInputClip(input, folder, signal)
  } catch (error) {
    if (!(error instanceof ClipReadError)) throw error
    console.error(`Failed to read the ${clip.kind} clip @${clip.id}:`, error)
    return { kind: 'notRead', problem: error.problem }
  }

  let output = ''
  let errorOutput = ''
  const run = { args: assetProbeArgs(input.name), folder, inputs: copy ? [copy] : [], timeoutMs: FFPROBE_TIMEOUT_MS, maxOutputBytes: FFPROBE_OUTPUT_BYTES }
  const end = await runProgram('ffprobe', toolName, run, signal, ({ stream, text }) => {
    if (stream === 'stdout') output += text
    else errorOutput += text
  })
  const facts = end.kind === 'exited' && end.code === 0 ? clipProbeFacts(output) : null
  if (!facts) {
    console.error(`ffprobe could not read the ${clip.kind} clip @${clip.id}:`, end, errorOutput)
    return { kind: 'notProbed' }
  }
  return { kind: 'probed', facts }
}

/** The result text of an `asset_info` call with the arguments `args`, for
 *  the conversation `sections`: one line for each image and clip that it
 *  names. Throws a `ToolError` for a bad `assets` argument, and for an id
 *  that names no image and no clip of the conversation. A stop of `signal`
 *  stops a run of ffprobe and rejects with the stop. */
export async function assetInfoResult(args: ToolArguments, sections: readonly Section[], signal: AbortSignal): Promise<string> {
  const ids = assetIdsArgument(args, { max: MAX_ASSET_INFO_IDS, notDone: ASSET_INFO_WORDING.notDone })
  const assets = conversationAssets(sections)
  const named = ids.flatMap((id) => assets.found.get(id) ?? [])
  if (named.length < ids.length) {
    throw new ToolError(unknownAssetsText(ids.filter((id) => !assets.found.has(id)), assets, ASSET_INFO_WORDING))
  }

  // The facts of each asset of `named`, at its index. The clips share one
  // work folder for their probes, after the images.
  const facts: string[] = []
  const clips: { index: number, clip: ClipAttachment }[] = []
  for (const [index, asset] of named.entries()) {
    if (asset.kind === 'clip') {
      clips.push({ index, clip: asset.clip })
      continue
    }
    signal.throwIfAborted()
    facts[index] = (await readImageFacts(asset.id, asset.reference.path)).facts
  }
  if (clips.length > 0) {
    await inWorkFolder(async (folder) => {
      for (const { index, clip } of clips) facts[index] = probedClipFacts(clip, await probeClip(clipInput(clip), folder, signal, ASSET_INFO_TOOL.name))
    })
  }

  const places = assetPlaces(sections, named)
  return assetInfoText(named.map((asset, index) => assetInfoLine(
    asset.id,
    asset.kind === 'clip' ? asset.clip.kind : 'image',
    facts[index],
    places[index],
  )))
}
