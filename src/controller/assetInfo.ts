import sbp from '@sbp/sbp'
import { assetPlaces, type AssetPlace } from '../model/chat/assetOrigins'
import type { ImageSize } from '../model/chat/imageDrawing'
import { imageExtension, imageMediaType } from '../model/chat/images'
import { ClipReadError, mediaFileExtension } from '../model/chat/mediaFiles'
import type { Section } from '../model/chat/types'
import type { ClipAttachment } from '../model/providers/clipInputs'
import { conversationAssets } from '../model/streams/mediaRequest'
import { assetProbeArgs, clipFactsText, clipProbeFacts, imageFactsText } from '../model/tools/assetFacts'
import {
  ASSET_INFO_TOOL,
  ASSET_INFO_WORDING,
  assetInfoIds,
  assetInfoLine,
  assetInfoText,
  CLIP_NOT_PROBED_FACTS,
  clipNotReadFacts,
  IMAGE_NOT_DECODED_FACTS,
  IMAGE_NOT_READ_FACTS,
} from '../model/tools/assetInfo'
import { clipInput } from '../model/tools/programRuns'
import { unknownAssetsText } from '../model/tools/toolInputs'
import { ToolError, type ToolArguments } from '../model/tools/types'
import { FFPROBE_OUTPUT_BYTES, FFPROBE_TIMEOUT_MS } from '../model/tools/videoTool'
import type { BundledToolInput } from './nativeTypes'
import { clipCopy, inWorkFolder, runProgram } from './programRuns'

// The work of the `asset_info` tool (model/tools/assetInfo.ts): it reads
// the facts of each image and clip that a call names. This module
// registers no selector: the `asset_info` runner (tools.ts) calls it.
//
// A file that Dez cannot read fails only its own line, so that the model
// gets the facts of the others. The cause goes to the log only: a native
// error and the output of ffprobe can hold a path.

// The facts text of the image `id`, whose file is at `path`: the webview
// decodes it for its size in pixels, as for the `image` tool.
async function imageFacts(id: string, path: string): Promise<string> {
  let file: File
  try {
    file = await sbp('dez.controller/images/readFile', path) as File
  } catch (error) {
    console.error(`Failed to read the image @${id}:`, error)
    return IMAGE_NOT_READ_FACTS
  }
  const mediaType = imageMediaType(path)
  const extension = mediaType && imageExtension(mediaType)
  let size = null as ImageSize | null
  try {
    // A plan that draws nothing: redraw only decodes the image and tells
    // its size, so the type of the drawing does not count.
    await sbp('dez.controller/images/redraw', file, (decoded: ImageSize) => {
      size = decoded
      return null
    }, 'image/png')
  } catch (error) {
    console.error(`Failed to decode the image @${id}:`, error)
    return `${imageFactsText(extension, null, file.size)} | ${IMAGE_NOT_DECODED_FACTS}`
  }
  return imageFactsText(extension, size, file.size)
}

// The facts text of `clip`, from one ffprobe run on its copy in the work
// folder `folder`. ffprobe reads one input file in a run, so each clip has
// its own run; every copy has its own name (`clipInput`), as a run refuses
// an input whose name the folder already has.
async function clipFacts(clip: ClipAttachment, folder: string, signal: AbortSignal): Promise<string> {
  const input = clipInput(clip)
  let copy: BundledToolInput | null
  try {
    copy = await clipCopy(input, folder, signal)
  } catch (error) {
    if (!(error instanceof ClipReadError)) throw error
    console.error(`Failed to read the ${clip.kind} clip @${clip.id}:`, error)
    return clipNotReadFacts(error.problem)
  }

  let output = ''
  let errorOutput = ''
  const run = { args: assetProbeArgs(input.name), folder, inputs: copy ? [copy] : [], timeoutMs: FFPROBE_TIMEOUT_MS, maxOutputBytes: FFPROBE_OUTPUT_BYTES }
  const end = await runProgram('ffprobe', ASSET_INFO_TOOL.name, run, signal, ({ stream, text }) => {
    if (stream === 'stdout') output += text
    else errorOutput += text
  })
  const facts = end.kind === 'exited' && end.code === 0 ? clipProbeFacts(output) : null
  if (!facts) {
    console.error(`ffprobe could not read the ${clip.kind} clip @${clip.id}:`, end, errorOutput)
    return CLIP_NOT_PROBED_FACTS
  }
  return clipFactsText(clip.kind, mediaFileExtension(clip.type, clip.url), facts)
}

/** The result text of an `asset_info` call with the arguments `args`, for
 *  the conversation `sections`: one line for each image and clip that it
 *  names. Throws a `ToolError` for a bad `assets` argument, and for an id
 *  that names no image and no clip of the conversation. A stop of `signal`
 *  stops a run of ffprobe and rejects with the stop. */
export async function assetInfoResult(args: ToolArguments, sections: readonly Section[], signal: AbortSignal): Promise<string> {
  const ids = assetInfoIds(args)
  const assets = conversationAssets(sections)
  const unknown = ids.filter((id) => !assets.images.has(id) && !assets.clips.has(id))
  if (unknown.length > 0) throw new ToolError(unknownAssetsText(unknown, assets, ASSET_INFO_WORDING))

  const facts = new Map<string, string>()
  const clips: ClipAttachment[] = []
  for (const id of ids) {
    const path = assets.images.get(id)
    if (path === undefined) {
      clips.push(assets.clips.get(id) as ClipAttachment)
      continue
    }
    signal.throwIfAborted()
    facts.set(id, await imageFacts(id, path))
  }
  if (clips.length > 0) {
    await inWorkFolder(async (folder) => {
      for (const clip of clips) facts.set(clip.id, await clipFacts(clip, folder, signal))
    })
  }

  // `assetPlaces` finds the assets by the rule of `conversationAssets`, so
  // it has a place for each id.
  const places = assetPlaces(sections)
  return assetInfoText(ids.map((id) => assetInfoLine(
    id,
    assets.clips.get(id)?.kind ?? 'image',
    facts.get(id) as string,
    places.get(id) as AssetPlace,
  )))
}
