import type { AssetOrigin, AssetPlace } from '../chat/assetOrigins'
import type { MediaTagKind } from '../chat/mediaTags'
import { modelRefKey } from '../chat/modelRef'
import { argumentWords, unknownValuesText } from './arguments'
import type { ClipProbeFacts } from './assetFacts'
import { ASSET_VIEW_TIMEOUT_MS } from './assetView'
import {
  blackIntervals,
  CHECK_STREAMS,
  CLIP_CHECKS,
  cutTimes,
  frameTimeText,
  FROZEN_MIN_SECONDS,
  frozenIntervals,
  loudnessCurve,
  MAX_CURVE_VALUES,
  MOMENTARY_WINDOW_SECONDS,
  SILENCE_DBFS,
  SILENCE_MIN_SECONDS,
  silenceIntervals,
  type ClipCheck,
  type ClipInterval,
  type LoudnessCurve,
} from './clipAnalysis'
import type { ProgramEnd } from './programRuns'
import type { InputWording } from './toolInputs'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// The `asset_info` tool: one line of facts for each image and clip that a
// call names, with who made it (assetOrigins.ts) and whether the editor
// hides it. The jobs of a reply end in any order, and the ids of their
// assets follow that order, so a model needs these lines to put the clips
// of its calls in their order (the scenes of a video) before a join. With
// `checks`, one ffmpeg run over each whole clip finds its black, frozen,
// and silent parts, its loudness over time, and its cuts
// (clipAnalysis.ts), and a line for each check follows the line of the
// clip. controller/assetInfo.ts reads the files and runs the programs.
//
// This module must not import chat/toolBlocks.ts or registry.ts: the
// registry imports it, and toolBlocks imports the registry.

/** The most ids of one call. */
export const MAX_ASSET_INFO_IDS = 20

// The description is static (no running counts, no dates): the tools array
// is in the provider's prompt cache.
export const ASSET_INFO_TOOL: ToolDefinition = {
  name: 'asset_info',
  description: 'Give the facts of images and clips of this conversation, one line for each, in the order of the ids: '
    + 'its id; its kind (image, video, or audio); its format and facts (the size of an image in pixels; the length of a clip in seconds; '
    + 'the picture size, the frames per second, the codec, and the sound of a video clip; the codec, the sample rate, and the channels of an audio clip; '
    + 'and the file size); whether the conversation shows it at its place (shown), or only a panel does (hidden): '
    + 'the panel of the chip of the call that made it, or the panel of the assets chip of the compaction for one that a compaction kept; '
    + 'and who made it: the user, a model, a call of a Dez tool, or a job of a Dez tool, with the number of the job in its reply and how its call begins. '
    + 'The jobs of a reply end in any order, and the ids of what they make follow that order: '
    + 'before you use clips in an order (the scenes of a video), read which call made each one. '
    + 'For an image or a clip that Dez cannot read (its file is gone, or it expired), the line says so in place of its facts. '
    + 'With `checks`, Dez also reads each whole clip with ffmpeg, and a line for each check follows the line of the clip: '
    + 'the parts that are black, frozen, or silent, the loudness over time, or the cuts, with their times, '
    + 'which you can then view with asset_view (`times`, or `start` and `end`).',
  parameters: [
    {
      name: 'assets',
      type: 'string',
      description: `The ids of the images and the clips, as in "@a @c", at most ${MAX_ASSET_INFO_IDS}.`,
      required: true,
    },
    {
      name: 'checks',
      type: 'string',
      description: 'For clips: what Dez finds in each whole clip, as in "black frozen silence", any of: '
        + '"black", the parts where the picture is black, from one frame on; '
        + `"frozen", the parts of ${FROZEN_MIN_SECONDS} s or more where the picture does not change (a still picture or a solid color counts); `
        + `"silence", the parts of ${SILENCE_MIN_SECONDS} s or more where the sound stays under ${SILENCE_DBFS} dBFS; `
        + `"loudness_curve", the loudness of each second in LUFS, at most ${MAX_CURVE_VALUES} values (a longer clip gets a longer step); `
        + '"cuts", the time of each cut between two shots, as `scenes` of asset_view finds them. '
        + `ffmpeg has ${ASSET_VIEW_TIMEOUT_MS / 1000} s for the checks of one clip; a check of the picture reads every frame, so it takes longer than a check of the sound. `
        + 'Default: no check. An image gets none.',
      required: false,
    },
  ],
}

const NOT_DONE = 'Dez read no facts.'

/** The words of `asset_info` in the text of an id that names no image and
 *  no clip (`unknownAssetsText`). */
export const ASSET_INFO_WORDING: InputWording = { argument: '`assets`', notDone: NOT_DONE }

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
    case 'carried':
      return origin.text
  }
}

/** One line of an `asset_info` result: the asset `id` of the kind `kind`,
 *  its facts text (`imageFactsText`, `clipFactsText`, or the text of a
 *  problem), and its place. */
export function assetInfoLine(id: string, kind: 'image' | MediaTagKind, facts: string, place: AssetPlace): string {
  return `@${id} | ${kind} | ${facts} | ${place.hidden ? 'hidden' : 'shown'} | ${assetOriginText(place.origin)}`
}

/** The checks of an `asset_info` call (`checks`), in the order of
 *  `CLIP_CHECKS`: none for a blank or absent one. Throws a `ToolError` for
 *  a name that is no check. */
export function assetInfoChecks(args: ToolArguments): ClipCheck[] {
  const words = argumentWords(args, 'checks').map((word) => word.toLowerCase())
  const unknown = [...new Set(words.filter((word) => !CLIP_CHECKS.some((check) => check === word)))]
  if (unknown.length > 0) throw new ToolError(`${unknownValuesText('checks', unknown, `any of: ${CLIP_CHECKS.join(', ')}`)} ${NOT_DONE}`)
  return CLIP_CHECKS.filter((check) => words.includes(check))
}

/** The streams of a clip that the checks read: the picture of a video
 *  clip (an audio clip's cover picture is none), and the sound. */
export type ClipStreams = Readonly<Record<'picture' | 'sound', boolean>>

/** The streams of a clip of `kind` with the facts `facts`. */
export function clipStreams(kind: MediaTagKind, facts: ClipProbeFacts): ClipStreams {
  return { picture: kind === 'video' && facts.video !== null, sound: facts.audio !== null }
}

/** The checks of `checks` that a clip with `streams` fits: those of the
 *  streams that it has. */
export function fittingChecks(checks: readonly ClipCheck[], streams: ClipStreams): ClipCheck[] {
  return checks.filter((check) => streams[CHECK_STREAMS[check]])
}

/** The most parts or times of one check line; the others are only
 *  counted. */
export const MAX_CHECK_ITEMS = 50

// The items of a check line, each one with `unit` after the last one shown.
function itemsText(items: readonly string[], unit = ''): string {
  if (items.length === 0) return 'none'
  const more = items.length - MAX_CHECK_ITEMS
  return `${items.slice(0, MAX_CHECK_ITEMS).join(', ')}${unit}${more > 0 ? `, and ${more} more` : ''}`
}

function intervalText({ start, end }: ClipInterval): string {
  return `${frameTimeText(start)} s to ${end === null ? 'the end' : `${frameTimeText(end)} s`}`
}

// A value of a loudness curve, to a tenth, as ebur128 writes it.
function lufsText(value: number | null): string {
  if (value === null) return 'none'
  return value === -Infinity ? '-inf' : String(Number(value.toFixed(1)))
}

function curveText(curve: LoudnessCurve | null): string {
  if (!curve) return `none: the sound is shorter than ${MOMENTARY_WINDOW_SECONDS} s`
  const each = curve.step === 1 ? 'each second' : `each ${curve.step} s`
  const silent = curve.values.includes(-Infinity) ? ' (-inf: no sound at all)' : ''
  return `${curve.values.map(lufsText).join(', ')} LUFS, one value for ${each} from 0 s${silent}`
}

// What `check` found in the log of the run of a clip's checks.
function findingText(check: ClipCheck, log: string): string {
  switch (check) {
    case 'black':
      return itemsText(blackIntervals(log).map(intervalText))
    case 'frozen':
      return itemsText(frozenIntervals(log).map(intervalText))
    case 'silence':
      return itemsText(silenceIntervals(log).map(intervalText))
    case 'loudness_curve':
      return curveText(loudnessCurve(log))
    case 'cuts':
      return itemsText(cutTimes(log).map(frameTimeText), ' s')
  }
}

// The indent of the lines that follow the line of a clip.
const CHECK_INDENT = '  '

/** The lines of `checks` of a clip with `streams`, under its line: what
 *  each check that fits the clip (`fittingChecks`) found, from the log of
 *  their run (`clipChecksArgs`; blank when none fits, as nothing ran), and
 *  for each other check, the stream that the clip lacks. */
export function checkLines(checks: readonly ClipCheck[], streams: ClipStreams, log: string): string[] {
  return checks.map((check) => {
    const stream = CHECK_STREAMS[check]
    return `${CHECK_INDENT}${check}: ${streams[stream] ? findingText(check, log) : `no check, the clip has no ${stream}`}`
  })
}

/** The line of the checks of a clip that Dez could not read (its facts
 *  tell why). */
export const CHECKS_NOT_READ_LINE = `${CHECK_INDENT}No checks: Dez could not read this clip.`

/** The line of the checks of a clip whose run of `checks` ended with
 *  `end`, which is not a run that ended well. */
export function checksFailedLine(end: ProgramEnd, checks: readonly ClipCheck[]): string {
  if (end.kind === 'timedOut') {
    const advice = checks.some((check) => CHECK_STREAMS[check] === 'picture')
      ? ' A check of the picture reads every frame: for a long video clip, check only its sound (`silence`, `loudness_curve`), '
        + 'or view parts of it with asset_view (`start` and `end`).'
      : ''
    return `${CHECK_INDENT}No checks: ffmpeg took longer than ${ASSET_VIEW_TIMEOUT_MS / 1000} s to read this whole clip, so Dez stopped it.${advice}`
  }
  if (end.kind === 'outputTooLarge') return `${CHECK_INDENT}No checks: ffmpeg wrote more log than Dez reads. Call again with fewer checks for this clip.`
  return `${CHECK_INDENT}No checks: ffmpeg could not read this clip. The file may be damaged; Help › Developer Console shows the cause. `
    + 'This is not a fault of the call.'
}

/** The first line of every `asset_info` result: the columns of a line. */
export const ASSET_INFO_COLUMNS = 'Each line: id | kind | format and facts | shown, or hidden in the panel of a chip (of its call, or of the compaction) | who made it.'

/** The result of an `asset_info` call with `checks`: a first line that
 *  names the columns, then the lines of `assetInfoLine`, each one of a
 *  clip followed by its check lines. */
export function assetInfoText(lines: readonly string[], checks: readonly ClipCheck[]): string {
  const columns = checks.length === 0 ? ASSET_INFO_COLUMNS : `${ASSET_INFO_COLUMNS} Under the line of a clip: a line for each check, with times in seconds of the clip.`
  return [columns, ...lines].join('\n')
}
