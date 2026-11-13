import { byteSizeText } from '../../utils/byteSize'
import { AUDIO_CUT_RATE, type AudioPart } from '../chat/audioCut'
import { sectionPlainText } from '../chat/content'
import { findImageReferences } from '../chat/images'
import { MAX_SAVED_CLIP_BYTES } from '../chat/mediaFiles'
import { findMediaTags, sectionClipSource, type MediaTag } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { assetIdArgument } from './arguments'
import { madeAssetText } from './jobs'
import type { KeptFile, ProgramEnd } from './programRuns'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type ToolArguments } from './types'

// The `audio` tool: work on the audio clips of a conversation, one
// subcommand each (subcommands.ts). `clip` makes a new clip from a part of
// one, for example to fit the length that a model takes.
//
// ffmpeg, a program that Dez ships, decodes and cuts the clip, in place of
// Web Audio (`dez.controller/media/cutAudio`): it was 3 to 7 times faster
// in a measurement on Linux, it does not stop the page while it decodes a
// long clip, and no byte of the clip comes into the webview. This module
// has the pure parts: the definition, the checks of a call, the arguments
// of the runs, and every text that the calling model reads.
// controller/audioTool.ts runs the program.
//
// Every text here is a tool result: it goes to the chat provider. So it
// names a clip by its id only.

export const AUDIO_TOOL: SubcommandTool = {
  name: 'audio',
  summary: 'Work with the audio clips of this conversation.',
  subcommands: [
    {
      name: 'clip',
      summary: 'Make a new audio clip from a part of an audio clip, for example to fit the length that a model takes.',
      description: 'Makes a new audio clip from a part of an audio clip of this conversation. '
        + 'An audio clip shows in the text as `<dez:audio id="b" type="audio/mpeg"/>`, where `b` is its id; the user writes `@b` for it. '
        + 'The clip itself does not change. The new clip is a WAV file. It goes into your reply, where the user can play it, '
        + 'and the result gives its id and its length in seconds. '
        + 'A call with only `clip` makes no clip, and the result gives the length of that clip: use it before a cut.',
      parameters: [
        { name: 'clip', type: 'string', description: 'The id of the audio clip, as in "b" or "@b".', required: true },
        {
          name: 'start',
          type: 'number',
          description: 'Where the part starts, in seconds from the start of the clip. Leave it out to start at the start of the clip.',
          required: false,
        },
        {
          name: 'end',
          type: 'number',
          description: 'Where the part ends, in seconds from the start of the clip. Leave it out, or give a time past the end of the clip, to end at the end of the clip.',
          required: false,
        },
      ],
      example: { clip: 'b', start: 0, end: 15 },
    },
  ],
}

export const AUDIO_TOOL_DEFINITION = subcommandToolDefinition(AUDIO_TOOL)

/** The clip id that the `clip` parameter of an `audio clip` call names (`b`
 *  or `@b`). Throws for any other text; the model reads the error. */
export function audioClipId(args: ToolArguments): string {
  return assetIdArgument(args.clip, 'a clip', 'b')
}

/** The audio clip `id` of a tab's `sections`: the newest media tag with that
 *  id in any section (a clip that a model made, or a clip file that the
 *  user pasted or dropped; mediaTags.ts), with the `src` that counts in its
 *  section (`sectionClipSource`). Throws for an id that names a video clip,
 *  an image, or nothing; the text tells the model the ids of the audio
 *  clips that it can name. */
export function audioClipOf(sections: readonly Section[], id: string): MediaTag {
  const tags = sections.flatMap((section) => findMediaTags(sectionPlainText(section)).map((tag) => ({ ...tag, src: sectionClipSource(tag.src, section.role) })))
  const tag = tags.findLast((candidate) => candidate.id === id)
  if (tag?.kind === 'audio') return tag
  if (tag?.kind === 'video') throw new ToolError(`@${id} is a video clip. The audio tool works on audio clips only.`)
  if (sections.some((section) => findImageReferences(sectionPlainText(section), section.role).some((reference) => reference.id === id))) {
    throw new ToolError(`@${id} is an image. The audio tool works on audio clips only.`)
  }
  const ids = [...new Set(tags.filter((candidate) => candidate.kind === 'audio').map((candidate) => `@${candidate.id}`))]
  throw new ToolError(ids.length === 0
    ? `This conversation has no audio clips, so it has no audio clip @${id}. Do not call the audio tool until the conversation has an audio clip.`
    : `No audio clip of this conversation has the id @${id}. Its audio clips are ${ids.join(', ')}: call again with one of these ids.`)
}

// Seconds for a text, to at most two decimals: `12.35`, `15`.
function secondsText(seconds: number): string {
  return String(Number(seconds.toFixed(2)))
}

/** The part that an `audio clip` call asks for, in seconds from the start
 *  of the clip. `end` is null for a part that ends at the clip's end. */
export interface AudioCutRequest {
  start: number
  end: number | null
}

/** The part that an `audio clip` call asks for: from `start` (0 with none)
 *  to `end`. Null for a call that gives neither: it asks for the clip's
 *  length. Throws for values that are a part of no clip; the text tells
 *  the model which values fit. The check needs no length of the clip, so
 *  it runs before Dez reads the clip. */
export function audioCutRequest(args: ToolArguments): AudioCutRequest | null {
  // The subcommand gives both parameters the type `number`
  // (`checkArgumentValues`); a parameter that the call leaves out has no key.
  const start = typeof args.start === 'number' ? args.start : undefined
  const end = typeof args.end === 'number' ? args.end : undefined
  if (start === undefined && end === undefined) return null

  const from = start ?? 0
  if (from < 0) throw new ToolError('"start" must be 0 or more. Give 0, or leave it out, to start at the start of the clip.')
  if (end !== undefined && end <= from) throw new ToolError(`"end" (${end}) must be after "start" (${from}).`)
  return { start: from, end: end ?? null }
}

/** The new clip of a cut, as a file of the work folder of its run. An id
 *  is only letters, so the name of no input copy (`clipInput`) is this
 *  name. */
export const AUDIO_CUT_FILE: KeptFile = { name: 'new_clip.wav', kind: 'audio', type: 'audio/wav', extension: 'wav' }

/** The time limit of one ffmpeg run of the tool. ffmpeg decodes a clip of
 *  some hours in less than a minute, so a longer run is one that hangs. */
export const AUDIO_RUN_TIMEOUT_MS = 10 * 60 * 1000

/** The most output that one ffmpeg run of the tool can write: a progress
 *  block each half second, and an error line for each part of a file that
 *  it cannot decode. Only the end of it is kept. */
export const AUDIO_RUN_OUTPUT_BYTES = 8 * 1024 * 1024

// What every ffmpeg run of the tool starts with.
// - `-v error`: the error output goes into an error result, and so to the
//   chat provider; the default level prints the metadata of the input.
// - `-progress pipe:1`: ffmpeg writes its progress to its standard output
//   as blocks of `key=value` lines. `out_time_us` is the length of the
//   audio that it wrote so far, in microseconds (`writtenAudioSeconds`).
const FFMPEG_RUN_ARGS: readonly string[] = ['-nostdin', '-hide_banner', '-v', 'error', '-progress', 'pipe:1']

// The most seconds that Dez gives ffmpeg as a time. ffmpeg takes no
// exponent form, which `toFixed` gives for a huge number, and no clip is
// this long (30 years): a start there cuts nothing, as every start past
// the end of a clip.
const MAX_TIME_SECONDS = 1e9

// The shortest length that Dez gives ffmpeg. A `-t` of less than one
// sample is no defined length: `-t 0.000001` gave 19 ms with the ffmpeg
// that Dez ships.
const MIN_CUT_SECONDS = 0.001

// A time as ffmpeg reads it: seconds with 6 decimals, the most that it
// reads.
function ffmpegTime(seconds: number): string {
  return Math.min(seconds, MAX_TIME_SECONDS).toFixed(6)
}

/** The arguments of the ffmpeg run that cuts the part `request` of the
 *  clip file `input` into `AUDIO_CUT_FILE`: a WAV file of 16-bit samples
 *  at `AUDIO_CUT_RATE`, with the channels of the clip.
 *
 *  - `-ss` and `-t` come after `-i`: ffmpeg decodes the clip from its
 *    start and drops the samples before the part, so the cut is exact. A
 *    seek in the input (`-ss` before `-i`) is faster, but it is not exact
 *    for every file (an MP3 with no seek table).
 *  - No `-t`, or a `-t` past the end of the clip, cuts to its end.
 *  - `-map 0:a:0`: only the first audio stream. The cover picture of a
 *    song is a video stream.
 *  - `-map_metadata -1 -bitexact`: no tag of the source (a title, an
 *    artist) and no tag of the encoder go into the new file, which a later
 *    request can send to a provider.
 *  - `-fs`: ffmpeg ends the run, with no error, when the file has this
 *    size. So a part that is too long (`AUDIO_CUT_TOO_LARGE_TEXT`) does
 *    not fill the disk, and its file is larger than `MAX_SAVED_CLIP_BYTES`. */
export function audioCutArgs(input: string, request: AudioCutRequest): string[] {
  const length = request.end === null ? [] : ['-t', ffmpegTime(Math.max(request.end - request.start, MIN_CUT_SECONDS))]
  return [
    ...FFMPEG_RUN_ARGS, '-i', input, '-map', '0:a:0', '-ss', ffmpegTime(request.start), ...length,
    '-map_metadata', '-1', '-ar', String(AUDIO_CUT_RATE), '-c:a', 'pcm_s16le', '-bitexact', '-fs', String(MAX_SAVED_CLIP_BYTES + 1),
    AUDIO_CUT_FILE.name,
  ]
}

/** The arguments of the ffmpeg run that decodes the whole clip file
 *  `input` and writes no file: its last progress block tells the exact
 *  length of the clip. The length that the header of a file states (what
 *  ffprobe reads) is not exact for every type: for an MP3 or an AAC file
 *  it can be a guess from the bit rate. */
export function audioLengthArgs(input: string): string[] {
  return [...FFMPEG_RUN_ARGS, '-i', input, '-map', '0:a:0', '-f', 'null', '-']
}

/** The seconds of audio that an ffmpeg run wrote, from the end of its
 *  standard output: the last `out_time_us` line. Null for a run that wrote
 *  no audio (`out_time_us=N/A`, or no such line). A cut whose start is at
 *  or past the end of the clip is such a run: ffmpeg ends it with no
 *  error and an empty file. */
export function writtenAudioSeconds(progress: string): number | null {
  const last = Array.from(progress.matchAll(/^out_time_us=(.*)$/gm)).at(-1)?.[1].trim() ?? ''
  const microseconds = /^\d+$/.test(last) ? Number(last) : 0
  return microseconds > 0 ? microseconds / 1_000_000 : null
}

/** The part of a clip that a cut of `request` took, from the `seconds` of
 *  audio that the cut wrote: a part with no end, or with an end past the
 *  end of the clip, ends where the clip ends. */
export function audioCutPart(request: AudioCutRequest, seconds: number): AudioPart {
  return { start: request.start, end: Math.min(request.end ?? Infinity, request.start + seconds) }
}

/** The error result of a cut that took no audio: the clip `id`, which is
 *  `duration` seconds long, has none from `start` on. */
export function audioEmptyCutText(id: string, start: number, duration: number): string {
  const length = secondsText(duration)
  // A start in the last sample of the clip is less than the length.
  return start >= duration
    ? `The audio clip @${id} is ${length} seconds long, so "start" must be less than ${length}.`
    : `The audio clip @${id} is ${length} seconds long, and it has no audio after second ${start}. Call again with a smaller "start".`
}

/** The error result of a call whose clip `id` ffmpeg did not decode. The
 *  details tell how the run ended (`audioRunDetails`). */
export function audioDecodeFailedText(id: string): string {
  return `Dez could not decode the audio clip @${id}: its file is broken, or it has a type that the ffmpeg of Dez does not read. `
    + `This is not a fault of the call. Tell the user, and do not call the audio tool again for @${id}.`
}

/** The details of `audioDecodeFailedText` for a run that ended with no
 *  error and wrote no audio. */
export const AUDIO_NOT_FOUND_DETAILS = 'ffmpeg found no audio in the file.'

/** The details of `audioDecodeFailedText` for a run that failed: how it
 *  ended, and `errorEnd`, the end of its error output. The caller takes
 *  the local paths out of it (`withoutLocalPaths`). */
export function audioRunDetails(end: Exclude<ProgramEnd, { kind: 'timedOut' }>, errorEnd: string): string {
  const how = end.kind === 'outputTooLarge'
    ? `Dez stopped ffmpeg: it wrote more than ${byteSizeText(AUDIO_RUN_OUTPUT_BYTES)} of output.`
    : end.code === null ? 'The system ended ffmpeg.' : `ffmpeg ended with the error code ${end.code}.`
  const written = errorEnd.trim()
  return written === '' ? how : `${how} The end of its error output:\n${written}`
}

/** The error result of a call whose ffmpeg run on the clip `id` did not
 *  end within the time limit. */
export function audioTimedOutText(id: string): string {
  return `Dez stopped the work on the audio clip @${id}: ffmpeg did not end within ${AUDIO_RUN_TIMEOUT_MS / 60_000} minutes. `
    + `This is not a fault of the call. Tell the user, and do not call the audio tool again for @${id}.`
}

/** The error result of a cut whose WAV file is larger than the most that
 *  Dez stores for a clip. */
export const AUDIO_CUT_TOO_LARGE_TEXT = `The part is too long: its WAV file is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)}, the most that Dez stores for a clip. `
  + 'Dez made no clip. Call again with a shorter part.'

/** The result of a call that made no clip: the length of the clip `id`. */
export function audioLengthText(id: string, duration: number): string {
  return `The audio clip @${id} is ${secondsText(duration)} seconds long. Give a start, an end, or both to make a new clip from a part of it.`
}

/** The result of a call that made the clip `newId`, of `duration` seconds,
 *  from `part` of the clip `id`. It names the clips by their ids only: a
 *  result goes to the provider, which gets no path of a stored file. */
export function audioCutResultText(id: string, newId: string, part: AudioPart, duration: number): string {
  return `${madeAssetText('audio', newId)} from @${id}, from second ${secondsText(part.start)} to second ${secondsText(part.end)}. `
    + `The audio clip @${newId} is ${secondsText(duration)} seconds long.`
}
