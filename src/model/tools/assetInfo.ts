import type { AssetOrigin, AssetPlace } from '../chat/assetOrigins'
import { IMAGE_ID_SOURCE } from '../chat/images'
import { mediaFileExtension, type ClipReadProblem } from '../chat/mediaFiles'
import type { MediaTagKind } from '../chat/mediaTags'
import { modelRefKey } from '../chat/modelRef'
import type { ClipAttachment } from '../providers/clipInputs'
import { clipFactsText, type ClipProbeFacts } from './assetFacts'
import type { InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// The `asset_info` tool: one line of facts for each image and clip that a
// call names, with who made it (assetOrigins.ts) and whether the editor
// hides it. The jobs of a reply end in any order, and the ids of their
// assets follow that order, so a model needs these lines to put the clips
// of its calls in their order (the scenes of a video) before a join.
// controller/assetInfo.ts reads the files.
//
// This module must not import chat/toolBlocks.ts or registry.ts: the
// registry imports it, and toolBlocks imports the registry.

/** The most ids of one call. */
export const MAX_ASSET_INFO_IDS = 20

// The description is static (no counts, no dates): the tools array is in
// the provider's prompt cache.
export const ASSET_INFO_TOOL: ToolDefinition = {
  name: 'asset_info',
  description: 'Give the facts of images and clips of this conversation, one line for each, in the order of the ids: '
    + 'its id; its kind (image, video, or audio); its format and facts (the size of an image in pixels; the length of a clip in seconds; '
    + 'the picture size, the frames per second, the codec, and the sound of a video clip; the codec, the sample rate, and the channels of an audio clip; '
    + 'and the file size); whether your reply shows it (shown), or only the panel of the chip of the call that made it (hidden); '
    + 'and who made it: the user, a model, a call of a Dez tool, or a job of a Dez tool, with the number of the job in its reply and how its call begins. '
    + 'The jobs of a reply end in any order, and the ids of what they make follow that order: '
    + 'before you use clips in an order (the scenes of a video), read which call made each one. '
    + 'For an image or a clip that Dez cannot read (its file is gone, or it expired), the line says so in place of its facts.',
  parameters: [
    {
      name: 'assets',
      type: 'string',
      description: `The ids of the images and the clips, as in "@a @c", at most ${MAX_ASSET_INFO_IDS}.`,
      required: true,
    },
  ],
}

const NOT_DONE = 'Dez read no facts.'

/** The words of `asset_info` in the text of an id that names no image and
 *  no clip (`unknownAssetsText`). */
export const ASSET_INFO_WORDING: InputWording = { argument: '`assets`', notDone: NOT_DONE }

const ASSET_ID_WORD = new RegExp(`^@?(${IMAGE_ID_SOURCE})$`)

/** The ids that the `assets` argument of a call names (split as the
 *  `join_clips` subcommand of `video` splits its clips), each one once, in
 *  the order of the call. Throws a `ToolError` that ends with `notDone`
 *  for a word that is no id, for no id, and for more than `max` ids. */
export function assetIdsArgument(args: ToolArguments, { max, notDone }: { max: number, notDone: string }): string[] {
  const words = (typeof args.assets === 'string' ? args.assets : '').split(/[\s,]+/).filter((word) => word !== '')
  const form = 'Give the ids of the images and the clips, as in "@a @c".'
  const ids = new Set<string>()
  for (const word of words) {
    const id = ASSET_ID_WORD.exec(word)?.[1]
    if (id === undefined) throw new ToolError(`\`assets\` holds ${JSON.stringify(word)}, which is no id of an image or a clip. ${form} ${notDone}`)
    ids.add(id)
  }
  if (ids.size === 0) throw new ToolError(`\`assets\` names no image and no clip. ${form} ${notDone}`)
  if (ids.size > max) {
    throw new ToolError(`\`assets\` names ${ids.size} images and clips, and one call takes at most ${max}. `
      + `Call again with the first ${max}, then again with the rest. ${notDone}`)
  }
  return [...ids]
}

/** The facts text of an image whose file Dez could not read. */
export const IMAGE_NOT_READ_FACTS = 'Dez could not read its file'

/** The facts text of an image whose picture the webview could not
 *  decode. */
export const IMAGE_NOT_DECODED_FACTS = 'Dez could not read its picture'

/** The facts text of a clip whose file ffprobe could not read. */
export const CLIP_NOT_PROBED_FACTS = 'ffprobe could not read its file'

/** The facts text of a clip that Dez could not read (`ClipReadError`), by
 *  its problem. */
export function clipNotReadFacts(problem: ClipReadProblem): string {
  switch (problem) {
    case 'deleted':
      return 'gone: the user deleted its file, and it has no web address'
    case 'expired':
      return 'expired: its provider does not keep it any more, and the user did not save it'
    case 'unreadable':
      return 'Dez could not read its file'
  }
}

/** What one ffprobe run tells of a clip: its facts; the problem of a clip
 *  that Dez could not read (`ClipReadError`); or that ffprobe could not
 *  read its file. */
export type ProbedClip =
  | { kind: 'probed', facts: ClipProbeFacts }
  | { kind: 'notRead', problem: ClipReadProblem }
  | { kind: 'notProbed' }

/** The facts text of `clip` from its probe. */
export function probedClipFacts(clip: Pick<ClipAttachment, 'kind' | 'type' | 'url'>, probed: ProbedClip): string {
  switch (probed.kind) {
    case 'probed':
      return clipFactsText(clip.kind, mediaFileExtension(clip.type, clip.url), probed.facts)
    case 'notRead':
      return clipNotReadFacts(probed.problem)
    case 'notProbed':
      return CLIP_NOT_PROBED_FACTS
  }
}

// A label as the end of an origin text, as in `: "scene 3 …"`. A label
// has no `"` (`jobCallLabel`).
function labelEnd(label: string): string {
  return label === '' ? '' : `: "${label}"`
}

/** Who made an asset, as a text for a model, as in `made by the
 *  model_invoke job 3 of its reply: "scene 3 …"`. */
export function assetOriginText(origin: AssetOrigin): string {
  switch (origin.kind) {
    case 'user':
      return 'from the user'
    case 'model':
      return origin.model === null ? 'made by a model' : `made by the model ${modelRefKey(origin.model)}`
    case 'job': {
      const job = origin.number === null ? `a job of the ${origin.tool} tool` : `the ${origin.tool} job ${origin.number} of its reply`
      return `made by ${job}${labelEnd(origin.label)}`
    }
    case 'call':
      return `made by the ${origin.tool} tool${labelEnd(origin.label)}`
  }
}

/** One line of an `asset_info` result: the asset `id` of the kind `kind`,
 *  its facts text (`imageFactsText`, `clipFactsText`, or the text of a
 *  problem), and its place. */
export function assetInfoLine(id: string, kind: 'image' | MediaTagKind, facts: string, place: AssetPlace): string {
  return `@${id} | ${kind} | ${facts} | ${place.hidden ? 'hidden' : 'shown'} | ${assetOriginText(place.origin)}`
}

/** The result of an `asset_info` call: a first line that names the
 *  columns, then the lines of `assetInfoLine`. */
export function assetInfoText(lines: readonly string[]): string {
  return ['Each line: id | kind | format and facts | shown, or hidden in the panel of its call\'s chip | who made it.', ...lines].join('\n')
}
