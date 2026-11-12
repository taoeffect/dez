import { byteSizeText } from '../../utils/byteSize'
import { canonicalMediaType } from '../chat/mediaFiles'
import type { MediaTagData, MediaTagKind } from '../chat/mediaTags'
import type { MediaKind } from './types'

// The input clips of a media request: the audio and video clips that the
// newest user message holds or names with an @id mention
// (`mediaRequestInput`).
// What a model takes is data on the model (`ModelInfo.clips`), which a
// media format reads from the provider's model data
// (`MediaFormat.clipRules` in mediaFormats.ts). Also the checks of a
// request's clips: the ones that need only the tags (the submit, and
// `generateMedia` for a caller that did not check), and the ones that need
// the bytes (`generateMedia`, which reads them).

/** How a model uses the clips of one kind:
 *  - `reference`: a reference for the video (a look, a motion, a voice, a
 *    sound), which the prompt can name.
 *  - `background`: the sound of the video, as it is.
 *  - `voice`: the voice of one reference of the request, by order: the
 *    n-th audio clip is the voice of the n-th reference, with the images
 *    first and then the videos (Venice's Wan 2.7).
 *  - `source`: the clip that the model changes or writes down (a video to
 *    edit, speech to say in another voice, speech to write down); the
 *    kinds of `NEEDS_INPUT_CLIP`. */
export const CLIP_USES = ['reference', 'background', 'voice', 'source'] as const

export type ClipUse = typeof CLIP_USES[number]

/** What a model takes of the clips of one kind. */
export interface ClipKindRules {
  use: ClipUse
  /** The most clips of the kind in one request. Missing: no known limit
   *  (a `voice` model takes one for each reference). */
  maxClips?: number
  /** The least and the most seconds of one clip, and the most seconds of
   *  all clips of the kind in one request together. Missing: no known
   *  limit. */
  minSeconds?: number
  maxSeconds?: number
  maxTotalSeconds?: number
  /** The most bytes of one clip. Missing: no known limit. */
  maxBytes?: number
  /** The media types that the model takes (`canonicalMediaType` form).
   *  Missing: any. An audio clip of another type goes as a WAV copy when
   *  the list holds `audio/wav` (`needsWavCopy`). Never empty. */
  types?: string[]
  /** The name that the model's prompt gives the n-th clip of the kind,
   *  with `{n}` for the number: `@Audio{n}`, `<Video {n}>`. Missing: the
   *  prompt keeps the @id. */
  promptName?: string
  /** The model takes a clip of the kind only by a web (`https`) address,
   *  which the provider downloads: the provider is known to refuse data
   *  URLs. Such a clip goes by the `url` of its tag, which only a clip
   *  that a provider made can have; a clip that is only a file, or whose
   *  address expired, does not go (`clipTagProblem`). */
  urlOnly?: true
}

/** What a model takes as input clips. A kind with no rules is not taken. */
export interface InputClipRules {
  audio?: ClipKindRules
  video?: ClipKindRules
  /** Audio clips go only together with a reference image or video. */
  audioNeedsVisual?: true
}

/** The fields of a media tag that a request needs of a clip: its kind and
 *  id for the checks and the prompt, its type, and its sources for the
 *  read (`dez.controller/media/readClip`). No path goes to a provider; the
 *  `url` goes only to a model that takes the clip's kind only by its web
 *  address (`ClipKindRules.urlOnly`). */
export type ClipAttachment = Pick<MediaTagData, 'kind' | 'id' | 'type' | 'src' | 'url' | 'expires'>

const WAV_TYPE = 'audio/wav'

/** Whether a clip of `type` goes as a WAV copy: an audio clip of a type
 *  that the model does not take, when it takes WAV. */
export function needsWavCopy(kind: MediaTagKind, rules: ClipKindRules, type: string): boolean {
  return kind === 'audio' && rules.types !== undefined && !rules.types.includes(canonicalMediaType(type)) && rules.types.includes(WAV_TYPE)
}

/** Whether `rules` limit the length of a clip or of all clips of the
 *  kind, so the request needs the length of each clip of the kind. */
export function hasLengthRules(rules: ClipKindRules): boolean {
  return rules.minSeconds !== undefined || rules.maxSeconds !== undefined || rules.maxTotalSeconds !== undefined
}

/** The most clips of `kind` that a request to a model with `rules` takes:
 *  0 for a kind with no rules, Infinity with no known limit. */
export function maxInputClips(rules: InputClipRules | undefined, kind: MediaTagKind): number {
  const kindRules = rules?.[kind]
  if (!kindRules) return 0
  return kindRules.maxClips ?? Infinity
}

/** `1 audio clip`, `2 video clips`. */
export function clipsText(count: number, kind: MediaTagKind): string {
  return `${count} ${kind} ${count === 1 ? 'clip' : 'clips'}`
}

// The media kinds that make nothing without a clip of the message, each
// with the kind of that clip and what a model of the kind does, as the
// end of a sentence for the user.
const NEEDS_INPUT_CLIP: Readonly<Partial<Record<MediaKind, { kind: MediaTagKind, does: string }>>> = {
  videoToVideo: { kind: 'video', does: 'makes a new video from a video clip' },
  voiceChange: { kind: 'audio', does: 'says the speech of an audio clip in another voice' },
  transcription: { kind: 'audio', does: 'writes down the speech of an audio clip' },
}

/** The kind of the clip that a request of `kind` cannot go without;
 *  undefined for a kind that needs none. */
export function neededClipKind(kind: MediaKind): MediaTagKind | undefined {
  return NEEDS_INPUT_CLIP[kind]?.kind
}

/** Why a request of `kind` with the clips `clips` does not go to the
 *  model `modelName`, as a sentence for the user; null when it can go.
 *  A model that changes or writes down a clip needs one clip of its kind
 *  (`NEEDS_INPUT_CLIP`). The check costs nothing, and the submit makes it
 *  before the reply starts. */
export function missingClipProblem(modelName: string, kind: MediaKind, clips: readonly Pick<ClipAttachment, 'kind'>[]): string | null {
  const needed = NEEDS_INPUT_CLIP[kind]
  if (!needed || clips.some((clip) => clip.kind === needed.kind)) return null
  const clip = needed.kind === 'audio' ? 'an audio clip' : 'a video clip'
  return `${modelName} ${needed.does}, and this message has no ${needed.kind} clip. Paste or drop ${clip} into the message, or name one with @id.`
}

// A copy that shares no object with `rules`.
function cloneKindRules(rules: ClipKindRules): ClipKindRules {
  return { ...rules, ...(rules.types && { types: [...rules.types] }) }
}

/** A copy that shares no object with `rules`. */
export function cloneInputClipRules(rules: InputClipRules): InputClipRules {
  return {
    ...rules,
    ...(rules.audio && { audio: cloneKindRules(rules.audio) }),
    ...(rules.video && { video: cloneKindRules(rules.video) }),
  }
}

// A length to 0.1 s. A length that breaks a limit is rounded away from the
// limit (`Math.ceil` above a most, `Math.floor` below a least), so that a
// clip of 10.04 s never reads as "10 seconds long" next to a most of 10.
function secondsText(seconds: number, round: (value: number) => number = Math.round): string {
  const rounded = round(seconds * 10) / 10
  return `${rounded} ${rounded === 1 ? 'second' : 'seconds'}`
}

// What to do about a clip that breaks a rule of its kind. Dez cuts and
// converts no video; an audio clip can be cut with the `audio` tool.
function fixText(kind: MediaTagKind, tooLong: boolean): string {
  if (kind === 'video') return 'Use another video clip, or choose another model.'
  if (tooLong) return 'Ask the chat model to cut it with the audio tool (`audio clip`), then name the new clip.'
  return 'Use another audio clip, or choose another model.'
}

/** Why the clips `clips` (the clips of a request, `mediaRequestInput`)
 *  do not go to the model `modelName` with the clip rules `rules` in a
 *  request with `imageCount` input images, as a sentence for the user;
 *  null when they can go, as far as the tags tell at the time `now`. The
 *  submit gives only the clips that the model takes (`mediaRequestInput`
 *  cuts the others), so the kind and count checks are for a caller of
 *  `generateMedia` that did not cut them. The check costs nothing. */
export function clipTagProblem(modelName: string, rules: InputClipRules | undefined, clips: readonly ClipAttachment[], imageCount: number, now = Date.now()): string | null {
  const counts = { audio: 0, video: 0 }
  for (const clip of clips) counts[clip.kind]++
  for (const kind of ['audio', 'video'] as const) {
    const max = maxInputClips(rules, kind)
    if (counts[kind] <= max) continue
    return max === 0
      ? `${modelName} takes no ${kind} clip, and this message has ${clipsText(counts[kind], kind)}. Remove the ${kind} clips and their @id mentions from the message.`
      : `${modelName} takes only ${clipsText(max, kind)}, and this message has ${counts[kind]}. Use fewer ${kind} clips.`
  }
  for (const clip of clips) {
    const kindRules = rules?.[clip.kind]
    const types = kindRules?.types
    if (!kindRules || !types || types.includes(canonicalMediaType(clip.type)) || needsWavCopy(clip.kind, kindRules, clip.type)) continue
    const typeList = new Intl.ListFormat('en', { type: 'disjunction' }).format(types)
    return `${modelName} takes only ${clip.kind} clips of the type ${typeList}, and @${clip.id} is ${canonicalMediaType(clip.type)}. ${fixText(clip.kind, false)}`
  }
  for (const clip of clips) {
    if (!rules?.[clip.kind]?.urlOnly) continue
    const lead = `${modelName} takes ${clip.kind} clips only by a web address that its provider downloads, and`
    if (clip.url === null) {
      return `${lead} @${clip.id} has none: Dez has it only as a file. Use a ${clip.kind} clip that a model made, while its web address works, or choose another model.`
    }
    if (!/^https:\/\//i.test(clip.url)) {
      return `${lead} the web address of @${clip.id} is not https. Use a ${clip.kind} clip that a model made, while its web address works, or choose another model.`
    }
    // A tag with a `url` has the time of the address in `expires`
    // (`savedMediaTag`); with no time, the provider tells.
    if (clip.expires !== null && Date.parse(clip.expires) <= now) {
      return `${lead} the web address of @${clip.id} has expired. Make the clip again, or choose another model.`
    }
  }
  if (counts.audio > 0 && rules?.audioNeedsVisual && imageCount + counts.video === 0) {
    return `${modelName} takes an audio clip only together with a reference image or video. Add an image or a video clip to the message, or name one with @id.`
  }
  const references = imageCount + counts.video
  if (rules?.audio?.use === 'voice' && counts.audio > references) {
    return `${modelName} takes each audio clip as the voice of one reference, in order: the first audio clip is the voice of the first image, and so on, with the images first and then the video clips. `
      + `This message has ${clipsText(counts.audio, 'audio')} and ${references} ${references === 1 ? 'image or video clip' : 'images and video clips'}. Use fewer audio clips, or more images or video clips.`
  }
  return null
}

/** One clip of a request, as `generateMedia` read it: its length in
 *  seconds (null when Dez could not tell it) and the length of the file
 *  that goes. */
export interface ReadInputClip {
  clip: ClipAttachment
  seconds: number | null
  byteLength: number
  /** The file that goes is Dez's WAV copy of the clip (`needsWavCopy`), not
   *  the clip's own file. */
  wavCopy?: boolean
}

/** Why the clips `read` do not go to the model `modelName` with the clip
 *  rules `rules`, by their lengths and sizes, as a sentence for the user;
 *  null when they can go, as far as Dez can tell. A clip whose length Dez
 *  could not tell gets no length check, and the provider's answer tells
 *  the user then. Dez cuts nothing: a clip that is too long gets the
 *  model's limit, and an audio clip the hint to cut it with the `audio`
 *  tool. The length of a clip comes before its size: the size of a WAV
 *  copy follows from its length, so a clip that is too long is the cause
 *  of a copy that is too large. */
export function clipFileProblem(modelName: string, rules: InputClipRules | undefined, read: readonly ReadInputClip[]): string | null {
  for (const { clip, seconds, byteLength, wavCopy } of read) {
    const kindRules = rules?.[clip.kind]
    if (!kindRules) continue
    if (seconds !== null && kindRules.maxSeconds !== undefined && seconds > kindRules.maxSeconds) {
      return `The ${clip.kind} clip @${clip.id} is ${secondsText(seconds, Math.ceil)} long, and ${modelName} takes ${clip.kind} clips of at most ${secondsText(kindRules.maxSeconds)}. ${fixText(clip.kind, true)}`
    }
    if (seconds !== null && kindRules.minSeconds !== undefined && seconds < kindRules.minSeconds) {
      return `The ${clip.kind} clip @${clip.id} is ${secondsText(seconds, Math.floor)} long, and ${modelName} takes ${clip.kind} clips of at least ${secondsText(kindRules.minSeconds)}. ${fixText(clip.kind, false)}`
    }
    if (kindRules.maxBytes !== undefined && byteLength > kindRules.maxBytes) {
      const size = wavCopy
        ? `Dez sends the audio clip @${clip.id} as a WAV copy, because ${modelName} takes no audio clip of the type ${canonicalMediaType(clip.type)}. The copy is ${byteSizeText(byteLength)}`
        : `The ${clip.kind} clip @${clip.id} is ${byteSizeText(byteLength)}`
      return `${size}, and ${modelName} takes ${clip.kind} clips of at most ${byteSizeText(kindRules.maxBytes)}. ${fixText(clip.kind, clip.kind === 'audio')}`
    }
  }
  for (const kind of ['audio', 'video'] as const) {
    const most = rules?.[kind]?.maxTotalSeconds
    if (most === undefined) continue
    const total = read.reduce((sum, { clip, seconds }) => sum + (clip.kind === kind && seconds !== null ? seconds : 0), 0)
    if (total <= most) continue
    return `The ${kind} clips of this message are ${secondsText(total, Math.ceil)} long together, and ${modelName} takes at most ${secondsText(most)} of ${kind} clips in one request. Use fewer or shorter ${kind} clips.`
  }
  return null
}
