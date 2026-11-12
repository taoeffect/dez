import type { AudioPart } from '../chat/audioCut'
import { sectionPlainText } from '../chat/content'
import { findImageReferences } from '../chat/images'
import { findMediaTags, type MediaTag } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import { assetIdArgument } from './arguments'
import { subcommandToolDefinition, type SubcommandTool } from './subcommands'
import { ToolError, type ToolArguments } from './types'

// The `audio` tool: work on the audio clips of a conversation, one
// subcommand each (subcommands.ts). `clip` makes a new clip from a part of
// one, for example to fit the length that a model takes.

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
 *  user pasted or dropped; mediaTags.ts). Throws for an id that names a
 *  video clip, an image, or nothing; the text tells the model the ids of
 *  the audio clips that it can name. */
export function audioClipOf(sections: readonly Section[], id: string): MediaTag {
  const tags = sections.flatMap((section) => findMediaTags(sectionPlainText(section)))
  const tag = tags.findLast((candidate) => candidate.id === id)
  if (tag?.kind === 'audio') return tag
  if (tag?.kind === 'video') throw new ToolError(`@${id} is a video clip. The audio tool works on audio clips only.`)
  if (sections.some((section) => findImageReferences(sectionPlainText(section)).some((reference) => reference.id === id))) {
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

/** The part of the clip `id`, of `duration` seconds, that an `audio clip`
 *  call cuts: from `start` (0 with none) to `end` (the clip's end with
 *  none, or with an end past it). Null for a call that gives neither: it
 *  asks for the clip's length. Throws for a part that is not in the clip;
 *  the text tells the model which values fit. */
export function audioClipPart(id: string, args: ToolArguments, duration: number): AudioPart | null {
  // The subcommand gives both parameters the type `number`
  // (`checkArgumentValues`); a parameter that the call leaves out has no key.
  const start = typeof args.start === 'number' ? args.start : undefined
  const end = typeof args.end === 'number' ? args.end : undefined
  if (start === undefined && end === undefined) return null

  const from = start ?? 0
  if (from < 0) throw new ToolError('"start" must be 0 or more. Give 0, or leave it out, to start at the start of the clip.')
  if (end !== undefined && end <= from) throw new ToolError(`"end" (${end}) must be after "start" (${from}).`)
  if (from >= duration) {
    throw new ToolError(`The audio clip @${id} is ${secondsText(duration)} seconds long, so "start" must be less than ${secondsText(duration)}.`)
  }
  return { start: from, end: Math.min(end ?? duration, duration) }
}

/** The result of a call that made no clip: the length of the clip `id`. */
export function audioLengthText(id: string, duration: number): string {
  return `The audio clip @${id} is ${secondsText(duration)} seconds long. Give a start, an end, or both to make a new clip from a part of it.`
}

/** The result of a call that made the clip `newId`, of `duration` seconds,
 *  from `part` of the clip `id`. It names the clips by their ids only: a
 *  result goes to the provider, which gets no path of a stored file. */
export function audioCutResultText(id: string, newId: string, part: AudioPart, duration: number): string {
  return `Made the audio clip @${newId} from @${id}, from second ${secondsText(part.start)} to second ${secondsText(part.end)}. `
    + `The audio clip @${newId} is ${secondsText(duration)} seconds long.`
}
